import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { buildExportGroups } from '../src/domain/exportGroups.js';
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
  const root = mkdtempSync(join(tmpdir(), 'dcsc-physical-copy-'));
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
    tabs: [{ title: 'System', type: 'hardware', subTabs: [{ title: 'System', sections: [{
      name: 'PROCESSOR', features: [{ code: 'BYW3', max: 2 }], results: [{ code: 'BYW3', quantity: 1 }],
    }] }] }],
  };
  const source = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: sourceRaw,
    configurationId: 'server-1', reduced: reduceConfiguration(sourceRaw, 'server-1'), primed: true });
  const rackRaw: RawConfiguration = { id: 'rack-1', workspaceId: 'rack-1', code: '7D6DCTO1WW',
    sliceCtoCode: '7D6DCTO1WW', name: 'Rack', description: '42U Rack', type: 'rack', quantity: 1,
    totalPrice: 12_256.01, tabs: [] };
  service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: rackRaw,
    configurationId: 'rack-1', reduced: reduceConfiguration(rackRaw, 'rack-1'), primed: true,
    workspaceId: source.workspaceId });
  const workspace = service.sessions.getWorkspace(source.workspaceId)!;
  workspace.rackArea = [{ id: 'rack-1', configurationId: 'rack-1', name: 'Rack', code: '7D6DCTO1WW',
    type: 'rack', size: 42, lockedSpace: [], errors: [], rackItems: [{ id: 'server-1',
      configurationId: 'server-1', name: 'Server', code: '7D73CTO1WW', type: 'server', size: 1,
      position: 1, lowestPosition: 1, highestPosition: 42, defaultPosition: 1, lock: false,
      rule: { mtMinMaxRule: null, productMinMaxRule: null }, nodes: [] }] }];
  workspace.serverState.cloneDependency = { 'server-1': ['server-1'], 'rack-1': ['rack-1'] };
  return { service, config, workspace, source, sourceRaw, rackRaw };
}

function installAcceptedCopy(service: DcscService, rackRaw: RawConfiguration) {
  const calls: SendInput[] = [];
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
    calls.push(request);
    const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
    if (request.endpoint === 'racks_customize') {
      const rackArea = structuredClone(body['rackArea'] as Obj[]);
      for (const rack of rackArea) for (const item of rack['rackItems'] as Obj[]) delete item['newHardware'];
      return { raw: { rackArea, nonRackArea: [], connections: [], errors: [] } } as never;
    }
    if (request.endpoint === 'workspace_autoDerive') {
      // The fresh browser Copy response is a normal delta and contains only
      // the rack configuration; source and copy are retained from the request.
      return { raw: { configurations: [structuredClone(rackRaw)] } } as never;
    }
    throw new Error(`Unexpected endpoint ${request.endpoint}`);
  });
  return { calls, send };
}

function snapshot(service: DcscService) {
  const copy = structuredClone(service.sessions.listWorkspaces());
  for (const workspace of copy) {
    workspace.lastAccessAt = 0;
    for (const session of workspace.configurations.values()) session.lastAccessAt = 0;
  }
  return copy;
}

