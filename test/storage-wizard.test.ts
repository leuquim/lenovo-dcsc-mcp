import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { isStorageRaidModeChange, clearStorageRaidSections, storageWizardOption, storageWizardSections, stageStorageWizardChange } from '../src/domain/storageWizard.js';
import { buildExportConfiguration, reduceConfiguration } from '../src/domain/reduce.js';
import { serializeSections } from '../src/domain/dcscWire.js';
import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import type { RawConfiguration } from '../src/model/types.js';

type Obj = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/storage-wizard.json', import.meta.url), 'utf8')) as {
  afterRaidMode: RawConfiguration; raidModeRequest: Obj;
  afterReverseRaidMode: RawConfiguration; reverseRaidModeRequest: Obj;
  before: RawConfiguration; afterOption: RawConfiguration; afterFeature: RawConfiguration;
  withoutDrives: RawConfiguration; cleared: RawConfiguration; clearRequest: Obj;
  optionRequest: Obj; optionSections: Obj[]; featureRequest: Obj; featureDelta: Obj;
};
const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); });

it('matches native reverse RAID clearing with a populated RAID1 array and restores it on undo', async () => {
  const captured = JSON.parse(readFileSync(new URL('./fixtures/parity/storage-raid-populated.json', import.meta.url), 'utf8')) as {
    before: RawConfiguration; after: RawConfiguration; request: { sections: Obj[]; delta: unknown; storageWizardOption: unknown };
  };
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const raw = structuredClone(captured.before);
  const session = service.sessions.create({ raw, configurationId: String(raw.id), locale: service.locale,
    solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] }, mode: 'cto', primed: true,
    reduced: reduceConfiguration(raw, String(raw.id)) });
  const workspace = service.sessions.getWorkspace(session.id)!;
  const compact = (sections: Obj[]) => sections.map(s => ({ name: s['name'],
    results: (s['results'] as Obj[]).map(r => ({ code: r['code'], quantity: r['quantity'] })) }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  expect(compact(reduceConfiguration(raw, String(raw.id)).sections)).toEqual(expect.arrayContaining([
    { name: 'CONTROLLER_1_ARRAY_1_FOR_SAS_SATA', results: [{ code: 'B9XD', quantity: 1 }] },
    { name: 'CONTROLLER_1_ARRAY_1_SAS_SATA_HDD', results: [{ code: 'AUM1', quantity: 2 }] },
  ]));
  const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [captured.after] } } as never);
  await service.configure(session, [{ section: 'RAID_CONFIG', code: '5977', quantity: 1 }], service.newCtx());
  const body = send.mock.calls[0]![0].body as { value: { configurations: Array<typeof captured.request> } };
  const actual = body.value.configurations[0]!;
  expect(compact(actual.sections)).toEqual(compact(captured.request.sections));
  expect(actual.delta).toEqual({ ...(captured.request.delta as Obj), previousFeatureCode: '5978', previousQuantity: 1 });
  expect(actual.storageWizardOption).toEqual(captured.request.storageWizardOption);
  expect(storageWizardOption(session.raw)).toEqual({ activate: false, userSelected: false });
  await service.sessions.undoWorkspace(workspace.id, workspace.revision);
  expect(session.raw).toEqual(captured.before);
});
function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const raw = structuredClone(fixture.before);
  const session = service.sessions.create({ raw, configurationId: String(raw.id), locale: service.locale,
    solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] }, mode: 'cto', primed: true,
    reduced: reduceConfiguration(raw, String(raw.id)) });
  return { service, session, workspace: service.sessions.getWorkspace(session.id)! };
}

it('matches the native explicit option and section payload, retaining intent on export without mutating input', () => {
  const before = structuredClone(fixture.before);
  const staged = stageStorageWizardChange(before, { optionId: '4-2' });
  const reduced = reduceConfiguration(staged, String(staged.id));
  expect(reduced.storageWizardOption).toEqual(fixture.optionRequest);
  const names = new Set(fixture.optionSections.map(s => s['name']));
  expect(reduced.sections.filter(s => names.has(s.name))).toEqual(fixture.optionSections);
  expect(buildExportConfiguration(reduced, staged)['storageWizardOption']).toEqual(fixture.optionRequest);
  expect(before).toEqual(fixture.before);
});

