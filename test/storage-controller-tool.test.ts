import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { buildExportGroups } from '../src/domain/exportGroups.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import { registerStorageTools } from '../src/mcp/storageTools.js';
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

function setup(options: { featureCode?: string; selectedFeature?: boolean } = {}) {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const raw = {
    id: 'server-id', code: '7D73CTOHWW', sliceCtoCode: '7D73CTOHWW', type: 'server', quantity: 1,
    selectedStorageNetwork: null, connectors: [],
    tabs: [{ title: 'Base', subTabs: [{ title: 'Base', sections: [] }] }],
  };
  const server = service.sessions.create({ locale: service.locale,
    solution: { solutionMode: 'HPC and AI - Systems', masterSlices: ['HPCGP'] }, mode: 'cto', raw,
    configurationId: raw.id, reduced: reduceConfiguration(raw, raw.id), primed: true });
  const workspace = service.sessions.getWorkspace(server.id)!;
  const option = options.featureCode ? '7D4FCTO6WW' : '7DJ0CTO1WW';
  workspace.serverState.storageConnectionNetworks = [{
    name: 'Primary SAN', maximumExpansions: 0, type: 'General Storage', layout: 'Fully Redundant',
    controller: { option, featureCode: options.featureCode ?? '', id: 'controller-id', hardwareType: 'storage' },
    expansion: {}, mainSwitch: { hardwareType: 'switch' },
  }];
  const controller = {
    id: 'website-id-is-replaced', code: option, sliceCtoCode: option, type: 'storage',
    quantity: 1, connectors: [{ id: 'port-1', sourceFeature: 'C4AC' }],
    tabs: [{ title: 'Cable Options', subTabs: [{ title: 'Cable Options', sections: [{
      name: 'Cable Options', features: [{ code: 'AV1W', quantity: 2, type: 'hardware' }],
    }] }] }],
    hipoServiceCtoServices: [{ targetCto: '7Q01STORAGE', description: 'Controller service',
      price: 120, results: [{ section: 'Service', code: 'QTEST', quantity: 1 }] }],
    ...(options.featureCode ? { unSelectableCharacters: [{
      name: 'BASE',
      features: [{ code: options.featureCode, description: 'Available controller base' }],
      results: options.selectedFeature === false ? [] : [{
        code: options.featureCode, quantity: 1, derived: true,
        description: 'Selected controller base',
      }],
    }] } : {}),
  };
  const requests: Obj[] = [];
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
    requests.push(request as unknown as Obj);
    if (request.endpoint === 'storage_controller_launch') return { raw: structuredClone(controller) } as never;
    if (request.endpoint === 'racks_customize') return { raw: {
      rackArea: [], nonRackArea: [], connections: [], errors: [],
    } } as never;
    throw new Error(`Unexpected endpoint ${request.endpoint}`);
  });
  const handlers = new Map<string, Handler>();
  registerStorageTools({ registerTool(name: string, _definition: unknown, callback: Handler) {
    handlers.set(name, callback); return { remove() {}, update() {} };
  } } as unknown as McpServer, service);
  return { service, server, workspace, controller, option, requests, send, handlers };
}

async function openController(value: ReturnType<typeof setup>) {
  return value.service.openStorageController(value.workspace.id, {
    name: 'Primary SAN', expectedRevision: value.workspace.revision, ctx: value.service.newCtx(),
  });
}

