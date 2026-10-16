import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import type { SendInput } from '../src/http/request.js';
import { DcscService } from '../src/mcp/service.js';
import type { RawConfiguration } from '../src/model/types.js';

type Obj = Record<string, unknown>;
const services: DcscService[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(persist = false) {
  const root = mkdtempSync(join(tmpdir(), 'dcsc-physical-clone-'));
  roots.push(root);
  const config = ConfigSchema.parse({ files: {
    persistSessions: persist,
    sessionFile: join(root, 'sessions.json'),
  }, logLevel: 'silent' });
  const service = new DcscService(config);
  services.push(service);
  const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
  const sourceRaw: RawConfiguration = {
    id: 'server-1', code: '7D73CTO1WW', sliceCtoCode: '7D73CTO1WW', description: 'SR630 V3',
    type: 'server', quantity: 1, totalPrice: 15_650.51,
    tabs: [{ title: 'System', type: 'hardware', subTabs: [{ title: 'System', sections: [{
      name: 'PROCESSOR', features: [{ code: 'BYW3', max: 2 }], results: [{ code: 'BYW3', quantity: 1 }],
    }] }] }],
  };
  const source = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: sourceRaw,
    configurationId: 'server-1', reduced: reduceConfiguration(sourceRaw, 'server-1'), primed: true });
  const rackRaw: RawConfiguration = { id: 'rack-1', code: '7D6DCTO1WW', sliceCtoCode: '7D6DCTO1WW',
    description: '42U Rack', type: 'rack', quantity: 1, totalPrice: 12_256.01, tabs: [] };
  service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: rackRaw,
    configurationId: 'rack-1', reduced: reduceConfiguration(rackRaw, 'rack-1'), primed: true,
    workspaceId: source.workspaceId });
  const workspace = service.sessions.getWorkspace(source.workspaceId)!;
  workspace.rackArea = [{ id: 'rack-1', configurationId: 'rack-1', code: '7D6DCTO1WW', type: 'rack',
    size: 42, lockedSpace: [], errors: [], rackItems: [{ id: 'server-1', configurationId: 'server-1',
      code: '7D73CTO1WW', type: 'server', size: 1, position: 1, lowestPosition: 1, highestPosition: 42,
      defaultPosition: 1, lock: false, rule: { mtMinMaxRule: null, productMinMaxRule: null }, nodes: [] }] }];
  workspace.serverState.cloneDependency = { 'server-1': ['server-1'], 'rack-1': ['rack-1'] };
  return { service, config, workspace, source, sourceRaw, rackRaw };
}

function installAcceptedLayout(service: DcscService, sourceRaw: RawConfiguration, rackRaw: RawConfiguration) {
  const calls: SendInput[] = [];
  let customizeCount = 0;
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
    calls.push(request);
    const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
    if (request.endpoint === 'racks_customize') {
      customizeCount += 1;
      const rackArea = structuredClone(body['rackArea'] as Obj[]);
      for (const rack of rackArea) for (const item of rack['rackItems'] as Obj[]) delete item['newHardware'];
      return { raw: { rackArea, nonRackArea: [], connections: [], errors: [] } } as never;
    }
    if (request.endpoint === 'workspace_autoDerive') {
      const wire = body['configurations'] as Obj[];
      return { raw: { configurations: wire.map(configuration => ({
        ...(configuration['id'] === 'rack-1' ? rackRaw : sourceRaw),
        id: configuration['id'], totalPrice: configuration['id'] === 'rack-1' ? 12_256.01 : 15_650.51,
      })) } } as never;
    }
    throw new Error(`Unexpected endpoint ${request.endpoint}`);
  });
  return { calls, send, customizeCount: () => customizeCount };
}

function snapshot(service: DcscService) {
  const copy = structuredClone(service.sessions.listWorkspaces());
  for (const workspace of copy) {
    workspace.lastAccessAt = 0;
    for (const session of workspace.configurations.values()) session.lastAccessAt = 0;
  }
  return copy;
}

