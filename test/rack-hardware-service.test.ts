import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
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

const SERVER_CODE = '7D73CTO1WW';
const OLD_RACK = '7D6DCTO1WW';
const NEW_RACK = '7D6DCTO2WW';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dcsc-rack-hardware-'));
  roots.push(root);
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false, sessionFile: join(root, 'sessions.json') }, logLevel: 'silent' }));
  services.push(service);
  const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
  const make = (id: string, code: string, type: string, workspaceId?: string) => {
    const raw: RawConfiguration = { id, workspaceId: id, code, sliceCtoCode: code, name: type, description: code, type, quantity: 1, tabs: [] };
    return service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw, configurationId: id,
      reduced: reduceConfiguration(raw, id), primed: true, ...(workspaceId ? { workspaceId } : {}) });
  };
  const server = make('server-1', SERVER_CODE, 'server');
  make('rack-1', OLD_RACK, 'rack', server.workspaceId);
  const workspace = service.sessions.getWorkspace(server.workspaceId)!;
  workspace.rackArea = [{ id: 'rack-1', code: OLD_RACK, sliceCtoCode: OLD_RACK, type: 'rack', size: 42, lockedSpace: [], errors: [],
    rackItems: [] }];
  workspace.nonRackArea = [{ id: 'server-1', code: SERVER_CODE, sliceCtoCode: SERVER_CODE, type: 'server', size: 1, nodes: [] }];
  workspace.floorItems = [{ id: 'cell', rackId: 'rack-1', x: 1, y: 0 }];
  return { service, workspace, server };
}

function install(service: DcscService, hardware?: (body: Obj) => Obj) {
  const calls: SendInput[] = [];
  vi.spyOn(service.http, 'send').mockImplementation(async request => {
    calls.push(request);
    const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
    switch (request.endpoint) {
      case 'cto_launch': {
        const code = request.path.split('/')[2]!;
        return { raw: { id: 'launched', code, sliceCtoCode: code, description: code, type: code === SERVER_CODE ? 'server' : 'rack', quantity: 1, tabs: [] } } as never;
      }
      case 'racks_launch': case 'pdu_preference': return { raw: {} } as never;
      case 'racks_customize_non_rack': return { raw: (body as unknown as Obj[]).map(item => ({ code: item['code'], type: item['type'], size: item['type'] === 'rack' ? 42 : 1 })) } as never;
      case 'racks_hardware': return { raw: hardware!(body) } as never;
      case 'racks_customize': return { raw: { rackArea: body['rackArea'], nonRackArea: body['nonRackArea'], connections: [], errors: [] } } as never;
      case 'workspace_autoDerive': return { raw: { configurations: [] } } as never;
      default: throw new Error(`Unexpected endpoint ${request.endpoint}`);
    }
  });
  return calls;
}

describe('rack hardware and container flows', () => {
  it('changes the rack model: new rack configuration, contents and floor cell kept, old rack configuration gone', async () => {
    const { service, workspace } = setup();
    workspace.rackArea = [{ ...workspace.rackArea[0]!, rackItems: [{ id: 'server-1', code: SERVER_CODE, type: 'server', size: 1, position: 1 }] }];
    workspace.nonRackArea = [];
    const calls = install(service);
    await service.changeRackModel(workspace.id, { rackId: 'rack-1', rackCode: NEW_RACK, ctx: service.newCtx() });

    expect(calls.map(call => call.endpoint).slice(0, 4)).toEqual(['cto_launch', 'racks_launch', 'pdu_preference', 'racks_customize_non_rack']);
    expect(calls[0]!.path).toBe(`/ctos/${NEW_RACK}/launch`);
    const saved = service.sessions.getWorkspace(workspace.id)!;
    expect(saved.rackArea).toHaveLength(1);
    expect(saved.rackArea[0]).toMatchObject({ code: NEW_RACK, rackItems: [{ id: 'server-1' }] });
    const newId = String(saved.rackArea[0]!['id']);
    expect(newId).not.toBe('rack-1');
    expect([...saved.configurations.values()].map(session => session.product.code).sort()).toEqual([NEW_RACK, SERVER_CODE]);
    expect(saved.floorItems).toMatchObject([{ rackId: newId, x: 1, y: 0 }]);
  });

  it('adds hardware: racks/hardware, then launch, then customize with the new configuration id on the item', async () => {
    const { service, workspace } = setup();
    vi.spyOn(service, 'catalog').mockResolvedValue({ entries: [], fetchedAt: 0, tree: [{ id: 'c', products: [
      { code: SERVER_CODE, ctoCode: SERVER_CODE, cto: true, lfo: false, hardwareType: 'server' }] }] } as never);
    const calls = install(service, body => ({
      rackArea: [{ ...(body['rack'] as Obj), rackItems: [{ id: null, code: SERVER_CODE, sliceCtoCode: SERVER_CODE, type: 'server', size: 1, position: 1 }] }],
      nonRackArea: [], connections: [],
    }));
    await service.addHardware(workspace.id, { rackId: 'rack-1', productCode: SERVER_CODE, ctx: service.newCtx() });

    expect(calls.map(call => call.endpoint).slice(0, 3)).toEqual(['racks_hardware', 'cto_launch', 'racks_customize']);
    const request = (calls[0]!.body as { value: Obj }).value;
    expect(Object.keys(request).sort()).toEqual(['newHardware', 'rack', 'workspace']);
    expect(request['newHardware']).toMatchObject([{ code: SERVER_CODE, cto: true }]);
    const saved = service.sessions.getWorkspace(workspace.id)!;
    const item = (saved.rackArea[0]!['rackItems'] as Obj[])[0]!;
    expect([...saved.configurations.values()].map(session => session.configurationId)).toContain(item['id']);
    expect(item['id']).not.toBeNull();
    await expect(service.addHardware(workspace.id, { rackId: 'rack-1', productCode: 'NOPE', ctx: service.newCtx() })).rejects.toThrow(/not a CTO product/);
  });

  it('adds a container: new rack, then the non-rack configuration moves into it', async () => {
    const { service, workspace, server } = setup();
    workspace.rackArea = [];
    install(service);
    await service.addRack(workspace.id, NEW_RACK, service.newCtx(), undefined, server.id);
    const saved = service.sessions.getWorkspace(workspace.id)!;
    expect(saved.rackArea).toHaveLength(1);
    expect(saved.rackArea[0]).toMatchObject({ code: NEW_RACK, rackItems: [{ id: 'server-1' }] });
    expect(saved.nonRackArea).toEqual([]);
    await expect(service.addRack(workspace.id, NEW_RACK, service.newCtx(), undefined, server.id)).rejects.toThrow(/not a non-rack item/);
  });
});
