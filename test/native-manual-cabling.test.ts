import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { countNativePhysicalCables, assertNativeConnectionsRetained, planNativeManualCableSelection, stageNativeManualConnection, seedNativeManualRoutes, selectNativeManualSourcePort, selectNativeManualSourceGroup, stageNativeManualCableQuantity, importedManualCableSelections, filterNativeManualCableChoices } from '../src/domain/nativeManualCabling.js';
import type { ManualCablingInput } from '../src/domain/manualCabling.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/manual-row-seeding.json', import.meta.url), 'utf8'));
const row = fixture.requestedManualRow;
const cableCatalog = JSON.parse(readFileSync(new URL('./fixtures/parity/manual-cable-topology-catalog.json', import.meta.url), 'utf8')).cables;
it('intersects broad distance choices with topology and point-to-point cable metadata', () => {
  const distance = { totalDistance: 0.6, compatibleCables: cableCatalog.map((c: Record<string, unknown>) => ({
    featureCode: c['featureCode'], optionCode: c['option'], length: 1,
  })) };
  const before = structuredClone(distance);
  expect(filterNativeManualCableChoices(distance, '100GbE_Copper', cableCatalog)).toEqual({
    totalDistance: 0.6, compatibleCables: [distance.compatibleCables.find((c: Record<string, unknown>) => c['featureCode'] === 'AV1Z')],
  });
  expect(filterNativeManualCableChoices(distance, 'Management_Ethernet', cableCatalog)['compatibleCables'])
    .toEqual([distance.compatibleCables.find((c: Record<string, unknown>) => c['featureCode'] === '3791')]);
  expect(distance).toEqual(before);
  expect(filterNativeManualCableChoices({ compatibleCables: [{ featureCode: 'AV1Z', optionCode: 'wrong-option' }] }, '100GbE_Copper', cableCatalog)['compatibleCables']).toEqual([]);
  expect(filterNativeManualCableChoices(distance, 'unknown', cableCatalog)['compatibleCables']).toEqual([]);
});
it('pins only AUTO network routes with explicit opt-in and preserves every other field', () => {
  const rows = [{ ...row, type: 'AUTO' }, row, { ...row, type: 'AUTO', subType: 'POWER' }];
  const before = structuredClone(rows);
  expect(seedNativeManualRoutes(rows, false)).toEqual({ rows, pinnedConnectionCount: 0 });
  const pinned = seedNativeManualRoutes(rows, true);
  expect(pinned).toEqual({ rows: [{ ...rows[0], type: 'MANUAL' }, rows[1], rows[2]], pinnedConnectionCount: 1 });
  expect(rows).toEqual(before);
});
it('rejects silent regeneration, changed cables and missing duplicate graph rows', () => {
  expect(() => assertNativeConnectionsRetained([row], [{ ...row, type: 'AUTO' }])).toThrow(/did not retain/);
  expect(() => assertNativeConnectionsRetained([row], [{ ...row, cablePart: 'different' }])).toThrow(/did not retain/);
  expect(() => assertNativeConnectionsRetained([row, row], [row])).toThrow(/did not retain/);
  expect(() => assertNativeConnectionsRetained([row], [{ ...row, cablePrice: 10 }])).not.toThrow();
});
it.each([
  ['divider', 4],
  ['category', 'BREAKOUT'],
  ['subType', 'POWER'],
])('rejects native rewrites of connection %s even when endpoints and part match', (field, value) => {
  expect(() => assertNativeConnectionsRetained([row], [{ ...row, [field]: value }]))
    .toThrow(`${field}: requested`);
});
it('explains a native topology rewrite without blaming an already consumed matching row', () => {
  const requested = { ...row, topology: '100GbE_Copper', cablePart: 'AV1Z' };
  const rewritten = { ...requested, topology: '1GbE_Copper' };
  expect(() => assertNativeConnectionsRetained([requested], [rewritten]))
    .toThrow('topology: requested "100GbE_Copper", returned "1GbE_Copper"');
  expect(() => assertNativeConnectionsRetained([requested, requested], [requested]))
    .toThrow('DCSC did not retain the requested connection graph. Workspace was not committed.');
});
it('adds the manual source connector while retaining existing selections and network metadata', () => {
  const connector = { port: 'QSFP56', portNumber: '2', topologies: ['100GbE_Copper'], quantity: 1 };
  const first = { ...connector, portNumber: '1' };
  const raw = { connectors: [first, connector], selectedTopologies: {
    Data: { networkTechnology: '100GbE_Copper', selectedConnectors: [first], color: 'Grey' },
    Management: { networkTechnology: '1GbE_Copper' },
  } };
  const connection = { network: 'Data', topology: '100GbE_Copper', sourcePortName: 'QSFP56', sourcePortNumber: '2' };
  const before = structuredClone(raw);
  const updated = selectNativeManualSourcePort(raw, connection);
  expect(updated).toEqual({ ...raw.selectedTopologies, Data: { ...raw.selectedTopologies.Data, selectedConnectors: [first, connector] } });
  expect(selectNativeManualSourcePort({ ...raw, selectedTopologies: updated }, connection)).toEqual(updated);
  expect(raw).toEqual(before);
  expect(() => selectNativeManualSourcePort(raw, { ...connection, sourcePortNumber: '9' })).toThrow(/missing or ambiguous/);
});
it('stages existing physical cable quantity so workspace derive cannot restore the old count', () => {
  const input: ManualCablingInput = { configurations: [], connections: [], rackArea: [{ id: 'rack', rackItems: [
    { id: 'switch', features: [{ name: 'DAC', results: [
      { code: 'AV1Z', quantity: 1, forAutoConnect: true }, { code: 'spare', quantity: 3 },
    ] }] },
  ] }] };
  const before = structuredClone(input);
  const plan = { configurationId: 'switch', section: 'DAC', code: 'AV1Z', previousQuantity: 1, requiredQuantity: 2, quantity: 2 };
  const staged = stageNativeManualCableQuantity(input, plan);
  expect(staged.rackArea[0]!.rackItems).toMatchObject([{ features: [{ results: [
    { code: 'AV1Z', quantity: 2, forAutoConnect: true }, { code: 'spare', quantity: 3 },
  ] }] }]);
  expect(input).toEqual(before);
  expect(() => stageNativeManualCableQuantity(input, { ...plan, configurationId: 'missing' })).toThrow(/placement/);
  expect(stageNativeManualCableQuantity(input, { ...plan, code: 'new' }).rackArea).toEqual(input.rackArea);
});
function setup() {
  const configurations = ['source', 'destination'].map(side => ({ id: row[`${side}Id`], code: row[`${side}Part`],
    connectors: [{ port: row[`${side}PortName`], portNumber: row[`${side}PortNumber`], topologies: [row.topology] }] }));
  const input: ManualCablingInput = { connections: [], configurations,
    rackArea: [{ id: 'rack', rackItems: configurations.map((c, index) => ({ id: c.id, code: c.code,
      position: index === 0 ? 2 : 6, description: row[index === 0 ? 'sourceItem' : 'destinationItem'] })) }],
    floorItems: [{ sourceId: 'rack', coordinate: 'A1' }] };
  const request = { network: row.network, topology: row.topology, cablePart: row.cablePart,
    source: { configurationId: row.sourceId, portName: row.sourcePortName, portNumber: row.sourcePortNumber },
    destination: { configurationId: row.destinationId, portName: row.destinationPortName, portNumber: row.destinationPortNumber },
    distance: structuredClone(row.cableDistance) };
  return { input, request };
}
it('constructs a complete native row without an existing connection template', () => {
  const { input, request } = setup(); const before = structuredClone({ input, request });
  const result = stageNativeManualConnection(input, request);
  const { cableFeature: _feature, ...expected } = row;
  expect(result).toMatchObject(expected);
  expect(result['cableFeature']).toMatchObject({ featureCode: row.cablePart, price: row.cablePrice });
  expect({ input, request }).toEqual(before);
});
it('rejects occupied, unknown or incompatible ports and mismatched distance/cable choices', () => {
  const { input, request } = setup();
  expect(() => stageNativeManualConnection({ ...input, connections: [row] }, request)).toThrow(/already connected/);
  expect(() => stageNativeManualConnection(input, { ...request, topology: 'wrong' })).toThrow(/compatible native port/);
  expect(() => stageNativeManualConnection(input, { ...request, destination: { ...request.destination, portNumber: '99999' } })).toThrow(/compatible native port/);
  expect(() => stageNativeManualConnection(input, { ...request, cablePart: 'unoffered' })).toThrow(/compatible choice/);
  expect(() => stageNativeManualConnection(input, { ...request, distance: { ...request.distance, from: { itemId: 'wrong' } } })).toThrow(/does not match/);
});

