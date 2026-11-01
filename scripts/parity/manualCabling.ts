/** Manual cabling parity: one case per mode, all driving dcsc_cabling_get / dcsc_cabling_set and compared with the website's import of the export. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assertNativeConnectionsRetained } from '../../src/domain/nativeManualCabling.js';
import { groupedCommercial } from '../lib/groupedRackParity.js';
import { HPC_MODE, HPC_MODE_LABEL, connectionIdentity, object, rows, selectedQuantity, selectedResults, websiteImport, type Obj } from './fabric.js';
import type { ExpectedDifference, Harness, ParityCase } from './harness.js';

const FIXTURES = 'test/fixtures/parity';
const ORIGINAL_CABLE = 'AVFT';
const ROW_SEED = path.resolve(FIXTURES, 'manual-row-seeding.json');
const COLLISION_CAPTURE = path.resolve(FIXTURES, 'manual-cabling-collision-swap.json');
const MAX_CHOICE_PAGES = 100;
const BREAKOUT_WEBSITE_DEFECT = 'DCSC cfxml_import loses the saved breakout divider 4; the website returns P2P/divider 1.';

export interface ManualCablingMode {
  id: string;
  cablePart?: '3802' | 'AVFU';
  create?: boolean;
  breakoutReplace?: boolean;
  breakout?: boolean;
  g100?: boolean;
  replaceStorage?: boolean;
  mixedStorage?: boolean;
  sharedStorage?: boolean;
  freshStorage?: boolean;
  prepareStorage?: boolean;
  managedDestination?: boolean;
  managedSource?: boolean;
  linkedSource?: boolean;
  linkedDestination?: boolean;
  shared?: boolean;
  collision?: boolean;
}

export const MANUAL_CABLING_MODES: ManualCablingMode[] = [
  { id: 'manual-cabling-replace' },
  { id: 'manual-cabling-replace-absent-code', cablePart: 'AVFU' },
  { id: 'manual-cabling-shared', shared: true },
  { id: 'manual-cabling-collision', collision: true },
  { id: 'manual-create', create: true },
  { id: 'manual-create-100g', create: true, g100: true },
  { id: 'manual-create-breakout', create: true, breakout: true },
  { id: 'manual-replace-breakout', create: true, breakoutReplace: true },
  { id: 'manual-create-managed-source', create: true, managedSource: true },
  { id: 'manual-create-managed-destination', create: true, managedDestination: true },
  { id: 'manual-create-storage-prepare', create: true, managedDestination: true, prepareStorage: true },
  { id: 'manual-create-fresh-storage', create: true, managedDestination: true, freshStorage: true },
  { id: 'manual-create-shared-storage', create: true, managedDestination: true, sharedStorage: true },
  { id: 'manual-create-mixed-storage', create: true, managedDestination: true, mixedStorage: true },
  { id: 'manual-replace-shared-storage', create: true, managedDestination: true, replaceStorage: true },
  { id: 'manual-create-linked-source', create: true, g100: true, linkedSource: true },
  { id: 'manual-create-linked-destination', create: true, linkedDestination: true },
];

export const manualCablingCases = (): ParityCase[] => MANUAL_CABLING_MODES.map(mode => ({
  id: mode.id,
  tags: ['cabling', 'manual-cabling', 'import', 'export'],
  run: h => runManualCabling(h, mode),
}));

function seedFor(flags: { prepareStorage: boolean; managedDestination: boolean; managedSource: boolean; sharedSeed: boolean }): string {
  const name = flags.prepareStorage ? 'manual-cabling-storage-optical.xml'
    : flags.managedDestination ? 'manual-cabling-managed-destination.xml'
      : flags.managedSource ? 'manual-cabling-managed-source.xml'
        : flags.sharedSeed ? 'manual-cabling-shared-network.xml' : 'manual-cabling-network.xml';
  return path.resolve(FIXTURES, 'xml', name);
}

async function runManualCabling(h: Harness, mode: ManualCablingMode): Promise<void> {
  const { mcp, step, compare } = h;
  const breakout = mode.breakout === true || mode.breakoutReplace === true;
  const data100 = mode.g100 === true || breakout;
  const replacementStorage = mode.replaceStorage === true;
  const mixedStorage = mode.mixedStorage === true || replacementStorage;
  const sharedStorage = mode.sharedStorage === true || mixedStorage;
  const freshStorage = mode.freshStorage === true || sharedStorage;
  const prepareStorage = mode.prepareStorage === true || freshStorage;
  const managedDestination = mode.managedDestination === true;
  const managedSource = mode.managedSource === true;
  const linkedSource = mode.linkedSource === true;
  const linkedDestination = mode.linkedDestination === true;
  const create = mode.create === true;
  const cablePart = mode.cablePart ?? '3802';
  const storageCablePart = sharedStorage ? 'A1PH' : 'A3RG';
  const seed = seedFor({ prepareStorage, managedDestination, managedSource, sharedSeed: mode.shared === true || mode.collision === true || create });
  let freshControllerId: string | undefined;
  let freshPhysicalId: string | undefined;
  let secondStoragePhysicalId: string | undefined;

  const call = (tool: string, args: Obj, expectError = false) => mcp.call(tool, args, { expectError });
  const workspaceOf = (id?: string): Obj => {
    const found = mcp.persistedWorkspaces().find(item => id === undefined || item['id'] === id);
    assert(found, 'Workspace is not persisted.');
    return found;
  };
  const graphOf = (id?: string) => rows(object(workspaceOf(id)['serverState'])['connections']);
  const cabling = async (action: 'create' | 'edit', args: Obj): Promise<Obj> => {
    const { session, expectedRevision, ...change } = args;
    const reply = await call('dcsc_cabling_set', { session, expectedRevision, changes: [{ action, ...change }] });
    return { ...object(rows(reply['results'])[0]), revision: reply['revision'] };
  };
  const detail = async (workspace: string, revision: number, index = 0): Promise<Obj> => {
    const page = await call('dcsc_cabling_get', { session: workspace, expectedRevision: revision, path: ['connections', String(index)], offset: 0, limit: 50 });
    return Object.fromEntries(rows(page['items']).filter(item => 'value' in item).map(item => [String(item['key']), item['value']]));
  };
  const findCableChoice = async (args: Obj, part: string): Promise<Obj> => {
    const { session, expectedRevision, ...candidate } = args;
    let request: Obj = { session, expectedRevision, candidate, path: ['choices'], offset: 0, limit: 50 };
    for (let page = 0; page < MAX_CHOICE_PAGES; page++) {
      const result = await call('dcsc_cabling_get', request);
      if (rows(result['items']).some(item => object(item['value'])['part'] === part)) return result;
      const next = object(result['next']);
      assert.equal(next['tool'], 'dcsc_cabling_get', `Expected cable ${part} is unavailable.`);
      request = object(next['arguments']);
    }
    throw new Error('Cable-choice pagination did not terminate.');
  };
  const restartAndCompare = async (label: string) => {
    const before = mcp.persistedWorkspaces();
    await mcp.killAndRestart();
    return () => compare(label, before, mcp.persistedWorkspaces());
  };
  const exportXml = async (workspace: string, fileName: string) => {
    const exported = await call('dcsc_export', { kind: 'reports', session: workspace, fileName, fileTypes: ['XML', 'QUOTE'] });
    const xml = String(exported['xml']);
    assert((await readFile(xml)).length > 0, `${fileName} export returned no XML.`);
    return { xml, exported };
  };
  const physicalCables = (workspace: Obj, id: string) => {
    const physical = rows(workspace['rackArea']).flatMap(rack => rows(rack['rackItems'])).concat(rows(workspace['nonRackArea'])).find(item => item['id'] === id);
    assert(physical, 'Replacement lost its physical destination.');
    return rows(physical['features']).filter(section => section['name'] === 'ETHERNET_CABLE').flatMap(section => rows(section['results']));
  };

  const workspace = await step('import', async () => {
    const imported = await call('dcsc_import', { filePath: seed, solutionMode: HPC_MODE });
    assert(imported['session'], 'Import returned no workspace.');
    return String(imported['session']);
  });
  const configurationBy = (predicate: (item: Obj) => boolean) => rows(workspaceOf(workspace)['configurations']).find(predicate)!;
  const serverConfiguration = () => configurationBy(item => object(item['raw'])['code'] === '7D73CTOHWW');

  if (freshStorage) await step('fresh-storage-definition', async () => {
    const catalog = await call('dcsc_network_get', { session: workspace, collection: 'storageControllers', limit: 100, fields: ['option', 'featureCode'] });
    const choice = rows(catalog['items']).find(item => item['option'] === '7Y70CTOHWW' && !item['featureCode']);
    assert(choice?.['id'], 'Native DE2000H base controller choice is unavailable.');
    await call('dcsc_storage_set', { session: workspace, change: { action: 'add', name: 'Fresh Manual Storage', controllerId: choice['id'], switchId: 'direct-attached', expansionQuantity: 0 } });
    const opened = await call('dcsc_storage_set', { session: workspace, change: { action: 'customize', component: 'controller', name: 'Fresh Manual Storage' } });
    assert.equal(opened['created'], true);
    freshControllerId = String(opened['controllerId']);
  });

  if (prepareStorage) await step('storage-hardware-preparation', async () => {
    const controller = configurationBy(item => freshStorage ? item['configurationId'] === freshControllerId : object(item['raw'])['code'] === '7Y70CTOHWW');
    const selected = (item: Obj) => rows(object(item['raw'])['tabs']).flatMap(tab => rows(tab['subTabs'])).flatMap(tab => rows(tab['sections']));
    if (!freshStorage) assert.equal(selected(controller).flatMap(section => rows(section['results'])).find(result => result['code'] === 'B4B2')?.['quantity'], 8);
    assert(!selected(controller).flatMap(section => rows(section['results'])).some(result => result['code'] === storageCablePart && Number(result['quantity']) > 0));
    await call('dcsc_configure', { session: controller['id'], changes: [
      ...(freshStorage ? [{ section: 'NETWORK_ADAPTER', code: 'B4B7', quantity: 2 }, { section: 'NETWORK_ADAPTER_CFC', code: 'B4DC', quantity: 1 }] : []),
      { section: 'MECH_TRANSCEIVER', code: 'B4B2', quantity: 0 },
      { section: 'DAC_SFP_CABLE', code: storageCablePart, quantity: 2 },
      ...(mixedStorage ? [{ section: 'DAC_SFP_CABLE', code: 'A1PJ', quantity: 2 }] : []),
    ] });
    const prepared = configurationBy(item => item['id'] === controller['id']);
    const sections = selected(prepared);
    assert.deepEqual(sections.flatMap(section => rows(section['errors'])), []);
    const results = sections.flatMap(section => rows(section['results']));
    assert.equal(results.find(result => result['code'] === storageCablePart)?.['quantity'], 2);
    assert(!results.some(result => result['code'] === 'B4B2' && Number(result['quantity']) > 0));
  });

  if (freshStorage) await step('fresh-storage-placement', async () => {
    const rackId = rows(workspaceOf(workspace)['rackArea'])[0]?.['id'];
    assert(rackId);
    const placed = await call('dcsc_storage_set', { session: workspace, change: { action: 'place', name: 'Fresh Manual Storage', rackId } });
    const controller = rows(placed['placements']).find(item => item['role'] === 'controller');
    assert(controller);
    freshPhysicalId = String(controller['physicalId']);
    assert(freshPhysicalId && freshPhysicalId !== freshControllerId);
    if (sharedStorage) {
      const second = await call('dcsc_storage_set', { session: workspace, change: { action: 'place', name: 'Fresh Manual Storage', rackId } });
      assert(rows(second['templates']).every(item => item['created'] === false));
      const instance = rows(second['placements']).find(item => item['role'] === 'controller');
      assert.equal(instance?.['templateId'], freshControllerId);
      secondStoragePhysicalId = String(instance?.['physicalId']);
      assert(secondStoragePhysicalId !== freshPhysicalId && secondStoragePhysicalId !== freshControllerId);
    }
    await call('dcsc_storage_set', { session: serverConfiguration()['id'], change: { action: 'assign', networkName: 'Fresh Manual Storage', autoConnect: false } });
  });

  if (managedDestination) await step('storage-topology-setup', async () => {
    const source = serverConfiguration();
    assert.deepEqual(object(source['raw'])['selectedTopologies'] ?? {}, {});
    await call('dcsc_network_set', { session: source['id'], change: { kind: 'topology', topology: '10GbE_Copper', networkName: object(source['raw'])['selectedStorageNetwork'], ports: ['SFP28:1'], autoConnect: false } });
  });

  if (linkedDestination) await step('linked-destination-clone', async () => {
    const example = object(object(JSON.parse(await readFile(ROW_SEED, 'utf8')))['requestedManualRow']);
    const destination = configurationBy(item => item['configurationId'] === example['destinationId']);
    assert(destination);
    await call('dcsc_rack_edit', { action: 'clone', session: destination['id'], count: 1, placement: 'same-rack' });
  });

  if (data100) await step('100g-setup', async () => {
    const source = serverConfiguration();
    await call('dcsc_configure', { session: source['id'], changes: [{ section: 'OCPCARD', code: breakout ? 'BPPW' : 'BPPX', quantity: 1 }] });
    await call('dcsc_network_set', { session: workspace, change: { kind: 'preferences', autoConnect: false, selections: [{
      networkTypeId: 'network-type:10G', topology: '100GbE_Copper',
      mainDeviceId: 'network-device:7D5FCTOKWW:BUZ2:NVIDIA SN3420 25GbE Managed Switch with Cumulus (PSE)',
      ...(breakout ? { cableId: 'cable:AV22:7Z57A03564:1jt0u82' } : {}),
    }] } });
    await call('dcsc_network_set', { session: source['id'], change: { kind: 'topology', topology: '100GbE_Copper', networkName: '10G', ports: [breakout ? 'SFP28:1' : 'QSFP56:1'], autoConnect: false } });
    if (linkedSource) await call('dcsc_rack_edit', { action: 'clone', session: source['id'], count: 1, placement: 'same-rack' });
    await call('dcsc_auto_connect', { session: workspace, settings: { autoAddSwitch: true, autoAddPDU: false } });
  });

  const revision = await step('inspect', async () => {
    const root = await call('dcsc_cabling_get', { session: workspace, path: [], offset: 0, limit: 20 });
    const value = Number(root['revision']);
    assert(Number.isInteger(value) && value > 0, 'Inspection returned no workspace revision.');
    return value;
  });

  if (create) return runCreate();
  if (mode.collision) return runCollision();
  if (mode.shared) return runShared();
  return runReplace();

  async function runCreate(): Promise<void> {
    const before = workspaceOf(workspace);
    const original = rows(object(before['serverState'])['connections']);
    const expectedOriginal = managedDestination ? 0 : managedSource ? 1 : linkedSource ? 5 : data100 ? 3 : 2;
    assert.equal(original.length, expectedOriginal);
    const managedItem = rows(before['rackArea']).flatMap(rack => rows(rack['rackItems'])).find(item => item['code'] === '7DHNCTO1WW');
    const serverRow = rows(before['configurations']).find(item => object(item['raw'])['code'] === '7D73CTOHWW');
    const example: Obj = managedDestination ? {
      sourceId: serverRow?.['configurationId'],
      destinationId: freshPhysicalId ?? rows(before['rackArea']).flatMap(rack => rows(rack['rackItems'])).find(item => item['code'] === '7Y70CTOHWW')?.['id'],
      network: object(serverRow?.['raw'])['selectedStorageNetwork'], topology: '10GbE_Copper',
    } : managedSource ? { ...original[0], sourceId: managedItem?.['id'] } : data100 ? original.find(row => row['topology'] === '100GbE_Copper')!
      : object(object(JSON.parse(await readFile(ROW_SEED, 'utf8')))['requestedManualRow']);
    assert(example);
    const newPart = managedDestination ? storageCablePart : managedSource ? '3801' : breakout ? 'AV22' : data100 ? 'AV1Z' : linkedDestination ? 'AVFQ' : '3791';
    const args = { ...(breakout ? { connectionType: 'breakout-4' } : {}), session: workspace, expectedRevision: revision, network: example['network'], topology: example['topology'],
      source: { configurationId: example['sourceId'], portName: managedDestination ? 'SFP28' : managedSource ? 'RJ45 mgmt' : breakout ? 'SFP28' : data100 ? 'QSFP56' : 'RJ45', portNumber: data100 ? '2' : '1' },
      destination: { configurationId: example['destinationId'], portName: managedDestination ? 'SFP+' : data100 ? 'QSFP28' : 'RJ45', portNumber: managedDestination ? '1' : data100 ? '60' : '20' } };
    const sourceArgs = args.source as Obj;
    const destinationArgs = args.destination as Obj;

    let state = await step('native-create', async () => {
      const options = await findCableChoice(args, newPart);
      assert(JSON.stringify(options).includes(newPart), 'Expected cable choice is unavailable.');
      if (data100 && !breakout) {
        const offered = rows(options['items']).map(item => object(item['value'])['part']);
        assert(!['AT2R', 'AV22', 'A1DL'].some(part => offered.includes(part)), '100 GbE point-to-point discovery offered a wrong-speed or breakout cable.');
      }
      const created = await cabling('create', { ...args, cablePart: newPart, pinExistingRoutes: true });
      assert.equal(created['additionalConnectionCount'], linkedSource ? 1 : 0);
      assert.equal((created['sourceConfigurationIds'] as string[]).length, linkedSource ? 2 : 1);
      const pinCount = original.filter(row => row['type'] === 'AUTO' && row['subType'] === 'NETWORK').length;
      assert(managedDestination ? pinCount === 0 : pinCount > 0);
      assert.equal(created['pinnedConnectionCount'], pinCount);
      const accepted = workspaceOf(workspace);
      const graph = rows(object(accepted['serverState'])['connections']);
      if (linkedSource) {
        const dependency = object(object(accepted['serverState'])['cloneDependency']);
        const group = Object.values(dependency).find(ids => Array.isArray(ids) && ids.includes(example['sourceId'])) as string[] | undefined;
        assert(group?.length === 2, 'Linked source group was lost.');
        const members = rows(accepted['configurations']).filter(item => group.includes(String(item['configurationId'])));
        assert.equal(members.length, 2);
        for (const member of members) {
          const selectedTopology = object(object(object(member['raw'])['selectedTopologies'])[String(args.network)]);
          assert.equal(selectedTopology['networkTechnology'], args.topology);
          assert.deepEqual(rows(selectedTopology['selectedConnectors']).map(item => `${item['port']}:${item['portNumber']}`).sort(), ['QSFP56:1', 'QSFP56:2']);
        }
        compare('manual-creation-keeps-clone-ownership', object(before['serverState'])['cloneDependency'], dependency);
      }
      assert.equal(graph.length, original.length + (linkedSource ? 2 : 1));
      assertNativeConnectionsRetained(original.map(row => ({ ...row, type: 'MANUAL' })), graph);
      const target = rows(accepted['configurations']).find(item => item['configurationId'] === (freshControllerId ?? example['destinationId']))!;
      if (linkedDestination) {
        const dependency = object(object(accepted['serverState'])['cloneDependency']);
        const group = Object.values(dependency).find(ids => Array.isArray(ids) && ids.includes(example['destinationId'])) as string[] | undefined;
        assert(group?.length === 2);
        for (const id of group) {
          const member = rows(accepted['configurations']).find(item => item['configurationId'] === id)!;
          assert.equal(selectedResults(object(member['raw']), 'ETHERNET_CABLE').find(result => result['code'] === newPart)?.['quantity'], 1);
        }
      }
      const section = managedDestination ? 'DAC_SFP_CABLE' : data100 ? 'QSFP+_AND_DAC_CABLES' : 'ETHERNET_CABLE';
      assert.equal(selectedQuantity(object(target['raw']), section, newPart), linkedSource ? 4 : managedDestination || data100 ? 2 : 1);
      return { revision: Number(created['revision']), graph, accepted };
    });

    if (linkedDestination) state = await step('linked-destination-second-member', async () => {
      const dependency = object(object(state.accepted['serverState'])['cloneDependency']);
      const group = Object.values(dependency).find(ids => Array.isArray(ids) && ids.includes(example['destinationId'])) as string[];
      const sourceCode = object(rows(state.accepted['configurations']).find(item => item['configurationId'] === example['sourceId'])!['raw'])['code'];
      const otherSource = rows(state.accepted['configurations']).find(item => item['configurationId'] !== example['sourceId'] && object(item['raw'])['code'] === sourceCode)!;
      assert(otherSource);
      const secondArgs = { ...args, expectedRevision: state.revision, source: { ...sourceArgs, configurationId: otherSource['configurationId'] },
        destination: { ...destinationArgs, configurationId: group.find(id => id !== example['destinationId'])! } };
      assert(JSON.stringify(await findCableChoice(secondArgs, newPart)).includes(newPart));
      const second = await cabling('create', { ...secondArgs, cablePart: newPart, pinExistingRoutes: true });
      assert.deepEqual(new Set(second['destinationConfigurationIds'] as string[]), new Set(group));
      const accepted = workspaceOf(workspace);
      const graph = rows(object(accepted['serverState'])['connections']);
      assert.equal(graph.length, state.graph.length + 1);
      assertNativeConnectionsRetained(state.graph, graph);
      for (const id of group) {
        const member = rows(accepted['configurations']).find(item => item['configurationId'] === id)!;
        assert.equal(selectedResults(object(member['raw']), 'ETHERNET_CABLE').find(result => result['code'] === newPart)?.['quantity'], 1,
          'One route on each linked destination must not select two cables per product.');
      }
      return { revision: Number(second['revision']), graph, accepted };
    });

    if (breakout) state = await step('breakout-second-branch', async () => {
      const secondArgs = { ...args, expectedRevision: state.revision, source: { ...sourceArgs, portNumber: '3' } };
      await findCableChoice(secondArgs, newPart);
      const second = await cabling('create', { ...secondArgs, cablePart: newPart, pinExistingRoutes: true });
      const accepted = workspaceOf(workspace);
      const graph = rows(object(accepted['serverState'])['connections']);
      assert.equal(graph.length, state.graph.length + 1);
      assertNativeConnectionsRetained(state.graph, graph);
      const branches = graph.filter(row => row['destinationId'] === destinationArgs['configurationId'] && row['destinationPortNumber'] === destinationArgs['portNumber']);
      assert.equal(branches.length, 2);
      assert(branches.every(row => row['category'] === 'BREAKOUT' && row['divider'] === 4 && row['type'] === 'MANUAL'));
      const destination = rows(accepted['configurations']).find(item => item['configurationId'] === destinationArgs['configurationId'])!;
      assert.equal(selectedQuantity(object(destination['raw']), 'QSFP+_AND_DAC_CABLES', newPart), 2, 'Three branches at two destination ports require two cables.');
      return { revision: Number(second['revision']), graph, accepted };
    });

    if (mode.breakoutReplace) state = await step('breakout-shared-replacement', async () => {
      const rowIndex = state.graph.findIndex(row => row['sourceId'] === sourceArgs['configurationId'] && row['sourcePortName'] === 'SFP28' && row['sourcePortNumber'] === '2');
      assert(rowIndex >= 0);
      const connection = await detail(workspace, state.revision, rowIndex);
      const replacement = await cabling('edit', { session: workspace, expectedRevision: state.revision, connectionId: connection['id'], cablePart: 'AV23' });
      assert.equal(rows(replacement['updatedConnections']).length, 1, 'Both branches of the selected physical cable must change.');
      const expected = state.graph.map(row => row['destinationId'] === destinationArgs['configurationId'] && row['destinationPortNumber'] === destinationArgs['portNumber']
        ? { ...row, cablePart: 'AV23', type: 'MANUAL' } : row);
      const accepted = workspaceOf(workspace);
      const graph = rows(object(accepted['serverState'])['connections']);
      assert.equal(graph.length, expected.length);
      assertNativeConnectionsRetained(expected, graph);
      const destination = rows(accepted['configurations']).find(item => item['configurationId'] === destinationArgs['configurationId'])!;
      for (const part of ['AV22', 'AV23']) assert.equal(selectedQuantity(object(destination['raw']), 'QSFP+_AND_DAC_CABLES', part), 1);
      return { revision: Number(replacement['revision']), graph, accepted };
    });

    if (sharedStorage) state = await step('shared-storage-second-connection', async () => {
      assert(secondStoragePhysicalId);
      const secondArgs = { ...args, expectedRevision: state.revision, source: { ...sourceArgs, portNumber: '2' }, destination: { ...destinationArgs, configurationId: secondStoragePhysicalId } };
      const secondPart = mixedStorage && !replacementStorage ? 'A1PJ' : newPart;
      await findCableChoice(secondArgs, secondPart);
      const second = await cabling('create', { ...secondArgs, cablePart: secondPart, pinExistingRoutes: true });
      assert.deepEqual(second['destinationConfigurationIds'], [freshControllerId]);
      const accepted = workspaceOf(workspace);
      const graph = rows(object(accepted['serverState'])['connections']);
      assert.equal(graph.length, state.graph.length + 1);
      assertNativeConnectionsRetained(state.graph, graph);
      assert(graph.some(row => row['destinationId'] === secondStoragePhysicalId && row['cablePart'] === secondPart));
      const controller = rows(accepted['configurations']).find(item => item['configurationId'] === freshControllerId)!;
      assert.equal(selectedQuantity(object(controller['raw']), 'DAC_SFP_CABLE', newPart), 2, 'Shared template must retain its spare cables.');
      return { revision: Number(second['revision']), graph, accepted };
    });

    if (replacementStorage) state = await step('shared-storage-cable-replacement', async () => {
      const row = await detail(workspace, state.revision, 0);
      const untouched = state.graph.filter(item => item['destinationId'] !== object(row['destination'])['configurationId']);
      const changed = await cabling('edit', { session: workspace, connectionId: row['id'], cablePart: 'A1PJ', cableQuantities: { oldPart: 2, newPart: 2 }, expectedRevision: state.revision });
      const accepted = workspaceOf(workspace);
      const graph = rows(object(accepted['serverState'])['connections']);
      assert.equal(graph.length, 2);
      assertNativeConnectionsRetained(untouched, graph);
      assert(graph.some(item => item['destinationId'] === object(row['destination'])['configurationId'] && item['cablePart'] === 'A1PJ'));
      return { revision: Number(changed['revision']), graph, accepted };
    });

    const exported = await step('native-create-restart-export', async () => {
      const verify = await restartAndCompare('creation-survives-restart');
      await detail(workspace, state.revision, 0);
      verify();
      const { xml, exported } = await exportXml(workspace, 'native-manual-created');
      if (breakout) {
        assert.equal(exported['breakoutBranchesAtRisk'], state.graph.filter(row => row['category'] === 'BREAKOUT').length);
        assert.match(String(exported['breakoutReimportWarning']), /website reimport/);
      }
      return xml;
    });

    let websiteXml = exported;
    let websiteWorkspace = state.accepted;
    if (breakout || managedSource || managedDestination) {
      const recovered = await step('manual-mcp-reimport', async () => {
        const imported = await call('dcsc_import', { filePath: exported, solutionMode: HPC_MODE });
        const recoveredId = String(imported['session']);
        let recoveredWorkspace = workspaceOf(recoveredId);
        let recoveredGraph = rows(object(recoveredWorkspace['serverState'])['connections']);
        assert.equal(recoveredGraph.length, state.graph.length);
        assertNativeConnectionsRetained(state.graph, recoveredGraph);
        if (replacementStorage) {
          const index = recoveredGraph.findIndex(row => row['cablePart'] === 'A1PJ');
          assert(index >= 0);
          const existing = await detail(recoveredId, Number(recoveredWorkspace['revision']), index);
          await cabling('edit', { session: recoveredId, connectionId: existing['id'], cablePart: 'A1PH', cableQuantities: { oldPart: 2, newPart: 2 }, expectedRevision: Number(recoveredWorkspace['revision']) });
          const expected = recoveredGraph.map((row, i) => i === index ? { ...row, cablePart: 'A1PH', type: 'MANUAL' } : row);
          recoveredWorkspace = workspaceOf(recoveredId);
          recoveredGraph = rows(object(recoveredWorkspace['serverState'])['connections']);
          assert.equal(recoveredGraph.length, expected.length);
          assertNativeConnectionsRetained(expected, recoveredGraph);
        }
        if (sharedStorage) {
          for (const physicalId of [freshPhysicalId, secondStoragePhysicalId]) {
            const member = rows(recoveredWorkspace['configurations']).find(item => item['configurationId'] === physicalId);
            assert(member, 'Both physical storage products must survive import.');
            const sections = rows(object(member['raw'])['tabs']).flatMap(tab => rows(tab['subTabs'])).flatMap(tab => rows(tab['sections']));
            assert.deepEqual(sections.flatMap(section => rows(section['errors'])), []);
            assert.equal(selectedQuantity(object(member['raw']), 'DAC_SFP_CABLE', newPart), 2);
            if (mixedStorage) assert.equal(selectedQuantity(object(member['raw']), 'DAC_SFP_CABLE', 'A1PJ'), 2);
          }
        }
        const destination = rows(recoveredWorkspace['configurations']).find(item => item['configurationId'] === destinationArgs['configurationId'])!;
        const section = managedDestination ? 'DAC_SFP_CABLE' : managedSource ? 'ETHERNET_CABLE' : 'QSFP+_AND_DAC_CABLES';
        if (mode.breakoutReplace) for (const part of ['AV22', 'AV23']) assert.equal(selectedQuantity(object(destination['raw']), section, part), 1);
        else assert.equal(selectedQuantity(object(destination['raw']), section, newPart), managedSource ? 1 : 2);
        const verify = await restartAndCompare('recovered-connection-survives-restart');
        const recoveredDetail = await detail(recoveredId, Number(recoveredWorkspace['revision']), 0);
        verify();
        if (sharedStorage) {
          const persisted = JSON.stringify(mcp.persistedWorkspaces());
          const choices = await call('dcsc_cabling_get', { session: recoveredId, expectedRevision: Number(recoveredWorkspace['revision']), refreshConnectionId: recoveredDetail['id'], path: ['connections', '0', 'compatibleCables'], offset: 0, limit: 50 });
          assert(rows(choices['items']).some(item => object(item['value'])['part'] === 'A1PJ'));
          compare('fresh-cable-discovery-leaves-state', JSON.parse(persisted), mcp.persistedWorkspaces());
        }
        const recoveredExport = await exportXml(recoveredId, 'recovered-breakout');
        return { xml: recoveredExport.xml, workspace: recoveredWorkspace, graph: recoveredGraph };
      });
      if (sharedStorage) { websiteXml = recovered.xml; websiteWorkspace = recovered.workspace; }
    }

    await step('native-create-website-reimport', async () => {
      const website = await websiteImport(h, websiteXml, 'native-create', { mode: HPC_MODE_LABEL, collectLayouts: true });
      const commercial = groupedCommercial(website.payload, websiteWorkspace);
      compare('website-commercial-rows', commercial.native, commercial.mcp);
      const restored = connectionIdentity(rows(website.layouts.at(-1)?.['connections']));
      assert(restored.length > 0, 'Website produced no restored layout.');
      const mine = connectionIdentity(rows(object(websiteWorkspace['serverState'])['connections']));
      const degraded: ExpectedDifference[] = breakout ? mine.flatMap((row, index) => row['category'] === 'BREAKOUT' ? [
        { path: `$[${index}].category`, web: 'P2P', mcp: 'BREAKOUT', doc: BREAKOUT_WEBSITE_DEFECT },
        { path: `$[${index}].divider`, web: 1, mcp: 4, doc: BREAKOUT_WEBSITE_DEFECT }] : []) : [];
      compare('website-restores-graph', restored, mine, { expectedDifferences: degraded });
    });

    if (managedSource) await step('managed-source-clear-ports', async () => {
      const source = rows(state.accepted['configurations']).find(item => object(item['raw'])['code'] === '7DHNCTO1WW')!;
      assert(source, 'Managed source template is missing.');
      const cleared = await call('dcsc_network_set', { session: source['id'], change: { kind: 'topology', topology: args.topology, networkName: args.network, ports: [], autoConnect: true } });
      assert.equal(cleared['connectionGraphStale'], false);
      assert.deepEqual(object(object(cleared['selectedTopologies'])[String(args.network)])['selectedConnectors'], []);
      const clearedGraph = graphOf(workspace);
      assert.equal(clearedGraph.length, 1);
      assert(!clearedGraph.some(row => row['sourcePart'] === '7DHNCTO1WW'));
      assert.equal(clearedGraph[0]!['sourceId'], original[0]!['sourceId']);
      const verify = await restartAndCompare('port-deselection-survives-restart');
      await detail(workspace, Number(workspaceOf(workspace)['revision']), 0);
      verify();
      const clearedExport = await exportXml(workspace, 'cleared-managed-source');
      const reimported = await call('dcsc_import', { filePath: clearedExport.xml, solutionMode: HPC_MODE });
      const importedGraph = graphOf(String(reimported['session']));
      assert.equal(importedGraph.length, clearedGraph.length);
      assertNativeConnectionsRetained(clearedGraph, importedGraph);
    });
  }

  async function runCollision(): Promise<void> {
    const capture = object(JSON.parse(await readFile(COLLISION_CAPTURE, 'utf8')));
    const expectedBefore = rows(capture['before']);
    const expectedAfter = rows(capture['after']);
    assert.equal(capture['calculateDistanceCalls'], 0, 'Captured native same-component port swap unexpectedly recalculates distance.');
    const swapped = await step('collision-swap', async () => {
      const initial = [await detail(workspace, revision, 0), await detail(workspace, revision, 1)];
      const destinationId = String(object(initial[0]!['destination'])['configurationId']);
      assert(destinationId && initial.every(row => object(row['destination'])['configurationId'] === destinationId), 'Collision seed rows do not share one physical destination.');
      const edited = initial.find(row => object(row['destination'])['portNumber'] === '2');
      const conflicting = initial.find(row => object(row['destination'])['portNumber'] === '3');
      assert(edited && conflicting, 'Collision seed must occupy destination ports 2 and 3.');
      assert.deepEqual([object(edited['source'])['location'], object(conflicting['source'])['location']], expectedBefore.map(row => row['sourceLocation']));
      const beforeCables = [object(edited['cable'])['part'], object(conflicting['cable'])['part']];
      const beforeDistances = [edited['totalDistance'], conflicting['totalDistance']];
      const result = await cabling('edit', { session: workspace, connectionId: String(edited['id']), expectedRevision: revision, destination: { configurationId: destinationId, portName: 'RJ45', portNumber: '3' } });
      const displaced = rows(result['swappedConnections']);
      assert.equal(displaced.length, 1, 'Occupied-port edit did not report exactly one displaced connection.');
      assert.equal(object(object(result['connection'])['destination'])['portNumber'], expectedAfter[0]!['destinationPortNumber']);
      assert.equal(object(displaced[0]!['destination'])['portNumber'], expectedAfter[1]!['destinationPortNumber']);
      assert.equal(object(result['connection'])['type'], 'MANUAL');
      assert.equal(displaced[0]!['type'], 'MANUAL');
      assert.equal(object(result['connection'])['compatibleCables'], undefined, 'Collision response leaked the compatible cable catalog.');
      assert.equal(displaced[0]!['compatibleCables'], undefined, 'Displaced response leaked the compatible cable catalog.');
      const finals = graphOf(workspace);
      const finalEdited = finals.find(row => row['sourceLocation'] === expectedAfter[0]!['sourceLocation']);
      const finalDisplaced = finals.find(row => row['sourceLocation'] === expectedAfter[1]!['sourceLocation']);
      assert(finalEdited && finalDisplaced, 'Collision swap lost one of the native source rows.');
      compare('collision-ports-vs-browser-capture', expectedAfter.map(row => row['destinationPortNumber']), [finalEdited['destinationPortNumber'], finalDisplaced['destinationPortNumber']]);
      compare('collision-keeps-cables', beforeCables, [finalEdited['cablePart'], finalDisplaced['cablePart']]);
      compare('collision-keeps-distances', beforeDistances, [finalEdited['totalDistance'], finalDisplaced['totalDistance']]);
      assert(finals.every(row => row['type'] === 'MANUAL'), 'Collision swap did not mark both affected rows MANUAL.');
      return Number(result['revision']);
    });
    await step('collision-restart-export', async () => {
      const verify = await restartAndCompare('swap-survives-restart');
      const restarted = [await detail(workspace, swapped, 0), await detail(workspace, swapped, 1)];
      compare('restarted-destination-ports', ['2', '3'], restarted.map(row => object(row['destination'])['portNumber']).sort());
      verify();
      await exportXml(workspace, 'manual-cable-collision');
    });
  }

  async function runShared(): Promise<void> {
    const split = await step('shared-split', async () => {
      const initial = [await detail(workspace, revision, 0), await detail(workspace, revision, 1)];
      const sharedRows = initial.filter(row => object(row['cable'])['part'] === ORIGINAL_CABLE);
      assert.equal(sharedRows.length, 2, 'Native shared seed must contain two AVFT graph rows.');
      const [first, retained] = sharedRows as [Obj, Obj];
      const destinationId = String(object(first['destination'])['configurationId']);
      assert.equal(object(retained['destination'])['configurationId'], destinationId, 'Shared rows do not have the same physical destination.');
      const shared = workspaceOf(workspace);
      assert.equal(rows(object(shared['serverState'])['connections']).filter(row => row['cablePart'] === ORIGINAL_CABLE).length, 2);
      const sharedConfig = rows(shared['configurations']).find(item => item['configurationId'] === destinationId)!;
      assert.equal(selectedQuantity(object(sharedConfig['raw']), 'ETHERNET_CABLE', ORIGINAL_CABLE), 2, 'Import must reconcile the native graph into canonical AVFT quantity two.');
      assert.equal(physicalCables(shared, destinationId).find(result => result['code'] === ORIGINAL_CABLE)?.['quantity'], 2);
      const result = await cabling('edit', { session: workspace, connectionId: String(first['id']), cablePart: 'AVFU', expectedRevision: revision });
      const after = workspaceOf(workspace);
      compare('split-leaves-one-row-per-cable', [ORIGINAL_CABLE, 'AVFU'], rows(object(after['serverState'])['connections']).map(row => row['cablePart']).sort());
      const config = rows(after['configurations']).find(item => item['configurationId'] === destinationId)!;
      compare('split-canonical-quantities', { [ORIGINAL_CABLE]: 1, AVFU: 1 },
        { [ORIGINAL_CABLE]: selectedQuantity(object(config['raw']), 'ETHERNET_CABLE', ORIGINAL_CABLE), AVFU: selectedQuantity(object(config['raw']), 'ETHERNET_CABLE', 'AVFU') });
      const physical = physicalCables(after, destinationId);
      compare('split-physical-quantities', { [ORIGINAL_CABLE]: 1, AVFU: 1 },
        { [ORIGINAL_CABLE]: physical.find(item => item['code'] === ORIGINAL_CABLE)?.['quantity'], AVFU: physical.find(item => item['code'] === 'AVFU')?.['quantity'] });
      const price = object(result['configurationChange']);
      assert.equal(price['configurationId'], destinationId);
      assert.equal(price['priceScope'], 'editable-configuration');
      return Number(result['revision']);
    });
    await step('shared-restart-export', async () => {
      const verify = await restartAndCompare('shared-state-survives-restart');
      const restarted = [await detail(workspace, split, 0), await detail(workspace, split, 1)];
      compare('restarted-cable-parts', [ORIGINAL_CABLE, 'AVFU'], restarted.map(row => object(row['cable'])['part']).sort());
      verify();
      const { xml } = await exportXml(workspace, 'manual-cable-shared');
      const content = await readFile(xml, 'utf8');
      assert(content.includes(ORIGINAL_CABLE) && content.includes('AVFU'), 'Export XML omitted a shared cable part.');
    });
  }

  async function runReplace(): Promise<void> {
    const replaced = await step('replace', async () => {
      const before = await detail(workspace, revision);
      assert.equal(object(before['cable'])['part'], ORIGINAL_CABLE, 'Seed current cable is not captured AVFT.');
      const destinationId = String(object(before['destination'])['configurationId']);
      const choices = await call('dcsc_cabling_get', { session: workspace, expectedRevision: revision, path: ['connections', '0', 'compatibleCables'], offset: 0, limit: 50 });
      assert(rows(choices['items']).map(item => object(item['value'])).some(choice => choice['part'] === cablePart), `Captured ${cablePart} compatible cable is unavailable.`);
      const priceBefore = Number(object(rows(workspaceOf(workspace)['configurations']).find(item => item['configurationId'] === destinationId)!['raw'])['totalPrice']);
      const result = await cabling('edit', { session: workspace, connectionId: String(before['id']), cablePart, expectedRevision: revision });
      assert.equal(object(result['connection'])['compatibleCables'], undefined, 'Mutation response leaked the compatible cable catalog.');
      assert.equal(object(object(result['connection'])['cable'])['part'], cablePart);
      const reported = object(result['configurationChange']);
      assert.equal(reported['configurationId'], destinationId);
      assert.equal(reported['priceScope'], 'editable-configuration');
      assert.equal(reported['currency'], 'USD');
      const after = workspaceOf(workspace);
      const connection = rows(object(after['serverState'])['connections'])[0]!;
      assert.equal(connection['cablePart'], cablePart);
      assert.equal(connection['type'], 'MANUAL');
      const raw = object(rows(after['configurations']).find(item => item['configurationId'] === destinationId)!['raw']);
      const priceAfter = Number(raw['totalPrice']);
      assert(Number.isFinite(priceBefore) && Number.isFinite(priceAfter), 'Authoritative cable prices are unavailable.');
      if (cablePart === '3802') assert(priceAfter < priceBefore, `Expected the captured price decrease; before=${priceBefore} after=${priceAfter}.`);
      compare('reported-price-change', { previousTotalPrice: priceBefore, totalPrice: priceAfter }, { previousTotalPrice: reported['previousTotalPrice'], totalPrice: reported['totalPrice'] });
      assert.equal(selectedResults(raw, 'ETHERNET_CABLE').filter(item => item['code'] === cablePart).length, 1);
      assert.equal(selectedResults(raw, 'ETHERNET_CABLE').filter(item => item['code'] === ORIGINAL_CABLE).length, 0);
      const physical = physicalCables(after, destinationId);
      assert.equal(physical.find(item => item['code'] === cablePart)?.['quantity'], 1, 'Replacement did not reach physical destination features.');
      assert(!physical.some(item => item['code'] === ORIGINAL_CABLE), 'Physical destination retained the old cable.');
      if (cablePart === 'AVFU') {
        assert.equal(physical.find(item => item['code'] === 'AVFU')?.['forAutoConnect'], true);
        assert.equal(physical.find(item => item['code'] === '3802')?.['quantity'], 1, 'Absent-new-code replacement removed the independent pre-existing cable.');
      }
      return Number(result['revision']);
    });
    await step('restart-export', async () => {
      const verify = await restartAndCompare('replacement-survives-restart');
      assert.equal(object((await detail(workspace, replaced))['cable'])['part'], cablePart);
      verify();
      const { xml } = await exportXml(workspace, 'manual-cable-replacement');
      assert((await readFile(xml, 'utf8')).includes(cablePart), 'Export XML omitted the accepted cable part.');
    });
  }
}
