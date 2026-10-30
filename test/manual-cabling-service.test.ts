import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { manualConnectionId } from '../src/domain/manualCabling.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import type { RawConfiguration } from '../src/model/types.js';
import { SessionPersistenceError } from '../src/session/persistenceError.js';

type Obj = Record<string, unknown>;
const fixture = JSON.parse(await readFile(
  new URL('./fixtures/parity/manual-cabling-edit.json', import.meta.url), 'utf8',
)) as { configurations: RawConfiguration[]; rackArea: Obj[]; floorPreference: Obj;
  beforeConnection: Obj; edit: { destination: { configurationId: string; portName: string; portNumber: string } };
  distanceResponse: Obj };
const cableFixture = JSON.parse(await readFile(
  new URL('./fixtures/parity/manual-cabling-cable-part.json', import.meta.url), 'utf8',
)) as { physicalDestinationId: string; configurationId: string; sectionName: string;
  oldCode: string; newChoice: Obj; beforeResults: Obj[]; beforeRackResults: Obj[];
  expectedRequest: { query: Obj; customizingIds: string[]; delta: Obj; results: Obj[]; rackResults: Obj[] };
  authoritativeResponse: { totalPrice: number; results: Obj[] } };
const absentCableFixture = JSON.parse(await readFile(
  new URL('./fixtures/parity/manual-cabling-absent-cable-part.json', import.meta.url), 'utf8',
)) as { newCode: string; acceptedConfiguration: RawConfiguration; deriveResponse: Obj;
  expectedPhysicalResults: Obj[] };
const collisionFixture = JSON.parse(await readFile(
  new URL('./fixtures/parity/manual-cabling-collision-swap.json', import.meta.url), 'utf8',
)) as { edit: { configurationId: string; fromPortName: string; fromPortNumber: string;
  toPortName: string; toPortNumber: string }; calculateDistanceCalls: number };
const solution = { solutionMode: 'HPC and AI - Systems', masterSlices: ['HPCGP'] };
const services: DcscService[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  await Promise.all(tempDirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function raw(configuration: RawConfiguration): RawConfiguration {
  return { ...structuredClone(configuration), code: configuration.sliceCtoCode, type: 'SERVER', quantity: 1,
    totalPrice: 100, tabs: configuration.tabs ?? [] };
}

function setup(service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'error' }))) {
  services.push(service);
  const raws = fixture.configurations.map(raw);
  const first = raws[0]!;
  const source = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: first,
    configurationId: String(first.id), reduced: reduceConfiguration(first, String(first.id)), primed: true });
  for (const configuration of raws.slice(1)) service.sessions.create({
    locale: service.locale, solution, mode: 'cto', raw: configuration,
    configurationId: String(configuration.id), reduced: reduceConfiguration(configuration, String(configuration.id)),
    primed: true, workspaceId: source.workspaceId,
  });
  const workspace = service.sessions.getWorkspace(source.workspaceId)!;
  workspace.rackArea = structuredClone(fixture.rackArea);
  const rack = workspace.rackArea[0]!;
  const rackId = String(rack['id']);
  workspace.floorItems = [{ id: 'floor-a1', rackId, x: 0, y: 0 }];
  workspace.serverState.floorInformation = {
    floorPreference: structuredClone(fixture.floorPreference),
    floorGridSettings: { colCount: 5, rowCount: 2, hotIndexes: [1], coldIndexes: [] },
    floorGrid: [{ ...structuredClone(rack), id: rackId, sourceId: rackId, type: 'rack', row: 0, col: 0,
      coordinate: 'A1', items: structuredClone(rack['rackItems']) }],
  };
  const connection = structuredClone(fixture.beforeConnection);
  workspace.serverState.connections = [connection];
  workspace.serverState.autoConnectResults = [structuredClone(connection)];
  workspace.serverState.networkingInformation = { autoConnectResults: [structuredClone(connection)] };
  return { service, source, workspace, connectionId: manualConnectionId(connection), ctx: service.newCtx({ solution }) };
}

function state(value: ReturnType<typeof setup>) {
  return structuredClone({ revision: value.workspace.revision, serverState: value.workspace.serverState,
    cables: value.workspace.cables, history: value.workspace.history, floorItems: value.workspace.floorItems });
}