describe('physical Clone Multiple service orchestration', () => {
  it('runs customize, derive, customize and commits authoritative placement and dependency atomically', async () => {
    const { service, workspace, source, sourceRaw, rackRaw } = setup();
    const { calls, customizeCount } = installAcceptedLayout(service, sourceRaw, rackRaw);
    const write = vi.fn();
    service.sessions.setPersistenceWriter(write);
    const revision = workspace.revision;
    const result = await service.cloneConfiguration({ sessionHandle: source.id, count: 1,
      labelPrefix: 'Node', placement: 'same-rack', expectedRevision: revision, ctx: service.newCtx() });

    expect(calls.map(call => call.endpoint)).toEqual(['racks_customize', 'workspace_autoDerive', 'racks_customize']);
    expect(customizeCount()).toBe(2);
    for (const call of [calls[0]!, calls[2]!]) {
      expect(call.query).toEqual({ autoArrange: false, autoConnect: true, cogValidation: true });
      expect(call.body).toMatchObject({ kind: 'json', value: { cloneDependency: {}, cloneDependencyColor: {} } });
    }
    expect(calls[1]!.query).toEqual({ entranceFlag: 'customize', guideMode: true });
    const derive = calls[1]!.body?.kind === 'json' ? calls[1]!.body.value as Obj : {};
    const information = derive['workspaceInformation'] as Obj;
    const cloneId = result.clones[0]!.configurationId;
    expect(information['cloneDependency']).toEqual({
      'server-1': ['server-1', cloneId], 'rack-1': ['rack-1'],
    });
    expect(information['configurations']).toBeNull();
    expect((derive['configurations'] as Obj[]).map(config => config['id']))
      .toEqual(['server-1', 'rack-1', cloneId]);
    expect(result.placements).toEqual([{ configurationId: cloneId, rackId: 'rack-1', position: 2 }]);
    expect(result.clones[0]!.label).toBe('Node 2');
    expect(result.clones[0]!.raw.quantity).toBe(1);
    expect(result.clones[0]!.raw.totalPrice).toBe(15_650.51);
    expect((workspace.rackArea[0]!['rackItems'] as Obj[]).find(item => item['id'] === cloneId))
      .toMatchObject({ position: 2, lock: false });
    expect((workspace.rackArea[0]!['rackItems'] as Obj[]).find(item => item['id'] === cloneId))
      .not.toHaveProperty('newHardware');
    expect(workspace.revision).toBe(revision + 1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2, 3])('rolls the full workspace back when remote stage %i fails', async failStage => {
    const { service, workspace, source, sourceRaw, rackRaw } = setup();
    const before = snapshot(service);
    let stage = 0;
    vi.spyOn(service.http, 'send').mockImplementation(async request => {
      stage += 1;
      if (stage === failStage) throw new Error(`Injected stage ${stage}`);
      const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
      if (request.endpoint === 'racks_customize') return { raw: {
        rackArea: body['rackArea'], nonRackArea: [], connections: [], errors: [],
      } } as never;
      const wire = body['configurations'] as Obj[];
      return { raw: { configurations: wire.map(configuration => ({
        ...(configuration['id'] === 'rack-1' ? rackRaw : sourceRaw), id: configuration['id'],
      })) } } as never;
    });
    await expect(service.cloneConfiguration({ sessionHandle: source.id, count: 1, placement: 'same-rack',
      expectedRevision: workspace.revision, ctx: service.newCtx() })).rejects.toThrow(`Injected stage ${failStage}`);
    expect(snapshot(service)).toEqual(before);
  });

  it('rejects stale callers before HTTP and rolls back an accepted remote clone on persistence failure', async () => {
    const { service, workspace, source, sourceRaw, rackRaw } = setup();
    const { calls } = installAcceptedLayout(service, sourceRaw, rackRaw);
    const before = snapshot(service);
    await expect(service.cloneConfiguration({ sessionHandle: source.id, count: 1, placement: 'same-rack',
      expectedRevision: workspace.revision + 1, ctx: service.newCtx() })).rejects.toThrow(/revision/i);
    expect(calls).toHaveLength(0);
    service.sessions.setPersistenceWriter(() => { throw new Error('disk full'); });
    await expect(service.cloneConfiguration({ sessionHandle: source.id, count: 1, placement: 'same-rack',
      expectedRevision: workspace.revision, ctx: service.newCtx() })).rejects.toMatchObject({
      remoteApplied: true, localNotCommitted: true,
    });
    expect(calls).toHaveLength(3);
    expect(snapshot(service)).toEqual(before);
  });

  it('retains cloned identity, placement, dependency, export, history, and restart state', async () => {
    const { service, config, workspace, source, sourceRaw, rackRaw } = setup(true);
    installAcceptedLayout(service, sourceRaw, rackRaw);
    const result = await service.cloneConfiguration({ sessionHandle: source.id, count: 1,
      placement: 'same-rack', expectedRevision: workspace.revision, ctx: service.newCtx() });
    const cloneId = result.clones[0]!.configurationId;
    const committedRevision = workspace.revision;
    let exported = buildExportData({ workspace, solution: workspace.solution, fileTypes: ['XML'],
      validationMode: workspace.validationMode });
    expect((exported['workspaceInformation'] as Obj)['cloneDependency']).toEqual({
      'server-1': ['server-1', cloneId], 'rack-1': ['rack-1'],
    });
    expect(await service.sessions.undoWorkspace(workspace.id, committedRevision)).toBe(true);
    expect(workspace.configurations.size).toBe(2);
    expect((workspace.rackArea[0]!['rackItems'] as Obj[])).toHaveLength(1);
    expect(await service.sessions.redoWorkspace(workspace.id, workspace.revision)).toBe(true);
    expect(workspace.configurations.size).toBe(3);
    expect((workspace.rackArea[0]!['rackItems'] as Obj[]).map(item => item['id'])).toContain(cloneId);

    await service.close();
    services.splice(services.indexOf(service), 1);
    const restored = new DcscService(config);
    services.push(restored);
    const loaded = restored.sessions.getWorkspace(workspace.id)!;
    expect(loaded.configurations.size).toBe(3);
    expect((loaded.rackArea[0]!['rackItems'] as Obj[]).map(item => item['id'])).toContain(cloneId);
    expect(loaded.serverState.cloneDependency).toEqual({
      'server-1': ['server-1', cloneId], 'rack-1': ['rack-1'],
    });
    exported = buildExportData({ workspace: loaded, solution: loaded.solution, fileTypes: ['XML'],
      validationMode: loaded.validationMode });
    expect((exported['workspaceInformation'] as Obj)['cloneDependency']).toEqual(loaded.serverState.cloneDependency);
  });
});
