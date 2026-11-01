import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { cloneConfigurationRaw } from '../src/domain/configurationIdentity.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import type { SendInput } from '../src/http/request.js';
import { DcscService } from '../src/mcp/service.js';
import type { RawConfiguration } from '../src/model/types.js';
import type { ConfigSession } from '../src/model/session.js';

type Obj = Record<string, unknown>;
const services: DcscService[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(persist = false) {
  const root = mkdtempSync(join(tmpdir(), 'dcsc-linked-clone-'));
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
    description: 'SR630 V3', name: 'Server', type: 'server', quantity: 1, totalPrice: 100,
    selectedTopologies: { Management: { selectedConnectors: [] } }, nodeRole: 'Compute',
    tabs: [{ title: 'System', type: 'hardware', subTabs: [{ title: 'Processors', sections: [{
      name: 'PROCESSOR', features: [{ code: 'BYW3', max: 2 }], results: [{ code: 'BYW3', quantity: 1 }],
    }] }] }],
  };
  const source = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: sourceRaw,
    configurationId: 'server-1', reduced: reduceConfiguration(sourceRaw, 'server-1'), primed: true,
    configurable: true });
  const cloneRaw = cloneConfigurationRaw(sourceRaw, 'server-1', 'server-2');
  const clone = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: cloneRaw,
    configurationId: 'server-2', reduced: reduceConfiguration(cloneRaw, 'server-2'), primed: true,
    configurable: true, workspaceId: source.workspaceId });
  const rackRaw: RawConfiguration = { id: 'rack-1', workspaceId: 'rack-1', code: '7D6DCTO1WW',
    sliceCtoCode: '7D6DCTO1WW', description: '42U Rack', name: 'Rack', type: 'rack', quantity: 1,
    totalPrice: 10, tabs: [] };
  service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: rackRaw,
    configurationId: 'rack-1', reduced: reduceConfiguration(rackRaw, 'rack-1'), primed: true,
    configurable: false, workspaceId: source.workspaceId });
  const workspace = service.sessions.getWorkspace(source.workspaceId)!;
  workspace.serverState.cloneDependency = {
    'server-1': ['server-1', 'server-2'], 'rack-1': ['rack-1'],
  };
  return { service, config, workspace, source, clone, sourceRaw };
}

function acceptedResponse(source: RawConfiguration, initiatingId: string, processorQuantity = 2): RawConfiguration {
  const raw = initiatingId === 'server-1'
    ? structuredClone(source)
    : cloneConfigurationRaw(source, 'server-1', initiatingId);
  raw.totalPrice = processorQuantity === 2 ? 200 : 100;
  raw.updateConfigurationIds = ['server-1', 'server-2'];
  const processor = raw.tabs?.[0]?.subTabs?.[0]?.sections?.[0];
  if (processor) processor.results = [{ code: 'BYW3', quantity: processorQuantity }];
  return raw;
}

function installAcceptedEdit(service: DcscService, source: RawConfiguration) {
  const calls: SendInput[] = [];
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
    calls.push(request);
    const initiatingId = String(request.query?.['configurationId']);
    const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
    const initiating = (body['configurations'] as Obj[] | undefined)?.find(value => value['id'] === initiatingId);
    const quantity = ((initiating?.['sections'] as Obj[] | undefined)
      ?.find(section => section['name'] === 'PROCESSOR')?.['results'] as Obj[] | undefined)?.[0]?.['quantity'];
    return { raw: { configurations: [acceptedResponse(source, initiatingId,
      typeof quantity === 'number' ? quantity : 1)], autoDerivedResults: [] } } as never;
  });
  return { calls, send };
}

function selection(session: ConfigSession): number | null | undefined {
  return session.raw.tabs?.[0]?.subTabs?.[0]?.sections?.[0]?.results?.[0]?.quantity;
}

function canonicalSnapshot(service: DcscService, workspaceId: string) {
  const workspace = service.sessions.getWorkspace(workspaceId)!;
  return {
    revision: workspace.revision,
    configurations: [...workspace.configurations.values()].map(session => ({
      id: session.configurationId, revision: session.revision, raw: structuredClone(session.raw),
      intents: structuredClone(session.intents),
    })),
    serverState: structuredClone(workspace.serverState),
  };
}

