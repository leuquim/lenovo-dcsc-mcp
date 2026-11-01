import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import { acceptPciWizardValidation, pciWizardOptions, pciWizardSections, pciWizardWireFields, stagePciWizardChange, withPciWizardOption } from '../src/domain/pciWizard.js';
import { buildExportConfiguration, reduceConfiguration } from '../src/domain/reduce.js';
import type { RawConfiguration } from '../src/model/types.js';

type Obj = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/pci-wizard.json', import.meta.url), 'utf8')) as {
  before: RawConfiguration; derived: RawConfiguration; validationRequest: { pciWizardOption: Obj };
  validationResponse: Obj; deriveOption: Obj; cancelRequest: { pciWizardOption: Obj }; cancelResponse: Obj; spareCancelRequest: { pciWizardOption: Obj }; spareCancelResponse: Obj; spareCancelDeriveOption: Obj; spareCancelFinalOption: Obj; alternativeRequest: { pciWizardOption: Obj }; alternativeResponse: Obj; alternativeDeriveOption: Obj;
};
const change = { optionId: '1P Rear5-a', rowId: '2', enabled: true };
const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); });
function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const raw = structuredClone(fixture.before);
  const session = service.sessions.create({ raw, configurationId: String(raw.id), locale: service.locale,
    solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] }, mode: 'cto', primed: true,
    reduced: reduceConfiguration(raw, String(raw.id)) });
  return { service, session, workspace: service.sessions.getWorkspace(session.id)! };
}
const results = (option: Obj) => (option['results'] as Obj[]).map(slot => ({ code: slot['code'], adapterCode: slot['adapterCode'] }));

it('matches native slot validation and the accepted derive option without mutating input', () => {
  const before = structuredClone(fixture.before);
  const staged = stagePciWizardChange(before, change);
  expect(staged.operate).toBe('add');
  expect(results(staged.option)).toEqual(results(fixture.validationRequest.pciWizardOption));
  const accepted = acceptPciWizardValidation(staged.option, fixture.validationResponse);
  expect(results(accepted)).toEqual(results(fixture.deriveOption));
  expect(accepted['solutionPrice']).toBe(fixture.deriveOption['solutionPrice']);
  const raw = withPciWizardOption(before, staged.options, accepted);
  const reduced = reduceConfiguration(raw, 'server');
  expect(reduced).toMatchObject({ pciWizardOption: { configId: change.optionId } });
  expect(reduced).not.toHaveProperty('adapterCodeAndPhysicalSlotMap');
  const exported = buildExportConfiguration(reduced, raw);
  expect(exported).toHaveProperty('adapterCodeAndPhysicalSlotMap');
  expect(results(exported['pciWizardOption'] as Obj)).toEqual(results(fixture.deriveOption));
  expect(before).toEqual(fixture.before);
});

it('replaces riser sections without mutating existing sections or duplicating results', () => {
  const sections = [{ name: 'REAR_SLOT3', results: [{ code: 'stale', quantity: 1 }] }];
  const before = structuredClone(sections);
  const first = pciWizardSections(fixture.before, sections);
  expect(pciWizardSections(fixture.before, first)).toEqual(first);
  expect(sections).toEqual(before);
  expect(first.flatMap(s => s.results).some(r => r.code === 'stale')).toBe(false);
});

it('rejects invalid choices, ambiguous validation and native warnings', () => {
  expect(pciWizardOptions({ tabs: [] })).toEqual([]);
  for (const invalid of [{ optionId: 'missing' }, { ...change, rowId: 'missing' },
    { ...change, slotCodes: ['missing'] }, { ...change, slotCodes: ['C3R9', 'C3R9'] },
    { ...change, rowId: '4', slotCodes: ['C3R3', 'C3R7'] }]) {
    expect(() => stagePciWizardChange(fixture.before, invalid)).toThrow();
  }
  const staged = stagePciWizardChange(fixture.before, change);
  expect(() => acceptPciWizardValidation(staged.option, { ...fixture.validationResponse, massage: 'Invalid slot' })).toThrow(/Invalid slot/);
  expect(() => acceptPciWizardValidation(staged.option, { ...fixture.validationResponse, code: '2.1' })).toThrow(/rejected/);
  expect(() => acceptPciWizardValidation(staged.option, { code: 1, pciWizardOption: { configId: change.optionId, adapterSlots: [] } })).toThrow(/catalog/);
});

