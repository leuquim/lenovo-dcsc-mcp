import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import type { SendInput } from '../src/http/request.js';
import { DcscService } from '../src/mcp/service.js';
import { registerStorageTools } from '../src/mcp/storageTools.js';
import { registerTools } from '../src/mcp/tools.js';
import { loadSessions, saveSessions } from '../src/session/persist.js';
import { SessionPersistenceError } from '../src/http/persistenceError.js';
import { SessionStore } from '../src/session/SessionStore.js';

type Obj = Record<string, unknown>;
type Reply = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;
const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Obj : {};

const services: DcscService[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function snapshot(service: DcscService) {
  const copy = structuredClone(service.sessions.listWorkspaces());
  for (const workspace of copy) {
    workspace.lastAccessAt = 0;
    for (const session of workspace.configurations.values()) session.lastAccessAt = 0;
  }
  return copy;
}

function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const solution = { solutionMode: 'HPC and AI - Systems', masterSlices: ['HPCGP'] };
  const serverRaw = { id: 'server-id', workspaceId: 'server-id', code: '7D73CTOHWW',
    sliceCtoCode: '7D73CTOHWW', type: 'server', name: 'Server', description: 'Server', quantity: 1,
    totalPrice: 100, tabs: [] };
  const server = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: serverRaw,
    configurationId: serverRaw.id, reduced: reduceConfiguration(serverRaw, serverRaw.id), primed: true });
  const workspace = service.sessions.getWorkspace(server.id)!;
  const rackRaw = { id: 'rack-id', workspaceId: 'rack-id', code: '7D6DCTO1WW', sliceCtoCode: '7D6DCTO1WW',
    type: 'rack', name: 'Rack', description: '42U Rack', quantity: 1, totalPrice: 1000, tabs: [] };
  service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: rackRaw,
    configurationId: rackRaw.id, reduced: reduceConfiguration(rackRaw, rackRaw.id), primed: true,
    workspaceId: workspace.id });
  const controllerRaw = { id: 'controller-template', workspaceId: 'controller-template', code: '7DP4CTO1WW',
    sliceCtoCode: '7DP4CTO1WW', type: 'storage', name: 'Controller', description: 'DS3200', quantity: 1,
    totalPrice: 211_948.51, tabs: [] };
  service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: controllerRaw,
    configurationId: controllerRaw.id, reduced: reduceConfiguration(controllerRaw, controllerRaw.id), primed: true,
    workspaceId: workspace.id });
  const switchRaw = { id: 'switch-template', workspaceId: 'switch-template', code: '7DHNCTO1WW',
    sliceCtoCode: '7DHNCTO1WW', type: 'switch', name: 'Switch', description: 'DB710S', quantity: 1,
    totalPrice: 10_759.01, tabs: [], unSelectableCharacters: [{ name: 'BASE',
      features: [{ code: 'C1FM' }], results: [{ code: 'C1FM', quantity: 1 }] }] };
  service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: switchRaw,
    configurationId: switchRaw.id, reduced: reduceConfiguration(switchRaw, switchRaw.id), primed: true,
    workspaceId: workspace.id });
  workspace.rackArea = [{ ...rackRaw, configurationId: rackRaw.id, size: 42, rackItems: [] }];
  workspace.serverState.storageConnectionNetworks = [{
    name: 'Primary SAN', maximumExpansions: 0, type: 'General Storage', layout: 'Fully Redundant',
    controller: { option: controllerRaw.code, featureCode: '', id: controllerRaw.id, hardwareType: 'storage' },
    expansion: {},
    mainSwitch: { option: switchRaw.code, featureCode: 'C1FM', id: switchRaw.id, hardwareType: 'switch' },
  }];
  workspace.serverState.autoConnectSettings = { autoAddPDU: false };
  workspace.serverState.cloneDependency = { [rackRaw.id]: [rackRaw.id], [serverRaw.id]: [serverRaw.id] };

  const requests: SendInput[] = [];
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
    requests.push(request);
    if (request.endpoint !== 'racks_customize') throw new Error(`Unexpected endpoint ${request.endpoint}`);
    const body = request.body?.kind === 'json' ? structuredClone(request.body.value as Obj) : {};
    const rackArea = body['rackArea'] as Obj[];
    for (const rack of rackArea) {
      for (const item of rack['rackItems'] as Obj[]) {
        if (item['code'] === controllerRaw.code) Object.assign(item, { position: 1, size: 2, quantity: 0 });
        if (item['code'] === switchRaw.code) Object.assign(item, { position: 4, size: 1, quantity: 0 });
      }
    }
    return { raw: { rackArea, nonRackArea: body['nonRackArea'], connections: [{
      sourceId: 'controller-template', destinationId: 'switch-template', sourcePort: '1', destinationPort: '1',
    }], errors: [] } } as never;
  });
  const handlers = new Map<string, Handler>();
  registerStorageTools({ registerTool(name: string, _definition: unknown, callback: Handler) {
    handlers.set(name, callback); return { remove() {}, update() {} };
  } } as unknown as McpServer, service);
  registerTools({ registerTool(name: string, _definition: unknown, callback: Handler) {
    handlers.set(name, callback); return { remove() {}, update() {} };
  } } as unknown as McpServer, service);
  return { service, workspace, requests, send, handlers };
}

