/** OS & Software edits inside a CTO: each browser UI action against the same MCP change, step by step. */
import assert from 'node:assert/strict';
import type { Page } from 'playwright';

import { serializeSections, type WireSection } from '../../../src/domain/dcscWire.js';
import { applyCatalogChange, reduceConfiguration } from '../../../src/domain/reduce.js';
import type { RawConfiguration, RawTab } from '../../../src/model/types.js';
import type { Json, ParityCase } from '../harness.js';
import { visible } from '../settingsUi.js';
import {
  chooseAntOption, clickCheckbox, clickVisible, displayedTotal, openMicrosoftCal, openSoftwareTab,
  softwareDeriveAfter, userCalPanel,
} from '../softwareUi.js';

const PRODUCT = '7D73CTO1WW';
const CLEAR_CHOICE = /^(?:none|please select|clear)$/i;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

interface Change { sectionName: string; code: string; quantity: number }
interface BrowserAction {
  name: string;
  change: Change;
  compareRequestDelta?: boolean;
  interact(page: Page): Promise<Json | void>;
}

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
      const scoped = heading.locator('xpath=ancestor::*[.//*[normalize-space(text())="Reset"]][1]').getByText('Reset', { exact: true });
      await clickVisible((await scoped.count()) > 0 ? scoped : page.getByText('Reset', { exact: true }), 'XClarity Reset');
    },
  },
  {
    name: 'multi-add-user',
    change: { sectionName: 'T1K2', code: 'T1K3', quantity: 1 },
    async interact(page) {
      await openMicrosoftCal(page);
      await clickCheckbox(page, 0, 'Windows Server 2025 User CAL');
    },
  },
  {
    name: 'filter-select-50-user-cal',
    change: { sectionName: 'T1K2/T1K3/CAL_50_2025', code: 'SDDZ', quantity: 1 },
    async interact(page) {
      const panel = await userCalPanel(page);
      await chooseAntOption(page, panel.locator('.ant-select:visible').nth(0), 'Windows Server 2025 CAL (50 User)');
    },
  },
  {
    name: 'filter-quantity-three',
    change: { sectionName: 'T1K2', code: 'SDDZ', quantity: 3 },
    async interact(page) {
      const panel = await userCalPanel(page);
      await chooseAntOption(page, panel.locator('.ant-select:visible').last(), '3');
    },
  },
  {
    name: 'multi-add-device',
    change: { sectionName: 'T1K2', code: 'T1K4', quantity: 1 },
    async interact(page) {
      await clickCheckbox(page, 1, 'Windows Server 2025 Device CAL');
    },
  },
  {
    name: 'filter-clear-via-group-reset',
    change: { sectionName: 'T1K2', code: 'T1K3', quantity: 0 },
    compareRequestDelta: false,
    async interact(page) {
      const panel = await userCalPanel(page);
      const filter = panel.locator('.ant-select:visible').first();
      await filter.click();
      const dropdown = await visible(page.locator('.ant-select-dropdown:visible'), '50 User CAL choices');
      const options = (await dropdown.locator('.ant-select-dropdown-menu-item').allInnerTexts()).map(value => value.trim()).filter(Boolean);
      await page.keyboard.press('Escape');
      const inlineClear = await filter.locator('.ant-select-selection__clear:visible').count();
      await clickVisible(panel.getByText('Reset', { exact: true }), 'User CAL Reset');
      return { clearChoice: options.some(value => CLEAR_CHOICE.test(value)), inlineClear };
    },
  },
  {
    name: 'multi-readd-user',
    change: { sectionName: 'T1K2', code: 'T1K3', quantity: 1 },
    async interact(page) {
      await clickCheckbox(page, 0, 'Windows Server 2025 User CAL re-add');
    },
  },
  {
    name: 'multi-remove-user',
    change: { sectionName: 'T1K2', code: 'T1K3', quantity: 0 },
    async interact(page) {
      await clickCheckbox(page, 0, 'Windows Server 2025 User CAL removal');
    },
  },
];

const softwareSections = (raw: RawConfiguration | Json): WireSection[] =>
  ('tabs' in raw ? serializeSections(raw as RawConfiguration) : array(raw['sections']).map(section => object(section) as WireSection));

const unrelatedSelections = (raw: RawConfiguration | Json) => softwareSections(raw).filter(section => section.type !== 'software')
  .map(section => ({
    name: section.name, type: String(section.type ?? ''),
    results: section.results.map(result => ({ code: result.code, quantity: result.quantity, type: String(result.type ?? section.type ?? '') }))
      .sort((left, right) => left.code.localeCompare(right.code) || left.quantity - right.quantity),
  })).sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));

export default {
  id: 'software-embedded',
  tags: ['software', 'configuration'],
  async run(h) {
    const { mcp, web, step, compare } = h;
    const page = await web.newPage();
    page.setDefaultTimeout(90_000);
    await step('open', () => openSoftwareTab(page, PRODUCT));

    const launched = await mcp.call('dcsc_launch', { productCode: PRODUCT, mode: 'cto', solutionMode: 'General Purpose' });
    const session = String(launched['session']);
    const savedRaw = () => {
      const workspace = mcp.persistedWorkspaces().find(entry => entry['id'] === launched['workspace']);
      assert(workspace, 'MCP workspace was not persisted.');
      return object(object(array(workspace['configurations'])[0])['raw']) as RawConfiguration;
    };
    const mcpUnrelated = unrelatedSelections(savedRaw());
    let browserUnrelated: ReturnType<typeof unrelatedSelections> | undefined;

    for (const action of ACTIONS) {
      await step(action.name, async () => {
        const captured: { evidence?: Json | void } = {};
        const { request, patch } = await softwareDeriveAfter(page, async () => { captured.evidence = await action.interact(page); });
        const configuration = object(array(request['configurations'])[0]);
        const before = savedRaw();
        if (action.compareRequestDelta !== false) {
          compare(`${action.name}-request-delta`, configuration['delta'],
            applyCatalogChange(reduceConfiguration(before, String(before.id)), before, action.change).delta);
        }
        const currentUnrelated = unrelatedSelections(configuration);
        browserUnrelated ??= currentUnrelated;
        compare(`${action.name}-browser-unrelated-unchanged`, browserUnrelated, currentUnrelated);
        if (captured.evidence) compare(`${action.name}-filter-clear-controls`, { clearChoice: false, inlineClear: 0 }, captured.evidence);

        await mcp.call('dcsc_configure', { session, changes: [{ section: action.change.sectionName, code: action.change.code, quantity: action.change.quantity }] });
        const after = savedRaw();
        const expectedSoftware = serializeSections({ tabs: array(patch['softwareTabs']) as RawTab[] } as RawConfiguration)
          .filter(section => section.type === 'software');
        compare(`${action.name}-software-sections`, expectedSoftware, serializeSections(after).filter(section => section.type === 'software'));
        compare(`${action.name}-mcp-unrelated-unchanged`, mcpUnrelated, unrelatedSelections(after));
        const shown = await displayedTotal(page, Math.round(Number(after.totalPrice) * 100) / 100);
        compare(`${action.name}-displayed-total`, { totalPrice: shown.totalPrice, currency: shown.currency },
          { totalPrice: Math.round(Number(after.totalPrice) * 100) / 100, currency: 'USD' });
      });
    }
  },
} satisfies ParityCase;