describe('linked Clone Multiple configuration edits', () => {
  it('posts both prepared members once and atomically fans out the authoritative response', async () => {
    const { service, workspace, source, clone, sourceRaw } = setup();
    const { calls } = installAcceptedEdit(service, sourceRaw);
    const write = vi.fn();
    service.sessions.setPersistenceWriter(write);
    const sourceRevision = source.revision;
    const cloneRevision = clone.revision;
    const workspaceRevision = workspace.revision;

    await service.configure(source, [{ section: 'PROCESSOR', code: 'BYW3', quantity: 2 }],
      service.newCtx(), sourceRevision);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      endpoint: 'cto_autoDerive',
      query: { configurationId: 'server-1', entranceFlag: 'customize', guideMode: true },
      body: { kind: 'json' },
    });
    const body = calls[0]!.body?.kind === 'json' ? calls[0]!.body.value as Obj : {};
    expect(body['customizingIds']).toEqual(['server-1', 'server-2']);
    const servers = (body['configurations'] as Obj[]).filter(value => value['id'] !== 'rack-1');
    expect(servers.map(value => ({ id: value['id'], quantity:
      ((value['sections'] as Obj[]).find(section => section['name'] === 'PROCESSOR')?.['results'] as Obj[])[0]?.['quantity'],
    }))).toEqual([{ id: 'server-1', quantity: 2 }, { id: 'server-2', quantity: 2 }]);
    expect(selection(source)).toBe(2);
    expect(selection(clone)).toBe(2);
    expect(source.raw.totalPrice).toBe(200);
    expect(clone.raw.totalPrice).toBe(200);
    expect(source.raw.selectedTopologies).toEqual({ Management: { selectedConnectors: [] } });
    expect(clone.raw.selectedTopologies).toEqual({ Management: { selectedConnectors: [] } });
    expect(source.raw.nodeRole).toBe('Compute');
    expect(clone.raw.nodeRole).toBe('Compute');
    expect(source.revision).toBe(sourceRevision + 1);
    expect(clone.revision).toBe(cloneRevision + 1);
    expect(workspace.revision).toBe(workspaceRevision + 1);
    expect(source.intents).toHaveLength(1);
    expect(clone.intents).toHaveLength(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('canonicalizes a clone-handle edit to the root editor while retaining caller CAS and result identity', async () => {
    const { service, source, clone, sourceRaw } = setup();
    const { calls } = installAcceptedEdit(service, sourceRaw);
    const cloneRevision = clone.revision;

    const result = await service.configure(clone, [
      { section: 'PROCESSOR', code: 'BYW3', quantity: 2 },
    ], service.newCtx(), cloneRevision);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toMatchObject({ configurationId: source.configurationId });
    expect(result.configurationId).toBe(clone.configurationId);
    expect(selection(source)).toBe(2);
    expect(selection(clone)).toBe(2);
    expect(clone.revision).toBe(cloneRevision + 1);
  });

  it.each([
    { label: 'no configuration', mutate: () => [] as RawConfiguration[] },
    { label: 'two configurations', mutate: (raw: RawConfiguration) => [raw, structuredClone(raw)] },
    { label: 'wrong initiating identity', mutate: (raw: RawConfiguration) => [{ ...raw, id: 'server-2' }] },
    { label: 'missing fan-out', mutate: (raw: RawConfiguration) => [{ ...raw, updateConfigurationIds: ['server-1'] }] },
    { label: 'extra fan-out', mutate: (raw: RawConfiguration) => [{ ...raw, updateConfigurationIds: ['server-1', 'server-2', 'other'] }] },
  ])('rolls back on $label response', async ({ mutate }) => {
    const { service, workspace, source, sourceRaw } = setup();
    const before = canonicalSnapshot(service, workspace.id);
    vi.spyOn(service.http, 'send').mockImplementation(async () => {
      const raw = acceptedResponse(sourceRaw, 'server-1');
      return { raw: { configurations: mutate(raw), autoDerivedResults: [] } } as never;
    });

    await expect(service.configure(source, [{ section: 'PROCESSOR', code: 'BYW3', quantity: 2 }],
      service.newCtx(), source.revision)).rejects.toThrow();
    expect(canonicalSnapshot(service, workspace.id)).toEqual(before);
  });

  it('checks initiating configuration CAS, pre-edit equivalence, and durable publication', async () => {
    const { service, workspace, source, clone, sourceRaw } = setup();
    const { calls } = installAcceptedEdit(service, sourceRaw);
    const before = canonicalSnapshot(service, workspace.id);
    await expect(service.configure(source, [{ section: 'PROCESSOR', code: 'BYW3', quantity: 2 }],
      service.newCtx(), source.revision + 1)).rejects.toThrow(/revision/i);
    expect(calls).toHaveLength(0);

    clone.raw.totalPrice = 101;
    await expect(service.configure(source, [{ section: 'PROCESSOR', code: 'BYW3', quantity: 2 }],
      service.newCtx(), source.revision)).rejects.toThrow(/divergent commercial/i);
    expect(calls).toHaveLength(0);
    clone.raw.totalPrice = 100;

    service.sessions.setPersistenceWriter(() => { throw new Error('private filesystem location'); });
    await expect(service.configure(source, [{ section: 'PROCESSOR', code: 'BYW3', quantity: 2 }],
      service.newCtx(), source.revision)).rejects.toMatchObject({
      remoteApplied: true, localNotCommitted: true,
    });
    expect(calls).toHaveLength(1);
    expect(canonicalSnapshot(service, workspace.id)).toEqual(before);
  });

  it('keeps linked quantity physical and applies workspace controls once per group', async () => {
    const { service, workspace, source, clone, sourceRaw } = setup();
    const { calls } = installAcceptedEdit(service, sourceRaw);

    await expect(service.setQuantity(source, 2, source.revision)).rejects.toThrow(/Linked physical clones/);
    expect(source.raw.quantity).toBe(1);
    expect(clone.raw.quantity).toBe(1);
    await service.setQuantity(source, 1, source.revision);
    expect(calls).toHaveLength(0);

    await service.setConfigurationControls(workspace.id, {
      validationMode: 'expert', expectedRevision: workspace.revision, ctx: service.newCtx(),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toMatchObject({ configurationId: 'server-1', guideMode: false });
    expect(source.validationMode).toBe('expert');
    expect(clone.validationMode).toBe('expert');
    expect(source.autoCorrect).toBe(false);
    expect(clone.autoCorrect).toBe(false);
  });

  it('undoes, redoes, and restores both linked members together', async () => {
    const { service, config, workspace, source, sourceRaw } = setup(true);
    installAcceptedEdit(service, sourceRaw);
    await service.configure(source, [{ section: 'PROCESSOR', code: 'BYW3', quantity: 2 }],
      service.newCtx(), source.revision);
    expect([...workspace.configurations.values()].filter(item => item.raw.type === 'server').map(selection))
      .toEqual([2, 2]);

    expect(await service.sessions.undoWorkspace(workspace.id, workspace.revision)).toBe(true);
    expect([...workspace.configurations.values()].filter(item => item.raw.type === 'server').map(selection))
      .toEqual([1, 1]);
    expect(await service.sessions.redoWorkspace(workspace.id, workspace.revision)).toBe(true);
    expect([...workspace.configurations.values()].filter(item => item.raw.type === 'server').map(selection))
      .toEqual([2, 2]);

    await service.close();
    services.splice(services.indexOf(service), 1);
    const restored = new DcscService(config);
    services.push(restored);
    const loaded = restored.sessions.getWorkspace(workspace.id)!;
    expect([...loaded.configurations.values()].filter(item => item.raw.type === 'server').map(selection))
      .toEqual([2, 2]);
    expect(loaded.serverState.cloneDependency).toEqual({
      'server-1': ['server-1', 'server-2'], 'rack-1': ['rack-1'],
    });
  });

  it.each(['source', 'member'] as const)('atomically undoes a linked edit from the %s handle', async targetKind => {
    const { service, workspace, source, clone, sourceRaw } = setup();
    installAcceptedEdit(service, sourceRaw);
    const target = targetKind === 'source' ? source : clone;
    await service.configure(target, [{ section: 'PROCESSOR', code: 'BYW3', quantity: 2 }],
      service.newCtx(), target.revision);
    const beforeUndoRevision = workspace.revision;

    expect(await service.undo(target, target.revision)).toBe(true);

    expect(selection(source)).toBe(1);
    expect(selection(clone)).toBe(1);
    expect(source.raw.totalPrice).toBe(100);
    expect(clone.raw.totalPrice).toBe(100);
    expect(source.intents).toEqual([]);
    expect(clone.intents).toEqual([]);
    expect(workspace.revision).toBe(beforeUndoRevision + 1);
    expect(workspace.serverState.linkedConfigurationEdits).toEqual({ 'server-1': [] });
  });

  it('restores durable linked edit metadata and atomically undoes after restart', async () => {
    const { service, config, workspace, source, sourceRaw } = setup(true);
    installAcceptedEdit(service, sourceRaw);
    await service.configure(source, [{ section: 'PROCESSOR', code: 'BYW3', quantity: 2 }],
      service.newCtx(), source.revision);
    await service.close();
    services.splice(services.indexOf(service), 1);

    const restored = new DcscService(config);
    services.push(restored);
    const loaded = restored.sessions.getWorkspace(workspace.id)!;
    const loadedSource = [...loaded.configurations.values()].find(item => item.configurationId === 'server-1')!;
    expect(loaded.serverState.linkedConfigurationEdits).toBeDefined();
    expect(await restored.undo(loadedSource, loadedSource.revision)).toBe(true);
    expect([...loaded.configurations.values()].filter(item => item.raw.type === 'server').map(selection))
      .toEqual([1, 1]);

    await restored.close();
    services.splice(services.indexOf(restored), 1);
    const reloaded = new DcscService(config);
    services.push(reloaded);
    expect([...reloaded.sessions.getWorkspace(workspace.id)!.configurations.values()]
      .filter(item => item.raw.type === 'server').map(selection)).toEqual([1, 1]);
  });

  it('rejects linked undo without mutation after an intervening member edit', async () => {
    const { service, workspace, source, clone, sourceRaw } = setup();
    installAcceptedEdit(service, sourceRaw);
    await service.configure(source, [{ section: 'PROCESSOR', code: 'BYW3', quantity: 2 }],
      service.newCtx(), source.revision);
    await service.sessions.transact(clone.id, { expectedRevision: clone.revision }, (_draftWorkspace, draft) => {
      if (!draft) throw new Error('missing clone');
      draft.raw.interveningOpaqueState = { accepted: true };
    });
    const before = canonicalSnapshot(service, workspace.id);

    await expect(service.undo(source, source.revision)).rejects.toThrow(/No matching atomic linked edit/);
    expect(canonicalSnapshot(service, workspace.id)).toEqual(before);
  });

  it('rejects config-scoped linked undo after a control recustomization without partial rollback', async () => {
    const { service, workspace, source, clone, sourceRaw } = setup();
    installAcceptedEdit(service, sourceRaw);
    await service.configure(source, [{ section: 'PROCESSOR', code: 'BYW3', quantity: 2 }],
      service.newCtx(), source.revision);

    await service.setConfigurationControls(workspace.id, {
      validationMode: 'expert', expectedRevision: workspace.revision, ctx: service.newCtx(),
    });
    expect(source.validationMode).toBe('expert');
    expect(clone.validationMode).toBe('expert');
    expect(selection(source)).toBe(2);
    expect(selection(clone)).toBe(2);
    const before = canonicalSnapshot(service, workspace.id);

    await expect(service.undo(source, source.revision)).rejects.toThrow(/No matching atomic linked edit/);
    expect(canonicalSnapshot(service, workspace.id)).toEqual(before);
  });
});


it.each(['node', 'storage'])('uses native root-only HPC requests while editing from a linked %s member', async type => {
  const { service, workspace, source, clone, sourceRaw } = setup();
  workspace.solution.solutionMode = 'HPC and AI - Systems';
  for (const raw of [sourceRaw, source.raw, clone.raw]) raw.type = type;
  const { calls } = installAcceptedEdit(service, sourceRaw);
  await service.configure(clone, [{ section: 'PROCESSOR', code: 'BYW3', quantity: 2 }], service.newCtx(), clone.revision);
  expect(selection(source)).toBe(2);
  expect(selection(clone)).toBe(2);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.query).not.toHaveProperty('entranceFlag');
  expect(calls[0]!.query?.['configurationId']).toBe('server-1');
  const body = calls[0]!.body?.kind === 'json' ? calls[0]!.body.value as Obj : {};
  expect((body['configurations'] as Obj[]).map(c => c['id'])).toEqual(['server-1', 'rack-1']);
  expect(body['customizingIds']).toEqual(['server-1', 'server-2']);
});


it('commits dependent HPC parent updates with nodes and requires workspace undo', async () => {
  const { service, workspace, source, clone, sourceRaw } = setup();
  workspace.solution.solutionMode = 'HPC and AI - Systems';
  for (const raw of [sourceRaw, source.raw, clone.raw]) raw.type = 'node';
  const parent = [...workspace.configurations.values()].find(c => c.configurationId === 'rack-1')!;
  parent.raw.type = 'chassis';
  workspace.nonRackArea = [{ id: 'rack-1', type: 'chassis', nodes: [{ id: 'server-1' }, { id: 'server-2' }] }];
  vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [
    { ...parent.raw, totalPrice: 20, updateConfigurationIds: ['rack-1'] },
    acceptedResponse(sourceRaw, 'server-1'),
  ] } } as never);
  await service.configure(clone, [{ section: 'PROCESSOR', code: 'BYW3', quantity: 2 }], service.newCtx(), clone.revision);
  expect(parent.raw.totalPrice).toBe(20);
  expect(selection(source)).toBe(2);
  await expect(service.undo(clone, clone.revision)).rejects.toThrow(/dcsc_undo/);
  expect(await service.sessions.undoWorkspace(workspace.id, workspace.revision)).toBe(true);
  expect(workspace.configurations.get(parent.id)!.raw.totalPrice).toBe(10);
  expect(selection(workspace.configurations.get(source.id)!)).toBe(1);
});

