/** Offline gate: bounded workspace inspection over stdio, lossless continuations and stale-revision rejection. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { reduceConfiguration } from '../../../src/domain/reduce.js';
import type { RawConfiguration } from '../../../src/model/types.js';
import { serializeWorkspaces } from '../../../src/session/persist.js';
import { SessionStore } from '../../../src/session/SessionStore.js';
import { array, continuation, object, pages, readText, type Continuation } from '../continuations.js';
import type { ParityCase } from '../harness.js';

const CONFIGURATIONS = 80;
const CABLES = 240;
const LONG_REPEAT = 2_000;
const LONG_CONNECTION = 'transceiver-metadata-'.repeat(LONG_REPEAT);
const LONG_WARNING = 'integrity-warning-'.repeat(LONG_REPEAT);

function seed(sessionFile: string) {
  const store = new SessionStore(200);
  let workspaceId: string | undefined;
  let firstSession: string | undefined;
  for (let index = 0; index < CONFIGURATIONS; index += 1) {
    const configurationId = `US__projection-${index}`;
    const raw: RawConfiguration = {
      id: configurationId, code: `NODE-${index}`, sliceCtoCode: `NODE-${index}`, description: `Projection node ${index}`,
      type: 'SERVER', quantity: 1, totalPrice: 100 + index, tabs: [],
      selectedTopologies: { Management: {} }, selectedStorageNetwork: 'SAN',
    };
    const session = store.create({
      locale: { geo: 'NA', country: 'US', language: 'en', currency: 'USD' },
      solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
      mode: 'cto', raw, configurationId, reduced: reduceConfiguration(raw, configurationId),
      primed: true, configurable: false,
      ...(workspaceId ? { workspaceId } : {}),
    });
    workspaceId ??= session.workspaceId;
    firstSession ??= session.id;
  }
  assert(workspaceId && firstSession);
  const workspace = store.getWorkspace(workspaceId);
  assert(workspace);
  workspace.rackSummaries = [{
    id: 'rack-1', code: 'RACK-42U', description: 'Projection rack', sizeU: 42, usedU: 1, freeU: 41, stableStatus: 'PASSED',
    items: [{ id: 'US__projection-0', code: 'NODE-0', description: 'Projection node 0', position: 1, endPosition: 1, sizeU: 1 }],
    errors: [{ code: 'INFO', message: 'Retained layout message' }],
  }];
  workspace.cables = Array.from({ length: CABLES }, (_, index) => ({
    id: `cable-${index}`, fromConfigId: `US__projection-${index % CONFIGURATIONS}`, fromPort: `A${index}`,
    toConfigId: `US__projection-${(index + 1) % CONFIGURATIONS}`, toPort: `B${index}`, cableCode: 'DAC', description: `Cable ${index}`,
  }));
  workspace.serverState['connections'] = [{
    network: 'Management', source: { configurationId: 'US__projection-0', port: 'A1' },
    destination: { configurationId: 'switch-0', port: 'B1' }, cable: { code: 'DAC' }, transceiverDetails: LONG_CONNECTION,
  }];
  workspace.integrityWarnings = [LONG_WARNING, ...Array.from({ length: 99 }, (_, index) => `warning-${index}`)];
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, serializeWorkspaces(store.listWorkspaces()));
  return { workspace: workspaceId, firstSession };
}

export default {
  id: 'projections',
  tags: ['offline', 'workspace'],
  async run(h) {
    const { mcp, step, compare } = h;

    const seeded = await step('seed-and-restart', async () => {
      const seeded = seed(mcp.sessionFile);
      await mcp.killAndRestart();
      return seeded;
    });

    const summary = await step('summary', async () => {
      const summary = await mcp.call('dcsc_workspace_get', { session: seeded.workspace });
      const totals = object(summary['totals']);
      compare('summary-totals', { configurations: CONFIGURATIONS, cables: CABLES, rawConnections: 1 },
        { configurations: totals['configurations'], cables: totals['cables'], rawConnections: totals['rawConnections'] });
      return summary;
    });
    const link = (name: string) => continuation(object(object(summary['pages'])[name])['inspect']);

    await step('cabling-diagnostics', async () => {
      const diagnostics = await mcp.call(link('cablingDiagnostics').tool, link('cablingDiagnostics').arguments);
      const items = array(diagnostics['items']).map(object);
      const networkItem = object(items.find(item => item['key'] === 'networks'));
      const networks = networkItem['next']
        ? await mcp.call(continuation(networkItem['next']).tool, continuation(networkItem['next']).arguments)
        : networkItem['value'];
      compare('diagnostics-missing-networks', { requested: 1, san: true, noConnections: true }, {
        requested: items.find(item => item['key'] === 'requestedNetworksWithoutConnections')?.['value'],
        san: /SAN/.test(JSON.stringify(networks)), noConnections: /no_connections/.test(JSON.stringify(networks)),
      });
    });

    await step('configuration-pages', async () => {
      const keys: string[] = [];
      for await (const page of pages(mcp, link('configurations'))) keys.push(...array(page['items']).map(item => String(object(item)['key'])));
      compare('configuration-keys', Array.from({ length: CONFIGURATIONS }, (_, index) => String(index)), keys);
    });

    const rawCollection = link('rawConnections');
    await step('long-strings', async () => {
      const collection = await mcp.call(rawCollection.tool, rawCollection.arguments);
      const rawItem = continuation(object(array(collection['items'])[0])['next']);
      const item = await mcp.call(rawItem.tool, rawItem.arguments);
      const longField = object(array(item['items']).find(entry => object(entry)['key'] === 'transceiverDetails'));
      compare('long-connection-text', LONG_CONNECTION, await readText(mcp, continuation(longField['next'])));

      const warnings = await mcp.call(link('integrityWarnings').tool, link('integrityWarnings').arguments);
      const first: Continuation = continuation(object(array(warnings['items'])[0])['next']);
      compare('long-warning-text', LONG_WARNING, await readText(mcp, first));
    });

    await step('layout', async () => {
      const layout = await mcp.call('dcsc_workspace_get', { session: seeded.workspace, view: 'layout' });
      const rack = object(array(layout['racks'])[0]);
      compare('layout-rack', { items: 1, errors: 1 }, { items: array(rack['items']).length, errors: array(rack['errors']).length });
    });

    await step('stale-continuation', async () => {
      const info = await mcp.call('dcsc_workspace_get', { session: seeded.firstSession });
      await mcp.call('dcsc_configure', { session: seeded.firstSession, salesQuantity: 2, expectedRevision: info['revision'] });
      const stale = await mcp.call(rawCollection.tool, rawCollection.arguments, { expectError: true });
      compare('stale-continuation-rejected', true, /changed from revision/.test(JSON.stringify(stale)));
    });
  },
} satisfies ParityCase;