it('matches native feature-add delta and preserves the returned invalid-combination diagnostics', async () => {
  const staged = stageStorageWizardChange(fixture.afterOption, { optionId: '4-2', feature: { groupIndex: 1, code: 'B8NZ', quantity: 1 } });
  const reduced = reduceConfiguration(staged, String(staged.id));
  expect(reduced.storageWizardOption).toEqual(fixture.featureRequest);
  expect(reduced.delta).toEqual(fixture.featureDelta);
  const { service, session, workspace } = setup();
  vi.spyOn(service.http, 'send').mockResolvedValueOnce({ raw: { configurations: [fixture.afterOption] } } as never)
    .mockResolvedValueOnce({ raw: { configurations: [fixture.afterFeature] } } as never);
  await service.setStorageWizard(session.id, { optionId: '4-2' }, workspace.revision, service.newCtx());
  const result = await service.setStorageWizard(session.id, { optionId: '4-2', feature: { groupIndex: 1, code: 'B8NZ', quantity: 1 } }, workspace.revision, service.newCtx());
  expect(result.errors).toHaveLength(1);
  expect(result.options.find(o => o['activate'])?.['userSelected']).toBe(true);
});

it('rejects invalid options, unavailable quantities, ambiguous features and editing an inactive option', () => {
  for (const change of [{ optionId: 'missing' }, { optionId: '4-2', feature: { groupIndex: 1, code: 'B8NZ', quantity: 1 } },
    { optionId: '1-2', feature: { groupIndex: 0, code: 'C3RT', quantity: 99 } },
    { optionId: '1-2', feature: { groupIndex: 7, code: 'missing', quantity: 0 } }]) {
    expect(() => stageStorageWizardChange(fixture.before, change)).toThrow();
  }
});

it('omits automatically chosen controller features when drive selections change, but retains explicit choices', () => {
  const raw = structuredClone(fixture.before);
  const wizard = raw['storageWizard'] as Obj;
  for (const o of wizard['storageWizardOptions'] as Obj[]) o['userSelected'] = false;
  const sections = serializeSections(raw);
  const hdd = sections.find(s => s.name === 'NONRAID_HDD')!;
  expect(hdd).toBeDefined();
  hdd.results[0]!.quantity += 1;
  expect(storageWizardSections(raw, sections, true).some(s => s.name === 'BACKPLANE')).toBe(false);
  const explicit = stageStorageWizardChange(raw, { optionId: '1-2' });
  expect(storageWizardSections(explicit, sections, true).some(s => s.name === 'BACKPLANE')).toBe(true);
});

it('rejects stale revisions before HTTP, rolls back failed derivation and restores intent through undo', async () => {
  const { service, session, workspace } = setup();
  const before = structuredClone(session.raw);
  const send = vi.spyOn(service.http, 'send').mockRejectedValueOnce(new Error('derive failed'));
  await expect(service.setStorageWizard(session.id, { optionId: '4-2' }, workspace.revision + 1, service.newCtx())).rejects.toThrow(/Revision conflict/);
  expect(send).not.toHaveBeenCalled();
  await expect(service.setStorageWizard(session.id, { optionId: '4-2' }, workspace.revision, service.newCtx())).rejects.toThrow(/derive failed/);
  expect(session.raw).toEqual(before);
  send.mockResolvedValue({ raw: { configurations: [fixture.afterOption] } } as never);
  await service.setStorageWizard(session.id, { optionId: '4-2' }, workspace.revision, service.newCtx());
  expect(storageWizardOption(session.raw)?.['configId']).toBe('4-2');
  await service.sessions.undoWorkspace(workspace.id, workspace.revision);
  expect(session.raw).toEqual(before);
});

it('does not commit a lost explicit selection or a failed durable write', async () => {
  const { service, session, workspace } = setup();
  const before = structuredClone(session.raw);
  const dropped = structuredClone(fixture.afterOption);
  const wizard = dropped['storageWizard'] as Obj;
  for (const option of wizard['storageWizardOptions'] as Obj[]) option['userSelected'] = false;
  const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [dropped] } } as never);
  await expect(service.setStorageWizard(session.id, { optionId: '4-2' }, workspace.revision, service.newCtx())).rejects.toThrow(/did not retain/);
  expect(session.raw).toEqual(before);
  send.mockResolvedValue({ raw: { configurations: [fixture.afterOption] } } as never);
  service.sessions.setPersistenceWriter(async () => { throw new Error('disk full'); });
  await expect(service.setStorageWizard(session.id, { optionId: '4-2' }, workspace.revision, service.newCtx()))
    .rejects.toMatchObject({ localNotCommitted: true, remoteApplied: true });
  expect(session.raw).toEqual(before);
  service.sessions.setPersistenceWriter(async () => undefined);
});