it('edits a linked HPC chassis from a member and commits its dependent child update', async () => {
  const { service, workspace, source, clone, sourceRaw } = setup();
  workspace.solution.solutionMode = 'HPC and AI - Systems';
  for (const raw of [sourceRaw, source.raw, clone.raw]) raw.type = 'chassis';
  const child = [...workspace.configurations.values()].find(c => c.configurationId === 'rack-1')!;
  child.raw.type = 'node';
  workspace.nonRackArea = [{ id: 'server-1', type: 'chassis', nodes: [{ id: 'rack-1' }] }, { id: 'server-2', type: 'chassis', nodes: [] }];
  const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [
    acceptedResponse(sourceRaw, 'server-1'), { ...child.raw, totalPrice: 25, updateConfigurationIds: ['rack-1'] },
  ] } } as never);
  await service.configure(clone, [{ section: 'PROCESSOR', code: 'BYW3', quantity: 2 }], service.newCtx(), clone.revision);
  expect(selection(source)).toBe(2); expect(selection(clone)).toBe(2);
  expect(child.raw.totalPrice).toBe(25);
  expect(send.mock.calls[0]![0].query).toMatchObject({ configurationId: 'server-1' });
  expect(send.mock.calls[0]![0].query).not.toHaveProperty('entranceFlag');
  await expect(service.undo(clone, clone.revision)).rejects.toThrow(/dcsc_undo/);
  await service.sessions.undoWorkspace(workspace.id, workspace.revision);
  expect(workspace.configurations.get(child.id)!.raw.totalPrice).toBe(10);
});

