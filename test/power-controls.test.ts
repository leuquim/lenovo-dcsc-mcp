import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConfigSchema } from '../src/config/schema.js';
import { acceptPowerCalculation, buildPowerCalculationRequest, inspectPowerControls, stagePowerControls } from '../src/domain/powerControls.js';
import { powerLoadFactor } from '../src/domain/power.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import type { RawConfiguration } from '../src/model/types.js';
import { registerPowerControlTools } from '../src/mcp/powerControlTools.js';

type Obj = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/power-controls.json', import.meta.url), 'utf8')) as {
  response: Obj; request: Obj[]; expectedMetadata: Record<string, string>;
  expectedExport: { voltage: Obj; loadFactor: number; currentPowerPolicy: number };
};
const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

function raw(id = 'node-1'): RawConfiguration {
  return { id, code: '7D73CTO1WW', type: 'SERVER', quantity: 1, totalPrice: 100, tabs: [],
    voltage: { level: 'Low', type: 'AC', displayValue: '115V', actualValue: '115' },
    optionalVoltages: [
      { level: 'Low', type: 'AC', displayValue: '115V', actualValue: '115' },
      fixture.expectedExport.voltage,
    ],
    currentPowerPolicy: 5, powerPolicies: [{ value: 5, description: 'Native policy' }],
    loadFactor: 70,
    powerReportResponse: { ...structuredClone(fixture.response),
      powerReport: { ...(fixture.response['powerReport'] as Obj), loadFactor: 70, operatingVoltage: '115V-AC' } },
    unSelectableCharacters: [
      { name: 'VOLTAGE_MI', results: [{ code: 'BK14', quantity: 1 }] },
      { name: 'POWER_POLICY_MI', results: [{ code: 'BE0E', quantity: 1 }] },
    ],
    unSelectableCharacterResults: [{ characterName: 'VOLTAGE_MI', results: [{ code: 'BK14', quantity: 1 }] }],
  };
}

function setup(linked = false) {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const create = (configuration: RawConfiguration, workspaceId?: string) => service.sessions.create({
    raw: configuration, configurationId: String(configuration.id), locale: service.locale,
    solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] }, mode: 'cto', primed: true,
    reduced: reduceConfiguration(configuration, String(configuration.id)), ...(workspaceId ? { workspaceId } : {}),
  });
  const first = create(raw());
  const workspace = service.sessions.getWorkspace(first.id)!;
  const second = linked ? create(raw('node-2'), workspace.id) : undefined;
  if (second) workspace.serverState.cloneDependency = { 'node-1': ['node-1', 'node-2'] };
  return { service, first, second, workspace };
}

it('matches native saved voltage/load factor and both metadata shapes without changing the source', () => {
  const initial = raw();
  const staged = stagePowerControls(initial, { voltage: '230V@AC', loadFactor: 100, powerPolicy: 5 });
  expect(buildPowerCalculationRequest(staged)[0]).toMatchObject({
    operationVoltage: fixture.expectedExport.voltage, utilization: 100, currentPowerPolicy: 5,
  });
  const accepted = acceptPowerCalculation(staged, fixture.response);
  expect(reduceConfiguration(accepted, 'node-1')).toMatchObject({
    voltage: fixture.expectedExport.voltage, loadFactor: fixture.expectedExport.loadFactor,
    currentPowerPolicy: fixture.expectedExport.currentPowerPolicy,
  });
  expect(accepted.unSelectableCharacters).toMatchObject([
    { name: 'VOLTAGE_MI', results: [{ code: fixture.expectedMetadata['VOLTAGE_MI'] }] },
    { name: 'POWER_POLICY_MI', results: [{ code: fixture.expectedMetadata['POWER_POLICY_MI'] }] },
  ]);
  expect(accepted.unSelectableCharacterResults).toMatchObject([{ results: [{ code: 'BK15' }] }]);
  expect(inspectPowerControls(initial).current).toMatchObject({ voltage: '115V@AC', loadFactor: 70 });
});

it('retains zero load and prefers the saved report over a stale top-level default', () => {
  const initial = raw();
  (initial.powerReportResponse as { powerReport: Obj }).powerReport['loadFactor'] = 0;
  expect(powerLoadFactor(initial)).toBe(0);
  expect(reduceConfiguration(initial, 'node-1').loadFactor).toBe(0);
  expect(buildPowerCalculationRequest(initial)[0]!['utilization']).toBe(0);
});

it('rejects unavailable power, unsupported choices, invalid percentages and silently ignored settings', () => {
  expect(() => stagePowerControls({ ...raw(), powerReportResponse: null }, { loadFactor: 30 })).toThrow(/unavailable/);
  for (const change of [{ voltage: '480V@AC' }, { powerPolicy: 99 }, { loadFactor: -1 }, { loadFactor: 0.5 }, {}]) {
    expect(() => stagePowerControls(raw(), change)).toThrow();
  }
  const staged = stagePowerControls(raw(), { voltage: '230V@AC', loadFactor: 30 });
  expect(() => acceptPowerCalculation(staged, fixture.response)).toThrow(/did not retain/);
  expect(() => acceptPowerCalculation(staged, { powerReport: {}, errorMsg: [] })).toThrow(/no complete numeric/);
  expect(() => acceptPowerCalculation(staged, { ...fixture.response, errorMsg: ['rejected'] })).toThrow(/rejected/);
});