it('commits the authoritative four-slot derive result, and undo restores the two-slot selection', async () => {
  const { service, session, workspace } = setup();
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
    if (request.path === '/pci_wizard/validate/additional/slot') return { raw: fixture.validationResponse } as never;
    if (request.path === '/ctos/autoDerive') return { raw: { configurations: [fixture.derived] } } as never;
    throw new Error(`Unexpected request ${request.path}`);
  });
  const initial = pciWizardWireFields(session.raw);
  await service.setPciWizard(session.id, change, workspace.revision, service.newCtx());
  expect(send).toHaveBeenCalledTimes(2);
  expect(results(pciWizardWireFields(session.raw)['pciWizardOption'] as Obj)).toHaveLength(4);
  await service.sessions.undoWorkspace(workspace.id, workspace.revision);
  expect(pciWizardWireFields(session.raw)).toEqual(initial);
});

it('rejects stale revisions before HTTP and rolls back validation or derive failures', async () => {
  const { service, session, workspace } = setup();
  const before = structuredClone(session.raw);
  const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { code: 0, massage: 'Rejected' } } as never);
  await expect(service.setPciWizard(session.id, change, workspace.revision + 1, service.newCtx())).rejects.toThrow(/Revision conflict/);
  expect(send).not.toHaveBeenCalled();
  await expect(service.setPciWizard(session.id, change, workspace.revision, service.newCtx())).rejects.toThrow(/Rejected/);
  expect(session.raw).toEqual(before);
  send.mockReset().mockResolvedValueOnce({ raw: fixture.validationResponse } as never).mockRejectedValueOnce(new Error('Derive failed'));
  await expect(service.setPciWizard(session.id, change, workspace.revision, service.newCtx())).rejects.toThrow(/Derive failed/);
  expect(session.raw).toEqual(before);
});

it('validates every linked member and rolls back the group if one member rejects the slot', async () => {
  const { service, session, workspace } = setup();
  const secondRaw = { ...structuredClone(fixture.before), id: 'second' };
  const second = service.sessions.create({ raw: secondRaw, configurationId: 'second', locale: service.locale,
    solution: session.solution, mode: 'cto', primed: true, workspaceId: workspace.id,
    reduced: reduceConfiguration(secondRaw, 'second') });
  workspace.serverState.cloneDependency = { [session.configurationId]: [session.configurationId, 'second'] };
  const initial = [structuredClone(session.raw), structuredClone(second.raw)];
  const revision = workspace.revision;
  const send = vi.spyOn(service.http, 'send').mockResolvedValueOnce({ raw: fixture.validationResponse } as never)
    .mockResolvedValueOnce({ raw: { code: 0, massage: 'Linked slot rejected' } } as never);
  await expect(service.setPciWizard(second.id, change, revision, service.newCtx())).rejects.toThrow(/Linked slot rejected/);
  expect(send).toHaveBeenCalledTimes(2);
  expect([session.raw, second.raw]).toEqual(initial);
  expect(workspace.revision).toBe(revision);
});

it('rejects generic riser edits before HTTP and does not publish a wizard edit when persistence fails', async () => {
  const { service, session, workspace } = setup();
  const before = structuredClone(session.raw);
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
    if (request.path === '/pci_wizard/validate/additional/slot') return { raw: fixture.validationResponse } as never;
    return { raw: { configurations: [fixture.derived] } } as never;
  });
  await expect(service.configure(session, [{ section: 'REAR_SLOT1', code: 'C3R9', quantity: 1 }], service.newCtx()))
    .rejects.toThrow(/dcsc_wizard_set/);
  expect(send).not.toHaveBeenCalled();
  service.sessions.setPersistenceWriter(async () => { throw new Error('disk full'); });
  await expect(service.setPciWizard(session.id, change, workspace.revision, service.newCtx()))
    .rejects.toMatchObject({ localNotCommitted: true, remoteApplied: true });
  expect(session.raw).toEqual(before);
  service.sessions.setPersistenceWriter(async () => undefined);
});