function setupCablePart() {
  const value = setup();
  const target = [...value.workspace.configurations.values()]
    .find(session => session.configurationId === cableFixture.configurationId)!;
  target.raw.tabs = [{ title: 'Cable Options', type: 'hardware', subTabs: [{ title: 'Cable Options', sections: [{
    name: cableFixture.sectionName, singleEntry: false,
    features: [
      { code: cableFixture.oldCode, description: '0.75m Blue Cat5e Cable', type: 'hardware' },
      { code: String(cableFixture.newChoice['featureCode']),
        description: String(cableFixture.newChoice['description']), type: 'hardware' },
    ], results: structuredClone(cableFixture.beforeResults),
  }] }] }];
  target.reduced = reduceConfiguration(target.raw, target.configurationId, 'cto', solution.solutionMode);
  const connection = (value.workspace.serverState.connections as Obj[])[0]!;
  (connection['cableDistance'] as Obj)['compatibleCables'] = [
    connection['cableFeature'], structuredClone(cableFixture.newChoice),
  ];
  value.workspace.serverState.autoConnectResults = structuredClone(value.workspace.serverState.connections);
  value.workspace.serverState.networkingInformation = {
    autoConnectResults: structuredClone(value.workspace.serverState.connections),
  };
  const rackItem = (value.workspace.rackArea[0]!['rackItems'] as Obj[])
    .find(item => item['id'] === cableFixture.physicalDestinationId)!;
  rackItem['features'] = [{ name: cableFixture.sectionName,
    results: structuredClone(cableFixture.beforeRackResults) }];
  const accepted = structuredClone(target.raw);
  accepted.totalPrice = cableFixture.authoritativeResponse.totalPrice;
  const acceptedSection = accepted.tabs![0]!.subTabs![0]!.sections![0]!;
  acceptedSection.results = structuredClone(cableFixture.authoritativeResponse.results);
  return { ...value, target, accepted };
}

function cableDeriveResponse(accepted: RawConfiguration, featureCode = String(cableFixture.newChoice['featureCode'])) {
  return { configurations: [accepted], autoDerivedResults: [], placementResults: [{
    workspaceId: cableFixture.configurationId,
    sectionPlacement: [{ sectionName: cableFixture.sectionName, errors: [], featurePlacement: [{
      sectionName: cableFixture.sectionName, featureCode, installations: [], placementError: null,
    }] }],
  }] };
}

