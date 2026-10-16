import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import type { RawConfiguration } from '../src/model/types.js';

type Obj = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/rack-recustomize-contract.json', import.meta.url), 'utf8'));
const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
  const rackId = fixture.response.configuration.id;
  const tabs = [{ title: 'Power', type: 'hardware', subTabs: [{ title: 'Power', sections: [{ name: 'PDU',
    features: [{ code: 'CE6L', max: 4, description: 'PDU' }], results: [],
  }] }] }];
  const raw: RawConfiguration = { id: rackId, code: '7D6DCTO1WW', sliceCtoCode: '7D6DCTO1WW', type: 'rack',
    quantity: 1, totalPrice: fixture.importBaseline.totalPrice, tabs };
  const rack = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw,
    configurationId: rackId, reduced: reduceConfiguration(raw, rackId), primed: true });
  const serverRaw = { id: 'server-1', code: 'SERVER', tabs: [] };
  service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: serverRaw,
    configurationId: serverRaw.id, reduced: reduceConfiguration(serverRaw, serverRaw.id), primed: true, workspaceId: rack.workspaceId });
  const workspace = service.sessions.getWorkspace(rack.id)!;
  workspace.rackArea = [{ id: rackId, code: '7D6DCTO1WW', type: 'rack', size: 42,
    rackItems: [{ id: 'server-1', code: 'SERVER', type: 'server', size: 1, position: 1 }] }];
  const hydrated: RawConfiguration = { ...fixture.response.configuration, tabs };
  return { service, workspace, rack, hydrated };
}
function beforeState(service: DcscService) {
  const workspaces = structuredClone(service.sessions.listWorkspaces());
  for (const ws of workspaces) { ws.lastAccessAt = 0; for (const session of ws.configurations.values()) session.lastAccessAt = 0; }
  return workspaces;
}

it('hydrates only the rack and applies PDU deltas with the full workspace and captured derived features', async () => {
  const { service, workspace, rack, hydrated } = setup();
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
    expect(request.query).toMatchObject({ configurationId: rack.configurationId, entranceFlag: 'customize', guideMode: true });
    const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
    expect(body.customizingIds).toEqual([rack.configurationId]);
    expect((body.configurations as Obj[]).map(value => value.id)).toEqual([rack.configurationId, 'server-1']);
    expect((body.workspaceInformation as Obj).rackData).toHaveLength(1);
    if (request.endpoint === 'rack_recustomize') return { raw: { configurations: [hydrated] } } as never;
    const target = (body.configurations as Obj[]).find(value => value.id === rack.configurationId)!;
    expect(target.sections).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'MECH_DERIVE_FCS',
      results: expect.arrayContaining([expect.objectContaining({ code: '4275', quantity: 8 }),
        expect.objectContaining({ code: '4271', quantity: 1 })]),
    })]));
    const accepted = structuredClone(hydrated);
    accepted.tabs![0]!.subTabs![0]!.sections![0]!.results = [{ code: 'CE6L', quantity: 1 }];
    accepted.totalPrice = 12881.01;
    return { raw: { configurations: [accepted] } } as never;
  });
  const revision = workspace.revision;
  const write = vi.fn(); service.sessions.setPersistenceWriter(write);
  await service.configurePdu(workspace.id, rack.configurationId, { pduCode: 'CE6L', ctx: service.newCtx(), expectedRevision: revision });
  expect(send.mock.calls.map(([request]) => request.endpoint)).toEqual(['rack_recustomize', 'cto_autoDerive']);
  expect(workspace.configurations.size).toBe(2);
  expect(rack.raw.totalPrice).toBe(12881.01);
  expect(workspace.revision).toBe(revision + 1);
  expect(write).toHaveBeenCalledTimes(1);
  await service.sessions.undoWorkspace(workspace.id);
  expect(rack.raw.totalPrice).toBe(fixture.importBaseline.totalPrice);
  expect(rack.raw.unSelectableCharacters).toBeUndefined();
});

it.each(['wrong-rack', 'edit-failure', 'disk-failure'])('discards hydration and edits together on %s', async failure => {
  const { service, workspace, rack, hydrated } = setup();
  const before = beforeState(service);
  vi.spyOn(service.http, 'send').mockImplementation(async request => {
    if (request.endpoint === 'rack_recustomize') return { raw: { configurations: [
      { ...hydrated, id: failure === 'wrong-rack' ? 'other' : rack.configurationId },
    ] } } as never;
    if (failure === 'edit-failure') throw new Error('edit failed');
    const accepted = structuredClone(hydrated);
    accepted.tabs![0]!.subTabs![0]!.sections![0]!.results = [{ code: 'CE6L', quantity: 1 }];
    return { raw: { configurations: [accepted] } } as never;
  });
  if (failure === 'disk-failure') service.sessions.setPersistenceWriter(() => { throw new Error('disk failed'); });
  await expect(service.configurePdu(workspace.id, rack.configurationId, { pduCode: 'CE6L', ctx: service.newCtx() })).rejects.toThrow();
  expect(beforeState(service)).toEqual(before);
});
