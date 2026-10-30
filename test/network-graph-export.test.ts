import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { mergeImportedState } from '../src/domain/importLayout.js';
import { DcscService } from '../src/mcp/service.js';

const capture = JSON.parse(readFileSync(new URL('./fixtures/parity/browser-auto-switch-cabling.json', import.meta.url), 'utf8'));
const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const raw = { id: 'server-1', code: '7D73CTOHWW', type: 'server', quantity: 1, tabs: [] };
  const solution = { solutionMode: 'HPC and AI - Systems', masterSlices: ['HPC'] };
  const session = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw,
    configurationId: raw.id, reduced: reduceConfiguration(raw, raw.id), primed: true });
  const workspace = service.sessions.getWorkspace(session.id)!;
  workspace.nonRackArea = [{ id: raw.id, code: raw.code, type: 'server' }];
  return { service, workspace, exportData: () => buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode: 'guided' }) };
}

it('exports the complete accepted graph at both browser locations and aggregates cable parts', async () => {
  const { service, workspace, exportData } = setup();
  const graph = [{ ...capture.connection, futureField: { retained: true }, divider: 1 }];
  vi.spyOn(service.http, 'send').mockResolvedValue({ raw: {
    configurations: [], connections: graph, switchMap: capture.switchMap, errors: [],
  } } as never);
  await service.runAutoConnect(workspace.id, service.newCtx(), workspace.revision);
  const data = exportData();
  expect(data.autoConnectResults).toEqual(graph);
  expect(data.networkingInformation).toMatchObject({ autoConnectResults: graph,
    switchMap: capture.switchMap, cables: capture.export.cables });
  // An authoritative empty graph clears imported mirrors, including on export.
  await service.sessions.transact(workspace.id, {}, async draft => {
    draft.serverState.autoConnectResults = graph;
    draft.serverState.networkingInformation = { autoConnectResults: graph, switchMap: capture.switchMap };
  });
  vi.mocked(service.http.send).mockResolvedValue({ raw: { connections: [], errors: [] } } as never);
  await service.runAutoConnect(workspace.id, service.newCtx(), workspace.revision);
  expect(exportData().autoConnectResults).toEqual([]);
  expect(exportData().networkingInformation).toMatchObject({ autoConnectResults: [], cables: [] });
  await service.sessions.undoWorkspace(workspace.id);
  expect(exportData().autoConnectResults).toEqual(graph);
});

it('retains imported graph metadata locally but omits prior rows from regeneration', async () => {
  const { service, workspace, exportData } = setup();
  workspace.serverState = { networkingInformation: {
    autoConnectResults: [capture.connection], switchMap: capture.switchMap,
    cables: capture.export.cables, futureNetworkField: { preserved: true },
  } };
  expect(exportData().autoConnectResults).toEqual([capture.connection]);
  expect(exportData().networkingInformation).toMatchObject({ cables: capture.export.cables });
  const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [], connections: [capture.connection], errors: [] } } as never);
  await service.runAutoConnect(workspace.id, service.newCtx(), workspace.revision);
  expect(send.mock.calls[0]![0].body).toMatchObject({ kind: 'json', value: {
    switchMap: capture.switchMap,
  } });
  expect((send.mock.calls[0]![0].body as { kind: 'json'; value: Record<string, unknown> }).value)
    .not.toHaveProperty('connections');
  expect(exportData().autoConnectResults).toEqual([capture.connection]);
  expect(exportData().networkingInformation).toMatchObject({ futureNetworkField: { preserved: true } });
});

it('counts cable parts rather than endpoint records and excludes Power from AI/HPC cable groups', () => {
  const { workspace, exportData } = setup();
  workspace.serverState.connections = [capture.connection, { ...capture.connection, destinationPortNumber: '3' },
    { ...capture.connection, network: 'Power', cablePart: 'POWER', cableType: 'power cord' }];
  expect(exportData().networkingInformation).toMatchObject({
    cables: [{ ...capture.export.cables[0], quantity: 2 }],
  });
  workspace.solution.solutionMode = 'General Purpose';
  expect(exportData().networkingInformation).toMatchObject({ cables: [
    { ...capture.export.cables[0], quantity: 2 }, { code: 'POWER', description: 'power cord', quantity: 1 },
  ] });
});

it('merges imported port graphs without dropping existing links or confusing two ports on one node', () => {
  const { workspace, exportData } = setup();
  const first = capture.connection;
  const second = { ...first, sourcePortNumber: '2', destinationPortNumber: '3' };
  workspace.serverState.connections = [first];
  mergeImportedState(workspace, { networkingInformation: { autoConnectResults: [first, second] } });
  expect(exportData().autoConnectResults).toEqual([first, second]);
  expect(workspace.cables).toHaveLength(2);
  expect(() => mergeImportedState(workspace, { networkingInformation: {
    autoConnectResults: [{ ...second, cablePart: 'CONFLICT' }],
  } })).toThrow('conflicts');
  expect(exportData().autoConnectResults).toEqual([first, second]);
});

it('reports local planning links excluded from a Lenovo workspace export without deleting them', async () => {
  const { service, workspace } = setup();
  mergeImportedState(workspace, { networkingInformation: { autoConnectResults: [capture.connection] } });
  const manual = { id: 'manual-planning', fromConfigId: 'server-1', toConfigId: 'server-1',
    fromPort: 'port-a', toPort: 'port-b', cableCode: 'UNVERIFIED' };
  workspace.cables.push(manual);
  vi.spyOn(service.http, 'send').mockResolvedValue({ stream: Readable.from(['fixture']) } as never);
  const result = await service.exportZip(workspace.id, { fileTypes: ['XML'], fileName: 'fixture', ctx: service.newCtx() });
  expect(result.manualPlanningLinksOmitted).toBe(1);
  expect(workspace.cables).toContainEqual(manual);
});
it('reports the observed website import risk without altering exported breakout rows', async () => {
  const { service, workspace, exportData } = setup();
  const graph = JSON.parse(readFileSync(new URL('./fixtures/parity/breakout-native.json', import.meta.url), 'utf8')).connections;
  workspace.serverState.connections = graph;
  vi.spyOn(service.http, 'send').mockResolvedValue({ stream: Readable.from(['fixture']) } as never);
  const result = await service.exportZip(workspace.id, { fileTypes: ['XML'], fileName: 'breakout', ctx: service.newCtx() });
  expect(result.breakoutBranchesAtRisk).toBe(4);
  expect(exportData().autoConnectResults).toEqual(graph);
});

it('exports current network definitions without requiring a mirrored import envelope', () => {
  const { workspace, exportData } = setup();
  const cluster = [{ name: 'Management', networkType: '1GbE_Copper' }];
  const storage = [{ name: 'SAN', controller: {}, mainSwitch: {} }];
  workspace.serverState = { clusterPreference: cluster, storageConnectionNetworks: storage };
  expect(exportData().networkingInformation).toMatchObject({ clusterPreference: cluster, storageNetworks: storage });
  workspace.serverState.networkingInformation = { clusterPreference: cluster, storageNetworks: storage, futureField: 1 };
  workspace.serverState.clusterPreference = [];
  workspace.serverState.storageConnectionNetworks = [];
  expect(exportData().networkingInformation).toMatchObject({ clusterPreference: [], storageNetworks: [], futureField: 1 });
  delete workspace.serverState.clusterPreference;
  delete workspace.serverState.storageConnectionNetworks;
  expect(exportData().networkingInformation).toMatchObject({ clusterPreference: cluster, storageNetworks: storage });
});