it.each(['switch', 'storage'])('edits a linked HPC %s member and couples containing-rack updates to workspace history', async type => {
  const { service, workspace, source, clone, sourceRaw } = setup();
  workspace.solution.solutionMode = 'HPC and AI - Systems';
  for (const raw of [sourceRaw, source.raw, clone.raw]) raw.type = type;
  const rack = [...workspace.configurations.values()].find(c => c.configurationId === 'rack-1')!;
  workspace.rackArea = [{ id: 'rack-1', type: 'rack', size: 42, rackItems: [
    { id: 'server-1', type, size: 1, position: 1 }, { id: 'server-2', type, size: 1, position: 2 },
  ] }];
  const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [
    acceptedResponse(sourceRaw, 'server-1'), { ...rack.raw, totalPrice: 20, updateConfigurationIds: ['rack-1'] },
  ] } } as never);
  await service.configure(clone, [{ section: 'PROCESSOR', code: 'BYW3', quantity: 2 }], service.newCtx(), clone.revision);
  expect(selection(source)).toBe(2); expect(selection(clone)).toBe(2); expect(rack.raw.totalPrice).toBe(20);
  const request = send.mock.calls[0]![0];
  expect(request.query).not.toHaveProperty('entranceFlag');
  expect(request.query?.['configurationId']).toBe('server-1');
  const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
  expect(body['customizingIds']).toEqual(['server-1', 'server-2']);
  expect((body['configurations'] as Obj[]).map(c => c['id'])).toEqual(['server-1', 'rack-1']);
  await expect(service.undo(clone, clone.revision)).rejects.toThrow(/workspace/i);
  await service.sessions.undoWorkspace(workspace.id, workspace.revision);
  expect(selection(source)).toBe(1); expect(selection(clone)).toBe(1); expect(rack.raw.totalPrice).toBe(10);
});
