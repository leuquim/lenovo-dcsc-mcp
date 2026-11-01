/** Reference-solution catalog paging and Customize, optionally followed by the unconfigured-software edit. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildExportGroups } from '../../src/domain/exportGroups.js';
import type { RawConfiguration } from '../../src/model/types.js';
import { captureUnconfiguredEdit } from '../lib/unconfiguredBrowser.js';
import { normalizers, type Harness, type Json } from './harness.js';

const CATEGORY_ID = '57d87668ec5695ab80433cf8866bf525';
const CRN_ID = 'SID0000978';
const UNCONFIGURED_SECTION = 'UNCONFIGURED_COMMVAULT_SOFTWARE';
const UNCONFIGURED_CODE = '7S1M004HWW';
const EDITED_QUANTITY = 4;
const PERSISTED_KEYS = ['configurations', 'rackArea', 'nonRackArea', 'serverState', 'revision'];

const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const cents = (value: number) => Math.round(value * 100) / 100;
const lines = (groups: Json[]) => groups.flatMap(group => rows(group['products']))
  .map(product => ({ code: product['code'], type: product['type'], quantity: product['quantity'],
    price: product['price'], unitPrice: product['unitPrice'] }));

export async function runReferenceSolutionCase(h: Harness, options: { editUnconfigured: boolean }): Promise<void> {
  const { mcp, web, step, compare, out } = h;
  const saved = (id: string) => {
    const workspace = mcp.persistedWorkspaces().find(entry => entry['id'] === id);
    assert(workspace, `Workspace ${id} was not persisted.`);
    return workspace;
  };

  await step('catalog', async () => {
    let page = await mcp.call('dcsc_reference_solutions', { view: 'categories', limit: 15 });
    let seen = rows(page['entries']).length;
    const total = Number(page['total']);
    while (page['next']) {
      page = await mcp.call('dcsc_reference_solutions', object(object(page['next'])['arguments']));
      seen += rows(page['entries']).length;
    }
    compare('category-paging-total', total, seen);
    const listed = await mcp.call('dcsc_reference_solutions', { view: 'solutions', categoryId: CATEGORY_ID, limit: 1 });
    compare('first-solution', CRN_ID, rows(listed['entries'])[0]?.['crnId']);
    await mcp.call('dcsc_reference_solutions', { view: 'solutions', categoryId: CATEGORY_ID,
      offset: 1, expectedCatalogFingerprint: 'stale' }, { expectError: true });
    await mcp.call('dcsc_reference_solutions', { view: 'validation', crnId: CRN_ID });
  });

  const native = await step('native-customize', async () => {
    const page = await web.newPage();
    await page.goto(`https://dcsc.lenovo.com/#/reference-solution/categories/${CATEGORY_ID}/solutions`, { waitUntil: 'domcontentloaded' });
    const button = page.locator(`#${CRN_ID}`).getByRole('button', { name: 'Customize', exact: true });
    await button.waitFor({ timeout: 60_000 });
    const pending = page.waitForResponse(response =>
      response.url().includes(`/reference_solution/CRNs/${CRN_ID}/customize`), { timeout: 180_000 });
    await button.evaluate(element => (element as HTMLElement).click());
    const response = await pending;
    assert.equal(response.status(), 200);
    const body = object(await response.json());
    await writeFile(path.join(out, 'native-customize.json'), JSON.stringify(body, null, 2));
    let editedGroups: Json[] | undefined;
    if (options.editUnconfigured) {
      const raw = rows(body['configuration'])[0]!;
      const feature = rows(raw['tabs']).flatMap(tab => rows(tab['subTabs'])).flatMap(tab => rows(tab['sections']))
        .find(section => section['name'] === UNCONFIGURED_SECTION);
      const unitPrice = rows(feature?.['features']).find(entry => entry['code'] === UNCONFIGURED_CODE)?.['unitPrice'];
      assert.equal(typeof unitPrice, 'number');
      editedGroups = await captureUnconfiguredEdit(page, out,
        cents(Number(raw['totalPrice']) - EDITED_QUANTITY * Number(unitPrice)));
      return { body, unitPrice: Number(unitPrice), editedGroups };
    }
    return { body, unitPrice: 0, editedGroups };
  });

  const id = await step('mcp-customize', async () => {
    const launched = await mcp.call('dcsc_launch', { mode: 'reference-solution', sid: CRN_ID, solutionMode: 'General Purpose' });
    const id = String(launched['session']);
    const workspace = saved(id);
    assert.equal(object(workspace['serverState'])['crnId'], CRN_ID);
    compare('customize-selections', normalizers.configurations(native.body['configuration']),
      normalizers.configurations(rows(workspace['configurations']).map(entry => entry['raw'])));
    return id;
  });

  let before = saved(id);
  if (options.editUnconfigured) {
    await step('unconfigured-edit', async () => {
      const session = String(rows(before['configurations'])[0]!['id']);
      const loaded = await mcp.call('dcsc_launch', { mode: 'unconfigured', session, expectedRevision: before['revision'] });
      const changes = [{ section: UNCONFIGURED_SECTION, code: UNCONFIGURED_CODE, quantity: EDITED_QUANTITY }];
      await mcp.call('dcsc_configure', { session, changes, expectedRevision: loaded['revision'] });
      await mcp.call('dcsc_configure', { session, changes, expectedRevision: loaded['revision'] }, { expectError: true });
      before = saved(id);
      const expected = normalizers.configurations(native.body['configuration']).map(entry => ({
        ...entry,
        totalPrice: cents(Number(entry.totalPrice) - EDITED_QUANTITY * native.unitPrice),
        selections: entry.selections.map(selection =>
          selection.section === UNCONFIGURED_SECTION && selection.code === UNCONFIGURED_CODE
            ? { ...selection, quantity: EDITED_QUANTITY } : selection),
      }));
      const configurations = rows(before['configurations']).map(entry => entry['raw']);
      compare('edited-selections', expected, normalizers.configurations(configurations));
      assert(native.editedGroups);
      const raw = object(configurations[0]) as RawConfiguration;
      compare('edited-export-lines', lines(native.editedGroups), lines(buildExportGroups(raw, String(raw.id)) as unknown as Json[]));
    });
  }

  await step('crash-restart', async () => {
    await mcp.killAndRestart();
    await mcp.call('dcsc_workspace_get', { session: id, expectedRevision: before['revision'] });
    const after = saved(id);
    compare('restart-persisted-state', Object.fromEntries(PERSISTED_KEYS.map(key => [key, before[key]])),
      Object.fromEntries(PERSISTED_KEYS.map(key => [key, after[key]])));
  });

  await step('reimport', async () => {
    const exported = await mcp.call('dcsc_export', { kind: 'reports', session: id, fileName: CRN_ID, fileTypes: ['XML', 'QUOTE'] });
    const body = await web.importCfxml(String(exported['xml']), 'reexport');
    const expected = options.editUnconfigured
      ? normalizers.configurations(rows(before['configurations']).map(entry => entry['raw']))
      : normalizers.configurations(native.body['configuration']);
    compare('browser-reimport-selections', expected, normalizers.configurations(body['configuration']));
  });
}