it('covers accepted cable usage while preserving spare selections', () => {
  const { input } = setup();
  const destination = input.configurations[1]!;
  destination.tabs = [{ subTabs: [{ sections: [{ name: 'ETHERNET_CABLE', results: [] }] }] }];
  input.connections = [row, { ...row, sourceId: 'another-source', destinationPortNumber: '90' }];
  expect(planNativeManualCableSelection(input, row)).toMatchObject({ previousQuantity: 0, requiredQuantity: 2, quantity: 2 });
  destination.tabs[0]!.subTabs![0]!.sections![0]!.results = [{ code: row.cablePart, quantity: 5 }];
  const before = structuredClone(input);
  expect(planNativeManualCableSelection(input, row)).toMatchObject({ previousQuantity: 5, requiredQuantity: 2, quantity: 5 });
  expect(input).toEqual(before);
});

it('resolves distance choices with empty groups against the destination catalog', () => {
  const { input } = setup();
  input.configurations[1]!.tabs = [{ subTabs: [{ sections: [{ name: 'ETHERNET_CABLE',
    features: [{ code: row.cablePart }], results: [] }] }] }];
  input.connections = [row];
  const distanceRow = { ...row, cableFeature: { ...row.cableFeature, ctoCode: row.sourcePart, selectionGroups: [] } };
  expect(planNativeManualCableSelection(input, distanceRow)).toMatchObject({ section: 'ETHERNET_CABLE', quantity: 1 });
  input.configurations[1]!.tabs[0]!.subTabs![0]!.sections!.push({ name: 'OTHER', features: [{ code: row.cablePart }] });
  expect(() => planNativeManualCableSelection(input, distanceRow)).toThrow(/missing or ambiguous/);
});

