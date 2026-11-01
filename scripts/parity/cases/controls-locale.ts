/** Fresh DE/EUR browser and MCP differential for the Guided/Expert and Auto-Correct controls. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page, Response } from 'playwright';

import { DCSC_HOME } from '../web.js';
import { setGermanEnglishEuro, settle, visible } from '../settingsUi.js';
import type { Json, ParityCase } from '../harness.js';

type ControlCase = { name: string; validationMode: 'guided' | 'expert'; autoCorrect: boolean };

const PRODUCT = '7D73CTO1WW';
const POWER_SUPPLY = 'BLKH';
const POWER_CABLE = '6400';
const POWER_SECTION = 'Power Supply';
const CASES: ControlCase[] = [
  { name: 'guided-on', validationMode: 'guided', autoCorrect: true },
  { name: 'guided-off', validationMode: 'guided', autoCorrect: false },
  { name: 'expert-off', validationMode: 'expert', autoCorrect: false },
];

const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const money = (value: unknown) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function selectedQuantity(configuration: Json, code: string): number {
  const result = array(configuration['tabs']).flatMap(tab => array(object(tab)['subTabs']))
    .flatMap(tab => array(object(tab)['sections'])).flatMap(section => array(object(section)['results']))
    .map(object).find(item => item['code'] === code);
  return Number(result?.['quantity'] ?? 0);
}

const services = (configuration: Json) => array(configuration['hipoServiceCtoServices']).map(value => ({
  code: String(object(value)['targetCto'] ?? ''), price: money(object(value)['price']),
})).sort((left, right) => left.code.localeCompare(right.code));

const outcome = (configuration: Json) => ({
  totalPrice: money(configuration['totalPrice']),
  selected: { [POWER_SUPPLY]: selectedQuantity(configuration, POWER_SUPPLY), [POWER_CABLE]: selectedQuantity(configuration, POWER_CABLE) },
  services: services(configuration),
});

async function autoCorrectInput(page: Page): Promise<Locator> {
  const text = await visible(page.getByText('Auto-Correct', { exact: true }), 'Auto-Correct label');
  const input = text.locator('xpath=ancestor::*[.//input[@type="checkbox"]][1]').locator('input[type="checkbox"]');
  assert.equal(await input.count(), 1, 'Could not isolate Auto-Correct input.');
  return input;
}

async function setBrowserControls(page: Page, controls: ControlCase) {
  const autoCorrect = await autoCorrectInput(page);
  if (controls.validationMode === 'expert') {
    await (await visible(page.getByText('Expert Mode', { exact: true }), 'Expert Mode control')).click();
    await page.waitForTimeout(300);
  } else if (!controls.autoCorrect) {
    await autoCorrect.click();
    await page.waitForTimeout(300);
  }
  const current = await autoCorrectInput(page);
  return { autoCorrect: await current.isChecked(), autoCorrectDisabled: await current.isDisabled() };
}

const isHardwareDerive = (response: Response) =>
  response.request().method() === 'POST' && response.url().includes('/api/ctos/autoDerive');

async function choosePowerSupplyQuantityOne(page: Page, validationMode: ControlCase['validationMode']) {
  await (await visible(page.getByText('Power', { exact: true }), 'Power tab')).click();
  await (await visible(page.getByText(POWER_SECTION, { exact: true }), 'Power Supply section')).click();
  await settle(page);
  const row = await visible(page.locator('.testFeature').filter({ hasText: POWER_SUPPLY }), `${POWER_SUPPLY} feature row`);
  await row.locator('[role="combobox"]').click();
  const one = await visible(page.locator('.ant-select-dropdown:visible .ant-select-dropdown-menu-item')
    .filter({ hasText: /^\s*1(?:\s*x)?\s*$/i }), 'power supply quantity 1');
  const pending = page.waitForResponse(isHardwareDerive, { timeout: 120_000 });
  await one.click();
  if (validationMode === 'expert') {
    // Expert mode batches local changes; Check and Continue is the explicit derive boundary.
    await (await visible(page.getByRole('button', { name: 'Check and Continue' }), 'Expert Check and Continue action')).click();
  }
  const response = await pending;
  assert.equal(response.status(), 200);
  const url = new URL(response.url());
  await settle(page);
  return {
    response: object(await response.json()),
    request: object(response.request().postDataJSON()),
    guideMode: url.searchParams.get('guideMode') === 'true',
  };
}

export default {
  id: 'controls-locale',
  tags: ['configuration', 'locale'],
  async run(h) {
    const { mcp, web, step, compare, out } = h;

    await mcp.call('dcsc_settings_set', { country: 'DE', language: 'en' });
    for (const controls of CASES) {
      const browser = await step(`browser-${controls.name}`, async () => {
        const page = await web.newPage();
        page.setDefaultTimeout(90_000);
        await setGermanEnglishEuro(page, DCSC_HOME);
        await page.goto(new URL('#/categories/STG%40Servers%40Rack%20Server%40ThinkSystem%20SR630%20V3', DCSC_HOME).href,
          { waitUntil: 'domcontentloaded', timeout: 90_000 });
        await settle(page);
        const launchPending = page.waitForResponse(response =>
          response.request().method() === 'POST' && response.url().includes(`/api/ctos/${PRODUCT}/launch`));
        await page.locator(`a[href*="${PRODUCT}"] button`).click();
        const launchResponse = await launchPending;
        assert.equal(launchResponse.status(), 200);
        const launchQuery = Object.fromEntries(['country_or_region', 'language', 'currency']
          .map(key => [key, new URL(launchResponse.url()).searchParams.get(key)]));
        await page.waitForURL(/#\/configuration\/cto\//);
        await settle(page);
        const ui = await setBrowserControls(page, controls);
        const derive = await choosePowerSupplyQuantityOne(page, controls.validationMode);
        const configuration = array(derive.response['configurations'])[0] ? object(array(derive.response['configurations'])[0]) : derive.response;
        await writeFile(path.join(out, `${controls.name}-browser-response.json`), JSON.stringify(derive.response, null, 2));
        return { ui, launchQuery, ...derive, outcome: outcome(configuration) };
      });

      await step(`mcp-${controls.name}`, async () => {
        const launched = await mcp.call('dcsc_launch', { productCode: PRODUCT, mode: 'cto', solutionMode: 'General Purpose', label: controls.name });
        const session = String(launched['session']);
        const applied = await mcp.call('dcsc_configure', { session, validationMode: controls.validationMode, autoCorrect: controls.autoCorrect });
        await mcp.call('dcsc_configure', { session, changes: [{ section: POWER_SECTION, code: POWER_SUPPLY, quantity: 1 }] });
        const workspace = mcp.persistedWorkspaces().find(entry => entry['id'] === launched['workspace']);
        assert(workspace, 'MCP workspace was not persisted.');
        const configuration = object(object(array(workspace['configurations'])[0])['raw']);
        const locale = object(workspace['locale']);
        compare(`${controls.name}-locale`, browser.launchQuery,
          { country_or_region: locale['country'], language: locale['language'], currency: locale['currency'] });
        compare(`${controls.name}-outcome`, browser.outcome, outcome(configuration));
        compare(`${controls.name}-controls`,
          { guideMode: browser.guideMode, autoCorrect: browser.ui.autoCorrect,
            autoVariant: object(browser.request['customizingFlags'])['autoVariant'], autoCorrectDisabled: browser.ui.autoCorrectDisabled },
          { guideMode: applied['validationMode'] === 'guided', autoCorrect: applied['autoCorrect'],
            autoVariant: applied['autoCorrect'], autoCorrectDisabled: applied['validationMode'] === 'expert' });
      });
    }

    await step('expert-rejects-auto-correct', async () => {
      const launched = await mcp.call('dcsc_launch', { productCode: PRODUCT, mode: 'cto', solutionMode: 'General Purpose', label: 'expert rejection' });
      const rejected = await mcp.call('dcsc_configure', { session: launched['session'], validationMode: 'expert', autoCorrect: true },
        { expectError: true });
      compare('expert-auto-correct-rejected', true, /Auto-Correct cannot be enabled in Expert mode/.test(String(rejected['error'])));
    });
  },
} satisfies ParityCase;
