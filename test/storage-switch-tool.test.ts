import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { buildExportGroups } from '../src/domain/exportGroups.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { projectWorkspaceSummary, workspaceDetailSource } from '../src/model/workspaceProjection.js';
import { DcscService } from '../src/mcp/service.js';
import { registerStorageTools } from '../src/mcp/storageTools.js';
import { registerTools } from '../src/mcp/tools.js';
import { loadSessions, saveSessions } from '../src/session/persist.js';
import { SessionPersistenceError } from '../src/http/persistenceError.js';
import { SessionStore } from '../src/session/SessionStore.js';

type Reply = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;
type Obj = Record<string, unknown>;
const services: DcscService[] = [];
const tempRoots: string[] = [];

function snapshot(service: DcscService) {
  const copy = structuredClone(service.sessions.listWorkspaces());
  for (const workspace of copy) {
    workspace.lastAccessAt = 0;
    for (const session of workspace.configurations.values()) session.lastAccessAt = 0;
  }
  return copy;
}

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(options: { selectedFeature?: boolean } = {}) {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const raw = {
    id: 'server-id', code: '7D73CTOHWW', sliceCtoCode: '7D73CTOHWW', type: 'server', quantity: 1,
    selectedStorageNetwork: null, connectors: [], totalPrice: 100,
    powerReportResponse: { powerReport: { inputPower: { idle: 200, loadFactorResult: 800, max: 1000, worst: 1100 },
      inputCurrent: { idle: 1, loadFactorResult: 2, max: 3, worst: 4 },
      apparentPower: { idle: 250, loadFactorResult: 850, max: 1050, worst: 1150 },
      heatGeneration: { idle: 100, loadFactorResult: 200, max: 300, worst: 400 },
      operatingVoltage: '230V-AC', empty: false, warningMessages: [] } },
    tabs: [{ title: 'Base', subTabs: [{ title: 'Base', sections: [] }] }],
  };
  const server = service.sessions.create({ locale: service.locale,
    solution: { solutionMode: 'HPC and AI - Systems', masterSlices: ['HPCGP'] }, mode: 'cto', raw,
    configurationId: raw.id, reduced: reduceConfiguration(raw, raw.id), primed: true });
  const workspace = service.sessions.getWorkspace(server.id)!;
  workspace.serverState.storageConnectionNetworks = [{
    name: 'Primary SAN', maximumExpansions: 0, type: 'General Storage', layout: 'Fully Redundant',
    controller: { option: '7DP4CTO1WW', featureCode: '', id: 'controller-id', hardwareType: 'storage' },
    expansion: {},
    mainSwitch: { option: '7DHNCTO1WW', featureCode: 'C1FM', id: 'switch-id', hardwareType: 'switch' },
  }];
  const storageSwitch = {
    id: 'website-id-is-replaced', code: '7DHNCTO1WW', sliceCtoCode: '7DHNCTO1WW', type: 'switch',
    quantity: 1, unitPrice: 0.01, totalPrice: 11483.01,
    totalPrices: [{ priceTypeId: 1, price: 11483.01, priceNotAvailable: false }],
    connectors: [{ portNumber: '0', port: 'LC-Fiber', connectorFunction: 'Network',
      topologies: ['8Gb_Fibre', '16Gb_Fibre', '32GbE_Fiber', '64GbE_Fiber'] }],
    powerReportResponse: { powerReport: { inputPower: { idle: 500, loadFactorResult: 2000, max: 2500, worst: 2750 },
      inputCurrent: { idle: 2, loadFactorResult: 4, max: 6, worst: 8 },
      apparentPower: { idle: 625, loadFactorResult: 2125, max: 2625, worst: 2875 },
      heatGeneration: { idle: 500, loadFactorResult: 1000, max: 1500, worst: 2000 },
      operatingVoltage: '230V-AC', empty: false, warningMessages: [] } },
    tabs: [{ title: 'Base', subTabs: [{ title: 'Base', sections: [] }] }, {
      title: 'Services', subTabs: [{ title: 'Lenovo Recommends|Better', sections: [{
        name: 'Lenovo Recommends|Better', results: [
          { code: '5WS7C21341', quantity: 1, price: 629, type: 'service', description: 'Premier support' },
          { code: '5MS7B07545', quantity: 1, price: 95, type: 'service', description: 'CO2 Offset' },
        ],
      }] }],
    }],
    unSelectableCharacters: [{ name: 'BASE',
      features: [{ code: 'C1FM', description: 'Available DB710S base' }],
      results: options.selectedFeature === false ? [] : [{
        code: 'C1FM', quantity: 1, derived: true, description: 'Selected DB710S base',
      }],
    }],
    hipoServiceCtoServices: [],
  };
  const requests: Obj[] = [];
  const storageController = {
    id: 'website-controller-id-is-replaced', code: '7DP4CTO1WW', sliceCtoCode: '7DP4CTO1WW',
    type: 'storage', quantity: 1, tabs: [{ title: 'Base', subTabs: [{ title: 'Base', sections: [] }] }],
  };
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
    requests.push(request as unknown as Obj);
    if (request.endpoint === 'storage_switch_launch') return { raw: structuredClone(storageSwitch) } as never;
    if (request.endpoint === 'storage_controller_launch') return { raw: structuredClone(storageController) } as never;
    if (request.endpoint === 'racks_customize') return { raw: {
      rackArea: [], nonRackArea: [], connections: [], errors: [],
    } } as never;
    throw new Error(`Unexpected endpoint ${request.endpoint}`);
  });
  const handlers = new Map<string, Handler>();
  registerStorageTools({ registerTool(name: string, _definition: unknown, callback: Handler) {
    handlers.set(name, callback); return { remove() {}, update() {} };
  } } as unknown as McpServer, service);
  registerTools({ registerTool(name: string, _definition: unknown, callback: Handler) {
    handlers.set(name, callback); return { remove() {}, update() {} };
  } } as unknown as McpServer, service);
  return { service, server, workspace, storageSwitch, requests, send, handlers };
}