it('rejects ambiguous BOM ownership, quantities and unsupported split cables', () => {
  const { input } = setup();
  input.configurations[1]!.tabs = [{ subTabs: [{ sections: [{ name: 'ETHERNET_CABLE',
    results: [{ code: row.cablePart, quantity: 1 }, { code: row.cablePart, quantity: 1 }] }] }] }];
  input.connections = [row];
  expect(() => planNativeManualCableSelection(input, row)).toThrow(/quantity is invalid or ambiguous/);
  expect(() => planNativeManualCableSelection(input, { ...row, destinationId: 'physical-alias' })).toThrow(/direct configuration/);
  expect(() => planNativeManualCableSelection(input, { ...row, cableFeature: { ...row.cableFeature, ctoCode: 'wrong' } })).toThrow(/destination product/);
  input.configurations[1]!.tabs[0]!.subTabs![0]!.sections![0]!.results = [];
  input.connections = [{ ...row, divider: 2 }];
  expect(() => planNativeManualCableSelection(input, row)).toThrow(/unsupported or inconsistent/);
});

it('stages shared source topology changes for root and member without mutating any input', () => {
  const native = JSON.parse(readFileSync(new URL('./fixtures/parity/linked-source-port-native.json', import.meta.url), 'utf8'));
  const connector = native.selectedAfter.Management.selectedConnectors[0];
  const root = { id: 'root', connectors: [connector], selectedTopologies: {
    Management: { networkTechnology: '1GbE_Copper', selectedConnectors: [] },
  } };
  const member = { ...structuredClone(root), id: 'member' };
  const unrelated = { ...structuredClone(root), id: 'unrelated' };
  const configurations = [root, member, unrelated];
  const before = structuredClone(configurations);
  for (const sourceId of ['root', 'member']) {
    const row = { sourceId, network: 'Management', topology: '1GbE_Copper', sourcePortName: 'RJ45 mgmt', sourcePortNumber: '1' };
    const selected = selectNativeManualSourceGroup(configurations, { root: ['member', 'root'] }, row);
    expect([...selected.keys()]).toEqual(['member', 'root']);
    expect(selected.get('member')).toEqual(selectNativeManualSourcePort(root, row));
    expect(selected.get('member')).toEqual(native.selectedAfter);
    expect(selected.get('root')).toEqual(selected.get('member'));
    expect(selected.get('root')).not.toBe(selected.get('member'));
    expect(() => selectNativeManualSourceGroup([root, { ...member, connectors: [] }, unrelated], { root: ['member', 'root'] }, row))
      .toThrow(/missing or ambiguous/);
  }
  expect(configurations).toEqual(before);
});

