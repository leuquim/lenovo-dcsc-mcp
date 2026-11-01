/** Automatic switch provisioning: the MCP design against the captured browser oracle, then the export re-imported by the website. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { HPC_MODE, enumerateNetwork, importedConfigurations, importedGraph, object, persistedWorkspace, rows, text, websiteImport, type Obj } from '../fabric.js';
import type { ParityCase } from '../harness.js';
import { normalizers } from '../normalizers.js';

const ORACLE_PATH = path.resolve('test/fixtures/parity/browser-auto-switch-cabling.json');
const SERVER_CODE = '7D73CTOHWW';
const RACK_CODE = '7D6DCTO1WW';
const SWITCH_CODE = '7D5FCTOFWW';
const MANAGEMENT_TOPOLOGY = '1GbE_Copper';
const SERVER_RACK_U = 1;
const MANUAL_SWITCH_U = 5;
const EXPECTED_CONFIGURATIONS = 4;
const CONNECTION_FIELDS = ['network', 'topology', 'sourcePart', 'sourcePortNumber', 'sourcePortName', 'destinationPart',
  'destinationPortNumber', 'destinationPortName', 'cablePart', 'cableOption', 'cableType', 'cablePrice', 'type', 'subType', 'category'] as const;
const pick = (row: Obj) => Object.fromEntries(CONNECTION_FIELDS.map(field => [field, row[field]]));

export default {
  id: 'network-switch',
  tags: ['network', 'cabling', 'import', 'export'],
  async run(h) {
    const { mcp, step, compare } = h;
    const oracle = object(JSON.parse(await readFile(ORACLE_PATH, 'utf8')));
    const oracleConnection = object(oracle['connection']);

    const design = await step('design', async () => {
      const launched = await mcp.call('dcsc_launch', { productCode: SERVER_CODE, solutionMode: HPC_MODE });
      const server = String(launched['session']);
      const workspace = String(launched['workspace']);
      const fabric = (collection: string, extra: Obj = {}) => enumerateNetwork(h, { session: workspace, collection, offset: 0, limit: 100, ...extra });
      const [networks, devices, cables] = await Promise.all([fabric('networkTypes'), fabric('networkDevices'), fabric('cables')]);
      const management = networks.find(item => item['name'] === 'Management');
      const mainDevice = devices.find(item => item['option'] === SWITCH_CODE && item['feature'] === 'BPC7'
        && Array.isArray(item['topologies']) && item['topologies'].includes(MANAGEMENT_TOPOLOGY));
      const cat5e = cables.find(item => text(item['category']).toUpperCase() === 'CAT5E' && Array.isArray(item['topologies'])
        && item['topologies'].includes(MANAGEMENT_TOPOLOGY) && Array.isArray(item['compatibility']) && item['compatibility'].includes(SWITCH_CODE));
      assert(management && mainDevice && cat5e, 'Current AI/HPC fabric lacks the Management network, SN2201/BPC7 switch or Cat5E cable.');
      const connectors = await enumerateNetwork(h, { session: server, collection: 'connectors', topology: MANAGEMENT_TOPOLOGY, offset: 0, limit: 100 });
      const managementPort = connectors.find(item => text(item['portNumber']) === '1' && /RJ45 mgmt/i.test(`${text(item['port'])} ${text(item['description'])}`));
      assert(managementPort, 'The SR630 V3 has no captured-compatible RJ45 management connector.');
      await mcp.call('dcsc_network_set', { session: server, change: { kind: 'topology', topology: MANAGEMENT_TOPOLOGY,
        networkName: 'Management', connectorIds: [managementPort['id']], autoConnect: false } });
      const rack = await mcp.call('dcsc_rack_add', { session: workspace, rackCode: RACK_CODE });
      const rackId = text(rows(rack['racks'])[0]?.['rackId']);
      assert(rackId, 'DCSC returned no rack after rack_add.');
      const manual = await mcp.call('dcsc_launch', { productCode: SWITCH_CODE, session: workspace, label: 'Manual SN2201', solutionMode: HPC_MODE });
      await mcp.call('dcsc_rack_edit', { session: workspace, action: 'place', configuration: server, rackId, uPosition: SERVER_RACK_U });
      await mcp.call('dcsc_rack_edit', { session: workspace, action: 'place', configuration: String(manual['session']), rackId, uPosition: MANUAL_SWITCH_U });
      await mcp.call('dcsc_network_set', { session: workspace, change: { kind: 'preferences', autoConnect: false, selections: [{
        networkTypeId: management['id'], topology: MANAGEMENT_TOPOLOGY, mainDeviceId: mainDevice['id'], cableId: cat5e['id'], cableColor: '' }] } });
      await mcp.call('dcsc_auto_connect', { session: workspace, settings: { autoAddPDU: false, autoAddSwitch: true, p2pCabling: true } });
      return { workspace, manualSwitchId: text(persistedConfigurationId(h, workspace, String(manual['session']))) };
    });

    const saved = await step('graph-vs-oracle', async () => {
      const workspace = persistedWorkspace(h, design.workspace);
      const configurations = rows(workspace['configurations']);
      assert.equal(configurations.length, EXPECTED_CONFIGURATIONS, 'Expected server, rack, manual switch and generated switch.');
      const switches = configurations.filter(item => object(item['product'])['code'] === SWITCH_CODE);
      assert.equal(switches.length, 2, 'Automatic orchestration must keep the manual switch and add a separate one.');
      const serverState = object(workspace['serverState']);
      const switchMap = rows(serverState['switchMap']);
      assert.equal(switchMap.length, 1, 'Expected exactly one generated Management switch mapping.');
      const generatedId = text(switchMap[0]!['id']);
      assert(generatedId && generatedId !== design.manualSwitchId, 'The generated switch must differ from the manual SN2201.');
      const graph = rows(serverState['connections']);
      assert.equal(graph.length, 1, 'Raw auto-connect graph must contain one link.');
      assert.equal(graph[0]!['destinationId'], generatedId);
      compare('auto-connect-link-vs-browser-oracle', pick(oracleConnection), pick(graph[0]!));
      return { workspace, generatedId, graph };
    });

    await step('export-fresh-website-import', async () => {
      const exported = await mcp.call('dcsc_export', { kind: 'reports', session: design.workspace, fileName: 'mcp-network-parity',
        fileTypes: ['XML', 'QUOTE', 'FLOOR', 'RACK_REPORT', 'RACK_DIAGRAM', 'QUOTE_GROUP', 'SUMMARY'] });
      const website = await websiteImport(h, text(exported['xml']), 'network-switch');
      const restored = importedConfigurations(website.payload);
      const own = rows(saved.workspace['configurations']).map(item => object(item['raw']));
      compare('website-import-configurations', normalizers.configurations(own), normalizers.configurations(restored));
      compare('website-import-configuration-ids', rows(saved.workspace['configurations']).map(item => text(item['configurationId'])).sort(),
        restored.map(item => text(item['id'])).sort());
      const items = rows(object(website.payload['workspace'])['rackArea'])
        .flatMap(rack => rows(rack['rackItems'] ?? rack['items'] ?? rack['children']));
      assert(items.some(item => text(item['id']) === saved.generatedId), 'Website import omitted the generated switch placement.');
      compare('website-import-port-graph', saved.graph.map(row => ({ cablePart: row['cablePart'], sourceId: row['sourceId'], destinationId: row['destinationId'] })),
        importedGraph(website.payload).map(row => ({ cablePart: row['cablePart'], sourceId: row['sourceId'], destinationId: row['destinationId'] })));
    });
  },
} satisfies ParityCase;

function persistedConfigurationId(h: Parameters<ParityCase['run']>[0], workspace: string, handle: string): string {
  const found = rows(persistedWorkspace(h, workspace)['configurations']).find(item => item['id'] === handle);
  assert(found, `Configuration ${handle} was not persisted.`);
  return text(found['configurationId']);
}