it('applies authoritative linked derivation to both members when editing a non-root member', async () => {
  const { service, session, workspace } = setup();
  const secondRaw = { ...structuredClone(fixture.before), id: 'second' };
  const second = service.sessions.create({ raw: secondRaw, configurationId: 'second', locale: service.locale,
    solution: session.solution, mode: 'cto', primed: true, workspaceId: workspace.id,
    reduced: reduceConfiguration(secondRaw, 'second') });
  workspace.serverState.cloneDependency = { [session.configurationId]: [session.configurationId, 'second'] };
  vi.spyOn(service.http, 'send').mockImplementation(async request => {
    if (request.path === '/pci_wizard/validate/additional/slot') return { raw: fixture.validationResponse } as never;
    const derived = { ...structuredClone(fixture.derived), id: session.configurationId,
      updateConfigurationIds: [session.configurationId, 'second'] };
    return { raw: { configurations: [derived] } } as never;
  });
  const edited = await service.setPciWizard(second.id, change, workspace.revision, service.newCtx());
  expect(edited.affectedConfigurationIds).toEqual([session.configurationId, 'second']);
  for (const member of [session, second]) {
    expect(results(pciWizardWireFields(member.raw)['pciWizardOption'] as Obj)).toHaveLength(4);
  }
});


it('matches native cancellation and rejects removal of a slot required by an installed adapter', () => {
  const staged = stagePciWizardChange(fixture.before, { optionId: '1P Rear5-a', rowId: '0', enabled: false });
  expect(staged.operate).toBe('cancel');
  expect(results(staged.option)).toEqual(results(fixture.cancelRequest.pciWizardOption));
  expect(() => acceptPciWizardValidation(staged.option, fixture.cancelResponse)).toThrow(/required for adapter/);
});


it('accepts native code4 only for successful spare-slot cancellation', () => {
  const staged = stagePciWizardChange(fixture.derived, { optionId: '1P Rear5-a', rowId: '0', enabled: false });
  expect(staged.operate).toBe('cancel');
  expect(results(staged.option)).toEqual(results(fixture.spareCancelRequest.pciWizardOption));
  const accepted = acceptPciWizardValidation(staged.option, fixture.spareCancelResponse, 'cancel');
  expect(results(accepted)).toEqual(results(fixture.spareCancelDeriveOption));
  expect(results(accepted)).toHaveLength(3);
  expect(() => acceptPciWizardValidation(staged.option, fixture.spareCancelResponse, 'add')).toThrow(/rejected/);
  expect(() => acceptPciWizardValidation(staged.option, { ...fixture.spareCancelResponse, massage: 'Required' }, 'cancel')).toThrow(/Required/);
});


it('matches native alternative-riser selection and accepts code2 without a warning', () => {
  const staged = stagePciWizardChange(fixture.before, { optionId: '1P Rear5-a', rowId: '4', enabled: true, slotCodes: ['C3R7'] });
  expect(staged.operate).toBe('add');
  expect(results(staged.option)).toEqual(results(fixture.alternativeRequest.pciWizardOption));
  const accepted = acceptPciWizardValidation(staged.option, fixture.alternativeResponse, 'add');
  expect(results(accepted)).toEqual(results(fixture.alternativeDeriveOption));
  expect(accepted['solutionPrice']).toBe(fixture.alternativeDeriveOption['solutionPrice']);
  expect(() => acceptPciWizardValidation(staged.option, { ...fixture.alternativeResponse, code: '2.1', massage: 'In use' }, 'add')).toThrow(/In use/);
});