it('keeps ordinary controller edits executable without pinning the old wizard option', async () => {
  const { service, session } = setup();
  const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [fixture.afterOption] } } as never);
  await service.configure(session, [{ section: 'BACKPLANE', code: 'C3RT', quantity: 2 }], service.newCtx());
  const body = send.mock.calls[0]![0].body;
  expect(body).toMatchObject({ kind: 'json', value: { configurations: [{ storageWizardOption: null }] } });
  const config = (body as { value: { configurations: Array<{ sections: Array<{ name: string; results: Obj[] }> }> } }).value.configurations[0]!;
  expect(config.sections.find(s => s.name === 'BACKPLANE')?.results).toMatchObject([{ code: 'C3RT', quantity: 2 }]);
});


it('matches native no-HDD deselection and rejects clearing configured drives before HTTP', async () => {
  const { service, session, workspace } = setup();
  const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [fixture.cleared] } } as never);
  await expect(service.setStorageWizard(session.id, { optionId: null }, workspace.revision, service.newCtx())).rejects.toThrow(/Remove configured storage drives/);
  expect(send).not.toHaveBeenCalled();
  const staged = stageStorageWizardChange(fixture.withoutDrives, { optionId: null });
  const reduced = reduceConfiguration(staged, String(staged.id));
  expect(reduced.storageWizardOption).toEqual(fixture.clearRequest['storageWizardOption']);
  expect(reduced.sections.some(s => ['BACKPLANE', 'SAS_SATA_RAID_CONTROLLER', 'NON_RAID_CONTROLLER'].includes(s.name))).toBe(false);
  session.raw = structuredClone(fixture.withoutDrives);
  const result = await service.setStorageWizard(session.id, { optionId: null }, workspace.revision, service.newCtx());
  expect(result.options.some(o => o['activate'] === true)).toBe(false);
});


it('matches native RAID-mode clearing while preserving unrelated sections, with atomic undo', async () => {
  const { service, session, workspace } = setup();
  const before = structuredClone(session.raw);
  const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [fixture.afterRaidMode] } } as never);
  await service.configure(session, [{ section: 'RAID_CONFIG', code: '5978', quantity: 1 }], service.newCtx());
  const body = send.mock.calls[0]![0].body as { value: { configurations: Array<{ sections: Obj[]; storageWizardOption: unknown; delta: unknown }> } };
  const wire = body.value.configurations[0]!;
  expect(wire.storageWizardOption).toBeNull();
  expect(wire.delta).toMatchObject(fixture.raidModeRequest['delta'] as Obj);
  const names = new Set(['RAID_CONFIG', 'NONRAID_HDD', 'BACKPLANE', 'SAS_SATA_RAID_CONTROLLER', 'NON_RAID_CONTROLLER', 'DERIVE_CABLE']);
  const compact = (sections: Obj[]) => sections.filter(s => names.has(String(s['name'])))
    .map(s => ({ name: s['name'], results: (s['results'] as Obj[]).map(r => ({ code: r['code'], quantity: r['quantity'] })) }));
  expect(compact(wire.sections)).toEqual(compact(fixture.raidModeRequest['sections'] as Obj[]));
  expect(session.raw).toMatchObject({ storageWizard: { storageWizardOptions: [] } });
  await service.sessions.undoWorkspace(workspace.id, workspace.revision);
  expect(session.raw).toEqual(before);
});

