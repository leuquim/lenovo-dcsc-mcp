import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import type { SendInput } from '../src/http/request.js';

type Obj = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/switch-provisioning.json', import.meta.url), 'utf8'));
const graphFixture = JSON.parse(readFileSync(new URL('./fixtures/parity/browser-auto-switch-cabling.json', import.meta.url), 'utf8'));
const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
function setup(failAt = '') {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const solution = { solutionMode: 'HPC and AI - Systems', masterSlices: ['HPCGP', 'HPCRYO', 'HPCGPALL', 'HPCGPRYO'] };
  let handle: string | undefined;
  for (const base of fixture.workspace.configurations) {
    const raw = { ...base, tabs: [], type: base.id === 'rack-1' ? 'rack' : base.id === 'server-1' ? 'server' : 'switch' };
    const session = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw,
      configurationId: raw.id, reduced: reduceConfiguration(raw, raw.id), primed: true,
      ...(handle ? { workspaceId: handle } : {}) });
    handle = session.workspaceId;
  }
  const workspace = service.sessions.getWorkspace(handle!)!;
  workspace.rackArea = structuredClone(fixture.workspace.rackArea);
  workspace.rackArea[0]!.size = 42;
  workspace.serverState = { ...structuredClone(fixture.workspace), connections: [] };
  const calls: SendInput[] = [];
  let generatedId = '';
  let deriveCount = 0;
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
    calls.push(request);
    const key = request.endpoint === 'workspace_autoDerive' ? `${request.endpoint}-${++deriveCount}` : request.endpoint;
    if (key === failAt) throw new Error(`Injected ${key}`);
    const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
    let raw: unknown;
    if (request.endpoint === 'switch_calculation') {
      raw = Array.isArray(body.switchMap) && body.switchMap.length ? [] : fixture.calculationResponse;
    } else if (request.endpoint === 'automatic_switch_launch') raw = fixture.launch;
    else if (request.endpoint === 'racks_customize') {
      const racks = structuredClone(body.rackArea) as Obj[];
      const items = racks[0]!.rackItems as Obj[];
      const item = items.find(value => value.id !== 'server-1' && value.id !== 'manual-switch-1')!;
      generatedId = String(item.id);
      item.position = 6;
      raw = { rackArea: racks, nonRackArea: [], connections: [{ ...graphFixture.connection, destinationId: generatedId }] };
    } else if (request.endpoint === 'workspace_autoDerive') {
      raw = { configurations: [{ ...fixture.launch, id: generatedId, totalPrice: 1450, quantity: 1 }],
        autoDerivedResults: [{ id: 'derived-installation', appliedConfigurations: [generatedId] }] };
    } else if (request.endpoint === 'auto_connect') {
      raw = { rackArea: body.rackArea, nonRackArea: [], connections: [{ ...graphFixture.connection, destinationId: generatedId }] };
    } else throw new Error(`Unexpected ${request.endpoint}`);
    return { raw } as never;
  });
  return { service, workspace, calls, send, solution };
}
function snapshot(service: DcscService) {
  const copy = structuredClone(service.sessions.listWorkspaces());
  for (const ws of copy) { ws.lastAccessAt = 0; for (const session of ws.configurations.values()) session.lastAccessAt = 0; }
  return copy;
}

it('provisions a separate switch, accepts authoritative placement, derives and exports the populated graph atomically', async () => {
  const { service, workspace, calls, solution } = setup();
  const write = vi.fn();
  service.sessions.setPersistenceWriter(write);
  const beforeRevision = workspace.revision;
  const result = await service.runAutoConnect(workspace.id, service.newCtx(), beforeRevision);
  expect(calls.map(call => call.endpoint)).toEqual(['switch_calculation', 'automatic_switch_launch',
    'racks_customize', 'workspace_autoDerive', 'auto_connect', 'workspace_autoDerive']);
  expect(calls[1]!.query).toMatchObject({ controlExpressModal: false, serviceCto: true, serviceType: 'servicecto' });
  expect(calls[4]!.query).toEqual({ autoArrange: true, autoConnect: true, cogValidation: true });
  const configBody = calls[4]!.body?.kind === 'json' ? calls[4]!.body.value as Obj : {};
  expect((configBody.configurations as Obj[]).every(config => Array.isArray(config.sections) && !('tabs' in config))).toBe(true);
  expect(workspace.configurations.size).toBe(4);
  const generated = [...workspace.configurations.values()].find(session => session.configurationId === result.connections[0]?.toId)!;
  expect(generated.configurationId).not.toBe('manual-switch-1');
  expect(generated.raw.totalPrice).toBe(1450);
  expect((workspace.rackArea[0]!.rackItems as Obj[]).find(item => item.id === generated.configurationId)?.position).toBe(6);
  expect(workspace.revision).toBe(beforeRevision + 1);
  expect(write).toHaveBeenCalledTimes(1);
  const exported = buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode: 'guided' });
  expect(exported.autoConnectResults).toEqual(result.rawConnections);
  expect(exported.networkingInformation).toMatchObject({ cables: graphFixture.export.cables,
    switchMap: [{ id: generated.configurationId, network: 'Management', type: 'main', code: '7D5FCTOFWW' }] });
  await service.sessions.undoWorkspace(workspace.id);
  expect(workspace.configurations.size).toBe(3);
  await service.sessions.redoWorkspace(workspace.id);
  expect(workspace.configurations.size).toBe(4);
  await service.runAutoConnect(workspace.id, service.newCtx(), workspace.revision);
  expect(calls.filter(call => call.endpoint === 'automatic_switch_launch')).toHaveLength(1);
  expect(workspace.configurations.size).toBe(4);
});

it.each(['switch_calculation', 'automatic_switch_launch', 'racks_customize',
  'workspace_autoDerive-1', 'auto_connect', 'workspace_autoDerive-2'])('does not publish a partial design after %s fails', async failAt => {
  const { service, workspace } = setup(failAt);
  const before = snapshot(service);
  await expect(service.runAutoConnect(workspace.id, service.newCtx(), workspace.revision)).rejects.toThrow(`Injected ${failAt}`);
  expect(snapshot(service)).toEqual(before);
});

it('does not publish generated identities or graph when persistence fails, and rejects stale callers before HTTP', async () => {
  const { service, workspace, calls } = setup();
  const before = snapshot(service);
  const write = vi.fn(() => { throw new Error('disk full'); });
  service.sessions.setPersistenceWriter(write);
  await expect(service.runAutoConnect(workspace.id, service.newCtx(), workspace.revision)).rejects.toMatchObject({
    remoteApplied: true, localNotCommitted: true,
  });
  expect(snapshot(service)).toEqual(before);
  expect(write).toHaveBeenCalledTimes(1);
  const requests = calls.length;
  await expect(service.runAutoConnect(workspace.id, service.newCtx(), workspace.revision + 1)).rejects.toThrow(/revision/i);
  expect(calls).toHaveLength(requests);
});
