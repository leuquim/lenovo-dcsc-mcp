/** Live MCP existing-row cable replacement, crash durability and export gate. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { assertNativeConnectionsRetained } from '../src/domain/nativeManualCabling.js';
import { assertGroupedCommercialParity } from './lib/groupedRackParity.js';
import { selectBrowserSolutionMode } from './parity/browser.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out');
  const cableIndex = process.argv.indexOf('--cable-part');
  const create = process.argv.includes('--create');
  const breakoutReplacement = process.argv.includes('--breakout-replace');
  const breakout = process.argv.includes('--breakout') || breakoutReplacement;
  const data100 = process.argv.includes('--100g') || breakout;
  const replacementStorage = process.argv.includes('--replace-storage');
  const mixedStorage = process.argv.includes('--mixed-storage') || replacementStorage;
  const sharedStorage = process.argv.includes('--shared-storage') || mixedStorage;
  const freshStorage = process.argv.includes('--fresh-storage') || sharedStorage;
  const storageCablePart = sharedStorage ? 'A1PH' : 'A3RG';
  const prepareStorage = process.argv.includes('--prepare-storage') || freshStorage;
  const managedDestination = process.argv.includes('--managed-destination');
  assert(!prepareStorage || managedDestination, '--prepare-storage requires --managed-destination.');
  const managedSource = process.argv.includes('--managed-source');
  assert(!managedSource || (create && !data100), '--managed-source requires Management creation.');
  assert(!managedDestination || (create && !data100 && !managedSource), '--managed-destination requires standalone storage creation.');
  const linkedSource = process.argv.includes('--linked-source');
  const linkedDestination = process.argv.includes('--linked-destination');
  assert(!linkedDestination || (create && !data100), '--linked-destination currently uses Management creation.');
  assert(!breakout || (!linkedSource && !linkedDestination), 'Breakout gate uses direct endpoints.');
  assert(!linkedSource || data100, '--linked-source requires --100g.');
  assert(!data100 || create, '--100g requires --create.');
  const shared = process.argv.includes('--shared');
  const collision = process.argv.includes('--collision');
  assert([shared, collision, create].filter(Boolean).length <= 1, 'Use only one of --shared, --collision or --create.');
  const cablePart = cableIndex >= 0 ? process.argv[cableIndex + 1] : '3802';
  assert(cablePart === '3802' || cablePart === 'AVFU', 'Use --cable-part 3802 or AVFU for the captured native cases.');
  const out = path.resolve(outIndex >= 0 ? process.argv[outIndex + 1]! :
    `artifacts/parity-manual-cabling/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(out, { recursive: true });
  const configFile = path.join(out, 'config.json');
  const sessionFile = path.join(out, 'sessions.json');
  const seed = path.resolve(prepareStorage ? 'test/fixtures/parity/xml/manual-cabling-storage-optical.xml' : managedDestination ? 'test/fixtures/parity/xml/manual-cabling-managed-destination.xml' : managedSource ? 'test/fixtures/parity/xml/manual-cabling-managed-source.xml' : shared || collision || create
    ? 'test/fixtures/parity/xml/manual-cabling-shared-network.xml'
    : 'test/fixtures/parity/xml/manual-cabling-network.xml');
  await writeFile(configFile, JSON.stringify({ logLevel: 'error', files: {
    persistSessions: true, sessionFile, artifactDir: path.join(out, 'exports'),
  } }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !entry[0].startsWith('DCSC_')));
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let stage = 'start'; let sequence = 0;
  const calls: Obj[] = [];
  let freshControllerId: string | undefined;
  let freshPhysicalId: string | undefined;
  let secondStoragePhysicalId: string | undefined;
  const start = async () => {
    transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/server.ts'], stderr: 'pipe',
      env: { ...env, DCSC_CONFIG: configFile } });
    client = new Client({ name: 'manual-cabling-parity', version: '1.0.0' });
    await client.connect(transport);
    const listed = await client.listTools();
    for (const name of ['dcsc_cabling_connections', 'dcsc_edit_cabling_connection', 'dcsc_export']) {
      assert(listed.tools.some(tool => tool.name === name), `${name} is not registered.`);
    }
  };
  const call = async (name: string, args: Obj): Promise<Obj> => {
    const response = await client!.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
    const text = (response.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text')?.text ?? '';
    const result = object(JSON.parse(text));
    const entry = { name, arguments: args, isError: response.isError === true,
      bytes: Buffer.byteLength(text), result };
    calls.push(entry);
    await writeFile(path.join(out, `${String(++sequence).padStart(3, '0')}-${name}.json`),
      JSON.stringify(entry, null, 2));
    assert.notEqual(response.isError, true, `${name}: ${text}`);
    assert(Buffer.byteLength(text) <= 8_000, `${name} exceeded the tool response budget.`);
    return result;
  };
  const detail = async (workspace: string, revision: number, index = 0): Promise<Obj> => {
    const page = await call('dcsc_cabling_connections', { session: workspace,
      expectedWorkspaceRevision: revision, path: ['connections', String(index)], offset: 0, limit: 50 });
    return Object.fromEntries(rows(page['items']).filter(item => 'value' in item)
      .map(item => [String(item['key']), item['value']]));
  };
  const findCableChoice = async (args: Obj, part: string): Promise<Obj> => {
    let request = { ...args, path: ['choices'], offset: 0, limit: 50 } as Obj;
    for (let page = 0; page < 100; page++) {
      const result = await call('dcsc_manual_cabling_options', request);
      if (rows(result['items']).some(item => object(item['value'])['part'] === part)) return result;
      const next = object(result['next']);
      assert.equal(next['tool'], 'dcsc_manual_cabling_options', `Expected cable ${part} is unavailable.`);
      request = object(next['arguments']);
    }
    throw new Error('Cable-choice pagination did not terminate.');
  };
  const snapshot = async (): Promise<Obj> => object(JSON.parse(await readFile(sessionFile, 'utf8')));
  try {
    await start();
    stage = 'import';
    const imported = await call('dcsc_import', { filePath: seed, solutionMode: 'HPC and AI - Systems' });
    const workspace = String(imported['workspace']);
    assert(workspace, 'Import returned no workspace.');
    if (freshStorage) {
      stage = 'fresh-storage-definition';
      const catalog = await call('dcsc_fabric_options', { session: workspace, collection: 'storageControllers',
        limit: 100, fields: ['option', 'featureCode'] });
      const choice = rows(catalog['items']).find(item => item['option'] === '7Y70CTOHWW' && !item['featureCode']);
      assert(choice?.['id'], 'Native DE2000H base controller choice is unavailable.');
      await call('dcsc_add_storage_network', { session: workspace, name: 'Fresh Manual Storage',
        controllerId: choice['id'], switchId: 'direct-attached', expansionQuantity: 0 });
      const opened = await call('dcsc_customize_storage_controller', { session: workspace, name: 'Fresh Manual Storage' });
      assert.equal(opened['created'], true);
      assert.equal(typeof opened['controllerId'], 'string');
      freshControllerId = String(opened['controllerId']);
      assert(freshControllerId);
    }
    if (prepareStorage) {
      stage = 'storage-hardware-preparation';
      const initial = rows((await snapshot())['workspaces'])[0]!;
      const controller = rows(initial['configurations']).find(c => freshStorage ? c['configurationId'] === freshControllerId : object(c['raw'])['code'] === '7Y70CTOHWW')!;
      assert(controller);
      const initialSections = rows(object(controller['raw'])['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']));
      const initialSelections = initialSections.flatMap(s => rows(s['results']));
      if (!freshStorage) assert.equal(initialSelections.find(r => r['code'] === 'B4B2')?.['quantity'], 8);
      assert(!initialSelections.some(r => r['code'] === storageCablePart && Number(r['quantity']) > 0));
      // An explicit user hardware choice, never an automatic side effect of cable creation.
      await call('dcsc_configure', { session: controller['id'], changes: [
        ...(freshStorage ? [
          { section: 'NETWORK_ADAPTER', code: 'B4B7', quantity: 2 },
          { section: 'NETWORK_ADAPTER_CFC', code: 'B4DC', quantity: 1 },
        ] : []),
        { section: 'MECH_TRANSCEIVER', code: 'B4B2', quantity: 0 },
        { section: 'DAC_SFP_CABLE', code: storageCablePart, quantity: 2 },
        ...(mixedStorage ? [{ section: 'DAC_SFP_CABLE', code: 'A1PJ', quantity: 2 }] : []),
      ] });
      const prepared = rows((await snapshot())['workspaces'])[0]!;
      const current = rows(prepared['configurations']).find(c => c['id'] === controller['id'])!;
      const sections = rows(object(current['raw'])['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']));
      assert.deepEqual(sections.flatMap(s => rows(s['errors'])), []);
      const selected = sections.flatMap(s => rows(s['results']));
      assert.equal(selected.find(r => r['code'] === storageCablePart)?.['quantity'], 2);
      assert(!selected.some(r => r['code'] === 'B4B2' && Number(r['quantity']) > 0));
    }
    if (freshStorage) {
      stage = 'fresh-storage-placement';
      const initial = rows((await snapshot())['workspaces'])[0]!;
      const rackId = rows(initial['rackArea'])[0]?.['id'];
      assert(rackId);
      const placed = await call('dcsc_place_storage_network', { session: workspace,
        name: 'Fresh Manual Storage', rackId });
      const controller = rows(placed['placements']).find(p => p['role'] === 'controller');
      assert(controller);
      assert.equal(typeof controller['physicalId'], 'string');
      freshPhysicalId = String(controller['physicalId']);
      assert(freshPhysicalId && freshPhysicalId !== freshControllerId);
      if (sharedStorage) {
        const second = await call('dcsc_place_storage_network', { session: workspace,
          name: 'Fresh Manual Storage', rackId });
        assert(rows(second['templates']).every(t => t['created'] === false));
        const instance = rows(second['placements']).find(p => p['role'] === 'controller');
        assert.equal(instance?.['templateId'], freshControllerId);
        assert.equal(typeof instance?.['physicalId'], 'string');
        secondStoragePhysicalId = String(instance?.['physicalId']);
        assert(secondStoragePhysicalId !== freshPhysicalId && secondStoragePhysicalId !== freshControllerId);
      }
      const source = rows(initial['configurations']).find(c => object(c['raw'])['code'] === '7D73CTOHWW')!;
      await call('dcsc_assign_storage_network', { session: source['id'], networkName: 'Fresh Manual Storage', autoConnect: false });
    }
    if (managedDestination) {
      stage = 'storage-topology-setup';
      const initial = rows((await snapshot())['workspaces'])[0]!;
      const source = rows(initial['configurations']).find(c => object(c['raw'])['code'] === '7D73CTOHWW')!;
      assert(source);
      assert.deepEqual(object(source['raw'])['selectedTopologies'] ?? {}, {});
      await call('dcsc_set_topology', { session: source['id'], topology: '10GbE_Copper',
        networkName: object(source['raw'])['selectedStorageNetwork'], ports: ['SFP28:1'], autoConnect: false });
    }
    if (linkedDestination) {
      const initial = rows((await snapshot())['workspaces'])[0]!;
      const example = object(object(JSON.parse(await readFile('test/fixtures/parity/manual-row-seeding.json', 'utf8')))['requestedManualRow']);
      const destination = rows(initial['configurations']).find(c => c['configurationId'] === example['destinationId'])!;
      assert(destination);
      await call('dcsc_clone_configuration', { session: destination['id'], count: 1, placement: 'same-rack' });
    }
    if (data100) {
      stage = '100g-setup';
      const initial = rows((await snapshot())['workspaces'])[0]!;
      const source = rows(initial['configurations']).find(c => object(c['raw'])['code'] === '7D73CTOHWW')!;
      assert(source);
      await call('dcsc_configure', { session: source['id'], changes: [{ section: 'OCPCARD', code: breakout ? 'BPPW' : 'BPPX', quantity: 1 }] });
      await call('dcsc_set_network_preferences', { session: workspace, autoConnect: false, selections: [{
        networkTypeId: 'network-type:10G', topology: '100GbE_Copper',
        mainDeviceId: 'network-device:7D5FCTOKWW:BUZ2:NVIDIA SN3420 25GbE Managed Switch with Cumulus (PSE)',
        ...(breakout ? { cableId: 'cable:AV22:7Z57A03564:1jt0u82' } : {}),
      }] });
      await call('dcsc_set_topology', { session: source['id'], topology: '100GbE_Copper', networkName: '10G', ports: [breakout ? 'SFP28:1' : 'QSFP56:1'], autoConnect: false });
      if (linkedSource) await call('dcsc_clone_configuration', { session: source['id'], count: 1, placement: 'same-rack' });
      await call('dcsc_add_cabling', { session: workspace, mode: 'auto', settings: { autoAddSwitch: true, autoAddPDU: false } });
    }
    stage = 'inspect';
    const root = await call('dcsc_cabling_connections', { session: workspace, path: [], offset: 0, limit: 20 });
    const revision = Number(root['workspaceRevision']);
    assert(Number.isInteger(revision) && revision > 0, 'Inspection returned no workspace revision.');
    if (create) {
      stage = 'native-create-options';
      const before = rows((await snapshot())['workspaces'])[0]!;
      const original = rows(object(before['serverState'])['connections']);
      assert.equal(original.length, managedDestination ? 0 : managedSource ? 1 : linkedSource ? 5 : data100 ? 3 : 2);
      const managedItem = rows(before['rackArea']).flatMap(r => rows(r['rackItems'])).find(i => i['code'] === '7DHNCTO1WW');
      const example = managedDestination ? {
        sourceId: rows(before['configurations']).find(c => object(c['raw'])['code'] === '7D73CTOHWW')?.['configurationId'],
        destinationId: freshPhysicalId ?? rows(before['rackArea']).flatMap(r => rows(r['rackItems'])).find(i => i['code'] === '7Y70CTOHWW')?.['id'],
        network: object(rows(before['configurations']).find(c => object(c['raw'])['code'] === '7D73CTOHWW')?.['raw'])['selectedStorageNetwork'],
        topology: '10GbE_Copper',
      } : managedSource ? { ...original[0], sourceId: managedItem?.['id'] } : data100 ? original.find(row => row['topology'] === '100GbE_Copper')!
        : object(object(JSON.parse(await readFile('test/fixtures/parity/manual-row-seeding.json', 'utf8')))['requestedManualRow']);
      assert(example);
      const newPart = managedDestination ? storageCablePart : managedSource ? '3801' : breakout ? 'AV22' : data100 ? 'AV1Z' : linkedDestination ? 'AVFQ' : '3791';
      const args = { ...(breakout ? { connectionType: 'breakout-4' } : {}), session: workspace, expectedRevision: revision, network: example['network'], topology: example['topology'],
        source: { configurationId: example['sourceId'], portName: managedDestination ? 'SFP28' : managedSource ? 'RJ45 mgmt' : breakout ? 'SFP28' : data100 ? 'QSFP56' : 'RJ45', portNumber: data100 ? '2' : '1' },
        destination: { configurationId: example['destinationId'], portName: managedDestination ? 'SFP+' : data100 ? 'QSFP28' : 'RJ45', portNumber: managedDestination ? '1' : data100 ? '60' : '20' } };
      const options = await findCableChoice(args, newPart);
      assert(JSON.stringify(options).includes(newPart), 'Expected cable choice is unavailable.');
      if (data100 && !breakout) {
        const offered = rows(options['items']).map(item => object(item['value'])['part']);
        assert(!['AT2R', 'AV22', 'A1DL'].some(part => offered.includes(part)),
          '100 GbE point-to-point discovery offered a wrong-speed or breakout cable.');
      }
      stage = 'native-create';
      const created = await call('dcsc_create_cabling_connection', { ...args, cablePart: newPart, pinExistingRoutes: true });
      assert.equal(created['additionalConnectionCount'], linkedSource ? 1 : 0);
      assert.equal((created['sourceConfigurationIds'] as string[]).length, linkedSource ? 2 : 1);
      const pinCount = original.filter(row => row['type'] === 'AUTO' && row['subType'] === 'NETWORK').length;
      assert(managedDestination ? pinCount === 0 : pinCount > 0); assert.equal(created['pinnedConnectionCount'], pinCount);
      let acceptedRevision = Number(created['workspaceRevision']);
      let persisted = await snapshot();
      let accepted = rows(persisted['workspaces'])[0]!;
      let graph = rows(object(accepted['serverState'])['connections']);
      if (linkedSource) {
        const dependency = object(object(accepted['serverState'])['cloneDependency']);
        const group = Object.values(dependency).find(ids => Array.isArray(ids) && ids.includes(example['sourceId'])) as string[] | undefined;
        assert(group?.length === 2, 'Linked source group was lost.');
        const configurations = rows(accepted['configurations']).filter(c => group.includes(String(c['configurationId'])));
        assert.equal(configurations.length, 2);
        for (const configuration of configurations) {
          const selected = object(object(object(configuration['raw'])['selectedTopologies'])[String(args.network)]);
          assert.equal(selected['networkTechnology'], args.topology);
          assert.deepEqual(rows(selected['selectedConnectors']).map(c => `${c['port']}:${c['portNumber']}`).sort(), ['QSFP56:1', 'QSFP56:2']);
        }
        assert.deepEqual(dependency, object(before['serverState'])['cloneDependency'], 'Manual creation changed clone ownership.');
      }
      assert.equal(graph.length, original.length + (linkedSource ? 2 : 1));
      assertNativeConnectionsRetained(original.map(row => ({ ...row, type: 'MANUAL' })), graph);
      const target = rows(accepted['configurations']).find(c => c['configurationId'] === (freshControllerId ?? example['destinationId']))!;
      if (linkedDestination) {
        const dependency = object(object(accepted['serverState'])['cloneDependency']);
        const group = Object.values(dependency).find(ids => Array.isArray(ids) && ids.includes(example['destinationId'])) as string[] | undefined;
        assert(group?.length === 2);
        for (const id of group) {
          const member = rows(accepted['configurations']).find(c => c['configurationId'] === id)!;
          const results = rows(object(member['raw'])['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']))
            .filter(s => s['name'] === 'ETHERNET_CABLE').flatMap(s => rows(s['results']));
          assert.equal(results.find(r => r['code'] === newPart)?.['quantity'], 1);
        }
      }
      const selections = rows(object(target['raw'])['tabs']).flatMap(t => rows(t['subTabs']))
        .flatMap(t => rows(t['sections'])).filter(s => s['name'] === (managedDestination ? 'DAC_SFP_CABLE' : data100 ? 'QSFP+_AND_DAC_CABLES' : 'ETHERNET_CABLE')).flatMap(s => rows(s['results']));
      assert.equal(selections.find(r => r['code'] === newPart)?.['quantity'], linkedSource ? 4 : managedDestination || data100 ? 2 : 1);
      if (linkedDestination) {
        stage = 'linked-destination-second-member';
        const group = Object.values(object(object(accepted['serverState'])['cloneDependency']))
          .find(ids => Array.isArray(ids) && ids.includes(example['destinationId'])) as string[];
        const sourceCode = object(rows(accepted['configurations']).find(c => c['configurationId'] === example['sourceId'])!['raw'])['code'];
        const otherSource = rows(accepted['configurations']).find(c => c['configurationId'] !== example['sourceId'] && object(c['raw'])['code'] === sourceCode)!;
        assert(otherSource);
        const secondArgs = { ...args, expectedRevision: acceptedRevision,
          source: { ...args.source, configurationId: otherSource['configurationId'] },
          destination: { ...args.destination, configurationId: group.find(id => id !== example['destinationId'])! } };
        const options = await findCableChoice(secondArgs, newPart);
        assert(JSON.stringify(options).includes(newPart));
        const previousGraph = graph;
        const second = await call('dcsc_create_cabling_connection', { ...secondArgs, cablePart: newPart, pinExistingRoutes: true });
        assert.deepEqual(new Set(second['destinationConfigurationIds'] as string[]), new Set(group));
        acceptedRevision = Number(second['workspaceRevision']);
        persisted = await snapshot(); accepted = rows(persisted['workspaces'])[0]!;
        graph = rows(object(accepted['serverState'])['connections']);
        assert.equal(graph.length, previousGraph.length + 1);
        assertNativeConnectionsRetained(previousGraph, graph);
        for (const id of group) {
          const member = rows(accepted['configurations']).find(c => c['configurationId'] === id)!;
          const results = rows(object(member['raw'])['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']))
            .filter(s => s['name'] === 'ETHERNET_CABLE').flatMap(s => rows(s['results']));
          assert.equal(results.find(r => r['code'] === newPart)?.['quantity'], 1, 'One route on each linked destination must not select two cables per product.');
        }
      }
      if (breakout) {
        stage = 'breakout-second-branch';
        const secondArgs = { ...args, expectedRevision: acceptedRevision, source: { ...args.source, portNumber: '3' } };
        await findCableChoice(secondArgs, newPart);
        const previousGraph = graph;
        const second = await call('dcsc_create_cabling_connection', { ...secondArgs, cablePart: newPart, pinExistingRoutes: true });
        acceptedRevision = Number(second['workspaceRevision']);
        persisted = await snapshot(); accepted = rows(persisted['workspaces'])[0]!;
        graph = rows(object(accepted['serverState'])['connections']);
        assert.equal(graph.length, previousGraph.length + 1);
        assertNativeConnectionsRetained(previousGraph, graph);
        const branches = graph.filter(r => r['destinationId'] === args.destination.configurationId && r['destinationPortNumber'] === args.destination.portNumber);
        assert.equal(branches.length, 2);
        assert(branches.every(r => r['category'] === 'BREAKOUT' && r['divider'] === 4 && r['type'] === 'MANUAL'));
        const dest = rows(accepted['configurations']).find(c => c['configurationId'] === args.destination.configurationId)!;
        const selected = rows(object(dest['raw'])['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']))
          .filter(s => s['name'] === 'QSFP+_AND_DAC_CABLES').flatMap(s => rows(s['results']));
        assert.equal(selected.find(r => r['code'] === newPart)?.['quantity'], 2, 'Three branches at two destination ports require two cables.');
      }
      if (breakoutReplacement) {
        stage = 'breakout-shared-replacement';
        const rowIndex = graph.findIndex(row => row['sourceId'] === args.source.configurationId && row['sourcePortName'] === 'SFP28' && row['sourcePortNumber'] === '2');
        assert(rowIndex >= 0);
        const connection = await detail(workspace, acceptedRevision, rowIndex);
        const replacement = await call('dcsc_edit_cabling_connection', { session: workspace, expectedRevision: acceptedRevision,
          connectionId: connection['id'], cablePart: 'AV23' });
        assert.equal(rows(replacement['updatedConnections']).length, 1, 'Both branches of the selected physical cable must change.');
        const expected = graph.map(row => row['destinationId'] === args.destination.configurationId && row['destinationPortNumber'] === args.destination.portNumber
          ? { ...row, cablePart: 'AV23', type: 'MANUAL' } : row);
        acceptedRevision = Number(replacement['workspaceRevision']);
        persisted = await snapshot(); accepted = rows(persisted['workspaces'])[0]!;
        graph = rows(object(accepted['serverState'])['connections']);
        assert.equal(graph.length, expected.length); assertNativeConnectionsRetained(expected, graph);
        const destination = rows(accepted['configurations']).find(c => c['configurationId'] === args.destination.configurationId)!;
        const selected = rows(object(destination['raw'])['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']))
          .filter(s => s['name'] === 'QSFP+_AND_DAC_CABLES').flatMap(s => rows(s['results']));
        for (const part of ['AV22', 'AV23']) assert.equal(selected.find(r => r['code'] === part)?.['quantity'], 1);
      }
      if (sharedStorage) {
        stage = 'shared-storage-second-connection';
        assert(secondStoragePhysicalId);
        const previousGraph = structuredClone(graph);
        const secondArgs = { ...args, expectedRevision: acceptedRevision,
          source: { ...args.source, portNumber: '2' },
          destination: { ...args.destination, configurationId: secondStoragePhysicalId } };
        const secondPart = mixedStorage && !replacementStorage ? 'A1PJ' : newPart;
        await findCableChoice(secondArgs, secondPart);
        const second = await call('dcsc_create_cabling_connection', { ...secondArgs, cablePart: secondPart, pinExistingRoutes: true });
        assert.deepEqual(second['destinationConfigurationIds'], [freshControllerId]);
        acceptedRevision = Number(second['workspaceRevision']);
        persisted = await snapshot(); accepted = rows(persisted['workspaces'])[0]!;
        graph = rows(object(accepted['serverState'])['connections']);
        assert.equal(graph.length, previousGraph.length + 1);
        assertNativeConnectionsRetained(previousGraph, graph);
        assert(graph.some(r => r['destinationId'] === secondStoragePhysicalId && r['cablePart'] === secondPart));
        const controller = rows(accepted['configurations']).find(c => c['configurationId'] === freshControllerId)!;
        const selected = rows(object(controller['raw'])['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']))
          .filter(s => s['name'] === 'DAC_SFP_CABLE').flatMap(s => rows(s['results']));
        assert.equal(selected.find(r => r['code'] === newPart)?.['quantity'], 2, 'Shared template must retain its spare cables.');
      }
      if (replacementStorage) {
        stage = 'shared-storage-cable-replacement';
        const row = await detail(workspace, acceptedRevision, 0);
        const untouched = graph.filter(r => r['destinationId'] !== object(row['destination'])['configurationId']);
        const changed = await call('dcsc_edit_cabling_connection', { session: workspace, connectionId: row['id'],
          cablePart: 'A1PJ', cableQuantities: { oldPart: 2, newPart: 2 }, expectedRevision: acceptedRevision });
        acceptedRevision = Number(changed['workspaceRevision']);
        persisted = await snapshot(); accepted = rows(persisted['workspaces'])[0]!;
        graph = rows(object(accepted['serverState'])['connections']);
        assert.equal(graph.length, 2);
        assertNativeConnectionsRetained(untouched, graph);
        assert(graph.some(r => r['destinationId'] === object(row['destination'])['configurationId'] && r['cablePart'] === 'A1PJ'));
      }
      stage = 'native-create-sigkill-restart';
      assert(transport!.pid); process.kill(transport!.pid!, 'SIGKILL');
      await client!.close(); client = undefined; transport = undefined;
      await start();
      await detail(workspace, acceptedRevision, 0);
      assert.deepEqual(await snapshot(), persisted, 'Creation changed across immediate SIGKILL/restart.');
      stage = 'native-create-export';
      const exported = await call('dcsc_export', { session: workspace, fileName: 'native-manual-created', fileTypes: ['XML', 'QUOTE'] });
      const xml = String(exported['xml']); assert((await readFile(xml)).length > 0);
      let browserXml = xml;
      let browserWorkspace = accepted;
      if (breakout) {
        assert.equal(exported['breakoutBranchesAtRisk'], graph.filter(r => r['category'] === 'BREAKOUT').length);
        assert.match(String(exported['breakoutReimportWarning']), /website reimport/);
      }
      if (breakout || managedSource || managedDestination) {
        stage = 'manual-mcp-reimport';
        const recovered = await call('dcsc_import', { filePath: xml, solutionMode: 'HPC and AI - Systems' });
        const recoveredId = String(recovered['workspace']);
        let recoverySnapshot = await snapshot();
        let recoveredWorkspace = rows(recoverySnapshot['workspaces']).find(w => w['id'] === recoveredId)!;
        assert(recoveredWorkspace, 'Recovered workspace is missing.');
        let recoveredGraph = rows(object(recoveredWorkspace['serverState'])['connections']);
        assert.equal(recoveredGraph.length, graph.length);
        assertNativeConnectionsRetained(graph, recoveredGraph);
        if (replacementStorage) {
          stage = 'imported-linked-storage-replacement';
          const index = recoveredGraph.findIndex(row => row['cablePart'] === 'A1PJ');
          assert(index >= 0);
          const existing = await detail(recoveredId, Number(recoveredWorkspace['revision']), index);
          await call('dcsc_edit_cabling_connection', { session: recoveredId, connectionId: existing['id'],
            cablePart: 'A1PH', cableQuantities: { oldPart: 2, newPart: 2 }, expectedRevision: Number(recoveredWorkspace['revision']) });
          const expected = recoveredGraph.map((row, i) => i === index ? { ...row, cablePart: 'A1PH', type: 'MANUAL' } : row);
          recoverySnapshot = await snapshot();
          recoveredWorkspace = rows(recoverySnapshot['workspaces']).find(w => w['id'] === recoveredId)!;
          recoveredGraph = rows(object(recoveredWorkspace['serverState'])['connections']);
          assert.equal(recoveredGraph.length, expected.length);
          assertNativeConnectionsRetained(expected, recoveredGraph);
          graph = structuredClone(recoveredGraph);
        }
        if (sharedStorage) {
          for (const physicalId of [freshPhysicalId, secondStoragePhysicalId]) {
            const member = rows(recoveredWorkspace['configurations']).find(c => c['configurationId'] === physicalId);
            assert(member, 'Both physical storage products must survive import.');
            const sections = rows(object(member['raw'])['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']));
            assert.deepEqual(sections.flatMap(s => rows(s['errors'])), []);
            const cables = sections.filter(s => s['name'] === 'DAC_SFP_CABLE').flatMap(s => rows(s['results']));
            assert.equal(cables.find(r => r['code'] === newPart)?.['quantity'], 2);
            if (mixedStorage) assert.equal(cables.find(r => r['code'] === 'A1PJ')?.['quantity'], 2);
          }
        }
        const destination = rows(recoveredWorkspace['configurations']).find(c => c['configurationId'] === args.destination.configurationId)!;
        const selected = rows(object(destination['raw'])['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']))
          .filter(s => s['name'] === (managedDestination ? 'DAC_SFP_CABLE' : managedSource ? 'ETHERNET_CABLE' : 'QSFP+_AND_DAC_CABLES')).flatMap(s => rows(s['results']));
        if (breakoutReplacement) {
          for (const part of ['AV22', 'AV23']) assert.equal(selected.find(r => r['code'] === part)?.['quantity'], 1);
        } else assert.equal(selected.find(r => r['code'] === newPart)?.['quantity'], managedSource ? 1 : 2);
        assert(transport!.pid); process.kill(transport!.pid!, 'SIGKILL');
        await client!.close(); client = undefined; transport = undefined; await start();
        const recoveredDetail = await detail(recoveredId, Number(recoveredWorkspace['revision']), 0);
        assert.deepEqual(await snapshot(), recoverySnapshot, 'Recovered connection changed across restart.');
        if (sharedStorage) {
          const choices = await call('dcsc_cabling_connections', { session: recoveredId,
            expectedWorkspaceRevision: Number(recoveredWorkspace['revision']), refreshConnectionId: recoveredDetail['id'],
            path: ['connections', '0', 'compatibleCables'], offset: 0, limit: 50 });
          assert(rows(choices['items']).some(item => object(item['value'])['part'] === 'A1PJ'));
          assert.deepEqual(await snapshot(), recoverySnapshot, 'Fresh cable discovery changed persisted workspace state.');
        }
        const recoveredExport = await call('dcsc_export', { session: recoveredId, fileName: 'recovered-breakout', fileTypes: ['XML', 'QUOTE'] });
        assert((await readFile(String(recoveredExport['xml']))).length > 0);
        if (sharedStorage) {
          browserXml = String(recoveredExport['xml']);
          browserWorkspace = recoveredWorkspace;
        }
        await writeFile(path.join(out, 'mcp-recovery-report.json'), JSON.stringify({ status: 'pass',
          workspace: recoveredId, connections: recoveredGraph.length, cableQuantity: managedSource ? 1 : 2, managedSource, managedDestination, breakoutReplacement, exportXml: recoveredExport['xml'] }, null, 2));
      }
      let websiteBlock: string | undefined;
      stage = 'native-create-browser-reimport';
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage(); const layouts: Obj[] = []; const pending: Promise<void>[] = [];
        page.on('response', response => {
          if (response.url().includes('/ctos/racks/customize?')) pending.push(response.json().then(raw => { layouts.push(object(raw)); }));
        });
        await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded' });
        await selectBrowserSolutionMode(page, 'AI & HPC – ThinkSystem Hardware', { diagnosticsDir: out });
        const importedResponse = page.waitForResponse(response => response.url().includes('/multiple/cfxml_import') && response.request().method() === 'POST', { timeout: 120000 });
        await page.locator('input[type=file]').first().setInputFiles(browserXml);
        const payload: unknown = await (await importedResponse).json();
        const native = object(Array.isArray(payload) ? payload[0] : payload);
        await writeFile(path.join(out, 'native-import.json'), JSON.stringify(native));
        assertGroupedCommercialParity(native, browserWorkspace);
        await page.waitForURL(/rack-summary/, { timeout: 120000 });
        await page.waitForTimeout(5000); await page.waitForLoadState('networkidle', { timeout: 60000 }); await Promise.all(pending);
        await writeFile(path.join(out, 'native-import.json'), JSON.stringify(native));
        await writeFile(path.join(out, 'native-layouts.json'), JSON.stringify(layouts));
        assert(layouts.length);
        const importedGraph = rows(layouts.at(-1)!['connections']);
        assert.equal(importedGraph.length, graph.length);
        try { assertNativeConnectionsRetained(graph, importedGraph); }
        catch (error) {
          if (!breakout) throw error;
          // Keep this a blocked gate, and allow only the independently captured import defect.
          const degraded = graph.map(row => row['category'] === 'BREAKOUT' ? { ...row, category: 'P2P', divider: 1 } : row);
          assertNativeConnectionsRetained(degraded, importedGraph);
          websiteBlock = 'DCSC cfxml_import loses saved breakout divider4; website returns P2P/divider1. MCP recovery passed separately.';
        }
      } finally { await browser.close(); }
      if (managedSource) {
        stage = 'managed-source-clear-ports';
        const source = rows(accepted['configurations']).find(c => object(c['raw'])['code'] === '7DHNCTO1WW')!;
        assert(source, 'Managed source template is missing.');
        const cleared = await call('dcsc_set_topology', { session: source['id'], topology: args.topology,
          networkName: args.network, ports: [], autoConnect: true });
        assert.equal(cleared['connectionGraphStale'], false);
        assert.deepEqual(object(object(cleared['selectedTopologies'])[String(args.network)])['selectedConnectors'], []);
        const clearedSnapshot = await snapshot();
        const clearedWorkspace = rows(clearedSnapshot['workspaces']).find(w => w['id'] === workspace)!;
        const clearedGraph = rows(object(clearedWorkspace['serverState'])['connections']);
        assert.equal(clearedGraph.length, 1);
        assert(!clearedGraph.some(r => r['sourcePart'] === '7DHNCTO1WW'));
        assert.equal(clearedGraph[0]!['sourceId'], original[0]!['sourceId']);
        assert(transport!.pid); process.kill(transport!.pid!, 'SIGKILL');
        await client!.close(); client = undefined; transport = undefined; await start();
        await detail(workspace, Number(clearedWorkspace['revision']), 0);
        assert.deepEqual(await snapshot(), clearedSnapshot, 'Port deselection changed across crash recovery.');
        const clearedExport = await call('dcsc_export', { session: workspace, fileName: 'cleared-managed-source', fileTypes: ['XML'] });
        const clearedImport = await call('dcsc_import', { filePath: clearedExport['xml'], solutionMode: 'HPC and AI - Systems' });
        const clearedImportedWorkspace = rows((await snapshot())['workspaces']).find(w => w['id'] === clearedImport['workspace'])!;
        const importedGraph = rows(object(clearedImportedWorkspace['serverState'])['connections']);
        assert.equal(importedGraph.length, clearedGraph.length);
        assertNativeConnectionsRetained(clearedGraph, importedGraph);
        await writeFile(path.join(out, 'clear-ports-report.json'), JSON.stringify({ status: 'pass',
          workspace, connections: importedGraph.length, exportXml: clearedExport['xml'] }, null, 2));
      }
      await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: websiteBlock ? 'blocked' : 'pass', websiteBlock, scope: 'native-manual-create-pin-crash-export-browser',
        workspace, calls: calls.length, topology: args.topology, replacementStorage, mixedStorage, sharedStorage, freshStorage, prepareStorage, managedSource, managedDestination, breakout, breakoutReplacement, linkedSource, linkedDestination, pinnedConnectionCount: pinCount, connectionCount: graph.length, exportXml: xml, browserExportXml: browserXml }, null, 2));
      if (websiteBlock) { console.log(`BLOCKED website handoff: ${websiteBlock}`); process.exitCode = 2; return; }
      console.log(`PASS native manual creation, pinning, SIGKILL/restart and native browser import (${calls.length} MCP calls).`);
      return;
    }
    if (collision) {
      stage = 'collision-first-inspect';
      const capturedCollision = object(JSON.parse(await readFile(
        path.resolve('test/fixtures/parity/manual-cabling-collision-swap.json'), 'utf8')));
      const expectedBefore = rows(capturedCollision['before']);
      const expectedAfter = rows(capturedCollision['after']);
      assert.equal(capturedCollision['calculateDistanceCalls'], 0,
        'Captured native same-component port swap unexpectedly recalculates distance.');
      const initial = [await detail(workspace, revision, 0), await detail(workspace, revision, 1)];
      const destinationId = String(object(initial[0]!['destination'])['configurationId']);
      assert(destinationId && initial.every(row =>
        object(row['destination'])['configurationId'] === destinationId),
      'Collision seed rows do not share one physical destination.');
      const edited = initial.find(row => object(row['destination'])['portNumber'] === '2');
      const conflicting = initial.find(row => object(row['destination'])['portNumber'] === '3');
      assert(edited && conflicting, 'Collision seed must occupy destination ports 2 and 3.');
      assert.deepEqual([object(edited['source'])['location'], object(conflicting['source'])['location']],
        expectedBefore.map(row => row['sourceLocation']));
      const beforeCables = [object(edited['cable'])['part'], object(conflicting['cable'])['part']];
      const beforeDistances = [edited['totalDistance'], conflicting['totalDistance']];

      stage = 'collision-swap';
      const swapped = await call('dcsc_edit_cabling_connection', {
        session: workspace, connectionId: String(edited['id']), expectedRevision: revision,
        destination: { configurationId: destinationId, portName: 'RJ45', portNumber: '3' },
      });
      const acceptedRevision = Number(swapped['workspaceRevision']);
      assert.equal(object(object(swapped['connection'])['destination'])['portNumber'],
        expectedAfter[0]!['destinationPortNumber']);
      const displaced = rows(swapped['swappedConnections']);
      assert.equal(displaced.length, 1, 'Occupied-port edit did not report exactly one displaced connection.');
      assert.equal(object(displaced[0]!['destination'])['portNumber'], expectedAfter[1]!['destinationPortNumber']);
      assert.equal(object(swapped['connection'])['type'], 'MANUAL');
      assert.equal(displaced[0]!['type'], 'MANUAL');
      assert.equal(object(swapped['connection'])['compatibleCables'], undefined,
        'Collision mutation response leaked the full compatible cable catalog.');
      assert.equal(displaced[0]!['compatibleCables'], undefined,
        'Displaced mutation response leaked the full compatible cable catalog.');

      const persistedAfter = await snapshot();
      const workspaceAfter = rows(persistedAfter['workspaces'])[0]!;
      const finalConnections = rows(object(workspaceAfter['serverState'])['connections']);
      const finalEdited = finalConnections.find(row => row['sourceLocation'] === expectedAfter[0]!['sourceLocation']);
      const finalDisplaced = finalConnections.find(row => row['sourceLocation'] === expectedAfter[1]!['sourceLocation']);
      assert(finalEdited && finalDisplaced, 'Collision swap lost one of the native source rows.');
      assert.deepEqual([finalEdited['destinationPortNumber'], finalDisplaced['destinationPortNumber']],
        expectedAfter.map(row => row['destinationPortNumber']));
      assert.deepEqual([finalEdited['cablePart'], finalDisplaced['cablePart']],
        beforeCables);
      assert.deepEqual([finalEdited['totalDistance'], finalDisplaced['totalDistance']],
        beforeDistances);
      assert(finalConnections.every(row => row['type'] === 'MANUAL'),
        'Collision swap did not mark both affected rows MANUAL.');

      stage = 'collision-sigkill-restart';
      assert(transport!.pid, 'MCP transport has no child PID.');
      process.kill(transport!.pid!, 'SIGKILL');
      await client!.close(); client = undefined; transport = undefined;
      await start();
      const restarted = [await detail(workspace, acceptedRevision, 0), await detail(workspace, acceptedRevision, 1)];
      assert.deepEqual(restarted.map(row => object(row['destination'])['portNumber']).sort(), ['2', '3']);
      assert.deepEqual(await snapshot(), persistedAfter,
        'Occupied-port swap changed across immediate SIGKILL/restart.');

      stage = 'collision-export';
      const exported = await call('dcsc_export', { session: workspace, fileName: 'manual-cable-collision',
        fileTypes: ['XML', 'QUOTE'] });
      const xmlPath = String(exported['xml']);
      assert(xmlPath && (await readFile(xmlPath)).length > 0, 'Collision export returned no XML.');
      await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'pass',
        scope: 'live-mcp-occupied-port-swap-crash-export', workspace, destinationId,
        revision: { before: revision, accepted: acceptedRevision },
        ports: { before: expectedBefore.map(row => row['destinationPortNumber']),
          after: expectedAfter.map(row => row['destinationPortNumber']) },
        cables: beforeCables, exportXml: xmlPath, calls: calls.length,
      }, null, 2));
      console.log(`PASS occupied-port swap, SIGKILL/restart and export (${calls.length} MCP calls).`);
      return;
    }
    if (shared) {
      stage = 'shared-first-inspect';
      const initial = [await detail(workspace, revision, 0), await detail(workspace, revision, 1)];
      const sharedRows = initial.filter(row => object(row['cable'])['part'] === 'AVFT');
      assert.equal(sharedRows.length, 2, 'Native shared seed must contain two AVFT graph rows.');
      const first = sharedRows[0]!;
      const retained = sharedRows[1]!;
      const destinationId = String(object(first['destination'])['configurationId']);
      assert.equal(object(retained['destination'])['configurationId'], destinationId,
        'Shared rows do not have the same physical destination.');
      const afterShare = await snapshot();
      const sharedWorkspace = rows(afterShare['workspaces'])[0]!;
      const sharedConnections = rows(object(sharedWorkspace['serverState'])['connections']);
      assert.equal(sharedConnections.filter(row => row['cablePart'] === 'AVFT').length, 2,
        'Quantity-preserving share did not produce two AVFT graph rows.');
      const sharedConfig = rows(sharedWorkspace['configurations'])
        .find(item => item['configurationId'] === destinationId)!;
      const selectedResults = (raw: Obj) => rows(raw['tabs']).flatMap(tab => rows(tab['subTabs']))
        .flatMap(subTab => rows(subTab['sections'])).filter(section => section['name'] === 'ETHERNET_CABLE')
        .flatMap(section => rows(section['results']));
      const sharedSelected = selectedResults(object(sharedConfig['raw']));
      assert.equal(sharedSelected.find(result => result['code'] === 'AVFT')?.['quantity'], 2,
        'Import must reconcile the native graph into canonical AVFT quantity two.');
      const physicalResults = (storedWorkspace: Obj) => {
        const physical = rows(storedWorkspace['rackArea']).flatMap(rack => rows(rack['rackItems']))
          .concat(rows(storedWorkspace['nonRackArea'])).find(item => item['id'] === destinationId);
        assert(physical, 'Shared replacement lost its physical destination.');
        return rows(physical['features']).filter(section => section['name'] === 'ETHERNET_CABLE')
          .flatMap(section => rows(section['results']));
      };
      assert.equal(physicalResults(sharedWorkspace).find(result => result['code'] === 'AVFT')?.['quantity'], 2,
        'Import must reconcile the physical destination to AVFT quantity two.');

      stage = 'shared-split';
      const sharedRevision = revision;
      const current = initial;
      const currentFirst = current.find(row => row['id'] === first['id']);
      assert(currentFirst && object(currentFirst['cable'])['part'] === 'AVFT',
        'First row identity or shared AVFT state was not preserved.');
      const split = await call('dcsc_edit_cabling_connection', { session: workspace,
        connectionId: String(currentFirst['id']), cablePart: 'AVFU', expectedRevision: sharedRevision });
      const acceptedRevision = Number(split['workspaceRevision']);
      const persistedAfter = await snapshot();
      const workspaceAfter = rows(persistedAfter['workspaces'])[0]!;
      const finalConnections = rows(object(workspaceAfter['serverState'])['connections']);
      assert.deepEqual(finalConnections.map(row => row['cablePart']).sort(), ['AVFT', 'AVFU'],
        'Shared split did not preserve one old and one new graph row.');
      const configAfter = rows(workspaceAfter['configurations'])
        .find(item => item['configurationId'] === destinationId)!;
      const finalSelected = selectedResults(object(configAfter['raw']));
      assert.equal(finalSelected.find(result => result['code'] === 'AVFT')?.['quantity'], 1,
        'Canonical configuration lost the untouched shared AVFT row.');
      assert.equal(finalSelected.find(result => result['code'] === 'AVFU')?.['quantity'], 1,
        'Canonical configuration did not accept AVFU quantity one.');
      const finalPhysical = physicalResults(workspaceAfter);
      assert.equal(finalPhysical.find(result => result['code'] === 'AVFT')?.['quantity'], 1);
      assert.equal(finalPhysical.find(result => result['code'] === 'AVFU')?.['quantity'], 1);
      const reportedPrice = object(split['configurationChange']);
      assert.equal(reportedPrice['configurationId'], destinationId);
      assert.equal(reportedPrice['priceScope'], 'editable-configuration');

      stage = 'shared-sigkill-restart';
      assert(transport!.pid, 'MCP transport has no child PID.');
      process.kill(transport!.pid!, 'SIGKILL');
      await client!.close(); client = undefined; transport = undefined;
      await start();
      const restarted = [await detail(workspace, acceptedRevision, 0), await detail(workspace, acceptedRevision, 1)];
      assert.deepEqual(restarted.map(row => object(row['cable'])['part']).sort(), ['AVFT', 'AVFU']);
      assert.deepEqual(await snapshot(), persistedAfter,
        'Shared manual cable state changed across immediate SIGKILL/restart.');
      stage = 'shared-export';
      const exported = await call('dcsc_export', { session: workspace, fileName: 'manual-cable-shared',
        fileTypes: ['XML', 'QUOTE'] });
      const xmlPath = String(exported['xml']);
      const xml = await readFile(xmlPath, 'utf8');
      assert(xml.includes('AVFT') && xml.includes('AVFU'), 'Export XML omitted a shared cable part.');
      await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'pass',
        scope: 'live-mcp-shared-cable-quantity-crash-export', workspace, destinationId,
        revision: { before: revision, shared: sharedRevision, accepted: acceptedRevision },
        parts: { shared: ['AVFT', 'AVFT'], final: ['AVFT', 'AVFU'] },
        price: reportedPrice, exportXml: xmlPath, calls: calls.length,
      }, null, 2));
      console.log(`PASS shared cable quantity, SIGKILL/restart and export (${calls.length} MCP calls).`);
      return;
    }
    const before = await detail(workspace, revision);
    assert.equal(object(before['cable'])['part'], 'AVFT', 'Seed current cable is not captured AVFT.');
    const destinationId = String(object(before['destination'])['configurationId']);
    const connectionId = String(before['id']);
    const choicesPage = await call('dcsc_cabling_connections', { session: workspace,
      expectedWorkspaceRevision: revision, path: ['connections', '0', 'compatibleCables'], offset: 0, limit: 50 });
    const choices = rows(choicesPage['items']).map(item => object(item['value']));
    assert(choices.some(choice => choice['part'] === cablePart), `Captured ${cablePart} compatible cable is unavailable.`);
    const persistedBefore = await snapshot();
    const workspaceBefore = rows(persistedBefore['workspaces'])[0]!;
    const configBefore = rows(workspaceBefore['configurations'])
      .find(item => item['configurationId'] === destinationId)!;
    const priceBefore = Number(object(configBefore['raw'])['totalPrice']);
    stage = 'replace';
    const replaced = await call('dcsc_edit_cabling_connection', { session: workspace, connectionId,
      cablePart, expectedRevision: revision });
    assert.equal(object(replaced['connection'])['compatibleCables'], undefined,
      'Mutation response leaked the full compatible cable catalog.');
    assert.equal(object(object(replaced['connection'])['cable'])['part'], cablePart);
    const reportedPrice = object(replaced['configurationChange']);
    assert.equal(reportedPrice['configurationId'], destinationId);
    assert.equal(reportedPrice['priceScope'], 'editable-configuration');
    assert.equal(reportedPrice['currency'], 'USD');
    const acceptedRevision = Number(replaced['workspaceRevision']);
    const persistedAfter = await snapshot();
    const workspaceAfter = rows(persistedAfter['workspaces'])[0]!;
    const connection = rows(object(workspaceAfter['serverState'])['connections'])[0]!;
    assert.equal(connection['cablePart'], cablePart);
    assert.equal(connection['type'], 'MANUAL');
    const configAfter = rows(workspaceAfter['configurations'])
      .find(item => item['configurationId'] === destinationId)!;
    const rawAfter = object(configAfter['raw']);
    const priceAfter = Number(rawAfter['totalPrice']);
    assert(Number.isFinite(priceBefore) && Number.isFinite(priceAfter), 'Authoritative cable prices are unavailable.');
    if (cablePart === '3802') assert(priceAfter < priceBefore,
      `Expected captured existing-code price decrease; before=${priceBefore} after=${priceAfter}.`);
    assert.equal(reportedPrice['previousTotalPrice'], priceBefore);
    assert.equal(reportedPrice['totalPrice'], priceAfter);
    const selected = rows(rawAfter['tabs']).flatMap(tab => rows(tab['subTabs']))
      .flatMap(subTab => rows(subTab['sections'])).filter(section => section['name'] === 'ETHERNET_CABLE')
      .flatMap(section => rows(section['results']));
    assert.equal(selected.filter(result => result['code'] === cablePart).length, 1);
    assert.equal(selected.filter(result => result['code'] === 'AVFT').length, 0);
    const physical = rows(workspaceAfter['rackArea']).flatMap(rack => rows(rack['rackItems']))
      .concat(rows(workspaceAfter['nonRackArea'])).find(item => item['id'] === destinationId);
    assert(physical, 'Replacement lost its physical destination.');
    const physicalCables = rows(physical['features']).filter(section => section['name'] === 'ETHERNET_CABLE')
      .flatMap(section => rows(section['results']));
    assert.equal(physicalCables.find(result => result['code'] === cablePart)?.['quantity'], 1,
      'Replacement did not reach physical destination features.');
    assert(!physicalCables.some(result => result['code'] === 'AVFT'), 'Physical destination retained the old cable.');
    if (cablePart === 'AVFU') {
      assert.equal(physicalCables.find(result => result['code'] === 'AVFU')?.['forAutoConnect'], true);
      assert.equal(physicalCables.find(result => result['code'] === '3802')?.['quantity'], 1,
        'Absent-new-code replacement removed the independent pre-existing cable.');
    }

    stage = 'sigkill-restart';
    assert(transport!.pid, 'MCP transport has no child PID.');
    process.kill(transport!.pid!, 'SIGKILL');
    await client!.close(); client = undefined; transport = undefined;
    await start();
    const afterRestart = await detail(workspace, acceptedRevision);
    assert.equal(object(afterRestart['cable'])['part'], cablePart);
    assert.deepEqual(await snapshot(), persistedAfter, 'Manual cable state changed across immediate SIGKILL/restart.');
    stage = 'export';
    const exported = await call('dcsc_export', { session: workspace, fileName: 'manual-cable-replacement',
      fileTypes: ['XML', 'QUOTE'] });
    const xmlPath = String(exported['xml']);
    const xml = await readFile(xmlPath, 'utf8');
    assert(xml.includes(cablePart), 'Export XML omitted the accepted cable part.');
    await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'pass',
      scope: 'live-mcp-existing-row-cable-replacement-crash-export', workspace, connectionId,
      destinationId, revision: { before: revision, accepted: acceptedRevision },
      price: { before: priceBefore, after: priceAfter }, cable: { before: 'AVFT', after: cablePart },
      exportXml: xmlPath, calls: calls.length,
    }, null, 2));
    console.log(`PASS manual cable replacement, SIGKILL/restart and export (${calls.length} MCP calls).`);
  } catch (error) {
    await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'fail', stage,
      error: error instanceof Error ? error.message : String(error), calls: calls.length }, null, 2));
    throw error;
  } finally {
    await client?.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