describe('dcsc_storage_set customize controller', () => {
  it('opens a native imported controller selection that omits hardwareType and its prior template identity', async () => {
    const value = setup();
    const imported = structuredClone(value.workspace.serverState.storageConnectionNetworks) as Obj[];
    const controller = imported[0]!['controller'] as Obj;
    delete controller['hardwareType'];
    delete controller['id'];
    delete value.workspace.serverState.storageConnectionNetworks;
    value.workspace.serverState.networkingInformation = { storageNetworks: imported };
    const result = await openController(value);
    expect(result.created).toBe(true);
    expect(value.requests.map(request => request['endpoint'])).toEqual(['storage_controller_launch', 'racks_customize']);
    expect(value.workspace.serverState.storageConnectionNetworks).toEqual([expect.objectContaining({
      controller: expect.objectContaining({ option: value.option, hardwareType: 'storage', id: result.controllerId }),
    })]);
    expect(imported[0]!['controller']).not.toHaveProperty('hardwareType');
    expect(imported[0]!['controller']).not.toHaveProperty('id');
  });

  it('opens a managed controller once, preserves its stable identity and exposes valid continuations', async () => {
    const { service, workspace, requests, handlers } = setup();
    const beforeRevision = workspace.revision;
    const reply = await handlers.get('dcsc_storage_set')!({
      session: workspace.id, change: { action: 'customize', name: 'Primary SAN', component: 'controller' }, expectedRevision: beforeRevision,
    });
    expect(reply.isError).not.toBe(true);
    const result = JSON.parse(reply.content[0]!.text);
    expect(result).toMatchObject({ workspace: workspace.id, revision: beforeRevision + 1,
      storageName: 'Primary SAN', controllerId: 'controller-id', created: true,
      inspect: { tool: 'dcsc_storage_get', arguments: { session: workspace.id } },
    });
    const opened = service.sessions.get(result.configuration)!;
    expect(opened.configurationId).toBe('controller-id');
    expect(opened.raw).toMatchObject({ id: 'controller-id', code: '7DJ0CTO1WW', type: 'storage' });
    expect(workspace.rackArea).toEqual([]);
    expect(workspace.nonRackArea).toEqual([]);
    const exported = buildExportData({ workspace, solution: workspace.solution,
      validationMode: 'guided', fileTypes: ['XML'] });
    expect(exported.configurations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'controller-id', code: '7DJ0CTO1WW', quantity: 1 }),
    ]));
    const exportWorkspace = exported.workspace as { nonRackArea: unknown[] };
    const exportInformation = exported.workspaceInformation as { nonRackData: unknown[] };
    expect(JSON.stringify(exportWorkspace.nonRackArea)).not.toContain('controller-id');
    expect(JSON.stringify(exportInformation.nonRackData)).not.toContain('controller-id');
    const managedProducts = buildExportGroups(workspace).flatMap(group => group.products);
    const controllerProduct = managedProducts
      .find(product => product.code === '7DJ0CTO1WW');
    expect(controllerProduct).toMatchObject({ id: 'controller-id', quantity: 0 });
    expect(managedProducts.some(product => product.code === '7Q01STORAGE' ||
      product.type === 'service' || product.type === 'servicectohipo')).toBe(false);
    expect(requests.map(request => request['endpoint'])).toEqual(['storage_controller_launch', 'racks_customize']);
    const customize = requests[1]!['body'] as { kind: string; value: { configurations: Obj[] } };
    expect(customize.value.configurations).toHaveLength(2);
    expect(customize.value.configurations.every(configuration =>
      Array.isArray(configuration['sections']) && !('tabs' in configuration))).toBe(true);

    const reopened = await service.openStorageController(workspace.id, {
      name: 'Primary SAN', expectedRevision: workspace.revision, ctx: service.newCtx(),
    });
    expect(reopened).toMatchObject({ session: result.configuration, controllerId: 'controller-id', created: false });
    expect(requests).toHaveLength(2);
    await service.sessions.undoWorkspace(workspace.id);
    expect([...workspace.configurations.values()].some(value => value.configurationId === 'controller-id')).toBe(false);
    await service.sessions.redoWorkspace(workspace.id);
    const restored = [...workspace.configurations.values()].find(value => value.configurationId === 'controller-id');
    expect(restored?.id).toBe(result.configuration);
  });

  it('accepts a nonempty controller feature only when launch returns it as selected', async () => {
    const value = setup({ featureCode: 'BCBN' });
    const opened = await openController(value);
    expect(opened).toMatchObject({ controllerId: 'controller-id', created: true });
    expect(value.requests.map(request => request['endpoint']))
      .toEqual(['storage_controller_launch', 'racks_customize']);
    expect(value.requests[0]!['path']).toBe('/ctos/7D4FCTO6WW/launch');
    const customize = value.requests[1]!['body'] as { kind: string; value: { configurations: Obj[] } };
    const controller = customize.value.configurations.find(configuration =>
      configuration['id'] === 'controller-id')!;
    expect(JSON.stringify(controller)).toContain('BCBN');
    expect(value.workspace.serverState.storageConnectionNetworks).toMatchObject([{
      controller: { option: '7D4FCTO6WW', featureCode: 'BCBN', id: 'controller-id' },
    }]);
  });

  it('rejects a requested controller feature that is available but not selected by launch', async () => {
    const value = setup({ featureCode: 'BCBN', selectedFeature: false });
    const revision = value.workspace.revision;
    await expect(openController(value)).rejects.toThrow(/BCBN.*selected|selected.*BCBN/i);
    expect(value.requests.map(request => request['endpoint'])).toEqual(['storage_controller_launch']);
    expect(value.workspace.revision).toBe(revision);
    expect(value.workspace.configurations.size).toBe(1);
    expect(value.workspace.serverState.storageConnectionNetworks).toMatchObject([{
      controller: { featureCode: 'BCBN', id: 'controller-id' },
    }]);
  });

  it('rejects stale callers before launch and does not commit malformed or rejected remote state', async () => {
    const { service, workspace, send } = setup();
    const beforeRevision = workspace.revision;
    await expect(service.openStorageController(workspace.id, {
      name: 'Primary SAN', expectedRevision: beforeRevision + 1, ctx: service.newCtx(),
    })).rejects.toThrow(/revision/i);
    expect(send).not.toHaveBeenCalled();

    send.mockResolvedValueOnce({ raw: { code: 'WRONG', type: 'storage', tabs: [] } } as never);
    await expect(service.openStorageController(workspace.id, {
      name: 'Primary SAN', ctx: service.newCtx(),
    })).rejects.toThrow(/no matching storage configuration/i);
    expect(workspace.revision).toBe(beforeRevision);
    expect(workspace.configurations.size).toBe(1);

    send.mockResolvedValueOnce({ raw: {
      id: 'remote', code: '7DJ0CTO1WW', type: 'storage', tabs: [], connectors: [],
    } } as never).mockResolvedValueOnce({ raw: {
      rackArea: [], nonRackArea: [], connections: [], errors: [{ message: 'rejected layout' }],
    } } as never);
    await expect(service.openStorageController(workspace.id, {
      name: 'Primary SAN', ctx: service.newCtx(),
    })).rejects.toThrow(/rejected layout/i);
    expect(workspace.revision).toBe(beforeRevision);
    expect(workspace.configurations.size).toBe(1);
    expect(workspace.serverState.storageConnectionNetworks).toMatchObject([{
      controller: { id: 'controller-id' },
    }]);
  });

  it('publishes nothing when launch transport or the final persistence write fails', async () => {
    const first = setup();
    const before = snapshot(first.service);
    first.send.mockRejectedValueOnce(new Error('connection reset'));
    await expect(first.service.openStorageController(first.workspace.id, {
      name: 'Primary SAN', ctx: first.service.newCtx(),
    })).rejects.toThrow(/connection reset/i);
    expect(snapshot(first.service)).toEqual(before);

    const second = setup();
    const secondBefore = snapshot(second.service);
    second.service.sessions.setPersistenceWriter(() => { throw new Error('disk full'); });
    const failure = await second.service.openStorageController(second.workspace.id, {
      name: 'Primary SAN', ctx: second.service.newCtx(),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionPersistenceError);
    expect(failure).toMatchObject({ remoteApplied: true, localNotCommitted: true });
    expect(snapshot(second.service)).toEqual(secondBefore);
  });
});

