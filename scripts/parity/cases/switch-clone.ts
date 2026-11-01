/** Native HPC switch Clone Multiple: capacity, linked ownership, history, crash recovery and the browser handoff of the export. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assertNativeConnectionsRetained } from '../../../src/domain/nativeManualCabling.js';
import { assertGroupedCommercialParity } from '../../lib/groupedRackParity.js';
import { selectBrowserSolutionMode } from '../browser.js';
import type { Harness, Json, ParityCase } from '../harness.js';

const FIXTURE = path.resolve('test/fixtures/parity/xml/manual-cabling-shared-network.xml');
const HPC_MODE = 'HPC and AI - Systems';
const HPC_MODE_LABEL = 'AI & HPC – ThinkSystem Hardware';
const SWITCH_CODE = '7D5FCTOFWW';
const NEXT_FREE_U = 7;
const CABLE_SECTION = 'ETHERNET_CABLE';
const CABLE_CODE = '3791';
const CABLE_QUANTITY = 2;
const IMPORT_TIMEOUT_MS = 120_000;

const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const physical = (racks: unknown) => rows(racks).flatMap(rack => rows(rack['rackItems']).map(item => ({
  rack: rack['id'], id: item['id'], code: item['code'], position: item['position'], size: item['size'],
}))).sort((left, right) => String(left.id).localeCompare(String(right.id)));

export async function runSwitchClone(h: Harness, edit: boolean): Promise<void> {
  const { mcp, step, compare } = h;
  const saved = () => mcp.persistedWorkspaces()[0]!;

  const { id, target, before } = await step('import', async () => {
    const imported = await mcp.call('dcsc_import', { filePath: FIXTURE, solutionMode: HPC_MODE });
    const before = saved();
    const target = rows(before['configurations']).find(entry => object(entry['raw'])['code'] === SWITCH_CODE);
    assert(target, 'The imported workspace has no HPC switch.');
    return { id: String(imported['session']), target, before };
  });

  const { cloneId, accepted, placed } = await step('clone', async () => {
    const cloned = await mcp.call('dcsc_rack_edit', { action: 'clone', session: target['id'], count: 1, placement: 'same-rack',
      expectedRevision: before['revision'] });
    const cloneId = String(rows(cloned['created'])[0]!['configurationId']);
    const accepted = saved();
    const placed = physical(accepted['rackArea']);
    compare('clone-uses-next-free-u', NEXT_FREE_U, rows(cloned['placements'])[0]!['position']);
    compare('clone-adds-one-configuration', rows(before['configurations']).length + 1, rows(accepted['configurations']).length);
    compare('clone-linked-ownership', [target['configurationId'], cloneId],
      object(object(accepted['serverState'])['cloneDependency'])[String(target['configurationId'])]);
    compare('clone-adds-one-physical-item', physical(before['rackArea']).length + 1, placed.length);
    return { cloneId, accepted, placed };
  });

  await step('history', async () => {
    await mcp.call('dcsc_undo', { session: id, action: 'undo', expectedRevision: accepted['revision'] });
    compare('undo-restores-layout', physical(before['rackArea']), physical(saved()['rackArea']));
    await mcp.call('dcsc_undo', { session: id, action: 'redo', expectedRevision: saved()['revision'] });
    compare('redo-restores-layout', placed, physical(saved()['rackArea']));
  });

  if (edit) {
    await step('linked-switch-edit', async () => {
      const clone = rows(saved()['configurations']).find(entry => entry['configurationId'] === cloneId)!;
      await mcp.call('dcsc_configure', { session: clone['id'], changes: [{ section: CABLE_SECTION, code: CABLE_CODE, quantity: CABLE_QUANTITY }] });
      const linkedQuantities = () => rows(saved()['configurations'])
        .filter(entry => [target['configurationId'], cloneId].includes(String(entry['configurationId'])))
        .map(entry => rows(object(entry['raw'])['tabs']).flatMap(tab => rows(tab['subTabs'])).flatMap(subTab => rows(subTab['sections']))
          .filter(section => section['name'] === CABLE_SECTION).flatMap(section => rows(section['results']))
          .find(result => result['code'] === CABLE_CODE)?.['quantity']);
      compare('linked-edit-reaches-both', [CABLE_QUANTITY, CABLE_QUANTITY], linkedQuantities());
      await mcp.call('dcsc_auto_connect', { session: id, settings: { autoAddSwitch: false, autoAddPDU: false } });
      compare('auto-connect-keeps-linked-edit', [CABLE_QUANTITY, CABLE_QUANTITY], linkedQuantities());
    });
  }

  const persisted = saved();
  await step('crash-restart', async () => {
    await mcp.killAndRestart();
    await mcp.call('dcsc_cabling_get', { session: id });
    compare('restart-keeps-persisted-state', persisted, saved());
  });

  const xml = await step('export', async () => {
    const exported = await mcp.call('dcsc_export', { kind: 'reports', session: id, fileName: 'hpc-switch-clone', fileTypes: ['XML', 'QUOTE'] });
    const file = String(exported['xml']);
    assert((await readFile(file)).length > 0, 'The exported XML is empty.');
    return file;
  });

  await step('browser-import', async () => {
    const page = await h.web.newPage();
    const layouts: Json[] = [];
    const pending: Promise<void>[] = [];
    page.on('response', response => {
      if (response.url().includes('/ctos/racks/customize?')) pending.push(response.json().then(value => { layouts.push(object(value)); }));
    });
    await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded' });
    await selectBrowserSolutionMode(page, HPC_MODE_LABEL, { diagnosticsDir: h.out });
    const response = page.waitForResponse(entry => entry.url().includes('/multiple/cfxml_import') && entry.request().method() === 'POST',
      { timeout: IMPORT_TIMEOUT_MS });
    await page.locator('input[type=file]').first().setInputFiles(xml);
    const payload: unknown = await (await response).json();
    const native = object(Array.isArray(payload) ? payload[0] : payload);
    assertGroupedCommercialParity(native, persisted);
    await page.waitForURL(/rack-summary/, { timeout: IMPORT_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: 60_000 });
    await Promise.all(pending);
    assert(layouts.length > 0, 'The browser made no layout request after the import.');
    const final = layouts.at(-1)!;
    const graph = rows(object(persisted['serverState'])['connections']);
    compare('browser-layout-matches-saved-racks', physical(persisted['rackArea']), physical(final['rackArea']));
    compare('browser-keeps-connection-count', graph.length, rows(final['connections']).length);
    assertNativeConnectionsRetained(graph, rows(final['connections']));
  });
}

export default {
  id: 'switch-clone',
  tags: ['rack', 'clone', 'hpc'],
  run: h => runSwitchClone(h, false),
} satisfies ParityCase;