describe('dcsc_storage_set place', () => {
  it('places bounded physical aliases and exposes executable inspection and export continuations', async () => {
    const value = setup();
    const revision = value.workspace.revision;
    const reply = await value.handlers.get('dcsc_storage_set')!({
      session: value.workspace.id, change: { action: 'place', name: 'Primary SAN', rackId: 'rack-id' }, expectedRevision: revision,
    });
    expect(reply.isError).not.toBe(true);
    const result = JSON.parse(reply.content[0]!.text) as Obj;
    expect(result).toMatchObject({ workspace: value.workspace.id, revision: revision + 1,
      storageName: 'Primary SAN',
      templates: [{ configurationId: 'controller-template', created: false },
        { configurationId: 'switch-template', created: false }],
      inspect: { tool: 'dcsc_workspace_get', arguments: {
        session: value.workspace.id, view: 'layout', path: ['rawRackArea'], expectedRevision: revision + 1,
      } },
    });
    const placements = result['placements'] as Obj[];
    expect(placements).toHaveLength(2);
    expect(placements).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'controller', templateId: 'controller-template', rackId: 'rack-id',
        position: 1, size: 2, quantity: 0 }),
      expect.objectContaining({ role: 'mainSwitch', templateId: 'switch-template', rackId: 'rack-id',
        position: 4, size: 1, quantity: 0 }),
    ]));
    expect(placements.every(placement => !('raw' in placement) && !('controllerExpansion' in placement))).toBe(true);
    expect(value.requests).toHaveLength(1);
    expect(value.requests[0]!.query).toEqual({ autoArrange: true, autoConnect: true, cogValidation: true });
    expect(value.workspace.serverState.cloneDependency).toMatchObject({
      'controller-template': ['controller-template', expect.any(String)],
      'switch-template': ['switch-template', expect.any(String)],
    });
    expect(value.workspace.serverState.connections).toHaveLength(1);
    const continuation = object(result['inspect']);
    const inspected = await value.handlers.get(String(continuation['tool']))!(object(continuation['arguments']));
    expect(inspected.isError).not.toBe(true);
    expect(JSON.parse(inspected.content[0]!.text)).toMatchObject({
      path: ['rawRackArea'], total: 1,
    });
  });

  it('rejects stale revisions before I/O and rolls back remote rejection and persistence failure', async () => {
    const stale = setup();
    await expect(stale.service.placeStorageNetwork(stale.workspace.id, {
      name: 'Primary SAN', rackId: 'rack-id', expectedRevision: stale.workspace.revision + 1,
      ctx: stale.service.newCtx(),
    })).rejects.toThrow(/revision/i);
    expect(stale.send).not.toHaveBeenCalled();

    const rejected = setup();
    const beforeRejected = snapshot(rejected.service);
    rejected.send.mockResolvedValueOnce({ raw: {
      rackArea: rejected.workspace.rackArea, nonRackArea: [], connections: [],
      errors: [{ message: 'storage placement rejected' }],
    } } as never);
    await expect(rejected.service.placeStorageNetwork(rejected.workspace.id, {
      name: 'Primary SAN', rackId: 'rack-id', ctx: rejected.service.newCtx(),
    })).rejects.toThrow(/did not retain|rejected/i);
    expect(snapshot(rejected.service)).toEqual(beforeRejected);

    const failed = setup();
    const beforeFailed = snapshot(failed.service);
    failed.service.sessions.setPersistenceWriter(() => { throw new Error('disk full'); });
    const failure = await failed.service.placeStorageNetwork(failed.workspace.id, {
      name: 'Primary SAN', rackId: 'rack-id', ctx: failed.service.newCtx(),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionPersistenceError);
    expect(failure).toMatchObject({ remoteApplied: true, localNotCommitted: true });
    expect(snapshot(failed.service)).toEqual(beforeFailed);
  });

  it('survives save/restart with template identities, aliases and accepted rack placement intact', async () => {
    const value = setup();
    await value.service.placeStorageNetwork(value.workspace.id, {
      name: 'Primary SAN', rackId: 'rack-id', ctx: value.service.newCtx(),
    });
    const root = mkdtempSync(join(tmpdir(), 'dcsc-storage-placement-'));
    roots.push(root);
    const config = ConfigSchema.parse({ files: { persistSessions: true,
      sessionFile: join(root, 'sessions.json') }, logLevel: 'silent' });
    const before = value.service.sessions.getWorkspace(value.workspace.id)!;
    const beforeDependencies = before.serverState.cloneDependency as Record<string, string[]>;
    before.cables = [{ id: 'managed-physical-cable',
      fromConfigId: beforeDependencies['controller-template']![1]!,
      toConfigId: beforeDependencies['switch-template']![1]!,
      fromPort: '1', toPort: '2', cableCode: '3801' }];
    saveSessions(value.service.sessions, config);
    const restored = new SessionStore();
    expect(loadSessions(restored, config)).toBe(1);
    const workspace = restored.listWorkspaces()[0]!;
    expect([...workspace.configurations.values()].map(session => session.configurationId))
      .toEqual(expect.arrayContaining(['controller-template', 'switch-template']));
    expect(workspace.cables).toEqual(before.cables);
    expect(workspace.integrity).not.toBe('damaged');
    before.cables.push({ ...before.cables[0]!, id: 'missing-physical-cable', fromConfigId: 'unplaced-alias' });
    saveSessions(value.service.sessions, config);
    const rejected = new SessionStore();
    expect(loadSessions(rejected, config)).toBe(1);
    expect(rejected.listWorkspaces()[0]!.cables).toEqual(workspace.cables);
    expect(rejected.listWorkspaces()[0]!.integrity).toBe('damaged');

    const dependencies = workspace.serverState.cloneDependency as Record<string, string[]>;
    expect(dependencies['controller-template']).toHaveLength(2);
    expect(dependencies['switch-template']).toHaveLength(2);
    const ids = (workspace.rackArea[0]!['rackItems'] as Obj[]).map(item => item['id']);
    expect(ids).toEqual(expect.arrayContaining([
      dependencies['controller-template']![1], dependencies['switch-template']![1],
    ]));
  });
});