describe('configured storage definition removal', () => {
  it('removes every exclusive physical alias and its references, with atomic history restoration', async () => {
    const value = setup();
    await openController(value);
    const aliases = ['controller-physical-1', 'controller-physical-2'];
    value.workspace.rackArea = [{ id: 'rack-id', code: 'RACK', size: 42, rackItems: aliases.map((id, index) => ({
      id, code: value.option, type: 'storage', position: index * 2 + 1, size: 2, quantity: 0,
    })) }];
    value.workspace.serverState.cloneDependency = { 'controller-id': ['controller-id', ...aliases] };
    value.workspace.serverState.cloneDependencyColor = { 'controller-id': { color: '#abcdef', dependBy: ['controller-id', ...aliases] } };
    value.workspace.serverState.connections = [{ sourceId: 'server-id', destinationId: aliases[0] }];
    value.workspace.serverState.floorInformation = { floorGrid: [{ id: 'rack-id', row: 0, col: 0,
      items: aliases.map(id => ({ id })) }] };
    await value.service.editStorageNetwork(value.workspace.id, { action: 'remove', name: 'Primary SAN',
      expectedRevision: value.workspace.revision });
    expect(value.workspace.rackArea[0]!.rackItems).toEqual([]);
    expect(value.workspace.serverState.cloneDependency).toEqual({});
    expect(value.workspace.serverState.cloneDependencyColor).toEqual({});
    expect(value.workspace.serverState.connections).toEqual([]);
    expect(value.workspace.serverState.connectionGraphInvalidation).toBeDefined();
    expect(JSON.stringify(value.workspace.serverState)).not.toContain('controller-physical');
    await value.service.sessions.undoWorkspace(value.workspace.id);
    expect(value.workspace.rackArea[0]!.rackItems).toHaveLength(2);
    expect(value.workspace.serverState.cloneDependency).toEqual({ 'controller-id': ['controller-id', ...aliases] });
    expect(buildExportGroups(value.workspace)[0]!.products.find(product => product.id === 'controller-id'))
      .toMatchObject({ quantity: 2 });
  });

  it('cascades an exclusively owned managed controller, its graph references and commercial group', async () => {
    const value = setup();
    const opened = await openController(value);
    value.workspace.serverState.connections = [{ sourceId: 'server-id', destinationId: 'controller-id' }];
    value.workspace.serverState.switchMap = [{ id: 'controller-id', network: 'Storage' }];
    value.workspace.cables = [{ id: 'storage-cable', fromConfigId: 'server-id', toConfigId: 'controller-id',
      fromPort: '1', toPort: '1', cableCode: 'AV1W' }];
    const revision = value.workspace.revision;
    const removed = await value.service.editStorageNetwork(value.workspace.id, {
      action: 'remove', name: 'Primary SAN', expectedRevision: revision,
    });
    expect(removed).toMatchObject({ storageNetworkCount: 0, updatedAssignments: 0, removedConfigurations: 1 });
    expect(value.service.sessions.get(opened.session)).toBeUndefined();
    expect(value.workspace.configurations.size).toBe(1);
    expect(value.workspace.serverState.storageConnectionNetworks).toEqual([]);
    expect(value.workspace.serverState.connections).toEqual([]);
    expect(value.workspace.serverState.switchMap).toEqual([]);
    expect(value.workspace.cables).toEqual([]);
    expect(buildExportGroups(value.workspace).flatMap(group => group.products)
      .some(product => product.code === '7DJ0CTO1WW')).toBe(false);

    await value.service.sessions.undoWorkspace(value.workspace.id);
    expect(value.service.sessions.get(opened.session)?.configurationId).toBe('controller-id');
    expect(value.workspace.serverState.storageConnectionNetworks).toMatchObject([{ name: 'Primary SAN' }]);
    await value.service.sessions.redoWorkspace(value.workspace.id);
    expect(value.service.sessions.get(opened.session)).toBeUndefined();

    const root = mkdtempSync(join(tmpdir(), 'dcsc-storage-remove-'));
    tempRoots.push(root);
    const config = ConfigSchema.parse({ files: { persistSessions: true,
      sessionFile: join(root, 'sessions.json') }, logLevel: 'silent' });
    saveSessions(value.service.sessions, config);
    const restored = new SessionStore();
    expect(loadSessions(restored, config)).toBe(1);
    const restoredWorkspace = restored.listWorkspaces()[0]!;
    expect(restoredWorkspace.configurations.size).toBe(1);
    expect(restoredWorkspace.serverState.storageConnectionNetworks).toEqual([]);
    expect([...restoredWorkspace.configurations.values()]
      .some(session => session.configurationId === 'controller-id')).toBe(false);
  });

  it('keeps the definition and managed controller until assignments are explicitly cleared', async () => {
    const value = setup();
    const opened = await openController(value);
    value.server.raw.selectedStorageNetwork = 'Primary SAN';
    const revision = value.workspace.revision;
    await expect(value.service.editStorageNetwork(value.workspace.id, {
      action: 'remove', name: 'Primary SAN', expectedRevision: revision,
    })).rejects.toThrow(/clearAssignments=true/i);
    expect(value.workspace.revision).toBe(revision);
    expect(value.service.sessions.get(opened.session)).toBeDefined();
    expect(value.workspace.serverState.storageConnectionNetworks).toHaveLength(1);
    expect(value.server.raw.selectedStorageNetwork).toBe('Primary SAN');

    const removed = await value.service.editStorageNetwork(value.workspace.id, {
      action: 'remove', name: 'Primary SAN', clearAssignments: true, expectedRevision: revision,
    });
    expect(removed).toMatchObject({ updatedAssignments: 1, removedConfigurations: 1 });
    expect(value.server.raw.selectedStorageNetwork).toBe('');
    expect(value.service.sessions.get(opened.session)).toBeUndefined();
  });

  it('preserves a managed controller still referenced by another storage definition', async () => {
    const value = setup();
    const opened = await openController(value);
    const primary = (value.workspace.serverState.storageConnectionNetworks as Array<Record<string, unknown>>)[0]!;
    value.workspace.serverState.storageConnectionNetworks = [primary, {
      ...structuredClone(primary), name: 'Secondary SAN',
    }];
    const removed = await value.service.editStorageNetwork(value.workspace.id, {
      action: 'remove', name: 'Primary SAN', expectedRevision: value.workspace.revision,
    });
    expect(removed).toMatchObject({ storageNetworkCount: 1, removedConfigurations: 0 });
    expect(value.service.sessions.get(opened.session)?.configurationId).toBe('controller-id');
    expect(value.workspace.serverState.storageConnectionNetworks).toMatchObject([{ name: 'Secondary SAN' }]);
  });

  it('rolls back the complete local cascade when persistence fails', async () => {
    const value = setup();
    await openController(value);
    const before = snapshot(value.service);
    value.service.sessions.setPersistenceWriter(() => { throw new Error('disk full'); });
    const failure = await value.service.editStorageNetwork(value.workspace.id, {
      action: 'remove', name: 'Primary SAN', expectedRevision: value.workspace.revision,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionPersistenceError);
    expect(failure).toMatchObject({ remoteApplied: false, localNotCommitted: true });
    expect(snapshot(value.service)).toEqual(before);
  });
});
