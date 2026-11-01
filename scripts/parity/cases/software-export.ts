/** Priced embedded CAL (three 50-user packs): browser-authored export archive against MCP configuration and workspace exports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Page } from 'playwright';

import { CAPTURE_EXPORT_FORMS, captureBrowserExport } from '../exportUi.js';
import { normalizers, type Json, type ParityCase } from '../harness.js';
import { visible } from '../settingsUi.js';
import { chooseAntOption, clickCheckbox, displayedTotal, openMicrosoftCal, softwareDeriveAfter, userCalPanel } from '../softwareUi.js';
import { DCSC_HOME } from '../web.js';

const PRODUCT = '7D73CTO1WW';
const COMPANION = 'SDH2';
const COMPANION_QUANTITY = 3;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const CHANGES = [
  { section: 'T1K2', code: 'T1K3', quantity: 1 },
  { section: 'T1K2/T1K3/CAL_50_2025', code: 'SDDZ', quantity: 1 },
  { section: 'T1K2', code: 'SDDZ', quantity: 3 },
];
const quantitiesForCode = (value: unknown, code: string): number[] => {
  if (Array.isArray(value)) return value.flatMap(item => quantitiesForCode(item, code));
  if (!value || typeof value !== 'object') return [];
  const item = value as Json;
  return (item['code'] === code && Number.isFinite(Number(item['quantity'])) ? [Number(item['quantity'])] : [])
    .concat(Object.values(item).flatMap(child => quantitiesForCode(child, code)));
};

async function configureBrowser(page: Page) {
  await page.goto(new URL(`#/configuration/cto/${PRODUCT}?hardwareType=server`, DCSC_HOME).href, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const cookie = page.locator('.dcsc-cookie-close').first();
  if (await cookie.isVisible({ timeout: 2_000 }).catch(() => false)) await cookie.click();
  await visible(page.getByText('Configuration Price', { exact: true }), 'Configuration Price');
  await (await visible(page.getByText('OS & Software', { exact: true }), 'OS & Software tab')).click();
  await openMicrosoftCal(page);
  await softwareDeriveAfter(page, () => clickCheckbox(page, 0, 'Windows Server 2025 User CAL'));
  const panel = await userCalPanel(page);
  await softwareDeriveAfter(page, () => chooseAntOption(page, panel.locator('.ant-select:visible').first(), 'Windows Server 2025 CAL (50 User)'));
  const { patch } = await softwareDeriveAfter(page, () => chooseAntOption(page, panel.locator('.ant-select:visible').last(), '3'));
  return { patch, total: await displayedTotal(page) };
}

export default {
  id: 'software-export',
  tags: ['software', 'export'],
  async run(h) {
    const { mcp, web, step, compare, out } = h;
    const page = await web.newPage();
    page.setDefaultTimeout(90_000);
    await page.addInitScript({ content: CAPTURE_EXPORT_FORMS });

    const browser = await step('browser-configure-and-export', async () => {
      const state = await configureBrowser(page);
      await (await visible(page.getByRole('button', { name: 'Summary' }), 'Summary button')).evaluate(element => (element as HTMLElement).click());
      await page.waitForURL(/rack-summary/, { waitUntil: 'commit', timeout: 60_000 });
      await page.waitForTimeout(2_000);
      const exported = await captureBrowserExport(page, out, 'browser-priced-cal-qty3');
      return { ...state, xml: exported.xml };
    });

    await step('mcp-configure-and-export', async () => {
      const launched = await mcp.call('dcsc_launch', { productCode: PRODUCT, mode: 'cto', solutionMode: 'General Purpose' });
      const session = String(launched['session']);
      await mcp.call('dcsc_configure', { session, changes: CHANGES });
      const workspace = mcp.persistedWorkspaces().find(entry => entry['id'] === launched['workspace']);
      assert(workspace, 'MCP workspace was not persisted.');
      const raw = object(object((workspace['configurations'] as unknown[])[0])['raw']);
      compare('total-before-export', browser.total.totalPrice, Math.round(Number(raw['totalPrice']) * 100) / 100);
      compare('companion-quantity', quantitiesForCode(browser.patch, COMPANION).includes(COMPANION_QUANTITY),
        quantitiesForCode(raw, COMPANION).includes(COMPANION_QUANTITY));

      const configuration = await mcp.call('dcsc_export', { kind: 'reports', session, scope: 'configuration', fileName: 'mcp-priced-cal-configuration', fileTypes: ['XML'] });
      const whole = await mcp.call('dcsc_export', { kind: 'reports', session: launched['workspace'], scope: 'workspace', fileName: 'mcp-priced-cal-workspace', fileTypes: ['XML'] });
      const expected = normalizers.cfxml(browser.xml);
      compare('configuration-xml-lines', expected, normalizers.cfxml(readFileSync(String(configuration['xml']), 'utf8')));
      compare('workspace-xml-lines', expected, normalizers.cfxml(readFileSync(String(whole['xml']), 'utf8')));
    });
  },
} satisfies ParityCase;
