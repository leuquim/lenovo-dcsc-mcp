/** Fresh DE/EUR browser/MCP differential for validation and Auto-Correct controls. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Response } from 'playwright';

import { ConfigSchema } from '../src/config/schema.js';
import { configureLogger } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';

type Json = Record<string, unknown>;
type ControlCase = { name: string; validationMode: 'guided' | 'expert'; autoCorrect: boolean };

const PRODUCT = '7D73CTO1WW';
const POWER_SUPPLY = 'BLKH';
const POWER_CABLE = '6400';
const CASES: ControlCase[] = [
  { name: 'guided-on', validationMode: 'guided', autoCorrect: true },
  { name: 'guided-off', validationMode: 'guided', autoCorrect: false },
  { name: 'expert-off', validationMode: 'expert', autoCorrect: false },
];

function object(value: unknown): Json {
  return typeof value === 'object' && value !== null ? value as Json : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function money(value: unknown): number {
  const amount = Number(value);
  assert(Number.isFinite(amount));
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function selectedQuantity(configuration: Json, code: string): number {
  for (const tab of array(configuration['tabs'])) {
    for (const subTab of array(object(tab)['subTabs'])) {
      for (const section of array(object(subTab)['sections'])) {
        for (const result of array(object(section)['results'])) {
          const item = object(result);
          if (item['code'] === code) return Number(item['quantity'] ?? 0);
        }
      }
    }
  }
  return 0;
}

function services(configuration: Json): Array<{ code: string; price: number }> {
  return array(configuration['hipoServiceCtoServices']).map(value => {
    const item = object(value);
    return { code: String(item['targetCto'] ?? ''), price: money(item['price']) };
  }).sort((left, right) => left.code.localeCompare(right.code));
}

async function visible(locator: Locator, description: string): Promise<Locator> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    for (let index = 0; index < await locator.count(); index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Could not find visible ${description}.`);
}

async function settle(page: Page): Promise<void> {
  await page.locator('.ant-spin-spinning:visible').first()
    .waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(700);
}

async function setGermanEnglishEuro(page: Page, origin: string): Promise<void> {
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await settle(page);
  const cookie = page.locator('.dcsc-cookie-close').first();
  if (await cookie.isVisible({ timeout: 1_000 }).catch(() => false)) await cookie.click();
  await (await visible(page.getByText('/ English / USD', { exact: true }), 'locale preferences')).click();
  await page.locator('.country .ant-select-selection').click();
  await (await visible(page.locator('.ant-select-dropdown:visible').getByText('Germany', { exact: true }), 'Germany option')).click();
  await page.locator('.language .ant-select-selection').click();
  await (await visible(page.locator('.ant-select-dropdown:visible').getByText('English', { exact: true }), 'English option')).click();
  assert.match(await page.locator('[role="dialog"]:visible').innerText(), /EUR\(€\)/);
  await page.getByRole('button', { name: 'Save Preferences' }).click();
  await settle(page);
  await visible(page.getByText('/ English / EUR', { exact: true }), 'DE/EUR locale marker');
}

async function launchBrowser(browser: Browser, origin: string): Promise<{ context: BrowserContext; page: Page; launch: Json }> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  await setGermanEnglishEuro(page, origin);
  await page.goto(new URL('#/categories/STG%40Servers%40Rack%20Server%40ThinkSystem%20SR630%20V3', origin).href,
    { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await settle(page);
  const launchPending = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes(`/api/ctos/${PRODUCT}/launch`));
  await page.locator(`a[href*="${PRODUCT}"] button`).click();
  const launchResponse = await launchPending;
  assert.equal(launchResponse.status(), 200);
  const launchUrl = new URL(launchResponse.url());
  assert.equal(launchUrl.searchParams.get('country_or_region'), 'DE');
  assert.equal(launchUrl.searchParams.get('language'), 'en');
  assert.equal(launchUrl.searchParams.get('currency'), 'EUR');
  await page.waitForURL(/#\/configuration\/cto\//);
  await settle(page);
  return { context, page, launch: object(await launchResponse.json()) };
}

async function autoCorrectInput(page: Page): Promise<Locator> {
  const text = await visible(page.getByText('Auto-Correct', { exact: true }), 'Auto-Correct label');
  const container = text.locator('xpath=ancestor::*[.//input[@type="checkbox"]][1]');
  const input = container.locator('input[type="checkbox"]');
  assert.equal(await input.count(), 1, 'Could not isolate Auto-Correct input.');
  return input;
}

async function setBrowserControls(page: Page, controls: ControlCase): Promise<{ autoCorrectDisabled: boolean }> {
  const autoCorrect = await autoCorrectInput(page);
  if (controls.validationMode === 'expert') {
    await (await visible(page.getByText('Expert Mode', { exact: true }), 'Expert Mode control')).click();
    await page.waitForTimeout(300);
  } else if (!controls.autoCorrect) {
    assert.equal(await autoCorrect.isChecked(), true);
    await autoCorrect.click();
    await page.waitForTimeout(300);
  }
  const current = await autoCorrectInput(page);
  assert.equal(await current.isChecked(), controls.autoCorrect);
  if (controls.validationMode === 'expert') assert.equal(await current.isDisabled(), true);
  return { autoCorrectDisabled: await current.isDisabled() };
}

function isHardwareDerive(response: Response): boolean {
  return response.request().method() === 'POST' && response.url().includes('/api/ctos/autoDerive');
}

async function choosePowerSupplyQuantityOne(
  page: Page,
  validationMode: 'guided' | 'expert',
): Promise<{ response: Json; request: Json; query: Json }> {
  await (await visible(page.getByText('Power', { exact: true }), 'Power tab')).click();
  await (await visible(page.getByText('Power Supply', { exact: true }), 'Power Supply section')).click();
  await settle(page);
  await visible(page.getByText(/ThinkSystem 1100W.*Titanium.*Power Supply/i),
    `${POWER_SUPPLY} power supply description`);
  const row = await visible(page.locator('.testFeature').filter({ hasText: POWER_SUPPLY }),
    `${POWER_SUPPLY} selectable feature row`);
  const select = row.locator('[role="combobox"]');
  assert.equal(await select.count(), 1, `Could not isolate ${POWER_SUPPLY} quantity selector.`);
  await select.click();
  const options = page.locator('.ant-select-dropdown:visible .ant-select-dropdown-menu-item');
  const one = await visible(options.filter({ hasText: /^\s*1(?:\s*x)?\s*$/i }),
    `power supply quantity 1; options were ${JSON.stringify(await options.allInnerTexts())}`);
  let response: Response | undefined;
  if (validationMode === 'guided') {
    const pending = page.waitForResponse(isHardwareDerive, { timeout: 120_000 });
    await one.click();
    response = await pending;
  } else {
    await one.click();
    // Expert mode batches local changes; Summary is the explicit derive boundary.
    const summary = await visible(page.getByRole('button', { name: 'Check and Continue' }),
      'Expert Check and Continue action');
    const pending = page.waitForResponse(isHardwareDerive, { timeout: 120_000 });
    await summary.click();
    response = await pending;
  }
  assert.equal(response.status(), 200);
  const url = new URL(response.url());
  await settle(page);
  return {
    response: object(await response.json()),
    request: object(response.request().postDataJSON()),
    query: {
      entranceFlag: url.searchParams.get('entranceFlag'),
      guideMode: url.searchParams.get('guideMode') === 'true',
      configurationId: url.searchParams.get('configurationId'),
    },
  };
}

function firstConfiguration(value: Json): Json {
  const configuration = array(value['configurations'])[0];
  return configuration ? object(configuration) : value;
}

function displayedPrice(configuration: Json): number {
  return money(configuration['totalPrice']);
}

async function browserCase(browser: Browser, origin: string, outDir: string, controls: ControlCase): Promise<Json> {
  const { context, page, launch } = await launchBrowser(browser, origin);
  try {
    const ui = await setBrowserControls(page, controls);
    const derive = await choosePowerSupplyQuantityOne(page, controls.validationMode);
    const configuration = firstConfiguration(derive.response);
    const result: Json = {
      controls: { validationMode: controls.validationMode, autoCorrect: controls.autoCorrect, ...ui },
      locale: { country: 'DE', language: 'en', currency: 'EUR' },
      launchPrice: displayedPrice(launch),
      totalPrice: displayedPrice(configuration),
      selected: { [POWER_SUPPLY]: selectedQuantity(configuration, POWER_SUPPLY), [POWER_CABLE]: selectedQuantity(configuration, POWER_CABLE) },
      services: services(configuration),
      query: derive.query,
      autoVariant: object(derive.request['customizingFlags'])['autoVariant'],
      delta: object(firstConfiguration(derive.request)['delta']),
    };
    await writeFile(path.join(outDir, `${controls.name}-browser.json`), `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(path.join(outDir, `${controls.name}-browser-request.json`), `${JSON.stringify(derive.request, null, 2)}\n`);
    await writeFile(path.join(outDir, `${controls.name}-browser-response.json`), `${JSON.stringify(derive.response, null, 2)}\n`);
    return result;
  } catch (error) {
    await Promise.allSettled([
      page.screenshot({ path: path.join(outDir, `${controls.name}-failure.png`), fullPage: true }),
      page.locator('body').innerText().then(body => writeFile(
        path.join(outDir, `${controls.name}-failure-body.txt`), body,
      )),
      Promise.all([
        page.locator('button:visible').allInnerTexts(),
        page.locator('[role="dialog"]:visible').allInnerTexts(),
      ]).then(([buttons, dialogs]) => writeFile(path.join(outDir, `${controls.name}-failure-ui.json`),
        `${JSON.stringify({ url: page.url(), buttons, dialogs }, null, 2)}\n`)),
    ]);
    throw error;
  } finally {
    await context.close();
  }
}

async function mcpCase(service: DcscService, controls: ControlCase): Promise<Json> {
  const locale = await service.resolveLocale(service.newCtx(), 'DE', 'en');
  const solution = await service.resolveSolution(service.newCtx({ locale }), 'General Purpose');
  const ctx = service.newCtx({ locale, solution });
  const session = await service.launch({ productCode: PRODUCT, mode: 'cto', solution, ctx, label: controls.name });
  await service.setConfigurationControls(session.id, { validationMode: controls.validationMode,
    autoCorrect: controls.autoCorrect, ctx });
  const ref = session.index.byCode.get(POWER_SUPPLY)?.[0];
  assert(ref, `${POWER_SUPPLY} missing from the MCP index.`);
  await service.configure(session, [{ section: ref.section, code: POWER_SUPPLY, quantity: 1 }], ctx);
  return {
    controls: { validationMode: session.validationMode, autoCorrect: session.autoCorrect },
    locale: session.locale,
    totalPrice: money(session.raw.totalPrice),
    selected: { [POWER_SUPPLY]: selectedQuantity(session.raw as Json, POWER_SUPPLY), [POWER_CABLE]: selectedQuantity(session.raw as Json, POWER_CABLE) },
    services: services(session.raw as Json),
  };
}

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outArg = process.argv.indexOf('--out');
  const outDir = path.resolve(outArg >= 0 ? process.argv[outArg + 1] ?? '' : `artifacts/parity-controls-locale/${stamp}`);
  const caseArg = process.argv.indexOf('--case');
  const selectedCases = caseArg >= 0
    ? CASES.filter(candidate => candidate.name === process.argv[caseArg + 1])
    : CASES;
  assert(selectedCases.length > 0, `Unknown --case value ${process.argv[caseArg + 1] ?? ''}.`);
  const origin = 'https://dcsc.lenovo.com/';
  await mkdir(outDir, { recursive: true });
  configureLogger('error');
  const browser = await chromium.launch({ headless: true });
  const service = new DcscService(ConfigSchema.parse({ logLevel: 'error', files: { persistSessions: false,
    artifactDir: path.join(outDir, 'mcp-artifacts') } }));
  const cases: Json[] = [];
  let failure: unknown;
  try {
    for (const controls of selectedCases) {
      const browserResult = await browserCase(browser, origin, outDir, controls);
      const mcpResult = await mcpCase(service, controls);
      assert.deepEqual(mcpResult['locale'], { country: 'DE', geo: 'EMEA', language: 'en', currency: 'EUR' });
      for (const key of ['totalPrice', 'selected', 'services']) {
        assert.deepEqual(mcpResult[key], browserResult[key], `${controls.name}: MCP ${key} differs from browser.`);
      }
      assert.equal(object(browserResult['query'])['guideMode'], controls.validationMode === 'guided');
      assert.equal(browserResult['autoVariant'], controls.autoCorrect);
      cases.push({ name: controls.name, status: 'pass', browser: browserResult, mcp: mcpResult });
      console.log(`PASS ${controls.name}: EUR ${String(browserResult['totalPrice'])}`);
    }
    const locale = await service.resolveLocale(service.newCtx(), 'DE', 'en');
    const solution = await service.resolveSolution(service.newCtx({ locale }), 'General Purpose');
    const session = await service.launch({ productCode: PRODUCT, mode: 'cto', solution,
      ctx: service.newCtx({ locale, solution }), label: 'expert rejection' });
    await assert.rejects(
      service.setConfigurationControls(session.id, { validationMode: 'expert', autoCorrect: true,
        ctx: service.newCtx({ locale, solution }) }),
      /Auto-Correct cannot be enabled in Expert mode/,
    );
  } catch (error) {
    failure = error;
    console.error(error);
  } finally {
    await Promise.allSettled([service.close(), browser.close()]);
    await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify({ schemaVersion: 1,
      status: failure ? 'fail' : 'pass', headless: true, product: PRODUCT,
      locale: { country: 'DE', language: 'en', currency: 'EUR' }, cases,
      expertAutoCorrectTrue: failure ? 'not-reached-or-failed' : 'rejected' }, null, 2)}\n`);
  }
  if (failure) process.exitCode = 1;
}

void main();
