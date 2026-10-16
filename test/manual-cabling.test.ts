import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { applyAcceptedManualCablePhysicalState, applyManualConnectionDistance, commitManualConnectionEdit, discoverManualPorts,
  inspectManualCabling, manualConnectionId, projectManualConnection,
  stageManualConnectionEdit, type ManualCablingInput } from '../src/domain/manualCabling.js';
import type { RawConfiguration } from '../src/model/types.js';
import type { RackObject } from '../src/domain/rack.js';

type Obj = Record<string, unknown>;
const captured = JSON.parse(readFileSync(
  new URL('./fixtures/parity/browser-auto-switch-cabling.json', import.meta.url), 'utf8',
)) as { connection: Obj };
const capturedEdit = JSON.parse(readFileSync(
  new URL('./fixtures/parity/manual-cabling-edit.json', import.meta.url), 'utf8',
)) as { configurations: RawConfiguration[]; rackArea: RackObject[]; floorItems: unknown[];
  floorPreference: Obj; beforeConnection: Obj;
  edit: { destination: { configurationId: string; portName: string; portNumber: string } };
  distanceRequest: Obj; distanceResponse: Obj; websiteExportConnection: Obj };
const capturedCablePart = JSON.parse(readFileSync(
  new URL('./fixtures/parity/manual-cabling-cable-part.json', import.meta.url), 'utf8',
)) as { physicalDestinationId: string; configurationId: string; sectionName: string;
  oldCode: string; newChoice: Obj; beforeResults: Obj[]; beforeRackResults: Obj[];
  expectedRequest: { query: Obj; customizingIds: string[]; delta: Obj; results: Obj[]; rackResults: Obj[] };
  authoritativeResponse: { totalPrice: number; results: Obj[] } };
const capturedAbsentCablePart = JSON.parse(readFileSync(
  new URL('./fixtures/parity/manual-cabling-absent-cable-part.json', import.meta.url), 'utf8',
)) as { physicalDestinationId: string; configurationId: string; sectionName: string;
  oldCode: string; newCode: string; acceptedConfiguration: RawConfiguration;
  deriveResponse: Obj; expectedPhysicalResults: Obj[] };
const capturedSharedCablePart = JSON.parse(readFileSync(
  new URL('./fixtures/parity/manual-cabling-shared-cable-part.json', import.meta.url), 'utf8',
)) as { finalGraph: Array<{ cablePart: string }>; exportConfigurationResults: Obj[];
  exportPhysicalResults: Obj[]; expectedSafety: string };
const capturedCollision = JSON.parse(readFileSync(
  new URL('./fixtures/parity/manual-cabling-collision-swap.json', import.meta.url), 'utf8',
)) as { edit: { configurationId: string; fromPortName: string; fromPortNumber: string;
  toPortName: string; toPortNumber: string }; before: Obj[]; after: Obj[]; calculateDistanceCalls: number };

function input(): ManualCablingInput {
  const connection = structuredClone(captured.connection);
  const compatible = ((connection['cableDistance'] as Obj)['compatibleCables'] as Obj[]);
  compatible.push({ ...compatible[0], featureCode: '3802', optionCode: '00WE112',
    description: '1.5m Blue Cat5e Cable', price: 12.5, length: 1.5 });
  connection['futureConnectionField'] = { kept: true };
  const configurations: RawConfiguration[] = [
    { id: 'server-1', sliceCtoCode: '7D73CTOHWW', description: 'SR630', connectors: [
      { port: 'RJ45 mgmt', portNumber: '1', topologies: ['1GbE_Copper'] },
    ] },
    { id: 'switch-template', sliceCtoCode: '7D5FCTOFWW', description: 'SN2201', connectors: [
      { port: 'RJ45', portNumber: '2', topologies: ['1GbE_Copper'] },
      { port: 'RJ45', portNumber: '3', topologies: ['1GbE_Copper'] },
    ] },
  ];
  const rackArea: RackObject[] = [{ id: 'rack-1', code: 'rack', rackItems: [
    { id: 'server-1', code: '7D73CTOHWW', description: 'SR630', position: 1 },
    { id: 'generated-switch-1', code: '7D5FCTOFWW', description: 'SN2201 generated', position: 6 },
    { id: 'manual-switch-1', code: '7D5FCTOFWW', description: 'SN2201 manual', position: 5 },
  ] }];
  return { connections: [connection], configurations, rackArea,
    floorItems: [{ row: 0, col: 0, rackItem: { id: 'rack-1', items: [
      { id: 'server-1', code: '7D73CTOHWW', description: 'SR630', position: 1 },
      { id: 'generated-switch-1', code: '7D5FCTOFWW', description: 'SN2201 generated', position: 6 },
      { id: 'manual-switch-1', code: '7D5FCTOFWW', description: 'SN2201 manual', position: 5 },
    ] } }], floorPreference: { rowGap: 0.2 },
    physicalTemplateIds: new Map([
      ['generated-switch-1', 'switch-template'], ['manual-switch-1', 'switch-template'],
    ]) };
}