describe('manual cabling service transaction', () => {
  it('commits an occupied-port swap as one durable graph edit and rolls both rows back on disk failure', async () => {
    const value = setup();
    const otherRaw = structuredClone(value.source.raw);
    otherRaw.id = 'second-server';
    value.service.sessions.create({ locale: value.service.locale, solution, mode: 'cto', raw: otherRaw,
      configurationId: otherRaw.id, reduced: reduceConfiguration(otherRaw, otherRaw.id),
      primed: true, workspaceId: value.workspace.id });
    const rackItems = value.workspace.rackArea[0]!['rackItems'] as Obj[];
    const sourceItem = rackItems.find(item => item['id'] === value.source.configurationId)!;
    rackItems.push({ ...structuredClone(sourceItem), id: otherRaw.id, configurationId: otherRaw.id, position: 2 });
    const first = structuredClone(fixture.beforeConnection);
    const second = { ...structuredClone(first), sourceId: otherRaw.id, sourceLocation: 'A1/U2/RJ45 mgmt',
      destinationPortNumber: collisionFixture.edit.toPortNumber };
    value.workspace.serverState.connections = [first, second];
    value.workspace.serverState.autoConnectResults = structuredClone([first, second]);
    value.workspace.serverState.networkingInformation = { autoConnectResults: structuredClone([first, second]) };
    const send = vi.spyOn(value.service.http, 'send');
    const write = vi.fn();
    value.service.sessions.setPersistenceWriter(write);
    const edit = { connectionId: manualConnectionId(first), destination: {
      configurationId: collisionFixture.edit.configurationId,
      portName: collisionFixture.edit.toPortName, portNumber: collisionFixture.edit.toPortNumber,
    }, expectedRevision: value.workspace.revision, ctx: value.ctx };
    const accepted = await value.service.editManualCabling(value.workspace.id, edit);
    expect(send).toHaveBeenCalledTimes(collisionFixture.calculateDistanceCalls);
    expect(write).toHaveBeenCalledTimes(1);
    expect(accepted.connection.destination.portNumber).toBe(collisionFixture.edit.toPortNumber);
    expect(accepted.swappedConnections).toEqual([expect.objectContaining({ type: 'MANUAL',
      destination: expect.objectContaining({ portNumber: collisionFixture.edit.fromPortNumber }),
    })]);
    const graph = value.workspace.serverState.connections as Obj[];
    expect(graph.map(row => row['type'])).toEqual(['MANUAL', 'MANUAL']);
    expect(value.workspace.serverState.autoConnectResults).toEqual(graph);
    expect((value.workspace.serverState.networkingInformation as Obj)['autoConnectResults']).toEqual(graph);
    expect(value.workspace.revision).toBe(edit.expectedRevision + 1);
    const beforeFailure = state(value);
    value.service.sessions.setPersistenceWriter(() => { throw new Error('disk full'); });
    await expect(value.service.editManualCabling(value.workspace.id, {
      ...edit, connectionId: manualConnectionId(graph[0]), expectedRevision: value.workspace.revision,
      destination: { ...edit.destination, portNumber: collisionFixture.edit.fromPortNumber },
    })).rejects.toBeInstanceOf(SessionPersistenceError);
    expect(state(value)).toEqual(beforeFailure);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the captured cable replacement wire and commits authoritative price, graph and history', async () => {
    const value = setupCablePart(); const write = vi.fn(); value.service.sessions.setPersistenceWriter(write);
    const send = vi.spyOn(value.service.http, 'send')
      .mockResolvedValue({ raw: cableDeriveResponse(value.accepted) } as never);
    const beforeRevision = value.workspace.revision;
    const result = await value.service.editManualCabling(value.workspace.id, {
      connectionId: value.connectionId, cablePart: String(cableFixture.newChoice['featureCode']),
      expectedRevision: beforeRevision, ctx: value.ctx,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const request = send.mock.calls[0]![0];
    expect(request).toMatchObject({ endpoint: 'manual_cabling_replacement', method: 'POST',
      path: '/ctos/autoDerive', query: { ...cableFixture.expectedRequest.query, guideMode: true },
      responseKind: 'json', timeoutClass: 'heavy' });
    const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
    expect(body).not.toHaveProperty('entranceFlag');
    expect(body['customizingIds']).toEqual(cableFixture.expectedRequest.customizingIds);
    const target = (body['configurations'] as Obj[]).find(configuration =>
      configuration['id'] === cableFixture.configurationId)!;
    expect(target['solutionMode']).toBe(solution.solutionMode);
    expect(target['delta']).toEqual(cableFixture.expectedRequest.delta);
    expect(((target['sections'] as Obj[]).find(section => section['name'] === cableFixture.sectionName)!['results']))
      .toEqual(cableFixture.expectedRequest.results);
    expect(result).toMatchObject({ workspace: value.workspace.id, revision: beforeRevision + 1,
      connection: { cable: { part: cableFixture.newChoice['featureCode'] }, type: 'MANUAL' },
      configurationChange: { session: value.target.id, configurationId: value.target.configurationId,
        previousTotalPrice: 100, totalPrice: cableFixture.authoritativeResponse.totalPrice,
        priceDelta: cableFixture.authoritativeResponse.totalPrice - 100,
        currency: 'USD', priceScope: 'editable-configuration' },
    });
    expect(value.target.raw.totalPrice).toBe(cableFixture.authoritativeResponse.totalPrice);
    expect((value.workspace.serverState.connections as Obj[])[0]).toMatchObject({
      cablePart: cableFixture.newChoice['featureCode'], cableOption: cableFixture.newChoice['optionCode'],
    });
    expect((((value.workspace.rackArea[0]!['rackItems'] as Obj[])
      .find(item => item['id'] === cableFixture.physicalDestinationId)!['features'] as Obj[])[0]!['results']))
      .toEqual(cableFixture.expectedRequest.rackResults);
    expect(write).toHaveBeenCalledTimes(1);
    expect(await value.service.sessions.undoWorkspace(value.workspace.id)).toBe(true);
    expect((value.workspace.serverState.connections as Obj[])[0]).toMatchObject({ cablePart: cableFixture.oldCode });
    expect(await value.service.sessions.redoWorkspace(value.workspace.id)).toBe(true);
    expect((value.workspace.serverState.connections as Obj[])[0]).toMatchObject({
      cablePart: cableFixture.newChoice['featureCode'],
    });
  });

  it('rolls back accepted cable quantities when native cable rules report errors', async () => {
    const value = setupCablePart(); const before = state(value); const write = vi.fn();
    value.service.sessions.setPersistenceWriter(write);
    const accepted = structuredClone(value.accepted);
    const section = accepted.tabs!.flatMap(t => t.subTabs ?? []).flatMap(t => t.sections ?? [])
      .find(s => s.name === cableFixture.sectionName)!;
    section.errors = [{ message: 'Cables must be selected in pairs.', errorType: 'VARIANT' }];
    vi.spyOn(value.service.http, 'send').mockResolvedValue({ raw: cableDeriveResponse(accepted) } as never);
    await expect(value.service.editManualCabling(value.workspace.id, {
      connectionId: value.connectionId, cablePart: String(cableFixture.newChoice['featureCode']),
      expectedRevision: value.workspace.revision, ctx: value.ctx,
    })).rejects.toThrow(/DCSC rejected cable quantities.*pairs/);
    expect(state(value)).toEqual(before);
    expect(write).not.toHaveBeenCalled();
  });

  it('publishes a newly selected cable that was absent from physical rack features', async () => {
    const value = setupCablePart();
    const connection = (value.workspace.serverState.connections as Obj[])[0]!;
    const compatible = (connection['cableDistance'] as Obj)['compatibleCables'] as Obj[];
    compatible.push({ category: 'Cable', featureCode: absentCableFixture.newCode,
      description: '1.0m Blue Cat5e Cable', optionCode: '00WE115', price: 9.5, length: 1,
      selectionGroups: [cableFixture.sectionName] });
    value.workspace.serverState.autoConnectResults = structuredClone(value.workspace.serverState.connections);
    value.workspace.serverState.networkingInformation = {
      autoConnectResults: structuredClone(value.workspace.serverState.connections),
    };
    const accepted = structuredClone(value.target.raw);
    accepted.tabs![0]!.subTabs![0]!.sections![0]!.results = structuredClone(
      absentCableFixture.acceptedConfiguration.tabs![0]!.subTabs![0]!.sections![0]!.results!,
    );
    vi.spyOn(value.service.http, 'send').mockResolvedValue({ raw: {
      configurations: [accepted], autoDerivedResults: [], ...absentCableFixture.deriveResponse,
    } } as never);
    const result = await value.service.editManualCabling(value.workspace.id, {
      connectionId: value.connectionId, cablePart: absentCableFixture.newCode,
      expectedRevision: value.workspace.revision, ctx: value.ctx,
    });
    expect(result).toMatchObject({ connection: { cable: { part: absentCableFixture.newCode } } });
    const physical = (value.workspace.rackArea[0]!['rackItems'] as Obj[])
      .find(item => item['id'] === cableFixture.physicalDestinationId)!;
    expect(((physical['features'] as Obj[])[0]!['results'])).toEqual(absentCableFixture.expectedPhysicalResults);
  });

  it('rolls cable replacement back on HTTP/rejection and reports post-derive disk failure as remote-applied', async () => {
    const httpFailure = setupCablePart(); const beforeHttp = state(httpFailure);
    vi.spyOn(httpFailure.service.http, 'send').mockRejectedValue(new Error('derive unavailable'));
    await expect(httpFailure.service.editManualCabling(httpFailure.workspace.id, {
      connectionId: httpFailure.connectionId, cablePart: '3802',
      expectedRevision: httpFailure.workspace.revision, ctx: httpFailure.ctx,
    })).rejects.toThrow(/derive unavailable/);
    expect(state(httpFailure)).toEqual(beforeHttp);

    const rejected = setupCablePart(); const beforeRejected = state(rejected);
    const notAccepted = structuredClone(rejected.target.raw);
    vi.spyOn(rejected.service.http, 'send').mockResolvedValue({ raw: {
      configurations: [notAccepted], autoDerivedResults: [], placementResults: [],
    } } as never);
    await expect(rejected.service.editManualCabling(rejected.workspace.id, {
      connectionId: rejected.connectionId, cablePart: '3802',
      expectedRevision: rejected.workspace.revision, ctx: rejected.ctx,
    })).rejects.toThrow(/did not accept/);
    expect(state(rejected)).toEqual(beforeRejected);

    const disk = setupCablePart(); const beforeDisk = state(disk);
    vi.spyOn(disk.service.http, 'send').mockResolvedValue({ raw: cableDeriveResponse(disk.accepted) } as never);
    disk.service.sessions.setPersistenceWriter(() => { throw new Error('disk full'); });
    const failure = await disk.service.editManualCabling(disk.workspace.id, {
      connectionId: disk.connectionId, cablePart: '3802',
      expectedRevision: disk.workspace.revision, ctx: disk.ctx,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionPersistenceError);
    expect(failure).toMatchObject({ localNotCommitted: true, remoteApplied: true });
    expect(state(disk)).toEqual(beforeDisk);
  });

  it('sends the captured endpoint-distance wire and commits the authoritative result once', async () => {
    const value = setup(); const write = vi.fn(); value.service.sessions.setPersistenceWriter(write);
    const send = vi.spyOn(value.service.http, 'send').mockResolvedValue({ raw: fixture.distanceResponse } as never);
    const beforeRevision = value.workspace.revision;
    const result = await value.service.editManualCabling(value.workspace.id, {
      connectionId: value.connectionId, destination: fixture.edit.destination,
      expectedRevision: beforeRevision, ctx: value.ctx,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ endpoint: 'manual_cabling_distance', method: 'POST',
      path: '/calculateDistance', responseKind: 'json', timeoutClass: 'interactive', body: { kind: 'json', value: {
        from: fixture.beforeConnection['sourceId'], to: fixture.edit.destination.configurationId,
        network: fixture.beforeConnection['topology'], floorPreference: fixture.floorPreference,
      } } });
    const body = send.mock.calls[0]![0].body;
    expect(body?.kind === 'json' && (body.value as Obj)['floorItems']).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 0, col: 0, rackItem: expect.objectContaining({
        items: expect.arrayContaining([expect.objectContaining({ id: fixture.edit.destination.configurationId,
          position: 5 })]),
      }) }),
    ]));
    expect(result).toMatchObject({ workspace: value.workspace.id, revision: beforeRevision + 1,
      connection: { destination: { configurationId: fixture.edit.destination.configurationId },
        type: 'MANUAL', totalDistance: fixture.distanceResponse['totalDistance'] } });
    expect(value.workspace.serverState.connections).toEqual(value.workspace.serverState.autoConnectResults);
    expect((value.workspace.serverState.networkingInformation as Obj)['autoConnectResults'])
      .toEqual(value.workspace.serverState.connections);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('changes only a port without distance HTTP and supports undo and redo', async () => {
    const value = setup(); const send = vi.spyOn(value.service.http, 'send');
    const beforeRevision = value.workspace.revision;
    await value.service.editManualCabling(value.workspace.id, { connectionId: value.connectionId,
      destination: { configurationId: String(fixture.beforeConnection['destinationId']),
        portName: 'RJ45', portNumber: '3' }, expectedRevision: beforeRevision, ctx: value.ctx });
    expect(send).not.toHaveBeenCalled();
    expect((value.workspace.serverState.connections as Obj[])[0]).toMatchObject({
      destinationPortNumber: '3', type: 'MANUAL', totalDistance: fixture.beforeConnection['totalDistance'],
    });
    expect(await value.service.sessions.undoWorkspace(value.workspace.id)).toBe(true);
    expect((value.workspace.serverState.connections as Obj[])[0]).toMatchObject({ destinationPortNumber: '2', type: 'AUTO' });
    expect(await value.service.sessions.redoWorkspace(value.workspace.id)).toBe(true);
    expect((value.workspace.serverState.connections as Obj[])[0]).toMatchObject({ destinationPortNumber: '3', type: 'MANUAL' });
  });

  it.each([
    ['invalid distance', async (value: ReturnType<typeof setup>) => {
      vi.spyOn(value.service.http, 'send').mockResolvedValue({ raw: {} } as never);
    }],
    ['HTTP failure', async (value: ReturnType<typeof setup>) => {
      vi.spyOn(value.service.http, 'send').mockRejectedValue(new Error('distance unavailable'));
    }],
  ])('rolls back the full edit on %s', async (_name, prepare) => {
    const value = setup(); const before = state(value); await prepare(value);
    await expect(value.service.editManualCabling(value.workspace.id, {
      connectionId: value.connectionId, destination: fixture.edit.destination,
      expectedRevision: value.workspace.revision, ctx: value.ctx,
    })).rejects.toThrow();
    expect(state(value)).toEqual(before);
  });

  it('rejects stale CAS before HTTP and discards a durable-write failure after calculation', async () => {
    const value = setup(); const before = state(value);
    const send = vi.spyOn(value.service.http, 'send').mockResolvedValue({ raw: fixture.distanceResponse } as never);
    await expect(value.service.editManualCabling(value.workspace.id, {
      connectionId: value.connectionId, destination: fixture.edit.destination,
      expectedRevision: value.workspace.revision - 1, ctx: value.ctx,
    })).rejects.toThrow(/revision/i);
    expect(send).not.toHaveBeenCalled();
    value.service.sessions.setPersistenceWriter(() => { throw new Error('disk full'); });
    const failure = await value.service.editManualCabling(value.workspace.id, {
      connectionId: value.connectionId, destination: fixture.edit.destination,
      expectedRevision: value.workspace.revision, ctx: value.ctx,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionPersistenceError);
    expect(failure).toMatchObject({ localNotCommitted: true, remoteApplied: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(state(value)).toEqual(before);
  });

  it('restores the accepted manual endpoint and history from durable storage', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dcsc-manual-cabling-')); tempDirs.push(directory);
    const sessionFile = path.join(directory, 'sessions.json');
    const config = ConfigSchema.parse({ files: { persistSessions: true, sessionFile }, logLevel: 'error' });
    const value = setup(new DcscService(config));
    vi.spyOn(value.service.http, 'send').mockResolvedValue({ raw: fixture.distanceResponse } as never);
    await value.service.editManualCabling(value.workspace.id, { connectionId: value.connectionId,
      destination: fixture.edit.destination, expectedRevision: value.workspace.revision, ctx: value.ctx });
    const expectedRevision = value.workspace.revision;
    await value.service.close(); services.splice(services.indexOf(value.service), 1);
    const restored = new DcscService(config); services.push(restored);
    const report = restored.inspectManualCabling(value.workspace.id);
    expect(report.revision).toBe(expectedRevision);
    expect(report.report.connections[0]).toMatchObject({ type: 'MANUAL',
      destination: { configurationId: fixture.edit.destination.configurationId },
      totalDistance: fixture.distanceResponse['totalDistance'] });
    expect(restored.sessions.getWorkspace(value.workspace.id)?.history?.undo.length).toBeGreaterThan(0);
  });
});

describe('native manual creation transaction', () => {
  function creationSetup() {
    const value = setup();
    const row = fixture.beforeConnection;
    const distance = row['cableDistance'] as Obj;
    vi.spyOn(value.service, 'fabricOptions').mockResolvedValue({ cables: (distance['compatibleCables'] as Obj[]).map(c => ({
      featureCode: c['featureCode'], option: c['optionCode'], topologies: [row['topology']], category: 'Cat5E',
    })) } as never);
    value.workspace.serverState.connections = [];
    delete value.workspace.serverState.autoConnectResults;
    delete value.workspace.serverState.networkingInformation;
    const source = [...value.workspace.configurations.values()].find(c => c.configurationId === row['sourceId'])!;
    source.raw.selectedTopologies = { Management: { networkTechnology: row['topology'] } };
    const destination = [...value.workspace.configurations.values()].find(c => c.configurationId === row['destinationId'])!;
    destination.raw.tabs = [{ subTabs: [{ sections: [{ name: 'ETHERNET_CABLE',
      results: [{ code: String(row['cablePart']), quantity: 1 }] }] }] }];
    const request = { network: String(row['network']), topology: String(row['topology']), cablePart: String(row['cablePart']),
      source: { configurationId: String(row['sourceId']), portName: String(row['sourcePortName']), portNumber: String(row['sourcePortNumber']) },
      destination: { configurationId: String(row['destinationId']), portName: String(row['destinationPortName']), portNumber: String(row['destinationPortNumber']) },
      expectedRevision: value.workspace.revision, ctx: value.ctx };
    return { ...value, request };
  }

  it('commits a retained graph and BOM together', async () => {
    const value = creationSetup();
    const send = vi.spyOn(value.service.http, 'send').mockImplementation(async input => {
      if (input.endpoint === 'manual_cabling_distance') return { raw: structuredClone(fixture.beforeConnection['cableDistance']) } as never;
      if (input.endpoint === 'auto_connect' && input.body?.kind === 'json') {
        const body = { ...input.body.value as Obj }; delete body['configurations']; return { raw: body } as never;
      }
      if (input.endpoint === 'workspace_autoDerive') return { raw: { configurations: [...value.workspace.configurations.values()].map(c => c.raw) } } as never;
      throw new Error(`Unexpected endpoint ${input.endpoint}`);
    });
    const result = await value.service.createNativeManualCabling(value.workspace.id, value.request);
    expect(result.revision).toBe(value.request.expectedRevision + 1);
    expect(result.connection.type).toBe('MANUAL');
    expect(value.workspace.serverState.connections).toHaveLength(1);
    expect(send.mock.calls.map(([input]) => input.endpoint)).toEqual(['manual_cabling_distance', 'auto_connect', 'workspace_autoDerive']);
    expect(send.mock.calls.find(([input]) => input.endpoint === 'auto_connect')![0].query)
      .toMatchObject({ autoArrange: false, autoConnect: true });
    await value.service.sessions.undoWorkspace(value.workspace.id, value.workspace.revision);
    expect(value.workspace.serverState.connections).toEqual([]);
    await value.service.sessions.redoWorkspace(value.workspace.id, value.workspace.revision);
    expect(value.workspace.serverState.connections).toHaveLength(1);
  });

  it.each([false, true])('commits and undoes linked source selections with additional native route=%s', async additionalRoute => {
    const value = creationSetup();
    const source = [...value.workspace.configurations.values()].find(c => c.configurationId === value.request.source.configurationId)!;
    const linkedRaw = { ...structuredClone(source.raw), id: 'linked-source' };
    const linked = value.service.sessions.create({ locale: value.service.locale, solution, mode: 'cto', raw: linkedRaw,
      configurationId: 'linked-source', reduced: reduceConfiguration(linkedRaw, 'linked-source'),
      primed: true, workspaceId: value.workspace.id });
    value.workspace.serverState.cloneDependency = { [source.configurationId]: [source.configurationId, linked.configurationId] };
    const before = structuredClone(source.raw.selectedTopologies);
    vi.spyOn(value.service.http, 'send').mockImplementation(async input => {
      if (input.endpoint === 'manual_cabling_distance') return { raw: structuredClone(fixture.beforeConnection['cableDistance']) } as never;
      if (input.endpoint === 'auto_connect' && input.body?.kind === 'json') {
        const body = { ...input.body.value as Obj }; delete body['configurations'];
        if (additionalRoute) body['connections'] = [...body['connections'] as Obj[], {
          ...(body['connections'] as Obj[])[0], sourceId: linked.configurationId, destinationPortNumber: '99', type: 'AUTO',
        }];
        return { raw: body } as never;
      }
      if (input.endpoint === 'workspace_autoDerive' && input.body?.kind === 'json') {
        const configurations = [...value.workspace.configurations.values()].map(c => structuredClone(c.raw));
        if (additionalRoute) {
          const info = (input.body.value as Obj)['workspaceInformation'] as Obj;
          const item = (info['rackData'] as Obj[]).flatMap(r => r['rackItems'] as Obj[])
            .find(c => c['id'] === value.request.destination.configurationId)!;
          expect(JSON.stringify(item['features'])).toContain('"quantity":2');
          const destination = configurations.find(c => c.id === value.request.destination.configurationId)!;
          destination.tabs![0]!.subTabs![0]!.sections![0]!.results![0]!.quantity = 2;
        }
        return { raw: { configurations } } as never;
      }
      throw new Error(`Unexpected endpoint ${input.endpoint}`);
    });
    value.request.expectedRevision = value.workspace.revision;
    const result = await value.service.createNativeManualCabling(value.workspace.id, value.request);
    expect(result.additionalConnectionCount).toBe(additionalRoute ? 1 : 0);
    expect(result.sourceConfigurationIds).toEqual([source.configurationId, linked.configurationId]);
    const selections = () => [...value.workspace.configurations.values()]
      .filter(c => [source.configurationId, linked.configurationId].includes(c.configurationId)).map(c => c.raw.selectedTopologies);
    const accepted = structuredClone(selections());
    expect(accepted[0]).toEqual(accepted[1]);
    expect(accepted[0]).not.toEqual(before);
    await value.service.sessions.undoWorkspace(value.workspace.id, value.workspace.revision);
    expect(selections()).toEqual([before, before]);
    await value.service.sessions.redoWorkspace(value.workspace.id, value.workspace.revision);
    expect(selections()).toEqual(accepted);
  });

  it('discovers native choices without mutating the workspace and rejects a concurrent edit', async () => {
    const value = creationSetup(); const before = state(value);
    const send = vi.spyOn(value.service.http, 'send').mockResolvedValue({ raw: structuredClone(fixture.beforeConnection['cableDistance']) } as never);
    const result = await value.service.inspectNativeManualCabling(value.workspace.id, value.request);
    expect(result.report.choices).toEqual(expect.arrayContaining([expect.objectContaining({ part: value.request.cablePart })]));
    expect(state(value)).toEqual(before);
    send.mockImplementationOnce(async () => {
      value.workspace.revision++;
      return { raw: structuredClone(fixture.beforeConnection['cableDistance']) } as never;
    });
    await expect(value.service.inspectNativeManualCabling(value.workspace.id, value.request)).rejects.toThrow();
  });

  it('pins existing routes only on opt-in and restores their AUTO ownership on undo', async () => {
    const value = creationSetup();
    const existing = { ...fixture.beforeConnection, sourceId: 'another-source', destinationPortNumber: '99', type: 'AUTO' };
    value.workspace.serverState.connections = [existing];
    const destination = [...value.workspace.configurations.values()].find(c => c.configurationId === value.request.destination.configurationId)!;
    destination.raw.tabs![0]!.subTabs![0]!.sections![0]!.results![0]!.quantity = 2;
    vi.spyOn(value.service.http, 'send').mockImplementation(async input => {
      if (input.endpoint === 'manual_cabling_distance') return { raw: structuredClone(fixture.beforeConnection['cableDistance']) } as never;
      if (input.endpoint === 'auto_connect' && input.body?.kind === 'json') {
        const body = { ...input.body.value as Obj }; delete body['configurations'];
        expect((body['connections'] as Obj[])[0]).toEqual({ ...existing, type: 'MANUAL' });
        // Native auto-connect may return its old physical quantity even after
        // accepting both manually seeded routes. Do not feed that stale row to derive.
        const items = (body['rackArea'] as Obj[]).flatMap(rack => rack['rackItems'] as Obj[]);
        items.find(item => item['id'] === value.request.destination.configurationId)!['features'] = [
          { name: 'ETHERNET_CABLE', results: [{ code: value.request.cablePart, quantity: 1, forAutoConnect: true }] },
        ];
        return { raw: body } as never;
      }
      if (input.endpoint === 'workspace_autoDerive' && input.body?.kind === 'json') {
        const info = (input.body.value as Obj)['workspaceInformation'] as Obj;
        const items = (info['rackData'] as Obj[]).flatMap(rack => rack['rackItems'] as Obj[]);
        expect(items.find(item => item['id'] === value.request.destination.configurationId)!['features'])
          .toEqual([{ name: 'ETHERNET_CABLE', results: [{ code: value.request.cablePart, quantity: 2, forAutoConnect: true }] }]);
        return { raw: { configurations: [...value.workspace.configurations.values()].map(c => c.raw) } } as never;
      }
      throw new Error(`Unexpected endpoint ${input.endpoint}`);
    });
    const result = await value.service.createNativeManualCabling(value.workspace.id, { ...value.request, pinExistingRoutes: true });
    expect(result.pinnedConnectionCount).toBe(1);
    expect(value.workspace.serverState.connections).toHaveLength(2);
    await value.service.sessions.undoWorkspace(value.workspace.id, value.workspace.revision);
    expect(value.workspace.serverState.connections).toEqual([existing]);
  });

  it('rolls back when Lenovo silently replaces the seed', async () => {
    const value = creationSetup(); const before = state(value);
    vi.spyOn(value.service.http, 'send').mockImplementation(async input => {
      if (input.endpoint === 'manual_cabling_distance') return { raw: structuredClone(fixture.beforeConnection['cableDistance']) } as never;
      if (input.endpoint === 'auto_connect' && input.body?.kind === 'json') {
        const body = structuredClone(input.body.value) as Obj;
        body['connections'] = [{ ...fixture.beforeConnection, type: 'AUTO' }];
        return { raw: body } as never;
      }
      throw new Error(`Unexpected endpoint ${input.endpoint}`);
    });
    await expect(value.service.createNativeManualCabling(value.workspace.id, value.request)).rejects.toThrow(/did not retain/);
    expect(state(value)).toEqual(before);
  });

  it('hides and rejects a distance-offered cable for a different topology before any write request', async () => {
    const value = creationSetup(); const before = state(value);
    const distanceChoice = ((fixture.beforeConnection['cableDistance'] as Obj)['compatibleCables'] as Obj[])
      .find(c => c['featureCode'] === value.request.cablePart)!;
    vi.mocked(value.service.fabricOptions).mockResolvedValue({ cables: [{
      featureCode: value.request.cablePart, option: distanceChoice['optionCode'], category: 'DAC', topologies: ['100GbE_Copper'],
    }] } as never);
    const send = vi.spyOn(value.service.http, 'send').mockResolvedValue({ raw: fixture.beforeConnection['cableDistance'] } as never);
    const options = await value.service.inspectNativeManualCabling(value.workspace.id, value.request);
    expect(options.report.choices).toEqual([]);
    await expect(value.service.createNativeManualCabling(value.workspace.id, value.request)).rejects.toThrow(/not one compatible choice/);
    expect(send.mock.calls.every(([input]) => input.endpoint === 'manual_cabling_distance')).toBe(true);
    expect(state(value)).toEqual(before);
  });

  it('rejects stale revisions and an unassigned network before HTTP', async () => {
    const value = creationSetup(); const send = vi.spyOn(value.service.http, 'send');
    await expect(value.service.createNativeManualCabling(value.workspace.id, { ...value.request, expectedRevision: 999 })).rejects.toThrow();
    await expect(value.service.createNativeManualCabling(value.workspace.id, { ...value.request, network: 'unassigned' })).rejects.toThrow(/not assigned/);
    expect(send).not.toHaveBeenCalled();
  });

  it('rolls back a retained graph if derivation drops its commercial cable', async () => {
    const value = creationSetup(); const before = state(value);
    const configurations = structuredClone([...value.workspace.configurations.values()].map(c => c.raw));
    const original = structuredClone(configurations);
    configurations.find(c => c.id === value.request.destination.configurationId)!.tabs![0]!.subTabs![0]!.sections![0]!.results = [];
    vi.spyOn(value.service.http, 'send').mockImplementation(async input => {
      if (input.endpoint === 'manual_cabling_distance') return { raw: structuredClone(fixture.beforeConnection['cableDistance']) } as never;
      if (input.endpoint === 'auto_connect' && input.body?.kind === 'json') {
        const body = { ...input.body.value as Obj }; delete body['configurations']; return { raw: body } as never;
      }
      if (input.endpoint === 'workspace_autoDerive') return { raw: { configurations } } as never;
      throw new Error(`Unexpected endpoint ${input.endpoint}`);
    });
    await expect(value.service.createNativeManualCabling(value.workspace.id, value.request)).rejects.toThrow(/sufficient manual cable quantity/);
    expect(state(value)).toEqual(before);
    expect([...value.workspace.configurations.values()].map(c => c.raw)).toEqual(original);
  });
});

describe('fresh choices for imported cable rows', () => {
  function imported() {
    const value = setupCablePart();
    const row = (value.workspace.serverState.connections as Obj[])[0]!;
    delete row['cableDistance'];
    vi.spyOn(value.service, 'fabricOptions').mockResolvedValue({ cables: [{
      featureCode: cableFixture.newChoice['featureCode'], option: cableFixture.newChoice['optionCode'],
      category: 'CAT5E', topologies: [row['topology']],
    }] } as never);
    const distance = { from: row['sourceId'], to: row['destinationId'], network: row['topology'],
      totalDistance: 1, compatibleCables: [structuredClone(cableFixture.newChoice)] };
    return { ...value, distance };
  }

  it('discovers missing choices without mutating graph, history or revision', async () => {
    const value = imported(); const before = state(value);
    vi.spyOn(value.service.http, 'send').mockResolvedValue({ raw: value.distance } as never);
    const result = await value.service.inspectManualCableChoices(value.workspace.id, value.connectionId, value.workspace.revision, value.ctx);
    expect(JSON.stringify(result.report)).toContain(String(cableFixture.newChoice['featureCode']));
    expect(state(value)).toEqual(before);
  });

  it('requires a revision and rejects a concurrent revision change', async () => {
    const value = imported(); const revision = value.workspace.revision;
    const send = vi.spyOn(value.service.http, 'send').mockImplementation(async () => {
      value.workspace.revision++;
      return { raw: value.distance } as never;
    });
    await expect(value.service.inspectManualCableChoices(value.workspace.id, value.connectionId, undefined, value.ctx)).rejects.toThrow(/required/);
    expect(send).not.toHaveBeenCalled();
    await expect(value.service.inspectManualCableChoices(value.workspace.id, value.connectionId, revision, value.ctx)).rejects.toThrow(/Revision conflict/);
  });

  it('rejects distance metadata for a different endpoint without altering the workspace', async () => {
    const value = imported(); const before = state(value);
    vi.spyOn(value.service.http, 'send').mockResolvedValue({ raw: { ...value.distance, from: 'foreign' } } as never);
    await expect(value.service.inspectManualCableChoices(value.workspace.id, value.connectionId, value.workspace.revision, value.ctx)).rejects.toThrow(/unexpected endpoint/);
    expect(state(value)).toEqual(before);
    await expect(value.service.editManualCabling(value.workspace.id, { connectionId: value.connectionId,
      cablePart: String(cableFixture.newChoice['featureCode']), expectedRevision: value.workspace.revision, ctx: value.ctx })).rejects.toThrow(/unexpected endpoint/);
    expect(state(value)).toEqual(before);
  });

  it('revalidates missing imported choices before coupled replacement derive', async () => {
    const value = imported();
    const send = vi.spyOn(value.service.http, 'send')
      .mockResolvedValueOnce({ raw: value.distance } as never)
      .mockResolvedValueOnce({ raw: cableDeriveResponse(value.accepted) } as never);
    await value.service.editManualCabling(value.workspace.id, { connectionId: value.connectionId,
      cablePart: String(cableFixture.newChoice['featureCode']), expectedRevision: value.workspace.revision, ctx: value.ctx });
    expect(send.mock.calls.map(([request]) => request.endpoint)).toEqual(['manual_cabling_distance', 'manual_cabling_replacement']);
    expect((value.workspace.serverState.connections as Obj[])[0]!['cablePart']).toBe(cableFixture.newChoice['featureCode']);
  });
});
