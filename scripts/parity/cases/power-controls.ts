/** Power controls: Save, crash/restart, undo/redo, export/import and native browser import of the same CFXML. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { inspectPowerControls } from '../../../src/domain/powerControls.js';
import type { RawConfiguration } from '../../../src/model/types.js';
import type { Json, ParityCase } from '../harness.js';

const PRODUCT = '7D73CTO1WW';
const NATIVE_FIXTURE = path.resolve('test/fixtures/parity/xml/power-controls-native.xml');
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const values = (page: Json): Json => Object.fromEntries(rows(page['items']).map(item => [String(item['key']), item['value']]));

export default {
  id: 'power-controls',
  tags: ['power', 'import', 'export'],
  async run(h) {
    const { mcp, web, step, compare } = h;
    const currentControls = async (session: string) => values(await mcp.call('dcsc_power_controls', { session }))['current'];

    const { session, before, workspace, edited } = await step('set-controls', async () => {
      const launched = await mcp.call('dcsc_launch', { productCode: PRODUCT, solutionMode: 'General Purpose' });
      const session = String(launched['session']);
      assert(session && session !== 'undefined');
      const before = await mcp.call('dcsc_power_controls', { session });
      assert.equal(values(before)['available'], true);
      const edited = await mcp.call('dcsc_set_power_controls', { session, expectedRevision: before['workspaceRevision'],
        voltage: '230V@AC', loadFactor: 100, powerPolicy: 5 });
      compare('set-controls-applied', { voltage: '230V@AC', loadFactor: 100, powerPolicy: 5 }, edited['current']);
      return { session, before, workspace: String(before['workspace']), edited };
    });

    await step('crash-restart', async () => {
      const snapshot = JSON.parse(await readFile(mcp.sessionFile, 'utf8')) as unknown;
      await mcp.killAndRestart();
      const restarted = await mcp.call('dcsc_power_controls', { session });
      compare('restart-retains-controls', edited['current'], values(restarted)['current']);
      compare('restart-session-file-unchanged', snapshot, JSON.parse(await readFile(mcp.sessionFile, 'utf8')));
      await mcp.call('dcsc_set_power_controls', { session, expectedRevision: before['workspaceRevision'], loadFactor: 30 },
        { expectError: true });
      await mcp.call('dcsc_workspace_history', { session: workspace, action: 'undo', expectedRevision: restarted['workspaceRevision'] });
      compare('undo-restores-original', values(before)['current'], await currentControls(session));
      await mcp.call('dcsc_workspace_history', { session: workspace, action: 'redo' });
      compare('redo-restores-edit', edited['current'], await currentControls(session));
    });

    await step('subsequent-derive', async () => {
      await mcp.call('dcsc_configure', { session, changes: [{ section: 'UEFI_OPERATING_MODES', code: 'BFYE', quantity: 1 }] });
      compare('derive-retains-controls', edited['current'], await currentControls(session));
    });

    const xmlPath = await step('export', async () => {
      const exported = await mcp.call('dcsc_export', { session, fileName: 'power-controls', fileTypes: ['XML', 'POWER_REPORT'] });
      const xmlPath = String(exported['xml']);
      assert((await readFile(xmlPath, 'utf8')).includes('BK15'), 'Export lost 230V metadata');
      assert.match(String(exported['powerSettingsWarning']), /reset/);
      return xmlPath;
    });

    await step('import', async () => {
      const imported = await mcp.call('dcsc_import', { filePath: xmlPath });
      const importedSession = String(rows(imported['sessions'])[0]!['id']);
      const importedControls = await mcp.call('dcsc_power_controls', { session: importedSession });
      const mcpImported = values(importedControls)['current'];
      compare('import-resets-load-factor', { voltage: '230V@AC', loadFactor: 70, powerPolicy: 5 }, mcpImported);
      for (const [label, file] of [['mcp', xmlPath], ['native', NATIVE_FIXTURE]] as const) {
        const body = await web.importCfxml(file, label);
        const node = rows(body['configuration'] ?? body['configurations'])
          .find(item => item['code'] === PRODUCT || item['sliceCtoCode'] === PRODUCT);
        assert(node, 'Browser import returned no matching server');
        compare(`browser-import-${label}-xml`, inspectPowerControls(node as RawConfiguration).current, mcpImported);
      }
      const reapplied = await mcp.call('dcsc_set_power_controls', { session: importedSession,
        expectedRevision: importedControls['workspaceRevision'], loadFactor: 100 });
      compare('reapply-restores-load-factor', edited['current'], reapplied['current']);
    });
  },
} satisfies ParityCase;