describe('browser-authoritative manual cable row edits', () => {
  it('stages the captured cable-part replacement as one targeted derive with exact duplicate wire results', () => {
    const connection = structuredClone(captured.connection);
    connection['destinationId'] = capturedCablePart.physicalDestinationId;
    connection['cablePart'] = capturedCablePart.oldCode;
    connection['cableFeature'] = {
      category: 'Cable', featureCode: capturedCablePart.oldCode, ctoCode: '7D5FCTOFWW',
      description: '0.75m Blue Cat5e Cable', optionCode: '00WE111', price: 9.5,
      selectionGroups: [capturedCablePart.sectionName],
    };
    const distance = connection['cableDistance'] as Obj;
    distance['compatibleCables'] = [connection['cableFeature'], capturedCablePart.newChoice];
    const raw: RawConfiguration = {
      id: capturedCablePart.configurationId, sliceCtoCode: '7D5FCTOFWW', description: 'SN2201',
      tabs: [{ title: 'Cable Options', type: 'hardware', subTabs: [{ title: 'Cable Options', sections: [{
        name: capturedCablePart.sectionName, singleEntry: false,
        features: [
          { code: capturedCablePart.oldCode, description: '0.75m Blue Cat5e Cable', type: 'hardware' },
          { code: String(capturedCablePart.newChoice['featureCode']),
            description: String(capturedCablePart.newChoice['description']), type: 'hardware' },
        ],
        results: structuredClone(capturedCablePart.beforeResults),
      }] }] }],
    };
    const value: ManualCablingInput = {
      connections: [connection], configurations: [raw],
      rackArea: [{ id: 'rack-1', rackItems: [{ id: capturedCablePart.physicalDestinationId,
        code: '7D5FCTOFWW', features: [{ name: capturedCablePart.sectionName,
          results: structuredClone(capturedCablePart.beforeRackResults) }] }] }],
      nonRackArea: [], solutionMode: 'HPC and AI - Systems',
    };
    const plan = stageManualConnectionEdit(value, {
      connectionId: manualConnectionId(connection), cablePart: String(capturedCablePart.newChoice['featureCode']),
    });
    expect(plan.distanceRequest).toBeUndefined();
    expect(plan.cableReplacement).toMatchObject({
      physicalDestinationId: capturedCablePart.physicalDestinationId,
      configurationId: capturedCablePart.configurationId,
      sectionName: capturedCablePart.sectionName,
      oldCode: capturedCablePart.oldCode,
      newCode: capturedCablePart.newChoice['featureCode'], quantity: 1,
      graphUsage: { oldCode: 1, newCode: 0 },
      targetQuantities: { oldCode: 0, newCode: 1 }, wireMode: 'native-single',
      query: capturedCablePart.expectedRequest.query,
      customizingIds: capturedCablePart.expectedRequest.customizingIds,
    });
    const replacement = plan.cableReplacement!;
    expect(replacement.reducedConfiguration.delta).toEqual(capturedCablePart.expectedRequest.delta);
    expect(replacement.reducedConfiguration.sections.find(section =>
      section.name === capturedCablePart.sectionName)?.results).toEqual(capturedCablePart.expectedRequest.results);
    expect(((replacement.rackArea[0]!['rackItems'] as Obj[])[0]!['features'] as Obj[])[0]!['results'])
      .toEqual(capturedCablePart.expectedRequest.rackResults);
    expect(plan.staged).toMatchObject({
      cablePart: '3802', cableOption: '40K8785', cableType: '1.5m Blue Cat5e Cable',
      cablePrice: 9.5, cableFeature: capturedCablePart.newChoice, type: 'MANUAL',
    });
    expect(commitManualConnectionEdit(value.connections, plan)[0]).toMatchObject({ cablePart: '3802' });
    expect(value.rackArea).toEqual(expect.arrayContaining([
      expect.objectContaining({ rackItems: expect.arrayContaining([
        expect.objectContaining({ features: expect.arrayContaining([
          expect.objectContaining({ results: capturedCablePart.beforeRackResults }),
        ]) }),
      ]) }),
    ]));
  });

  it('uses a quantity-preserving derive when the native wire would erase a shared quantity', () => {
    // The native UI keeps AVFT on the untouched graph row and physical item,
    // but its accepted/exported canonical configuration drops AVFT entirely.
    // Following that wire would make the MCP's commercial state inconsistent.
    expect(capturedSharedCablePart.finalGraph.map(row => row.cablePart)).toEqual(['AVFU', 'AVFT']);
    expect(capturedSharedCablePart.exportPhysicalResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AVFT', quantity: 1 }),
      expect.objectContaining({ code: 'AVFU', quantity: 1 }),
    ]));
    expect(capturedSharedCablePart.exportConfigurationResults).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AVFT' }),
    ]));
    expect(capturedSharedCablePart.expectedSafety).toMatch(/^fail-closed:/);

    const value = input();
    const connection = value.connections[0] as Obj;
    connection['destinationId'] = 'switch-template';
    const config = value.configurations[1]!;
    config.tabs = [{ title: 'Cable Options', type: 'hardware', subTabs: [{ title: 'Cable Options', sections: [{
      name: 'ETHERNET_CABLE', features: [
        { code: 'AVFT', description: 'old' }, { code: '3802', description: 'new' },
      ], results: [{ code: 'AVFT', quantity: 1 }, { code: '3802', quantity: 1 }],
    }] }] }];
    const rackItems = value.rackArea[0]!['rackItems'] as Obj[];
    rackItems.push({ id: 'switch-template', code: '7D5FCTOFWW', description: 'SN2201 direct' });
    const rackItem = rackItems.find(item => item['id'] === 'switch-template')!;
    rackItem['features'] = [{ name: 'ETHERNET_CABLE', results: [
      { code: '3802', quantity: 1 }, { code: 'AVFT', quantity: 1 },
    ] }];
    const second = { ...structuredClone(connection), sourceId: 'server-2', sourcePortNumber: '2' };
    const shared = { ...value, connections: [connection, second] };
    const plan = stageManualConnectionEdit(shared, {
      connectionId: manualConnectionId(connection), cablePart: '3802',
    });
    expect(plan.cableReplacement).toMatchObject({
      graphUsage: { oldCode: 2, newCode: 0 },
      targetQuantities: { oldCode: 1, newCode: 1 },
      wireMode: 'quantity-preserving', quantity: 1,
    });
    expect(plan.cableReplacement!.reducedConfiguration.delta).toMatchObject({ quantity: 1 });
    expect(plan.cableReplacement!.reducedConfiguration.sections.find(section =>
      section.name === 'ETHERNET_CABLE')?.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AVFT', quantity: 1 }),
      expect.objectContaining({ code: '3802', quantity: 1 }),
    ]));
    const accepted = structuredClone(config);
    const physical = applyAcceptedManualCablePhysicalState(plan.cableReplacement!, accepted, {
      placementResults: [{ workspaceId: 'switch-template', sectionPlacement: [{
        sectionName: 'ETHERNET_CABLE', featurePlacement: [
          { featureCode: 'AVFT', installations: [], placementError: null },
          { featureCode: '3802', installations: [], placementError: null },
        ],
      }] }],
    });
    const acceptedPhysical = ((physical.rackArea[0]!['rackItems'] as Obj[])
      .find(item => item['id'] === 'switch-template')!['features'] as Obj[])[0]!['results'];
    expect(acceptedPhysical).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AVFT', quantity: 1 }),
      expect.objectContaining({ code: '3802', quantity: 1 }),
    ]));

    const aliasValue = input();
    const aliasConnection = aliasValue.connections[0] as Obj;
    const aliasConfig = aliasValue.configurations[1]!;
    aliasConfig.tabs = structuredClone(config.tabs);
    expect(() => stageManualConnectionEdit(aliasValue, {
      connectionId: manualConnectionId(aliasConnection), cablePart: '3802',
    })).toThrow(/managed physical alias.*not supported/);
    rackItem['features'] = [{ name: 'ETHERNET_CABLE', results: [{ code: 'AVFT', quantity: 1 }] }];
    expect(() => stageManualConnectionEdit(value, {
      connectionId: manualConnectionId(connection), cablePart: '3802',
      destination: { configurationId: 'manual-switch-1', portName: 'RJ45', portNumber: '2' },
    })).toThrow(/separate revision-bound calls/);
  });

  it('rebuilds a previously absent physical cable feature from the accepted native derive', () => {
    const connection = structuredClone(captured.connection);
    connection['destinationId'] = capturedAbsentCablePart.physicalDestinationId;
    connection['cablePart'] = capturedAbsentCablePart.oldCode;
    connection['cableFeature'] = { category: 'Cable', featureCode: capturedAbsentCablePart.oldCode,
      description: '0.75m Blue Cat5e Cable', optionCode: '00WE111', price: 9.5,
      selectionGroups: [capturedAbsentCablePart.sectionName] };
    const newChoice = { category: 'Cable', featureCode: capturedAbsentCablePart.newCode,
      description: '1.0m Blue Cat5e Cable', optionCode: '00WE115', price: 9.5, length: 1,
      selectionGroups: [capturedAbsentCablePart.sectionName] };
    (connection['cableDistance'] as Obj)['compatibleCables'] = [connection['cableFeature'], newChoice];
    const raw: RawConfiguration = { id: capturedAbsentCablePart.configurationId, sliceCtoCode: '7D5FCTOFWW',
      tabs: [{ title: 'Cable Options', type: 'hardware', subTabs: [{ title: 'Cable Options', sections: [{
        name: capturedAbsentCablePart.sectionName, singleEntry: false,
        features: [{ code: capturedAbsentCablePart.oldCode }, { code: capturedAbsentCablePart.newCode }],
        results: [{ code: '3802', quantity: 1, description: '1.5m Blue Cat5e Cable' },
          { code: capturedAbsentCablePart.oldCode, quantity: 1, description: '0.75m Blue Cat5e Cable' }],
      }] }] }] };
    const value: ManualCablingInput = { connections: [connection], configurations: [raw],
      rackArea: [{ id: 'rack-1', rackItems: [{ id: capturedAbsentCablePart.physicalDestinationId,
        code: '7D5FCTOFWW', features: [{ name: capturedAbsentCablePart.sectionName, results: [
          capturedCablePart.beforeRackResults[0], capturedCablePart.beforeRackResults[1],
        ] }] }] }], nonRackArea: [] };
    const plan = stageManualConnectionEdit(value, { connectionId: manualConnectionId(connection),
      cablePart: capturedAbsentCablePart.newCode });
    const accepted = applyAcceptedManualCablePhysicalState(plan.cableReplacement!,
      capturedAbsentCablePart.acceptedConfiguration, capturedAbsentCablePart.deriveResponse);
    const physical = (accepted.rackArea[0]!['rackItems'] as Obj[])[0]!;
    expect(((physical['features'] as Obj[])[0]!['results'])).toEqual(capturedAbsentCablePart.expectedPhysicalResults);
    const stagedPhysical = (plan.cableReplacement!.rackArea[0]!['rackItems'] as Obj[])[0]!;
    expect(((stagedPhysical['features'] as Obj[])[0]!['results'])).toEqual([capturedCablePart.beforeRackResults[0]]);

    const missingSectionInput = structuredClone(value);
    ((missingSectionInput.rackArea[0]!['rackItems'] as Obj[])[0]!)['features'] = [];
    const missingSectionPlan = stageManualConnectionEdit(missingSectionInput, {
      connectionId: manualConnectionId(connection), cablePart: capturedAbsentCablePart.newCode,
    });
    const createdSection = applyAcceptedManualCablePhysicalState(missingSectionPlan.cableReplacement!,
      capturedAbsentCablePart.acceptedConfiguration, capturedAbsentCablePart.deriveResponse);
    expect((((createdSection.rackArea[0]!['rackItems'] as Obj[])[0]!['features'] as Obj[])[0]))
      .toEqual({ name: capturedAbsentCablePart.sectionName,
        results: capturedAbsentCablePart.expectedPhysicalResults });

    expect(() => applyAcceptedManualCablePhysicalState(plan.cableReplacement!, {
      ...capturedAbsentCablePart.acceptedConfiguration, id: 'wrong-config',
    }, capturedAbsentCablePart.deriveResponse)).toThrow(/does not match/);
    expect(() => applyAcceptedManualCablePhysicalState(plan.cableReplacement!,
      capturedAbsentCablePart.acceptedConfiguration, { placementResults: [] })).toThrow(/placement.*missing/);
  });

  it('replays the captured native U6 to U5 Save contract and corrects the website stale distance', () => {
    const value: ManualCablingInput = { connections: [capturedEdit.beforeConnection],
      configurations: capturedEdit.configurations, rackArea: capturedEdit.rackArea,
      floorItems: capturedEdit.floorItems, floorPreference: capturedEdit.floorPreference };
    const connectionId = manualConnectionId(capturedEdit.beforeConnection);
    const plan = stageManualConnectionEdit(value, { connectionId, destination: capturedEdit.edit.destination });
    expect(plan.distanceRequest).toEqual(capturedEdit.distanceRequest);
    const accepted = applyManualConnectionDistance(plan, capturedEdit.distanceResponse);
    const committed = commitManualConnectionEdit(value.connections, accepted) as Obj[];
    expect(committed[0]).toMatchObject({
      destinationId: capturedEdit.websiteExportConnection['destinationId'],
      destinationLocation: capturedEdit.websiteExportConnection['destinationLocation'],
      destinationPortName: capturedEdit.websiteExportConnection['destinationPortName'],
      destinationPortNumber: capturedEdit.websiteExportConnection['destinationPortNumber'],
      type: 'MANUAL', totalDistance: capturedEdit.distanceResponse['totalDistance'],
      cableDistance: { to: capturedEdit.distanceResponse['to'],
        totalDistance: capturedEdit.distanceResponse['totalDistance'] },
    });
    // The current website exports the new endpoint with the old U6 numeric
    // distance. MCP commits the authoritative calculation response instead.
    expect(capturedEdit.websiteExportConnection['totalDistance']).toBe(0.62225);
    expect(committed[0]!['totalDistance']).toBeCloseTo(0.5778, 8);
    expect(discoverManualPorts(value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ configurationId: capturedEdit.edit.destination.configurationId,
        location: 'A1/U5/RJ45', number: '2' }),
    ]));
  });

  it('projects stable row IDs, exact current values, compatible cables and physical alias ports', () => {
    const value = input();
    const report = inspectManualCabling(value);
    expect(report.connections).toHaveLength(1);
    expect(report.connections[0]).toMatchObject({
      id: expect.stringMatching(/^connection_[0-9a-f]{20}$/), network: 'Management', topology: '1GbE_Copper',
      source: { configurationId: 'server-1', portName: 'RJ45 mgmt', portNumber: '1' },
      destination: { configurationId: 'generated-switch-1', portName: 'RJ45', portNumber: '2' },
      cable: { part: 'AVFT', option: '00WE111' }, compatibleCables: [
        expect.objectContaining({ part: 'AVFT' }), expect.objectContaining({ part: '3802' }),
      ],
    });
    expect(discoverManualPorts(value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ configurationId: 'generated-switch-1', number: '2', location: 'A1/U6/RJ45' }),
      expect.objectContaining({ configurationId: 'manual-switch-1', number: '3', location: 'A1/U5/RJ45' }),
    ]));
    expect(manualConnectionId(value.connections[0])).toBe(report.connections[0]!.id);
  });

  it('stages a physical endpoint edit, emits the captured distance request and preserves opaque fields', () => {
    const value = input(); const connectionId = manualConnectionId(value.connections[0]);
    const plan = stageManualConnectionEdit(value, { connectionId,
      destination: { configurationId: 'manual-switch-1', portName: 'RJ45', portNumber: '3' },
    });
    expect(plan.distanceRequest).toEqual({ floorPreference: { rowGap: 0.2 },
      floorItems: [{ row: 0, col: 0, rackItem: { id: 'rack-1', items: [
        { id: 'server-1', code: '7D73CTOHWW', description: 'SR630', position: 1 },
        { id: 'generated-switch-1', code: '7D5FCTOFWW', description: 'SN2201 generated', position: 6 },
        { id: 'manual-switch-1', code: '7D5FCTOFWW', description: 'SN2201 manual', position: 5 },
      ] } }],
      from: 'server-1', to: 'manual-switch-1', network: '1GbE_Copper' });
    expect(plan.staged).toMatchObject({ destinationId: 'manual-switch-1', destinationPortName: 'RJ45',
      destinationPortNumber: '3', destinationLocation: 'A1/U5/RJ45', destinationPart: '7D5FCTOFWW',
      type: 'MANUAL', futureConnectionField: { kept: true } });
    const accepted = applyManualConnectionDistance(plan, { totalDistance: 0.42225,
      compatibleCables: [{ featureCode: 'AVFT' }], futureDistanceField: true });
    const committed = commitManualConnectionEdit(value.connections, accepted) as Obj[];
    expect(committed[0]).toMatchObject({ totalDistance: 0.42225,
      cableDistance: { totalDistance: 0.42225, futureDistanceField: true },
      futureConnectionField: { kept: true } });
    expect(value.connections[0]).toMatchObject({ destinationId: 'generated-switch-1' });
  });

  it('keeps cable choices inspection-only and rejects stale graph commits or bad distance data', () => {
    const value = input(); const connectionId = manualConnectionId(value.connections[0]);
    const plan = stageManualConnectionEdit(value, { connectionId,
      destination: { configurationId: 'manual-switch-1', portName: 'RJ45', portNumber: '2' },
    });
    expect(() => commitManualConnectionEdit([], plan)).toThrow(/changed/);
    expect(() => applyManualConnectionDistance(plan, {})).toThrow(/numeric cable distance/);
    expect(() => applyManualConnectionDistance(plan, { totalDistance: -1 })).toThrow(/non-negative/);
    expect(() => applyManualConnectionDistance(plan, { totalDistance: 1,
      from: { itemId: 'wrong-source' }, to: { itemId: 'manual-switch-1' } })).toThrow(/unexpected endpoint/);
    expect(() => applyManualConnectionDistance(plan, { totalDistance: 1,
      from: { itemId: 'server-1' }, to: { itemId: 'wrong-target' } })).toThrow(/unexpected endpoint/);
    expect(() => applyManualConnectionDistance(plan, { totalDistance: 1,
      from: { itemId: 'server-1' }, to: { itemId: 'manual-switch-1' }, network: 'IB' }))
      .toThrow(/unexpected network/);
  });

  it('rejects ambiguous identities and endpoints outside current discovery', () => {
    const value = input(); const connectionId = manualConnectionId(value.connections[0]);
    expect(() => stageManualConnectionEdit({ ...value, connections: [...value.connections, ...value.connections] },
      { connectionId, destination: { configurationId: 'manual-switch-1', portName: 'RJ45', portNumber: '2' } },
    )).toThrow(/ambiguous/);
    expect(() => stageManualConnectionEdit(value, { connectionId,
      destination: { configurationId: 'manual-switch-1', portName: 'RJ45', portNumber: '99' },
    })).toThrow(/not one selectable/);
    expect(() => stageManualConnectionEdit(value, { connectionId,
      source: { configurationId: 'manual-switch-1', portName: 'RJ45', portNumber: '2' },
    })).toThrow(/current source component/);
    expect(() => stageManualConnectionEdit(value, { connectionId,
      destination: { configurationId: 'generated-switch-1', portName: 'RJ45', portNumber: '2' },
    })).toThrow(/does not change/);
    const crossComponentOccupied = { ...value, connections: [...value.connections, {
      ...structuredClone(value.connections[0] as Obj), sourceId: 'another-server',
      destinationId: 'manual-switch-1', destinationPortNumber: '3',
    }] };
    expect(() => stageManualConnectionEdit(crossComponentOccupied, { connectionId,
      destination: { configurationId: 'manual-switch-1', portName: 'RJ45', portNumber: '3' },
    })).toThrow(/same-side port swap/);
    const missingTopology = { ...(value.connections[0] as Obj), topology: '' };
    expect(() => stageManualConnectionEdit({ ...value, connections: [missingTopology] }, {
      connectionId: manualConnectionId(missingTopology),
      destination: { configurationId: 'manual-switch-1', portName: 'RJ45', portNumber: '2' },
    })).toThrow(/no network topology/);
    expect(() => projectManualConnection({})).toThrow(/empty cabling row/);
  });

  it('atomically swaps a captured occupied destination port without recalculating distance', () => {
    const value = input();
    const edited = value.connections[0] as Obj;
    expect(edited['destinationPortName']).toBe(capturedCollision.edit.fromPortName);
    expect(edited['destinationPortNumber']).toBe(capturedCollision.edit.fromPortNumber);
    const conflicting = {
      ...structuredClone(edited),
      sourceId: 'server-2', sourceLocation: capturedCollision.before[1]!['sourceLocation'],
      destinationPortNumber: capturedCollision.edit.toPortNumber,
      cablePart: capturedCollision.before[1]!['cablePart'],
      totalDistance: capturedCollision.after[1]!['totalDistance'],
    };
    edited['sourceLocation'] = capturedCollision.before[0]!['sourceLocation'];
    edited['cablePart'] = capturedCollision.before[0]!['cablePart'];
    edited['totalDistance'] = capturedCollision.after[0]!['totalDistance'];
    value.connections = [edited, conflicting];

    const plan = stageManualConnectionEdit(value, {
      connectionId: manualConnectionId(edited),
      destination: {
        configurationId: 'generated-switch-1',
        portName: capturedCollision.edit.toPortName,
        portNumber: capturedCollision.edit.toPortNumber,
      },
    });
    expect(capturedCollision.calculateDistanceCalls).toBe(0);
    expect(plan.distanceRequest).toBeUndefined();
    expect(plan.staged).toMatchObject({
      destinationPortNumber: capturedCollision.after[0]!['destinationPortNumber'],
      cablePart: capturedCollision.after[0]!['cablePart'], type: 'MANUAL',
      totalDistance: capturedCollision.after[0]!['totalDistance'],
    });
    expect(plan.collisionSwaps).toHaveLength(1);
    expect(plan.collisionSwaps![0]!.staged).toMatchObject({
      destinationPortNumber: capturedCollision.after[1]!['destinationPortNumber'],
      cablePart: capturedCollision.after[1]!['cablePart'], type: 'MANUAL',
      totalDistance: capturedCollision.after[1]!['totalDistance'],
    });
    expect(commitManualConnectionEdit(value.connections, plan)).toMatchObject([
      { destinationPortNumber: '3', type: 'MANUAL' },
      { destinationPortNumber: '2', type: 'MANUAL' },
    ]);

    const badTopology = structuredClone(value);
    (badTopology.connections[1] as Obj)['topology'] = 'unsupported-topology';
    expect(() => stageManualConnectionEdit(badTopology, {
      connectionId: manualConnectionId(badTopology.connections[0]),
      destination: { configurationId: 'generated-switch-1', portName: 'RJ45', portNumber: '3' },
    })).toThrow(/not one selectable/);
    expect(() => commitManualConnectionEdit(value.connections.slice(0, 1), plan)).toThrow(/collision row changed/);
  });
});
