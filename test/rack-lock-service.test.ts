import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import type { SendInput } from '../src/http/request.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';
import type { RawConfiguration } from '../src/model/types.js';

type Obj = Record<string, unknown>;
type Reply = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;
const services: DcscService[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(persist = false) {
  const root = mkdtempSync(join(tmpdir(), 'dcsc-rack-lock-'));
  roots.push(root);
  const config = ConfigSchema.parse({ files: {
    persistSessions: persist,
    sessionFile: join(root, 'sessions.json'),
  }, logLevel: 'silent' });
  const service = new DcscService(config);
  services.push(service);
  const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
  const sourceRaw: RawConfiguration = {
    id: 'server-1', workspaceId: 'server-1', code: '7D73CTO1WW', sliceCtoCode: '7D73CTO1WW',
    name: 'Server', description: 'SR630 V3', type: 'server', quantity: 1, totalPrice: 15_650.51,
    tabs: [],
  };
  const source = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: sourceRaw,
    configurationId: 'server-1', reduced: reduceConfiguration(sourceRaw, 'server-1'), primed: true });
  const rackRaw: RawConfiguration = {
    id: 'rack-1', workspaceId: 'rack-1', code: '7D6DCTO1WW', sliceCtoCode: '7D6DCTO1WW',
    name: 'Rack', description: '42U Rack', type: 'rack', quantity: 1, totalPrice: 12_256.01, tabs: [],
  };
  service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: rackRaw,
    configurationId: 'rack-1', reduced: reduceConfiguration(rackRaw, 'rack-1'), primed: true,
    workspaceId: source.workspaceId });
  const workspace = service.sessions.getWorkspace(source.workspaceId)!;
  workspace.rackArea = [{
    id: 'rack-1', configurationId: 'rack-1', name: 'Rack', code: '7D6DCTO1WW',
    type: 'rack', size: 42, lockedSpace: [], errors: [], rackItems: [{
      id: 'server-1', configurationId: 'server-1', name: 'Server', code: '7D73CTO1WW',
      type: 'server', size: 1, position: 1, lowestPosition: 1, highestPosition: 42,
      defaultPosition: 1, lock: false, rule: { mtMinMaxRule: null, productMinMaxRule: null }, nodes: [],
    }],
  }];
  workspace.serverState.cloneDependency = { 'server-1': ['server-1'], 'rack-1': ['rack-1'] };
  return { service, config, workspace, source };
}

function installAcceptedLocks(service: DcscService) {
  const calls: SendInput[] = [];
  vi.spyOn(service.http, 'send').mockImplementation(async request => {
    calls.push(request);
    const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
    if (request.endpoint === 'racks_customize') return { raw: {
      rackArea: structuredClone(body['rackArea']),
      nonRackArea: structuredClone(body['nonRackArea'] ?? []),
      connections: structuredClone(body['connections'] ?? []), errors: [],
    } } as never;
    if (request.endpoint === 'workspace_autoDerive') return { raw: {
      configurations: service.sessions.list().map(session => structuredClone(session.raw)),
    } } as never;
    throw new Error(`Unexpected endpoint ${request.endpoint}`);
  });
  return calls;
}

function jsonBody(call: SendInput): Obj {
  expect(call.body?.kind).toBe('json');
  return call.body?.kind === 'json' ? call.body.value as Obj : {};
}

function snapshot(service: DcscService) {
  const copy = structuredClone(service.sessions.listWorkspaces());
  for (const workspace of copy) {
    workspace.lastAccessAt = 0;
    for (const session of workspace.configurations.values()) session.lastAccessAt = 0;
  }
  return copy;
}