async function openSwitch(value: ReturnType<typeof setup>) {
  return value.service.openStorageSwitch(value.workspace.id, {
    name: 'Primary SAN', expectedRevision: value.workspace.revision, ctx: value.service.newCtx(),
  });
}

describe('dcsc_customize_storage_switch', () => {
  it('opens a managed SAN switch once with stable identity, nonphysical export and valid continuations', async () => {
    const { service, server, workspace, requests, handlers } = setup();
    const beforeRevision = workspace.revision;
    const reply = await handlers.get('dcsc_customize_storage_switch')!({
      session: workspace.id, name: 'Primary SAN', expectedRevision: beforeRevision,
    });
    expect(reply.isError).not.toBe(true);
    const result = JSON.parse(reply.content[0]!.text);
    expect(result).toMatchObject({ workspace: workspace.id, revision: beforeRevision + 1,
      storageName: 'Primary SAN', switchId: 'switch-id', created: true,
      inspect: { tool: 'dcsc_session_info', arguments: { session: result.session } },
      next: { tool: 'dcsc_list_options', arguments: { session: result.session } },
      configure: { tool: 'dcsc_configure', session: result.session },
    });
    expect(result.configure).not.toHaveProperty('arguments');
    const opened = service.sessions.get(result.session)!;
    expect(opened.configurationId).toBe('switch-id');
    expect(opened.raw).toMatchObject({ id: 'switch-id', code: '7DHNCTO1WW', type: 'switch', name: 'Switch' });
    expect(workspace.rackArea).toEqual([]);
    expect(workspace.nonRackArea).toEqual([]);
    expect(workspace.serverState.switchMap ?? []).toEqual([]);
    const exported = buildExportData({ workspace, solution: workspace.solution,
      validationMode: 'guided', fileTypes: ['XML'] });
    expect(exported.configurations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'switch-id', code: '7DHNCTO1WW', quantity: 1 }),
    ]));
    expect(JSON.stringify(exported.workspace)).not.toContain('switch-id');
    expect(JSON.stringify((exported.workspaceInformation as Obj)['rackData'])).not.toContain('switch-id');
    expect(JSON.stringify((exported.workspaceInformation as Obj)['nonRackData'])).not.toContain('switch-id');
    const managedProducts = buildExportGroups(workspace).flatMap(group => group.products)
      .filter(product => product.id === 'switch-id');
    expect(managedProducts).toEqual([expect.objectContaining({
      code: '7DHNCTO1WW', type: 'hardware', quantity: 0, price: 0,
      unitPrice: 10759.01, prices: [{ priceTypeId: 1, price: 11483.01, priceNotAvailable: false }],
    })]);
    const summary = projectWorkspaceSummary(workspace, {
      tool: 'dcsc_session_info', arguments: { session: workspace.id },
    });
    expect(summary).toMatchObject({ totalPrice: 100, configurations: expect.arrayContaining([
      expect.objectContaining({ id: result.session, quantity: 0, configurationQuantity: 1,
        managedStorageTemplate: true, extendedPrice: 0 }),
    ]) });
    expect(workspaceDetailSource(workspace)).toMatchObject({
      unracked: [expect.objectContaining({ session: server.id })],
    });
    const workspacePower = JSON.parse((await handlers.get('dcsc_power')!({ session: workspace.id })).content[0]!.text);
    expect(workspacePower).toMatchObject({ total: { maxKW: 1 }, perConfiguration: expect.arrayContaining([
      expect.objectContaining({ session: result.session, salesQuantity: 0, managedStorageTemplate: true }),
    ]) });
    const switchPower = JSON.parse((await handlers.get('dcsc_power')!({ session: result.session })).content[0]!.text);
    expect(switchPower).toMatchObject({ total: { maxKW: 2.5 } });
    expect(requests.map(request => request['endpoint'])).toEqual(['storage_switch_launch', 'racks_customize']);
    const customize = requests[1]!['body'] as { kind: string; value: { configurations: Obj[] } };
    expect(customize.value.configurations).toHaveLength(2);
    expect(customize.value.configurations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'switch-id', code: '7DHNCTO1WW', name: 'Switch' }),
    ]));
    expect(customize.value.configurations.every(configuration =>
      Array.isArray(configuration['sections']) && !('tabs' in configuration))).toBe(true);

    const reopened = await service.openStorageSwitch(workspace.id, {
      name: 'Primary SAN', expectedRevision: workspace.revision, ctx: service.newCtx(),
    });
    expect(reopened).toMatchObject({ session: result.session, switchId: 'switch-id', created: false });
    expect(requests).toHaveLength(2);

    await expect(service.closeSession(result.session)).rejects.toThrow(/dcsc_edit_storage_network/);
    expect(service.sessions.get(result.session)?.configurationId).toBe('switch-id');
  });

  it('requires a selected feature and rolls back malformed or rejected remote state', async () => {
    const unselected = setup({ selectedFeature: false });
    await expect(openSwitch(unselected)).rejects.toThrow(/C1FM.*selected|selected.*C1FM/i);
    expect(unselected.requests.map(request => request['endpoint'])).toEqual(['storage_switch_launch']);
    expect(unselected.workspace.configurations.size).toBe(1);

    const malformed = setup();
    const revision = malformed.workspace.revision;
    malformed.send.mockResolvedValueOnce({ raw: { code: 'WRONG', type: 'switch', tabs: [] } } as never);
    await expect(openSwitch(malformed)).rejects.toThrow(/no matching switch configuration/i);
    expect(malformed.workspace.revision).toBe(revision);
    expect(malformed.workspace.configurations.size).toBe(1);

    malformed.send.mockResolvedValueOnce({ raw: structuredClone(malformed.storageSwitch) } as never)
      .mockResolvedValueOnce({ raw: { rackArea: [], nonRackArea: [], connections: [],
        errors: [{ message: 'rejected switch layout' }] } } as never);
    await expect(openSwitch(malformed)).rejects.toThrow(/rejected switch layout/i);
    expect(malformed.workspace.revision).toBe(revision);
    expect(malformed.workspace.configurations.size).toBe(1);
  });

  it('rejects stale callers before launch and publishes nothing after transport or disk failure', async () => {
    const stale = setup();
    await expect(stale.service.openStorageSwitch(stale.workspace.id, {
      name: 'Primary SAN', expectedRevision: stale.workspace.revision + 1, ctx: stale.service.newCtx(),
    })).rejects.toThrow(/revision/i);
    expect(stale.send).not.toHaveBeenCalled();

    const transport = setup();
    const transportBefore = snapshot(transport.service);
    transport.send.mockRejectedValueOnce(new Error('connection reset'));
    await expect(openSwitch(transport)).rejects.toThrow(/connection reset/i);
    expect(snapshot(transport.service)).toEqual(transportBefore);

    const persistence = setup();
    const persistenceBefore = snapshot(persistence.service);
    persistence.service.sessions.setPersistenceWriter(() => { throw new Error('disk full'); });
    const failure = await openSwitch(persistence).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionPersistenceError);
    expect(failure).toMatchObject({ remoteApplied: true, localNotCommitted: true });
    expect(snapshot(persistence.service)).toEqual(persistenceBefore);
  });

  it('removes an exclusive switch, preserves a shared switch, and restores the lifecycle across history/restart', async () => {
    const exclusive = setup();
    const controller = await exclusive.service.openStorageController(exclusive.workspace.id, {
      name: 'Primary SAN', expectedRevision: exclusive.workspace.revision, ctx: exclusive.service.newCtx(),
    });
    const opened = await openSwitch(exclusive);
    await exclusive.service.sessions.transact(exclusive.workspace.id, { history: 'restore' }, draft => {
      draft.serverState.connections = [{ sourceId: 'server-id', destinationId: 'switch-id' }];
      draft.cables = [{ id: 'storage-cable', fromConfigId: 'server-id', toConfigId: 'switch-id',
        fromPort: '1', toPort: '1', cableCode: 'B4B3' }];
    });
    const removed = await exclusive.service.editStorageNetwork(exclusive.workspace.id, {
      action: 'remove', name: 'Primary SAN', expectedRevision: exclusive.workspace.revision,
    });
    expect(removed).toMatchObject({ storageNetworkCount: 0, removedConfigurations: 2 });
    expect(exclusive.service.sessions.get(controller.session)).toBeUndefined();
    expect(exclusive.service.sessions.get(opened.session)).toBeUndefined();
    expect(exclusive.workspace.serverState.connections).toEqual([]);
    expect(exclusive.workspace.cables).toEqual([]);
    await exclusive.service.sessions.undoWorkspace(exclusive.workspace.id);
    expect(exclusive.service.sessions.get(opened.session)?.configurationId).toBe('switch-id');
    expect(exclusive.service.sessions.get(controller.session)?.configurationId).toBe('controller-id');
    await exclusive.service.sessions.redoWorkspace(exclusive.workspace.id);
    expect(exclusive.service.sessions.get(opened.session)).toBeUndefined();

    const root = mkdtempSync(join(tmpdir(), 'dcsc-storage-switch-remove-'));
    tempRoots.push(root);
    const config = ConfigSchema.parse({ files: { persistSessions: true,
      sessionFile: join(root, 'sessions.json') }, logLevel: 'silent' });
    saveSessions(exclusive.service.sessions, config);
    const restored = new SessionStore();
    expect(loadSessions(restored, config)).toBe(1);
    const restoredWorkspace = restored.listWorkspaces()[0]!;
    expect([...restoredWorkspace.configurations.values()]
      .some(session => session.configurationId === 'switch-id')).toBe(false);

    const shared = setup();
    const sharedOpened = await openSwitch(shared);
    await shared.service.sessions.transact(shared.workspace.id, { history: 'restore' }, draft => {
      const primary = (draft.serverState.storageConnectionNetworks as Array<Record<string, unknown>>)[0]!;
      draft.serverState.storageConnectionNetworks = [primary, {
        ...structuredClone(primary), name: 'Secondary SAN',
      }];
    });
    const sharedRemoval = await shared.service.editStorageNetwork(shared.workspace.id, {
      action: 'remove', name: 'Primary SAN', expectedRevision: shared.workspace.revision,
    });
    expect(sharedRemoval).toMatchObject({ storageNetworkCount: 1, removedConfigurations: 0 });
    expect(shared.service.sessions.get(sharedOpened.session)?.configurationId).toBe('switch-id');
  });
});