it('uses maximum per-member cable demand for linked destinations and stages every physical member', () => {
  const { input } = setup();
  const destination = input.configurations[1]!;
  destination.tabs = [{ subTabs: [{ sections: [{ name: 'ETHERNET_CABLE',
    features: [{ code: row.cablePart }], results: [{ code: row.cablePart, quantity: 1 }] }] }] }];
  const member = { ...structuredClone(destination), id: 'destination-member' };
  input.configurations = [...input.configurations, member];
  input.cloneDependency = { [String(destination.id)]: [destination.id, member.id] };
  input.connections = [row, { ...row, sourcePortNumber: '2', destinationPortNumber: '90' }, { ...row, sourcePortNumber: '3', destinationId: member.id }];
  const target = (input.rackArea[0]!['rackItems'] as Record<string, unknown>[])[1]!;
  target['features'] = [{ name: 'ETHERNET_CABLE', results: [{ code: row.cablePart, quantity: 1 }] }];
  (input.rackArea[0]!['rackItems'] as Record<string, unknown>[]).push({ ...structuredClone(target), id: member.id });
  const before = structuredClone(input);
  const plan = planNativeManualCableSelection(input, row);
  expect(plan).toMatchObject({ configurationIds: [destination.id, member.id], previousQuantity: 1, requiredQuantity: 2, quantity: 2 });
  const layout = stageNativeManualCableQuantity(input, plan);
  const items = layout.rackArea[0]!['rackItems'] as Record<string, unknown>[];
  for (const item of items.slice(1)) expect(item['features']).toEqual([{ name: 'ETHERNET_CABLE', results: [{ code: row.cablePart, quantity: 2 }] }]);
  expect(input).toEqual(before);
  member.tabs![0]!.subTabs![0]!.sections![0]!.results![0]!.quantity = 3;
  expect(() => planNativeManualCableSelection(input, row)).toThrow(/divergent cable quantities/);
  destination.tabs![0]!.subTabs![0]!.sections![0]!.results![0]!.quantity = 3;
  expect(planNativeManualCableSelection(input, row).quantity).toBe(3);
});