describe('rack item and empty-U Lock service orchestration', () => {
  it('matches the captured one-based customize and zero-based derive wire contract', async () => {
    const { service, workspace, source } = setup();
    const calls = installAcceptedLocks(service);
    const initialRevision = workspace.revision;

    await service.setRackLock(source.id, {
      target: { itemId: 'server-1' }, locked: true,
      expectedRevision: workspace.revision, ctx: service.newCtx(),
    });
    await service.setRackLock(workspace.id, {
      target: { rackId: 'rack-1', position: 42 }, locked: true,
      expectedRevision: workspace.revision, ctx: service.newCtx(),
    });

    expect(calls.map(call => call.endpoint)).toEqual([
      'racks_customize', 'workspace_autoDerive', 'racks_customize', 'workspace_autoDerive',
    ]);
    expect(calls[0]!.query).toEqual({ autoArrange: false, autoConnect: true, cogValidation: true });
    expect(calls[2]!.query).toEqual({ autoArrange: false, autoConnect: true, cogValidation: true });
    expect(calls[1]!.query).toEqual({ entranceFlag: 'customize', guideMode: true });
    expect(calls[3]!.query).toEqual({ entranceFlag: 'customize', guideMode: true });

    const itemCustomizeRack = (jsonBody(calls[0]!)['rackArea'] as Obj[])[0]!;
    expect((itemCustomizeRack['rackItems'] as Obj[])[0]).toMatchObject({
      id: 'server-1', position: 1, lock: true,
    });
    expect(itemCustomizeRack['lockedSpace']).toEqual([]);
    const itemDerive = jsonBody(calls[1]!);
    expect(itemDerive['customizingIds']).toEqual([]);
    const itemDeriveRack = ((itemDerive['workspaceInformation'] as Obj)['rackData'] as Obj[])[0]!;
    expect((itemDeriveRack['rackItems'] as Obj[])[0]).toMatchObject({ lock: true });
    expect(itemDeriveRack['lockedSpace']).toEqual([]);

    const spaceCustomizeRack = (jsonBody(calls[2]!)['rackArea'] as Obj[])[0]!;
    expect(spaceCustomizeRack['lockedSpace']).toEqual([42]);
    const spaceDerive = jsonBody(calls[3]!);
    expect(spaceDerive['customizingIds']).toEqual([]);
    const spaceDeriveRack = ((spaceDerive['workspaceInformation'] as Obj)['rackData'] as Obj[])[0]!;
    expect(spaceDeriveRack['lockedSpace']).toEqual([41]);
    expect((spaceDeriveRack['rackItems'] as Obj[])[0]).toMatchObject({ lock: true });

    expect(workspace.rackArea[0]!.lockedSpace).toEqual([42]);
    expect((workspace.rackArea[0]!.rackItems as Obj[])[0]).toMatchObject({ lock: true });
    expect(workspace.revision).toBe(initialRevision + 2);
  });

  it.each([1, 2])('rolls back the entire workspace when remote stage %i fails', async failStage => {
    const { service, workspace, source } = setup();
    const before = snapshot(service);
    let stage = 0;
    vi.spyOn(service.http, 'send').mockImplementation(async request => {
      stage += 1;
      if (stage === failStage) throw new Error(`Injected lock stage ${stage}`);
      const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
      return { raw: request.endpoint === 'racks_customize' ? {
        rackArea: body['rackArea'], nonRackArea: [], connections: [], errors: [],
      } : { configurations: service.sessions.list().map(session => structuredClone(session.raw)) },
      } as never;
    });
    await expect(service.setRackLock(source.id, {
      target: { itemId: 'server-1' }, locked: true,
      expectedRevision: workspace.revision, ctx: service.newCtx(),
    })).rejects.toThrow(`Injected lock stage ${failStage}`);
    expect(snapshot(service)).toEqual(before);
  });

  it('rejects stale callers before HTTP and rolls back an accepted remote change on disk failure', async () => {
    const { service, workspace, source } = setup();
    const calls = installAcceptedLocks(service);
    const before = snapshot(service);
    await expect(service.setRackLock(source.id, {
      target: { itemId: 'server-1' }, locked: true,
      expectedRevision: workspace.revision + 1, ctx: service.newCtx(),
    })).rejects.toThrow(/revision/i);
    expect(calls).toHaveLength(0);

    service.sessions.setPersistenceWriter(() => { throw new Error('/private/session/file'); });
    await expect(service.setRackLock(source.id, {
      target: { itemId: 'server-1' }, locked: true,
      expectedRevision: workspace.revision, ctx: service.newCtx(),
    })).rejects.toMatchObject({ remoteApplied: true, localNotCommitted: true });
    expect(calls).toHaveLength(2);
    expect(snapshot(service)).toEqual(before);
  });

  it('persists canonical locks through undo, redo, close and restart', async () => {
    const { service, config, workspace, source } = setup(true);
    installAcceptedLocks(service);
    await service.setRackLock(source.id, {
      target: { itemId: 'server-1' }, locked: true,
      expectedRevision: workspace.revision, ctx: service.newCtx(),
    });
    await service.setRackLock(workspace.id, {
      target: { rackId: 'rack-1', position: 42 }, locked: true,
      expectedRevision: workspace.revision, ctx: service.newCtx(),
    });
    const committedRevision = workspace.revision;
    expect(await service.sessions.undoWorkspace(workspace.id, committedRevision)).toBe(true);
    expect(workspace.rackArea[0]!.lockedSpace).toEqual([]);
    expect(await service.sessions.redoWorkspace(workspace.id, workspace.revision)).toBe(true);
    expect(workspace.rackArea[0]!.lockedSpace).toEqual([42]);

    await service.close();
    services.splice(services.indexOf(service), 1);
    const restored = new DcscService(config);
    services.push(restored);
    const loaded = restored.sessions.getWorkspace(workspace.id)!;
    expect(loaded.rackArea[0]!.lockedSpace).toEqual([42]);
    expect((loaded.rackArea[0]!.rackItems as Obj[])[0]).toMatchObject({ lock: true, position: 1 });
  });

  it('exposes the accepted canonical result and executable navigation through the registered tool', async () => {
    const { service, workspace, source } = setup();
    installAcceptedLocks(service);
    const handlers = new Map<string, Handler>();
    registerTools({ registerTool(name: string, _definition: unknown, callback: Handler) {
      handlers.set(name, callback);
      return { remove() {}, update() {} };
    } } as unknown as McpServer, service);

    const reply = await handlers.get('dcsc_set_rack_lock')!({
      session: source.id, target: { rackId: 'rack-1', position: 42 }, locked: true,
      expectedRevision: workspace.revision,
    });
    expect(reply.isError).not.toBe(true);
    expect(JSON.parse(reply.content[0]!.text)).toMatchObject({
      rackId: 'rack-1', position: 42, locked: true,
      workspace: workspace.id, workspaceRevision: workspace.revision,
      revisionScope: 'workspace',
      next: { tool: 'dcsc_workspace_layout', arguments: { session: workspace.id } },
    });
  });
});
