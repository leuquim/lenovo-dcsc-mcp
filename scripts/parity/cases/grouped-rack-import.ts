/** Reference solution Customize on the website versus dcsc_launch: grouped racks, persistence, and the browser handoff of the export. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertGroupedCommercialParity } from '../../lib/groupedRackParity.js';
import { assertNativeFloorHandoff } from '../../lib/xconfigParity.js';
import type { Json, ParityCase } from '../harness.js';

const CATEGORY_ID = '5dd22135ca5b4482bea9d764089ca99d';
const CRN_ID = 'SID0001325';
const EXPECTED_RACKED_ITEMS = 29;
const EXPECTED_CONFIGURATIONS = 31;
const EXPECTED_NON_RACK_ITEMS = 1;
const NAVIGATION_TIMEOUT_MS = 120_000;
const CUSTOMIZE_TIMEOUT_MS = 180_000;

const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const byJson = (left: Json, right: Json) => JSON.stringify(left).localeCompare(JSON.stringify(right));

export default {
  id: 'grouped-rack-import',
  tags: ['rack', 'import', 'reference-solution'],
  async run(h) {
    const { mcp, step, compare } = h;

    const native = await step('website-customize', async () => {
      const page = await h.web.newPage();
      await page.goto(`https://dcsc.lenovo.com/#/reference-solution/categories/${CATEGORY_ID}/solutions`, { waitUntil: 'domcontentloaded' });
      const button = page.locator(`#${CRN_ID}`).getByRole('button', { name: 'Customize', exact: true });
      await button.waitFor({ timeout: 60_000 });
      const pending = page.waitForResponse(response => response.url().includes(`/reference_solution/CRNs/${CRN_ID}/customize`),
        { timeout: CUSTOMIZE_TIMEOUT_MS });
      await button.evaluate(element => (element as HTMLElement).click());
      const response = await pending;
      assert.equal(response.status(), 200);
      const body = object(await response.json());
      await writeFile(path.join(h.out, 'native-customize.json'), JSON.stringify(body, null, 2));
      await page.waitForURL(/rack-summary/, { timeout: NAVIGATION_TIMEOUT_MS });
      return body;
    });

    const codes = new Map(rows(native['configuration']).map(entry => [entry['id'], entry['code']]));
    const expected = rows(object(native['floorInformation'])['floorGrid']).filter(cell => cell['type'] === 'rack')
      .flatMap(rack => rows(rack['items']).map(item => ({ rack: codes.get(rack['id']), code: item['code'], position: item['position'], size: item['size'] })));

    const { workspace, saved } = await step('mcp-launch', async () => {
      const launched = await mcp.call('dcsc_launch', { mode: 'reference-solution', sid: CRN_ID, solutionMode: 'General Purpose' });
      const workspace = String(launched['session']);
      return { workspace, saved: mcp.persistedWorkspaces().find(entry => entry['id'] === workspace)! };
    });
    const actual = rows(saved['rackArea']).flatMap(rack => rows(rack['rackItems'])
      .map(item => ({ rack: rack['code'], code: item['code'], position: item['position'], size: item['size'] })));
    compare('racked-items', expected.sort(byJson), actual.sort(byJson));
    compare('shape', { racked: EXPECTED_RACKED_ITEMS, configurations: EXPECTED_CONFIGURATIONS, nonRack: EXPECTED_NON_RACK_ITEMS },
      { racked: actual.length, configurations: rows(saved['configurations']).length, nonRack: rows(saved['nonRackArea']).length });
    assertGroupedCommercialParity(native, saved);

    await step('restart', async () => {
      await mcp.killAndRestart();
      const info = await mcp.call('dcsc_workspace_get', { session: workspace });
      compare('restored-workspace-is-exportable', { damaged: false }, { damaged: info['integrity'] === 'damaged' });
      const after = mcp.persistedWorkspaces().find(entry => entry['id'] === workspace)!;
      for (const key of ['configurations', 'rackArea', 'nonRackArea', 'serverState', 'revision']) {
        compare(`restart-keeps-${key}`, saved[key], after[key]);
      }
    });

    await step('browser-reimport', async () => {
      const exported = await mcp.call('dcsc_export', { kind: 'reports', session: workspace, fileName: CRN_ID, fileTypes: ['XML', 'QUOTE'] });
      const body = await h.web.importCfxml(String(exported['xml']), 'mcp-export');
      assertNativeFloorHandoff(body, saved);
      assertGroupedCommercialParity(body, saved);
    });
  },
} satisfies ParityCase;