it('updates linked members atomically, keeps units independent and supports workspace undo', async () => {
  const { service, first, second, workspace } = setup(true);
  const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: fixture.response } as never);
  const revision = workspace.revision;
  const result = await service.setPowerControls(second!.id, { voltage: '230V@AC', loadFactor: 100 }, revision, service.newCtx());
  expect(result.affectedConfigurationIds).toEqual(['node-1', 'node-2']);
  expect(send).toHaveBeenCalledTimes(2);
  for (const [request] of send.mock.calls) {
    expect(request.path).toBe('/powercalculation/powercalculate');
    expect(request.body).toMatchObject({ kind: 'json', value: [{ utilization: 100 }] });
  }
  expect(inspectPowerControls(first.raw).current).toEqual(inspectPowerControls(second!.raw).current);
  expect(workspace.revision).toBe(revision + 1);
  await service.sessions.undoWorkspace(workspace.id, workspace.revision);
  expect(inspectPowerControls(first.raw).current).toMatchObject({ loadFactor: 70, voltage: '115V@AC' });
});

it('rejects stale workspace revisions before HTTP and rolls back all members on a failed calculation', async () => {
  const { service, first, second, workspace } = setup(true);
  const send = vi.spyOn(service.http, 'send').mockResolvedValueOnce({ raw: fixture.response } as never)
    .mockRejectedValueOnce(new Error('Calculation unavailable'));
  await expect(service.setPowerControls(first.id, { loadFactor: 100 }, workspace.revision + 1, service.newCtx())).rejects.toThrow(/Revision conflict/);
  expect(send).not.toHaveBeenCalled();
  const revision = workspace.revision;
  await expect(service.setPowerControls(first.id, { voltage: '230V@AC', loadFactor: 100 }, revision, service.newCtx())).rejects.toThrow(/Calculation unavailable/);
  expect(workspace.revision).toBe(revision);
  expect(powerLoadFactor(first.raw)).toBe(70);
  expect(powerLoadFactor(second!.raw)).toBe(70);
});

it('rejects missing export metadata and leaves live state unchanged if durable save fails', async () => {
  const staged = stagePowerControls(raw(), { voltage: '230V@AC', loadFactor: 100 });
  const missing = structuredClone(fixture.response);
  delete (missing['powerReport'] as Obj)['voltageMI'];
  expect(() => acceptPowerCalculation(staged, missing)).toThrow(/omitted VOLTAGE_MI/);
  const { service, first, workspace } = setup();
  vi.spyOn(service.http, 'send').mockResolvedValue({ raw: fixture.response } as never);
  service.sessions.setPersistenceWriter(async () => { throw new Error('disk full'); });
  const revision = workspace.revision;
  await expect(service.setPowerControls(first.id, { voltage: '230V@AC', loadFactor: 100 }, revision, service.newCtx()))
    .rejects.toMatchObject({ localNotCommitted: true, remoteApplied: true });
  expect(workspace.revision).toBe(revision);
  expect(inspectPowerControls(first.raw).current).toMatchObject({ voltage: '115V@AC', loadFactor: 70 });
  service.sessions.setPersistenceWriter(async () => undefined);
});

it('discovers bounded choices through the tool and invalidates navigation after mutation', async () => {
  const { service, first, workspace } = setup();
  type Reply = { isError?: boolean; content: Array<{ text: string }> };
  type Handler = (args: Record<string, unknown>) => Promise<Reply>;
  const handlers = new Map<string, Handler>();
  registerPowerControlTools({ registerTool(name: string, _definition: unknown, handler: Handler) {
    handlers.set(name, handler);
  } } as unknown as McpServer, service);
  first.raw.powerPolicies = Array.from({ length: 100 }, (_, index) => ({ value: index, description: `Policy ${index} `.repeat(500) }));
  const args = { session: first.id, path: [], offset: 0, limit: 20 };
  const reply = await handlers.get('dcsc_power_controls')!(args);
  expect(reply.isError).not.toBe(true);
  expect(Buffer.byteLength(reply.content[0]!.text)).toBeLessThan(7_500);
  const page = JSON.parse(reply.content[0]!.text) as { items: Array<{ key: string; next?: { arguments: Obj } }> };
  const continuation = page.items.find(item => item.key === 'policies')!.next!;
  expect(continuation.arguments['expectedRevision']).toBe(workspace.revision);
  vi.spyOn(service.http, 'send').mockResolvedValue({ raw: fixture.response } as never);
  const saved = await handlers.get('dcsc_set_power_controls')!({ session: first.id,
    expectedRevision: workspace.revision, voltage: '230V@AC', loadFactor: 100 });
  expect(saved.isError).not.toBe(true);
  expect((await handlers.get('dcsc_power_controls')!(continuation.arguments)).isError).toBe(true);
});