it('counts native breakout cables by physical destination, including partial branches', () => {
  const native = JSON.parse(readFileSync(new URL('./fixtures/parity/breakout-native.json', import.meta.url), 'utf8'));
  const branches = native.connections;
  expect(countNativePhysicalCables(branches)).toBe(native.selection.quantity);
  expect(countNativePhysicalCables(branches.slice(0, 1))).toBe(1);
  expect(countNativePhysicalCables([branches[0], { ...branches[1], destinationPortNumber: '50' }])).toBe(2);
  expect(() => countNativePhysicalCables([...branches, { ...branches[0], sourcePortNumber: '5' }])).toThrow(/inconsistent/);
  expect(() => countNativePhysicalCables([branches[0], branches[0]])).toThrow(/repeats/);
  expect(() => countNativePhysicalCables([branches[0], { ...branches[1], cablePart: 'different' }])).toThrow(/inconsistent/);
  expect(() => countNativePhysicalCables([{ ...branches[0], divider: 2 }])).toThrow(/unsupported/);
  expect(countNativePhysicalCables([{ ...branches[0], divider: 1, category: 'P2P' }])).toBe(1);
});
it('offers only the demonstrated four-way breakout catalog shape on explicit request', () => {
  const distance = { compatibleCables: cableCatalog.map((c: Record<string, unknown>) => ({ featureCode: c['featureCode'], optionCode: c['option'] })) };
  expect(filterNativeManualCableChoices(distance, '100GbE_Copper', cableCatalog, 'breakout-4')['compatibleCables'])
    .toEqual([{ featureCode: 'AV22', optionCode: '7Z57A03564' }]);
  expect(filterNativeManualCableChoices(distance, '40GbE_Copper', cableCatalog, 'breakout-4')['compatibleCables']).toEqual([]);
});
it('shares only matching breakout destinations and rejects full ports and occupied sources', () => {
  const { input, request } = setup();
  request.topology = '100GbE_Copper';
  request.source.portName = 'SFP28'; request.destination.portName = 'QSFP28';
  input.configurations[0]!.connectors = [1, 2, 3, 4, 5].map(n => ({ port: 'SFP28', portNumber: String(n), topologies: [request.topology] }));
  request.source.portNumber = '1';
  input.configurations[1]!.connectors = [{ port: 'QSFP28', portNumber: request.destination.portNumber, topologies: [request.topology] }];
  const args = { ...request, connectionType: 'breakout-4' as const };
  const first = stageNativeManualConnection(input, args);
  expect(first).toMatchObject({ category: 'BREAKOUT', divider: 4 });
  input.connections = [first];
  expect(() => stageNativeManualConnection(input, args)).toThrow(/already connected/);
  args.source = { ...args.source, portNumber: '2' };
  expect(stageNativeManualConnection(input, args)).toMatchObject({ divider: 4 });
  expect(() => stageNativeManualConnection(input, { ...args, connectionType: 'point-to-point' })).toThrow(/already connected/);
  input.connections = [{ ...first, network: 'other' }];
  expect(() => stageNativeManualConnection(input, args)).toThrow(/already connected/);
  input.connections = [1, 2, 3, 4].map(n => ({ ...first, sourcePortNumber: String(n) }));
  args.source.portNumber = '5';
  expect(() => stageNativeManualConnection(input, args)).toThrow(/no free branches/);
});

it('updates managed source topology on its template while preserving physical endpoint identity', () => {
  const connector = { port: 'RJ45 mgmt', portNumber: '1', topologies: ['1GbE_Copper'] };
  const template = { id: 'template', connectors: [connector], selectedTopologies: {
    Management: { networkTechnology: '1GbE_Copper', selectedConnectors: [] },
  } };
  const connection = { sourceId: 'physical', network: 'Management', topology: '1GbE_Copper',
    sourcePortName: 'RJ45 mgmt', sourcePortNumber: '1' };
  const before = structuredClone({ template, connection });
  for (const mapping of [new Map([['physical', 'template']]), { physical: 'template' }]) {
    const selected = selectNativeManualSourceGroup([template], { template: ['template'] }, connection, mapping);
    expect([...selected.keys()]).toEqual(['template']);
    expect(selected.get('template')).toEqual({ Management: {
      networkTechnology: '1GbE_Copper', selectedConnectors: [connector],
    } });
  }
  expect({ template, connection }).toEqual(before);
  expect(() => selectNativeManualSourceGroup([template], { template: ['template'] }, connection,
    new Map([['physical', 'missing']]))).toThrow(/not in the workspace/);
});

it('counts managed destination usage per physical member while preserving template spares', () => {
  const section = { name: 'DAC_SFP_CABLE', features: [{ code: 'A3RG' }], results: [{ code: 'A3RG', quantity: 2 }] };
  const connection = (id: string, port: string) => ({ destinationId: id, destinationPortName: 'SFP+',
    destinationPortNumber: port, sourceId: `server-${id}-${port}`, sourcePortName: 'SFP28', sourcePortNumber: '1',
    cablePart: 'A3RG', category: 'P2P', divider: 1, cableFeature: { featureCode: 'A3RG', selectionGroups: [] } });
  const input: ManualCablingInput = { configurations: [{ id: 'template', code: '7Y70CTOHWW',
    tabs: [{ subTabs: [{ sections: [section] }] }] }],
    cloneDependency: { template: ['template'] }, physicalTemplateIds: new Map([['physical-a', 'template'], ['physical-b', 'template']]),
    connections: [connection('physical-a', '1'), connection('physical-b', '1')],
    rackArea: [{ id: 'rack', rackItems: ['physical-a', 'physical-b'].map(id => ({ id, features: [section] })) }] };
  const plan = planNativeManualCableSelection(input, connection('physical-a', '1'));
  expect(plan).toMatchObject({ configurationId: 'template', physicalDestinationIds: ['physical-a', 'physical-b'], requiredQuantity: 1, quantity: 2 });
  input.connections = [...input.connections, connection('physical-b', '2'), connection('physical-b', '3')];
  const expanded = planNativeManualCableSelection(input, connection('physical-a', '1'));
  expect(expanded).toMatchObject({ requiredQuantity: 3, quantity: 3 });
  const physical = stageNativeManualCableQuantity(input, expanded);
  expect((physical.rackArea[0]!.rackItems as Array<{ features: typeof section[] }>).map(i => i.features[0]!.results[0]!.quantity)).toEqual([3, 3]);
  expect(section.results[0]!.quantity).toBe(2);
});