describe('independent physical rack Copy service orchestration', () => {
  it('matches the captured two-request contract and commits a distinct commercial configuration', async () => {
    const { service, workspace, source, rackRaw } = setup();
    const { calls } = installAcceptedCopy(service, rackRaw);
    const write = vi.fn();
    service.sessions.setPersistenceWriter(write);
    const revision = workspace.revision;

    const result = await service.copyRackItem(source.id, { expectedRevision: revision, ctx: service.newCtx() });
    const copyId = result.copy.configurationId;
    expect(calls.map(call => call.endpoint)).toEqual(['racks_customize', 'workspace_autoDerive']);
    expect(calls[0]!.query).toEqual({ autoArrange: false, autoConnect: true, cogValidation: true });
    const customize = calls[0]!.body?.kind === 'json' ? calls[0]!.body.value as Obj : {};
    expect(customize['cloneDependency']).toEqual({});
    expect((customize['configurations'] as Obj[]).map(raw => ({ id: raw['id'], name: raw['name'] })))
      .toEqual([{ id: 'server-1', name: 'Server' }, { id: 'rack-1', name: 'Rack' },
        { id: copyId, name: 'Copy_Server' }]);
    expect((customize['rackArea'] as Obj[])[0]!['rackItems']).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: copyId, name: 'Copy_Server', position: 2, lock: false, newHardware: true }),
    ]));

    expect(calls[1]!.query).toEqual({ entranceFlag: 'customize', guideMode: true });
    const derive = calls[1]!.body?.kind === 'json' ? calls[1]!.body.value as Obj : {};
    expect(derive['customizingIds']).toEqual([]);
    expect((derive['workspaceInformation'] as Obj)['cloneDependency']).toEqual({
      'server-1': ['server-1'], 'rack-1': ['rack-1'],
    });
    expect(result.copy.raw).toMatchObject({ id: copyId, workspaceId: copyId, name: 'Copy_Server',
      quantity: 1, totalPrice: 15_650.51 });
    expect(result.placement).toEqual({ configurationId: copyId, rackId: 'rack-1', position: 2 });
    expect(workspace.serverState.cloneDependency).toEqual({
      'server-1': ['server-1'], 'rack-1': ['rack-1'], [copyId]: [copyId],
    });
    const serverProducts = buildExportGroups(workspace)[0]!.products.filter(product =>
      product.code === '7D73CTO1WW' && product.type === 'hardware');
    expect(serverProducts.map(product => ({ id: product.id, quantity: product.quantity,
      unitPrice: product.unitPrice }))).toEqual([
      { id: 'server-1', quantity: 1, unitPrice: 15_650.51 },
      { id: copyId, quantity: 1, unitPrice: 15_650.51 },
    ]);
    expect(workspace.revision).toBe(revision + 1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2])('rolls the complete workspace back when remote stage %i fails', async failStage => {
    const { service, workspace, source } = setup();
    const before = snapshot(service);
    let stage = 0;
    vi.spyOn(service.http, 'send').mockImplementation(async request => {
      stage += 1;
      if (stage === failStage) throw new Error(`Injected stage ${stage}`);
      const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
      if (request.endpoint === 'racks_customize') return { raw: {
        rackArea: body['rackArea'], nonRackArea: [], connections: [], errors: [],
      } } as never;
      return { raw: { configurations: [] } } as never;
    });
    await expect(service.copyRackItem(source.id, { expectedRevision: workspace.revision,
      ctx: service.newCtx() })).rejects.toThrow(`Injected stage ${failStage}`);
    expect(snapshot(service)).toEqual(before);
  });

  it('rejects stale callers before HTTP and reports accepted-remote persistence failure safely', async () => {
    const { service, workspace, source, rackRaw } = setup();
    const { calls } = installAcceptedCopy(service, rackRaw);
    const before = snapshot(service);
    await expect(service.copyRackItem(source.id, { expectedRevision: workspace.revision + 1,
      ctx: service.newCtx() })).rejects.toThrow(/revision/i);
    expect(calls).toHaveLength(0);
    service.sessions.setPersistenceWriter(() => { throw new Error('/private/session/file'); });
    await expect(service.copyRackItem(source.id, { expectedRevision: workspace.revision,
      ctx: service.newCtx() })).rejects.toMatchObject({ remoteApplied: true, localNotCommitted: true });
    expect(calls).toHaveLength(2);
    expect(snapshot(service)).toEqual(before);
  });

  it('retains copy identity, placement, dependency, history and restart state', async () => {
    const { service, config, workspace, source, rackRaw } = setup(true);
    installAcceptedCopy(service, rackRaw);
    const result = await service.copyRackItem(source.id, { expectedRevision: workspace.revision,
      ctx: service.newCtx() });
    const copyId = result.copy.configurationId;
    const committedRevision = workspace.revision;
    const exported = buildExportData({ workspace, solution: workspace.solution, fileTypes: ['XML'],
      validationMode: workspace.validationMode });
    expect((exported['workspaceInformation'] as Obj)['cloneDependency']).toEqual({
      'server-1': ['server-1'], 'rack-1': ['rack-1'], [copyId]: [copyId],
    });
    expect(await service.sessions.undoWorkspace(workspace.id, committedRevision)).toBe(true);
    expect(workspace.configurations.size).toBe(2);
    expect((workspace.rackArea[0]!['rackItems'] as Obj[])).toHaveLength(1);
    expect(await service.sessions.redoWorkspace(workspace.id, workspace.revision)).toBe(true);
    expect(workspace.configurations.size).toBe(3);

    await service.close();
    services.splice(services.indexOf(service), 1);
    const restored = new DcscService(config);
    services.push(restored);
    const loaded = restored.sessions.getWorkspace(workspace.id)!;
    const copy = [...loaded.configurations.values()].find(session => session.configurationId === copyId);
    expect(copy?.raw.name).toBe('Copy_Server');
    expect((loaded.rackArea[0]!['rackItems'] as Obj[]).find(item => item['id'] === copyId))
      .toMatchObject({ position: 2, name: 'Copy_Server' });
    expect((loaded.serverState.cloneDependency as Record<string, string[]>)[copyId]).toEqual([copyId]);
  });

  it('exposes the accepted copy through the registered tool with executable navigation', async () => {
    const { service, workspace, source, rackRaw } = setup();
    installAcceptedCopy(service, rackRaw);
    const handlers = new Map<string, Handler>();
    registerTools({ registerTool(name: string, _definition: unknown, callback: Handler) {
      handlers.set(name, callback);
      return { remove() {}, update() {} };
    } } as unknown as McpServer, service);

    const reply = await handlers.get('dcsc_copy_rack_item')!({
      session: source.id, expectedRevision: workspace.revision,
    });
    expect(reply.isError).not.toBe(true);
    const result = JSON.parse(reply.content[0]!.text) as Obj;
    expect(result).toMatchObject({
      workspace: workspace.id, workspaceRevision: workspace.revision,
      name: 'Copy_Server', source: { session: source.id, configurationId: 'server-1' },
      placement: { rackId: 'rack-1', position: 2 },
      next: { tool: 'dcsc_list_options' }, inspect: { tool: 'dcsc_workspace_layout' },
    });
    expect(result['configurationId']).not.toBe('server-1');
  });
});
