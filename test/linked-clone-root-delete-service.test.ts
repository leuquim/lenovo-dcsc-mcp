import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { buildExportGroups } from '../src/domain/exportGroups.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import type { SendInput } from '../src/http/request.js';
import { DcscService } from '../src/mcp/service.js';
import type { RawConfiguration } from '../src/model/types.js';

type Obj = Record<string, unknown>;
const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
  const server = (id: string): RawConfiguration => ({
    id, workspaceId: id, code: '7D73CTO1WW', sliceCtoCode: '7D73CTO1WW', name: 'Server',
    description: 'SR630 V3', type: 'server', quantity: 1, totalPrice: 13_465.51, tabs: [],
  });
  const rackRaw: RawConfiguration = { id: 'rack-1', workspaceId: 'rack-1', code: '7D6DCTO1WW',
    sliceCtoCode: '7D6DCTO1WW', name: 'Rack', description: '42U Rack', type: 'rack', quantity: 1,
    totalPrice: 12_691.01, tabs: [] };
  const source = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: server('server-root'),
    configurationId: 'server-root', reduced: reduceConfiguration(server('server-root'), 'server-root'), primed: true });
  for (const raw of [rackRaw, server('server-2'), server('server-3')]) {
    const id = String(raw.id);
    service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw,
      configurationId: id, reduced: reduceConfiguration(raw, id), primed: true,
      workspaceId: source.workspaceId });
  }
  const workspace = service.sessions.getWorkspace(source.workspaceId)!;
  workspace.rackArea = [{ id: 'rack-1', configurationId: 'rack-1', code: '7D6DCTO1WW', type: 'rack',
    size: 42, lockedSpace: [], rackItems: ['server-root', 'server-2', 'server-3'].map((id, index) => ({
      id, configurationId: id, code: '7D73CTO1WW', type: 'server', name: 'Server', size: 1,
      position: index + 1, lowestPosition: 1, highestPosition: 42, defaultPosition: index + 1,
      lock: false, rule: { mtMinMaxRule: null, productMinMaxRule: null }, nodes: [],
    })) }];
  workspace.serverState.cloneDependency = {
    'server-root': ['server-root', 'server-2', 'server-3'], 'rack-1': ['rack-1'],
  };
  workspace.serverState.cloneDependencyColor = {
    'server-root': { color: '#33ebbb', dependBy: ['server-root', 'server-2', 'server-3'] },
  };
  workspace.serverState.linkedConfigurationEdits = {
    'server-root': [{ at: 1, members: ['server-root', 'server-2', 'server-3'] }],
  };
  return { service, workspace, source, rackRaw };
}

function installAcceptedDelete(service: DcscService, rackRaw: RawConfiguration) {
  const calls: SendInput[] = [];
  vi.spyOn(service.http, 'send').mockImplementation(async request => {
    calls.push(request);
    const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
    if (request.endpoint === 'racks_customize') return { raw: {
      rackArea: body['rackArea'], nonRackArea: [], connections: [], errors: [],
    } } as never;
    if (request.endpoint === 'workspace_autoDerive') return { raw: {
      // Browser returns only the rack delta after deletion. The two surviving
      // linked server configurations remain authoritative client state.
      configurations: [structuredClone(rackRaw)],
    } } as never;
    throw new Error(`Unexpected endpoint ${request.endpoint}`);
  });
  return calls;
}

describe('linked Clone Multiple root deletion service orchestration', () => {
  it('matches the browser customize/derive delta and commits the promoted group', async () => {
    const { service, workspace, source, rackRaw } = setup();
    const calls = installAcceptedDelete(service, rackRaw);
    await service.editLayout(source.id, { action: 'remove', configurationId: 'server-root',
      expectedRevision: workspace.revision, ctx: service.newCtx() });

    expect(calls.map(call => call.endpoint)).toEqual(['racks_customize', 'workspace_autoDerive']);
    expect(calls[0]!.query).toEqual({ autoArrange: false, autoConnect: true, cogValidation: true });
    const customize = calls[0]!.body?.kind === 'json' ? calls[0]!.body.value as Obj : {};
    expect((customize['configurations'] as Obj[]).map(raw => raw['id']))
      .toEqual(['server-root', 'rack-1', 'server-2', 'server-3']);
    expect(customize['cloneDependency']).toEqual({});
    expect(((customize['rackArea'] as Obj[])[0]!['rackItems'] as Obj[]).map(item => item['id']))
      .toEqual(['server-2', 'server-3']);

    expect(calls[1]!.query).toEqual({ entranceFlag: 'customize', guideMode: true });
    const derive = calls[1]!.body?.kind === 'json' ? calls[1]!.body.value as Obj : {};
    expect(derive['customizingIds']).toEqual([]);
    expect((derive['configurations'] as Obj[]).map(raw => raw['id']))
      .toEqual(['rack-1', 'server-2', 'server-3']);
    expect((derive['workspaceInformation'] as Obj)['cloneDependency']).toEqual({
      'rack-1': ['rack-1'], 'server-2': ['server-2', 'server-3'],
    });

    expect([...workspace.configurations.values()].map(session => session.configurationId))
      .toEqual(['rack-1', 'server-2', 'server-3']);
    expect(workspace.serverState.cloneDependency).toEqual({
      'rack-1': ['rack-1'], 'server-2': ['server-2', 'server-3'],
    });
    expect(workspace.serverState.cloneDependencyColor).toEqual({
      'server-2': { color: '#33ebbb', dependBy: ['server-2', 'server-3'] },
    });
    expect(workspace.serverState.linkedConfigurationEdits).toEqual({});
    const serverHardware = buildExportGroups(workspace)[0]!.products.filter(product =>
      product.type === 'hardware' && product.code === '7D73CTO1WW');
    expect(serverHardware).toEqual([expect.objectContaining({ id: 'server-2', quantity: 2, price: 26_931.02 })]);
  });

  it.each(['racks_customize', 'workspace_autoDerive'] as const)('rolls back when %s fails', async endpoint => {
    const { service, workspace, source, rackRaw } = setup();
    const before = structuredClone(service.sessions.listWorkspaces());
    vi.spyOn(service.http, 'send').mockImplementation(async request => {
      if (request.endpoint === endpoint) throw new Error(`Injected ${endpoint}`);
      const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
      if (request.endpoint === 'racks_customize') return { raw: {
        rackArea: body['rackArea'], nonRackArea: [], connections: [], errors: [],
      } } as never;
      return { raw: { configurations: [structuredClone(rackRaw)] } } as never;
    });
    await expect(service.editLayout(source.id, { action: 'remove', configurationId: 'server-root',
      expectedRevision: workspace.revision, ctx: service.newCtx() })).rejects.toThrow(`Injected ${endpoint}`);
    const after = structuredClone(service.sessions.listWorkspaces());
    for (const collection of [before, after]) for (const current of collection) {
      current.lastAccessAt = 0;
      for (const session of current.configurations.values()) session.lastAccessAt = 0;
    }
    expect(after).toEqual(before);
  });
});