it('restores captured paired manual cable spares before import derivation without changing source data', () => {
  const input = JSON.parse(readFileSync(new URL('./fixtures/parity/manual-import-cable-spares.json', import.meta.url), 'utf8')) as ManualCablingInput;
  const before = structuredClone(input);
  const plans = importedManualCableSelections(input);
  expect(plans.map(p => ({ code: p.code, quantity: p.quantity, required: p.requiredQuantity })).sort((a, b) => a.code.localeCompare(b.code)))
    .toEqual([{ code: 'A1PH', quantity: 2, required: 1 }, { code: 'A1PJ', quantity: 2, required: 1 }]);
  let staged = { rackArea: [...input.rackArea], nonRackArea: [...input.nonRackArea ?? []] };
  for (const plan of plans) staged = stageNativeManualCableQuantity({ ...input, ...staged }, plan);
  const quantities = staged.rackArea.flatMap(r => (r['rackItems'] as Array<Record<string, unknown>>))
    .flatMap(item => item['features'] as Array<Record<string, unknown>>)
    .flatMap(section => section['results'] as Array<Record<string, unknown>>).map(r => r['quantity']);
  expect(quantities).toEqual([2, 2, 2, 2]);
  expect(input).toEqual(before);
});

it('does not preserve automatic routes or invent missing imported cable quantities', () => {
  const input = JSON.parse(readFileSync(new URL('./fixtures/parity/manual-import-cable-spares.json', import.meta.url), 'utf8')) as ManualCablingInput;
  expect(importedManualCableSelections({ ...input, connections: input.connections.map(value => ({ ...(value as object), type: 'AUTO' })) })).toEqual([]);
  for (const c of input.configurations) for (const tab of c.tabs ?? []) for (const sub of tab.subTabs ?? [])
    for (const section of sub.sections ?? []) for (const result of section.results ?? []) if (result.code === 'A1PJ') result.quantity = 0;
  expect(importedManualCableSelections(input).map(p => p.code)).toEqual(['A1PH']);
});

it('retains an explicit cable as a spare when native auto-connect removes its last route', () => {
  const input = JSON.parse(readFileSync(new URL('./fixtures/parity/manual-import-cable-spares.json', import.meta.url), 'utf8')) as ManualCablingInput;
  const plan = importedManualCableSelections(input).find(p => p.code === 'A1PJ')!;
  const changed = structuredClone(input);
  changed.connections = changed.connections.filter(value => (value as Record<string, unknown>)['cablePart'] !== plan.code);
  for (const rack of changed.rackArea) for (const item of rack['rackItems'] as Array<Record<string, unknown>>) {
    for (const section of item['features'] as Array<Record<string, unknown>>) {
      section['results'] = (section['results'] as Array<Record<string, unknown>>).filter(r => r['code'] !== plan.code);
    }
  }
  const before = structuredClone(changed);
  const restored = stageNativeManualCableQuantity(changed, plan, input);
  const spares = restored.rackArea.flatMap(r => r['rackItems'] as Array<Record<string, unknown>>)
    .flatMap(item => item['features'] as Array<Record<string, unknown>>)
    .flatMap(section => section['results'] as Array<Record<string, unknown>>).filter(r => r['code'] === plan.code);
  expect(spares).toHaveLength(2);
  expect(spares.every(r => r['quantity'] === 2 && r['forAutoConnect'] === false)).toBe(true);
  expect(changed).toEqual(before);
  expect(() => stageNativeManualCableQuantity(changed, plan, changed)).toThrow(/unambiguous pre-connect physical record/);
});
