/**
 * Fresh browser/MCP differential for embedded OS & Software editing.
 *
 * This deliberately drives the same visible controls a user does. Historical
 * fixture prices are not an oracle: each step compares the live browser patch,
 * displayed total and request delta with a contemporaneous MCP edit.
 *
 * Run: npx tsx scripts/parity-software.ts [--out artifacts/parity-software/<run>]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page, type Response } from 'playwright';

import { ConfigSchema } from '../src/config/schema.js';
import { serializeSections, type WireSection } from '../src/domain/dcscWire.js';
import { applyCatalogChange } from '../src/domain/reduce.js';
import { configureLogger } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';
import type { RawConfiguration, RawTab } from '../src/model/types.js';

type Json = Record<string, unknown>;
type Change = { sectionName: string; code: string; quantity: number };
type BrowserAction = {
  name: string;
  change: Change;
  expectedDelta?: Json;
  compareRequestDelta?: boolean;
  interact(page: Page): Promise<Json | void>;
};
type CaseResult = {
  name: string;
  status: 'pass' | 'fail';
  change: Change;
  sectionId?: string;
  browser?: {
    totalPrice: number;
    currency: string;
    delta: unknown;
    responseStatus: number;
    uiEvidence?: Json;
  };
  mcp?: { totalPrice: number; currency: string; revision: number };
  softwareSections?: number;
  error?: string;
};

const PRODUCT = '7D73CTO1WW';
const SOFTWARE_DERIVE = /\/api\/ctos\/autoDerive(?:\?|$)/;
const ACTIONS: BrowserAction[] = [
  {
    name: 'maintenance-five',
    change: { sectionName: 'T1GT/T1GU/SW_MAINT_DURATION', code: 'SMD5', quantity: 1 },
    async interact(page) {
      await clickVisible(page.getByText(/with 3 Yr S&S/i), 'current 3-year maintenance choice');
      await clickVisible(page.getByText(/with 5 Yr S&S/i), '5-year maintenance choice');
    },
  },
  {
    name: 'group-remove',
    change: { sectionName: 'T1GT', code: 'T1GU', quantity: 0 },
    async interact(page) {
      const heading = await visible(page.getByText('XClarity One', { exact: true }), 'XClarity One');
      const panel = heading.locator(
        'xpath=ancestor::*[.//*[normalize-space(text())="Reset"]][1]',
      );
      const scoped = panel.getByText('Reset', { exact: true });
      await clickVisible((await scoped.count()) > 0 ? scoped : page.getByText('Reset', { exact: true }), 'XClarity Reset');
    },
  },
  {
    name: 'multi-add-user',
    change: { sectionName: 'T1K2', code: 'T1K3', quantity: 1 },
    async interact(page) {
      await openMicrosoftCal(page);
      await clickCheckbox(page, 0, false, 'Windows Server 2025 User CAL');
    },
  },
  {
    name: 'filter-select-50-user-cal',
    change: { sectionName: 'T1K2/T1K3/CAL_50_2025', code: 'SDDZ', quantity: 1 },
    expectedDelta: {
      section: 'CAL_50_2025',
      featureCode: 'SDDZ',
      quantity: 1,
      isClear: false,
      type: 'software',
    },
    async interact(page) {
      const panel = await userCalPanel(page);
      const selects = panel.locator('.ant-select:visible');
      assert((await selects.count()) >= 4, 'User CAL did not expose its four license filters.');
      await chooseAntOption(page, selects.nth(0), 'Windows Server 2025 CAL (50 User)');
      return { filter: 'CAL_50_2025', selected: 'SDDZ' };
    },
  },
  {
    name: 'filter-quantity-three',
    change: { sectionName: 'T1K2', code: 'SDDZ', quantity: 3 },
    expectedDelta: {
      section: 'T1K2',
      featureCode: 'SDDZ',
      quantity: 3,
      isClear: false,
      type: 'hipo',
      previousQuantity: 1,
    },
    async interact(page) {
      const panel = await userCalPanel(page);
      const selects = panel.locator('.ant-select:visible');
      assert((await selects.count()) >= 5, 'Selected User CAL did not expose a quantity control.');
      await chooseAntOption(page, selects.last(), '3');
      return { selectedQuantity: 3, nonUnitQuantitySupported: true };
    },
  },
  {
    name: 'multi-add-device',
    change: { sectionName: 'T1K2', code: 'T1K4', quantity: 1 },
    async interact(page) {
      await clickCheckbox(page, 1, false, 'Windows Server 2025 Device CAL');
    },
  },
  {
    name: 'filter-clear-via-group-reset',
    // The site exposes no filter-level None/clear action. Reset removes this
    // group while preserving the independently selected Device CAL group.
    change: { sectionName: 'T1K2', code: 'T1K3', quantity: 0 },
    compareRequestDelta: false,
    expectedDelta: {
      section: 'T1K2',
      featureCode: null,
      quantity: 0,
      isClear: false,
      type: 'software',
    },
    async interact(page) {
      const panel = await userCalPanel(page);
      const filter = panel.locator('.ant-select:visible').first();
      await filter.click();
      const dropdown = await visible(page.locator('.ant-select-dropdown:visible'), '50 User CAL choices');
      const options = (await dropdown.locator('.ant-select-dropdown-menu-item').allInnerTexts())
        .map((value) => value.trim()).filter(Boolean);
      assert(options.includes('Windows Server 2025 CAL (50 User)'), 'Selected filter option disappeared.');
      assert(
        !options.some((value) => /^(?:none|please select|clear)$/i.test(value)),
        `User CAL filter unexpectedly exposed a clear choice: ${options.join(', ')}`,
      );
      await page.keyboard.press('Escape');
      const clearControls = await filter.locator('.ant-select-selection__clear:visible').count();
      assert.equal(clearControls, 0, 'User CAL filter unexpectedly exposed an inline clear control.');
      await clickVisible(panel.getByText('Reset', { exact: true }), 'User CAL Reset');
      return { filterClearChoice: false, inlineClearControl: false, clearControl: 'group-reset', options };
    },
  },
  {
    name: 'multi-readd-user',
    change: { sectionName: 'T1K2', code: 'T1K3', quantity: 1 },
    async interact(page) {
      await clickCheckbox(page, 0, false, 'Windows Server 2025 User CAL re-add');
    },
  },
  {
    name: 'multi-remove-user',
    change: { sectionName: 'T1K2', code: 'T1K3', quantity: 0 },
    async interact(page) {
      await clickCheckbox(page, 0, true, 'Windows Server 2025 User CAL removal');
    },
  },
];

function object(value: unknown): Json {
  return typeof value === 'object' && value !== null ? value as Json : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function money(value: unknown): number {
  const amount = Number(value);
  assert(Number.isFinite(amount), `Expected a finite price, received ${String(value)}.`);
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv = process.argv.slice(2)): { origin: string; outDir: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let origin = 'https://dcsc.lenovo.com/';
  let outDir = path.resolve(`artifacts/parity-software/${stamp}`);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--origin' || argument === '--out') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      if (argument === '--origin') origin = value;
      else outDir = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { origin, outDir };
}

async function visible(locator: Locator, description: string): Promise<Locator> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Could not find a visible ${description}.`);
}

async function clickVisible(locator: Locator, description: string): Promise<void> {
  const target = await visible(locator, description);
  await target.scrollIntoViewIfNeeded();
  await target.click({ timeout: 20_000 });
}

async function closeCookieBanner(page: Page): Promise<void> {
  const close = page.locator('.dcsc-cookie-close').first();
  if (await close.isVisible({ timeout: 2_000 }).catch(() => false)) await close.click();
}

async function waitUntilSettled(page: Page): Promise<void> {
  await page.locator('.ant-spin-spinning:visible').first()
    .waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
}

async function openMicrosoftCal(page: Page): Promise<void> {
  await clickVisible(page.getByText('Microsoft', { exact: true }), 'Microsoft software tab');
  const label = await visible(
    page.getByText('Windows Server 2025 CAL', { exact: true }),
    'Windows Server 2025 CAL section label',
  );
  await label.click();
  await page.waitForTimeout(300);
  const boxes = page.locator('label.ant-checkbox-wrapper:not(.screen):visible');
  assert((await boxes.count()) >= 2, 'Windows Server 2025 CAL did not expose its actual checkbox controls.');
  // The text label opens the section. It must not toggle either actual input.
  assert.equal(await boxes.nth(0).locator('input[type="checkbox"]').isChecked(), false);
  assert.equal(await boxes.nth(1).locator('input[type="checkbox"]').isChecked(), false);
}

async function clickCheckbox(
  page: Page,
  index: number,
  expectedBefore: boolean,
  description: string,
): Promise<void> {
  const checkbox = page.locator('label.ant-checkbox-wrapper:not(.screen):visible').nth(index);
  await checkbox.waitFor({ state: 'visible', timeout: 20_000 });
  const input = checkbox.locator('input[type="checkbox"]');
  assert.equal(await input.isChecked(), expectedBefore, `${description} started in the wrong state.`);
  await checkbox.click();
}

async function userCalPanel(page: Page): Promise<Locator> {
  const heading = await visible(
    page.getByText('Windows Server 2025 User CALs', { exact: true }),
    'Windows Server 2025 User CALs group',
  );
  const panel = heading.locator(
    'xpath=ancestor::*[.//*[normalize-space(text())="Reset"]][1]',
  );
  assert.equal(await panel.count(), 1, 'Could not isolate the Windows Server 2025 User CAL panel.');
  return panel;
}

async function chooseAntOption(page: Page, select: Locator, optionText: string): Promise<void> {
  await select.scrollIntoViewIfNeeded();
  await select.click();
  const dropdown = await visible(page.locator('.ant-select-dropdown:visible'), `${optionText} dropdown`);
  await clickVisible(
    dropdown.locator('.ant-select-dropdown-menu-item').filter({ hasText: optionText }),
    `${optionText} option`,
  );
}

function isSoftwareDerive(response: Response): boolean {
  if (response.request().method() !== 'POST' || !SOFTWARE_DERIVE.test(response.url())) return false;
  return new URL(response.url()).searchParams.get('isCustomizeOSSoftware') === 'true';
}

async function performBrowserAction(
  page: Page,
  outDir: string,
  action: BrowserAction,
): Promise<{ patch: Json; request: Json; responseStatus: number; uiEvidence?: Json }> {
  const responsePromise = page.waitForResponse(isSoftwareDerive, { timeout: 90_000 });
  let uiEvidence: Json | void;
  try {
    uiEvidence = await action.interact(page);
  } catch (error) {
    void responsePromise.catch(() => undefined);
    throw error;
  }
  const response = await responsePromise;
  assert.equal(response.status(), 200, `${action.name}: browser software derive returned ${response.status()}.`);
  const patch = object(await response.json());
  const request = object(response.request().postDataJSON());
  await waitUntilSettled(page);
  await writeFile(path.join(outDir, `${action.name}-browser-request.json`), `${JSON.stringify(request, null, 2)}\n`);
  await writeFile(path.join(outDir, `${action.name}-browser-response.json`), `${JSON.stringify(patch, null, 2)}\n`);
  return { patch, request, responseStatus: response.status(), ...(uiEvidence ? { uiEvidence } : {}) };
}

function assertExpectedDelta(actual: unknown, expected: Json | undefined, name: string): void {
  if (!expected) return;
  const delta = object(actual);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(delta[key], value, `${name}: browser delta.${key} differs from the captured contract.`);
  }
}

function configurationFromRequest(request: Json): Json {
  const configuration = array(request['configurations'])[0];
  assert(configuration, 'Browser software derive request omitted configurations[0].');
  return object(configuration);
}

function softwareSectionsFromPatch(patch: Json): WireSection[] {
  const tabs = patch['softwareTabs'];
  assert(Array.isArray(tabs), 'Browser software derive response omitted softwareTabs.');
  return serializeSections({ tabs: tabs as RawTab[] } as RawConfiguration)
    .filter((section) => section.type === 'software');
}

function typedUnrelatedSelections(value: RawConfiguration | Json): Array<{
  name: string;
  type: string;
  results: Array<{ code: string; quantity: number; type: string }>;
}> {
  let sections: WireSection[];
  if ('tabs' in value) {
    sections = serializeSections(value as RawConfiguration);
  } else {
    sections = array(value['sections']).map((section) => object(section) as WireSection);
  }
  return sections.filter((section) => section.type !== 'software').map((section) => ({
    name: section.name,
    type: String(section.type ?? ''),
    results: section.results.map((result) => ({
      code: result.code,
      quantity: result.quantity,
      type: String(result.type ?? section.type ?? ''),
    })).sort((left, right) => left.code.localeCompare(right.code) || left.quantity - right.quantity),
  })).sort((left, right) =>
    left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
}

async function readDisplayedTotal(page: Page): Promise<{ totalPrice: number; currency: string; text: string }> {
  const body = await page.locator('body').innerText();
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
  const candidates: Array<{ totalPrice: number; currency: string; text: string }> = [];
  const currency = lines.some((line) => /(?:^|\W)USD(?:\W|$)/.test(line)) ? 'USD' : '';
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^(?:total|configuration) price:?$/i.test(lines[index] ?? '')) continue;
    for (const line of lines.slice(index + 1, index + 5)) {
      const match = line.match(/([$€£])\s*([0-9][0-9,.]*)/);
      if (!match) continue;
      const amount = Number(match[2]?.replace(/,/g, ''));
      if (Number.isFinite(amount)) {
        candidates.push({ totalPrice: money(amount), currency: currency || symbolCurrency(match[1] ?? ''), text: line });
        break;
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error('Could not read a currency amount following a visible Configuration/Total Price label.');
  }
  return candidates[0]!;
}

function symbolCurrency(symbol: string): string {
  if (symbol === '$') return 'USD';
  if (symbol === '€') return 'EUR';
  if (symbol === '£') return 'GBP';
  return symbol;
}

async function waitForDisplayedTotal(
  page: Page,
  expected: number,
): Promise<{ totalPrice: number; currency: string; text: string }> {
  const deadline = Date.now() + 20_000;
  let last: { totalPrice: number; currency: string; text: string } | undefined;
  while (Date.now() < deadline) {
    last = await readDisplayedTotal(page).catch(() => undefined);
    if (last && last.totalPrice === expected) return last;
    await page.waitForTimeout(250);
  }
  throw new Error(`Browser Total Price did not settle at ${expected}; last visible value was ${last?.text ?? 'none'}.`);
}

async function launchBrowser(page: Page, origin: string): Promise<void> {
  await page.goto(
    new URL('#/categories/STG%40Servers%40Rack%20Server%40ThinkSystem%20SR630%20V3', origin).href,
    { waitUntil: 'domcontentloaded', timeout: 60_000 },
  );
  await closeCookieBanner(page);
  const customize = await visible(
    page.locator('button:has-text("Customize"), a:has-text("Customize"), [role="button"]:has-text("Customize")'),
    'first Customize control',
  );
  const launch = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes(`/api/ctos/${PRODUCT}/launch`),
    { timeout: 90_000 },
  );
  const initialDerive = page.waitForResponse(
    (response) => response.request().method() === 'POST' && SOFTWARE_DERIVE.test(response.url()) &&
      new URL(response.url()).searchParams.get('isCustomizeOSSoftware') !== 'true',
    { timeout: 90_000 },
  );
  await customize.click();
  const [launchResponse, deriveResponse] = await Promise.all([launch, initialDerive]);
  assert.equal(launchResponse.status(), 200, `Browser launch returned ${launchResponse.status()}.`);
  assert.equal(deriveResponse.status(), 200, `Browser initial derive returned ${deriveResponse.status()}.`);
  await waitUntilSettled(page);
  await clickVisible(page.getByText('OS & Software', { exact: true }), 'OS & Software tab');
  await clickVisible(page.getByText('XClarity', { exact: true }), 'XClarity sub-tab');
}

async function main(): Promise<void> {
  const options = parseArgs();
  await mkdir(options.outDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const cases: CaseResult[] = [];
  let browser: Browser | undefined;
  let service: DcscService | undefined;
  let page: Page | undefined;
  let failure: unknown;

  try {
    configureLogger('error');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      serviceWorkers: 'block',
    });
    page = await context.newPage();
    service = new DcscService(ConfigSchema.parse({
      files: { persistSessions: false, artifactDir: path.join(options.outDir, 'mcp-artifacts') },
      logLevel: 'error',
      pacing: { perToolRequestBudget: 80 },
    }));

    await launchBrowser(page, options.origin);
    const ctx = service.newCtx();
    const solution = await service.resolveSolution(ctx, 'General Purpose');
    const session = await service.launch({ productCode: PRODUCT, mode: 'cto', solution, ctx });
    const mcpUnrelated = typedUnrelatedSelections(session.raw);
    let browserUnrelated: ReturnType<typeof typedUnrelatedSelections> | undefined;

    for (const action of ACTIONS) {
      const result: CaseResult = { name: action.name, status: 'fail', change: action.change };
      cases.push(result);
      try {
        const ref = session.index.sections.find((section) => section.name === action.change.sectionName);
        assert(ref, `${action.name}: MCP did not discover section ${action.change.sectionName}.`);
        assert(
          session.index.byCode.get(action.change.code)?.some((feature) => feature.section === ref.id),
          `${action.name}: MCP did not discover ${action.change.code} in ${ref.id}.`,
        );
        result.sectionId = ref.id;

        const browserStep = await performBrowserAction(page, options.outDir, action);
        const browserConfiguration = configurationFromRequest(browserStep.request);
        assertExpectedDelta(browserConfiguration['delta'], action.expectedDelta, action.name);
        const capturedBrowserPrice = await readDisplayedTotal(page);
        result.browser = {
          totalPrice: capturedBrowserPrice.totalPrice,
          currency: capturedBrowserPrice.currency,
          delta: browserConfiguration['delta'],
          responseStatus: browserStep.responseStatus,
          ...(browserStep.uiEvidence ? { uiEvidence: browserStep.uiEvidence } : {}),
        };
        const predicted = applyCatalogChange(session.reduced, session.raw, action.change);
        if (action.compareRequestDelta !== false) {
          assert.deepEqual(
            predicted.delta,
            browserConfiguration['delta'],
            `${action.name}: MCP request-builder delta differs from the browser request.`,
          );
        }

        const currentBrowserUnrelated = typedUnrelatedSelections(browserConfiguration);
        browserUnrelated ??= currentBrowserUnrelated;
        assert.deepEqual(
          currentBrowserUnrelated,
          browserUnrelated,
          `${action.name}: browser software edit changed unrelated hardware/service sections.`,
        );

        await service.configure(
          session,
          [{ section: ref.id, code: action.change.code, quantity: action.change.quantity }],
          service.newCtx(),
          session.revision,
        );
        const expectedSoftware = softwareSectionsFromPatch(browserStep.patch);
        const actualSoftware = serializeSections(session.raw).filter((section) => section.type === 'software');
        assert.deepEqual(actualSoftware, expectedSoftware, `${action.name}: MCP software sections differ from browser patch.`);
        assert.deepEqual(
          typedUnrelatedSelections(session.raw),
          mcpUnrelated,
          `${action.name}: MCP software edit changed unrelated hardware/service sections.`,
        );

        const mcpTotal = money(session.raw.totalPrice);
        const browserPrice = await waitForDisplayedTotal(page, mcpTotal);
        assert.equal(browserPrice.currency, session.locale.currency, `${action.name}: displayed currency differs from MCP locale.`);

        await writeFile(
          path.join(options.outDir, `${action.name}-normalized-software.json`),
          `${JSON.stringify({ browser: expectedSoftware, mcp: actualSoftware }, null, 2)}\n`,
        );
        result.status = 'pass';
        result.browser.totalPrice = browserPrice.totalPrice;
        result.browser.currency = browserPrice.currency;
        result.mcp = {
          totalPrice: mcpTotal,
          currency: session.locale.currency,
          revision: session.revision,
        };
        result.softwareSections = actualSoftware.length;
        console.log(`PASS ${action.name}: ${browserPrice.currency} ${browserPrice.totalPrice.toFixed(2)}`);
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }
  } catch (error) {
    failure = error;
    console.error(error);
    if (page) {
      await Promise.allSettled([
        page.screenshot({ path: path.join(options.outDir, 'failure.png'), fullPage: true }),
        page.locator('body').innerText().then((text) => writeFile(path.join(options.outDir, 'failure-body.txt'), text)),
      ]);
    }
  } finally {
    await Promise.allSettled([
      service?.close() ?? Promise.resolve(),
      browser?.close() ?? Promise.resolve(),
    ]);
    const report = {
      schemaVersion: 1,
      startedAt,
      completedAt: new Date().toISOString(),
      headless: true,
      freshContext: true,
      origin: options.origin,
      product: PRODUCT,
      status: failure ? 'fail' : 'pass',
      totals: {
        cases: ACTIONS.length,
        attempted: cases.length,
        unrun: ACTIONS.length - cases.length,
        passed: cases.filter((item) => item.status === 'pass').length,
        failed: cases.filter((item) => item.status === 'fail').length +
          (failure && cases.length === 0 ? 1 : 0),
      },
      cases,
      ...(failure ? { error: failure instanceof Error ? failure.stack ?? failure.message : String(failure) } : {}),
    };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(path.join(options.outDir, 'report.json'), serialized);
    await writeFile(path.join(options.outDir, 'report.sha256'), `${sha256(serialized)}  report.json\n`);
    console.log(`Report: ${path.join(options.outDir, 'report.json')}`);
  }

  if (failure) process.exitCode = 1;
}

void main();