it('distinguishes RAID mode groups, preserves boot storage, and rejects ambiguous batches before HTTP', async () => {
  expect(isStorageRaidModeChange(fixture.before, '5977')).toBe(false);
  expect(isStorageRaidModeChange(fixture.before, '2212')).toBe(false);
  expect(isStorageRaidModeChange(fixture.before, '5978')).toBe(true);
  expect(isStorageRaidModeChange(fixture.afterRaidMode, '5977')).toBe(true);
  const boot = { name: 'M.2_SSD', subTabTitle: 'M.2 Boot Enablement', results: [{ code: 'boot', quantity: 2 }] };
  expect(clearStorageRaidSections(fixture.before, [boot])).toEqual([boot]);
  const { service, session } = setup();
  const send = vi.spyOn(service.http, 'send');
  await expect(service.configure(session, [{ section: 'RAID_CONFIG', code: '5978', quantity: 1 },
    { section: 'NONRAID_HDD', code: 'BYLR', quantity: 2 }], service.newCtx())).rejects.toThrow(/Switch RAID mode separately/);
  expect(send).not.toHaveBeenCalled();
});


it('retains storage intent for the same RAID mode and does not apply CTO clearing to LFO', async () => {
  const { service, session } = setup();
  const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [fixture.before] } } as never);
  await service.configure(session, [{ section: 'RAID_CONFIG', code: '5977', quantity: 1 }], service.newCtx());
  expect(send.mock.calls[0]![0].body).toMatchObject({ value: { configurations: [{
    storageWizardOption: { configId: '1-2', activate: true },
    sections: expect.arrayContaining([expect.objectContaining({ name: 'NONRAID_HDD', results: expect.arrayContaining([
      expect.objectContaining({ code: 'BYLR', quantity: 2 }),
    ]) })]),
  }] } });
  send.mockClear();
  session.mode = 'lfo';
  await expect(service.configure(session, [{ section: 'RAID_CONFIG', code: '5978', quantity: 1 }], service.newCtx()))
    .rejects.toThrow(/LFO RAID-mode switching/);
  expect(send).not.toHaveBeenCalled();
});


it('matches native reverse RAID switch from a configuration with no wizard options', async () => {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const raw = structuredClone(fixture.afterRaidMode);
  const session = service.sessions.create({ raw, configurationId: String(raw.id), locale: service.locale,
    solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] }, mode: 'cto', primed: true,
    reduced: reduceConfiguration(raw, String(raw.id)) });
  const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [fixture.afterReverseRaidMode] } } as never);
  await service.configure(session, [{ section: 'RAID_CONFIG', code: '5977', quantity: 1 }], service.newCtx());
  const body = send.mock.calls[0]![0].body as { value: { configurations: Array<{ sections: Obj[]; storageWizardOption: unknown; delta: unknown }> } };
  const wire = body.value.configurations[0]!;
  expect(wire.storageWizardOption).toBeNull();
  expect(wire.delta).toMatchObject(fixture.reverseRaidModeRequest['delta'] as Obj);
  expect(wire.sections.filter(s => ['NONRAID_HDD', 'BACKPLANE', 'DERIVE_CABLE', 'SAS_SATA_RAID_CONTROLLER'].includes(String(s['name'])))).toEqual([]);
  expect(storageWizardOption(session.raw)).toEqual({ activate: false, userSelected: false });
});

it('matches SR850 V4 mixed SAS/SATA and AnyBay option and component wire contracts', () => {
  const native = JSON.parse(readFileSync(new URL('./fixtures/parity/storage-wizard-sr850.json', import.meta.url), 'utf8')) as {
    before: RawConfiguration; after: RawConfiguration; optionRequest: Obj; optionSections: Obj[]; featureRequest: Obj; featureDelta: Obj;
  };
  const staged = stageStorageWizardChange(native.before, { optionId: '13-4' });
  const reduced = reduceConfiguration(staged, String(staged.id));
  expect(reduced.storageWizardOption).toEqual(native.optionRequest);
  const names = new Set(native.optionSections.map(s => s['name']));
  expect(reduced.sections.filter(s => names.has(s.name))).toEqual(native.optionSections);
  expect(reduced.sections.find(s => s.name === 'BACKPLANE')?.results.map(r => ({ code: r.code, quantity: r.quantity })))
    .toEqual([{ code: 'C3RT', quantity: 2 }, { code: 'C3RU', quantity: 1 }]);
  const edit = stageStorageWizardChange(native.after, { optionId: '13-4', feature: { groupIndex: 1, code: 'B8NZ', quantity: 1 } });
  const edited = reduceConfiguration(edit, String(edit.id));
  expect(edited.storageWizardOption).toEqual(native.featureRequest);
  expect(edited.delta).toEqual(native.featureDelta);
});
