/** Distributed main/leaf Management cabling: MCP preferences + Auto-Connect against the browser oracle and a fresh website import. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readJsonProjection } from '../../lib/read-json-projection.js';
import { HPC_MODE, connectionsByRole, enumerateNetwork, importedConfigurations, importedGraph, importedSwitchMap,
  object, persistedWorkspace, rows, text, websiteImport } from '../fabric.js';
import type { ParityCase } from '../harness.js';

const SOURCE_XML = path.resolve('test/fixtures/parity/xml/manual-cabling-shared-network.xml');
const ORACLE_PATH = path.resolve('test/fixtures/parity/network-leaf-auto-connect.json');
const CONFIGURATIONS_AFTER_LEAF = 6;
const byRole = (left: Record<string, unknown>, right: Record<string, unknown>) => text(left['type']).localeCompare(text(right['type']));

export default {
  id: 'network-leaf',
  tags: ['network', 'cabling', 'import', 'export'],
  async run(h) {
    const { mcp, step, compare } = h;
    const oracle = object(JSON.parse(await readFile(ORACLE_PATH, 'utf8')));
    const expectedConnections = rows(oracle['connections'])
      .sort((left, right) => text(left['sourceRole']).localeCompare(text(right['sourceRole'])));

    const workspace = await step('import-native-seed', async () => {
      const imported = await mcp.call('dcsc_import', { filePath: SOURCE_XML, solutionMode: HPC_MODE });
      assert(imported['session'], 'Import returned no workspace.');
      return String(imported['session']);
    });

    const connected = await step('preference-close-and-auto-connect', async () => {
      const fabric = (collection: string, limit: number) => enumerateNetwork(h, { session: workspace, collection, offset: 0, limit });
      const [networks, devices, cables, policies] = await Promise.all([
        fabric('networkTypes', 100), fabric('networkDevices', 100), fabric('cables', 100), fabric('leafNodeCabling', 20)]);
      const management = networks.find(item => item['name'] === 'Management');
      const bpc7 = devices.find(item => item['feature'] === 'BPC7' && item['option'] === '7D5FCTOFWW');
      const cat5e = cables.find(item => item['featureCode'] === '3791' && Array.isArray(item['compatibility']) && item['compatibility'].includes('7D5FCTOFWW'))
        ?? cables.find(item => item['featureCode'] === '3791');
      const balanced = policies.find(item => item['description'] === 'Balance Connections across leaf switches (best performance)');
      assert(management && bpc7 && cat5e && balanced, 'Current fabric lacks the captured Management/BPC7/Cat5E/leaf policy choices.');
      const changed = await mcp.call('dcsc_network_set', { session: workspace, expectedRevision: persistedWorkspace(h, workspace)['revision'],
        change: { kind: 'preferences', autoConnect: false, selections: [{ networkTypeId: management['id'], layout: 'Distributed',
          mainDeviceId: bpc7['id'], leafDeviceId: bpc7['id'], cableId: cat5e['id'], cableColor: '', leafCableColor: '',
          mainTrunks: 1, leafTrunks: 1, leafCabling: balanced['description'] }] } });
      assert.equal(changed['connectionGraphStale'], true);
      assert.equal(changed['autoConnectRequired'], true);
      const state = persistedWorkspace(h, workspace);
      assert.equal(rows(state['configurations']).length, CONFIGURATIONS_AFTER_LEAF, 'Preference Close must keep five imported configurations and add one leaf.');
      const preference = rows(object(state['serverState'])['clusterPreference']).find(item => item['name'] === 'Management');
      assert(preference, 'Accepted workspace lost its Management preference.');
      const picked = (value: unknown) => ({ feature: object(value)['feature'], option: object(value)['option'] });
      compare('leaf-preference-vs-browser-oracle', oracle['preference'], {
        name: preference['name'], networkType: preference['networkType'], networkLayout: preference['networkLayout'],
        mainSwitch: picked(preference['mainSwitch']), leafSwitch: picked(preference['leafSwitch']),
        trunks: preference['trunks'], leafTrunks: preference['leafTrunks'], leafCabling: preference['leafCabling'] });
      return mcp.call('dcsc_auto_connect', { session: workspace, expectedRevision: changed['revision'], settings: object(oracle['settings'])['final'] });
    });

    const { switches, graph } = await step('graph-vs-oracle', async () => {
      assert(connected['revision']);
      const serverState = object(persistedWorkspace(h, workspace)['serverState']);
      const switches = rows(serverState['switchMap']);
      const graph = rows(serverState['connections']);
      compare('leaf-switch-map-vs-browser-oracle', rows(oracle['switchMap']).sort(byRole),
        switches.map(({ id: _id, ...entry }) => entry).sort(byRole));
      compare('leaf-graph-vs-browser-oracle', expectedConnections, connectionsByRole(graph, switches));
      return { switches, graph };
    });

    await step('sigkill-restart', async () => {
      const accepted = mcp.persistedWorkspaces();
      await mcp.killAndRestart();
      compare('restart-retains-leaf-state', accepted, mcp.persistedWorkspaces());
      const layout = await mcp.call('dcsc_workspace_get', { view: 'layout', session: workspace });
      assert.equal(object(layout['totals'])['rawConnections'], expectedConnections.length);
      assert.notEqual(layout['connectionGraphStale'], true, 'Restarted workspace marked the accepted graph stale.');
      const inspect = object(object(object(layout['pages'])['rawConnections'])['inspect']);
      const projected = rows(await readJsonProjection((tool, args) => mcp.call(tool, args),
        { tool: text(inspect['tool']), arguments: object(inspect['arguments']) }, 'array'));
      compare('restart-projection-vs-persisted-graph', connectionsByRole(graph, switches), connectionsByRole(projected, switches));
    });

    await step('export-fresh-website-import', async () => {
      const exported = await mcp.call('dcsc_export', { kind: 'reports', session: workspace, fileName: 'network-leaf-parity', fileTypes: ['XML', 'QUOTE', 'FLOOR'] });
      const xmlPath = text(exported['xml']);
      assert((await readFile(xmlPath)).length > 0, 'Leaf export returned no XML.');
      const website = await websiteImport(h, xmlPath, 'leaf');
      compare('website-import-leaf-graph', connectionsByRole(graph, switches),
        connectionsByRole(importedGraph(website.payload), importedSwitchMap(website.payload)));
      compare('website-import-configuration-count', CONFIGURATIONS_AFTER_LEAF, importedConfigurations(website.payload).length);
    });
  },
} satisfies ParityCase;
