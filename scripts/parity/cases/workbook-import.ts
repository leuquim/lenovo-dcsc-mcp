/** Excel workbook import: MCP import against the native import of the same workbook, restart and XML handoff. */
import assert from 'node:assert/strict';
import path from 'node:path';

import { normalizers, type Json, type ParityCase } from '../harness.js';

const SEED = path.resolve('test/fixtures/parity/xml/sr630-v3-qty4.xml');
const WORKBOOK_TYPES = ['XML', 'QUOTE', 'QUOTE_GROUP', 'SUMMARY', 'POWER_REPORT', 'MESSAGE_HISTORY', 'FLOOR', 'RACK_REPORT', 'RACK_DIAGRAM', 'P2P_REPORT'];
const PERSISTED_KEYS = ['configurations', 'rackArea', 'nonRackArea', 'serverState', 'revision'];
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];

export default {
  id: 'workbook-import',
  tags: ['import', 'export'],
  async run(h) {
    const { mcp, web, step, compare } = h;
    const saved = (id: string) => {
      const workspace = mcp.persistedWorkspaces().find(entry => entry['id'] === id);
      assert(workspace, `Workspace ${id} was not persisted.`);
      return workspace;
    };
    const rawsOf = (workspace: Json) => rows(workspace['configurations']).map(entry => entry['raw']);

    const { original, workbook } = await step('seed-and-export', async () => {
      const seed = await mcp.call('dcsc_import', { filePath: SEED, solutionMode: 'General Purpose' });
      const original = saved(String(seed['session']));
      const exported = await mcp.call('dcsc_export', { kind: 'reports', session: seed['session'],
        fileName: 'workbook-source', fileTypes: WORKBOOK_TYPES });
      const workbook = (exported['workbooks'] as string[])[0];
      assert(workbook, 'Export did not return a workbook');
      return { original, workbook };
    });

    const native = await step('native-workbook', () => web.importCfxml(workbook, 'workbook'));
    compare('native-matches-exported-products', normalizers.products(rawsOf(original)), normalizers.importedProducts(native));

    const { id, before } = await step('workbook-import', async () => {
      const imported = await mcp.call('dcsc_import', { filePath: workbook, solutionMode: 'General Purpose' });
      const id = String(imported['session']);
      const before = saved(id);
      compare('import-products', normalizers.importedProducts(native), normalizers.products(rawsOf(before)));
      compare('import-layout-counts', { rack: rows(original['rackArea']).length, loose: rows(original['nonRackArea']).length },
        { rack: rows(before['rackArea']).length, loose: rows(before['nonRackArea']).length });
      return { id, before };
    });

    await step('crash-restart', async () => {
      await mcp.killAndRestart();
      await mcp.call('dcsc_workspace_get', { session: id });
      const after = saved(id);
      compare('restart-persisted-state', Object.fromEntries(PERSISTED_KEYS.map(key => [key, before[key]])),
        Object.fromEntries(PERSISTED_KEYS.map(key => [key, after[key]])));
    });

    await step('xml-handoff', async () => {
      const reexported = await mcp.call('dcsc_export', { kind: 'reports', session: id,
        fileName: 'workbook-roundtrip', fileTypes: ['XML', 'QUOTE', 'RACK_REPORT'] });
      const nativeXml = await web.importCfxml(String(reexported['xml']), 'reexported-xml');
      compare('xml-handoff-products', normalizers.importedProducts(native), normalizers.importedProducts(nativeXml));
      compare('xml-handoff-rack-count', rows(before['rackArea']).length, rows(object(nativeXml['workspace'])['rackArea']).length);
    });
  },
} satisfies ParityCase;
