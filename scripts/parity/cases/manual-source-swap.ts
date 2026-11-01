/** Atomic source-port swap on one component, compared with what the website restores from the exported XML. */
import assert from 'node:assert/strict';
import path from 'node:path';

import { assertNativeConnectionsRetained } from '../../../src/domain/nativeManualCabling.js';
import { groupedCommercial } from '../../lib/groupedRackParity.js';
import { HPC_MODE, HPC_MODE_LABEL, connectionIdentity, object, persistedGraph, persistedWorkspace, rows, websiteImport, type Obj } from '../fabric.js';
import type { ParityCase } from '../harness.js';

const SEED = path.resolve('test/fixtures/parity/xml/manual-cabling-source-swap.xml');
export default {
  id: 'manual-source-swap',
  tags: ['cabling', 'import', 'export'],
  async run(h) {
    const { mcp, step, compare } = h;
    const imported = await step('import', () => mcp.call('dcsc_import', { filePath: SEED, solutionMode: HPC_MODE }));
    const workspace = String(imported['session']);
    const saved = () => persistedWorkspace(h, workspace);
    const before = persistedGraph(h, workspace);
    const editedIndex = before.findIndex(row => row['topology'] === '100GbE_Copper' && row['sourcePortNumber'] === '1');
    assert(editedIndex >= 0, 'Seed has no 100GbE port-1 source row.');
    const edited = before[editedIndex]!;
    const other = before.find(row => row['sourceId'] === edited['sourceId'] && row['sourcePortName'] === edited['sourcePortName'] && row['sourcePortNumber'] === '2');
    assert(other, 'Seed has no port-2 row on the same source.');

    const expected = structuredClone(before);
    const swappedEdited = expected[editedIndex]!;
    const swappedOther = expected.find(row => row['sourceId'] === other['sourceId'] && row['sourcePortName'] === other['sourcePortName'] && row['sourcePortNumber'] === '2')!;
    for (const field of ['sourcePortName', 'sourcePortNumber', 'sourceLocation']) [swappedEdited[field], swappedOther[field]] = [swappedOther[field], swappedEdited[field]];
    swappedEdited['type'] = 'MANUAL';
    swappedOther['type'] = 'MANUAL';
    const check = (wanted: Obj[]) => {
      const actual = persistedGraph(h, workspace);
      assert.equal(actual.length, wanted.length);
      assertNativeConnectionsRetained(wanted, actual);
    };

    const swapArgs = await step('swap', async () => {
      const details = await mcp.call('dcsc_cabling_get', { session: workspace, expectedRevision: saved()['revision'], path: ['connections', String(editedIndex)], limit: 50 });
      const detail = Object.fromEntries(rows(details['items']).map(row => [String(row['key']), row['value']]));
      assert(detail['id']);
      const commercialBefore = rows(saved()['configurations']).map(configuration => configuration['raw']);
      const args = { session: workspace, expectedRevision: saved()['revision'],
        changes: [{ action: 'edit', connectionId: detail['id'], source: { configurationId: other['sourceId'], portName: other['sourcePortName'], portNumber: other['sourcePortNumber'] } }] };
      const changed = object(rows((await mcp.call('dcsc_cabling_set', args))['results'])[0]);
      assert.equal(rows(changed['swappedConnections']).length, 1);
      check(expected);
      compare('swap-keeps-commercial-selections', commercialBefore, rows(saved()['configurations']).map(configuration => configuration['raw']));
      return args;
    });

    await step('stale-history-restart', async () => {
      const persisted = JSON.stringify(mcp.persistedWorkspaces());
      await mcp.call('dcsc_cabling_set', swapArgs, { expectError: true });
      compare('stale-swap-leaves-persisted-state', JSON.parse(persisted), mcp.persistedWorkspaces());
      await mcp.call('dcsc_undo', { session: workspace, action: 'undo' });
      check(before);
      await mcp.call('dcsc_undo', { session: workspace, action: 'redo' });
      check(expected);
      const accepted = mcp.persistedWorkspaces();
      await mcp.killAndRestart();
      await mcp.call('dcsc_cabling_get', { session: workspace });
      compare('restart-retains-swap', accepted, mcp.persistedWorkspaces());
    });

    await step('export-reimport', async () => {
      const exported = await mcp.call('dcsc_export', { kind: 'reports', session: workspace, fileName: 'source-swap', fileTypes: ['XML', 'QUOTE'] });
      const xml = String(exported['xml']);
      const reimported = await mcp.call('dcsc_import', { filePath: xml, solutionMode: HPC_MODE });
      assertNativeConnectionsRetained(expected, persistedGraph(h, String(reimported['session'])));
      const website = await websiteImport(h, xml, 'mcp-export', { mode: HPC_MODE_LABEL, collectLayouts: true });
      const native = groupedCommercial(website.payload, saved());
      compare('website-commercial-rows', native.native, native.mcp);
      const layout = rows(website.layouts.at(-1)?.['connections']);
      assert(layout.length > 0, 'Website produced no restored layout.');
      compare('website-restores-swapped-ports', connectionIdentity(layout), connectionIdentity(persistedGraph(h, workspace)));
    });
  },
} satisfies ParityCase;
