import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import type { RawConfiguration } from '../src/model/types.js';

type Obj = Record<string, unknown>;
const derivedFixture = JSON.parse(readFileSync(
  new URL('./fixtures/parity/pdu-auto-derived-selection.json', import.meta.url), 'utf8')) as Obj;
const rackFixture = JSON.parse(readFileSync(
  new URL('./fixtures/parity/rack-recustomize-contract.json', import.meta.url), 'utf8')) as Obj;
const roots: string[] = [];
const services: DcscService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function a1mt(raw: RawConfiguration): Obj {
  const section = (raw.unSelectableCharacters as Obj[])
    .find((candidate) => candidate['name'] === 'ETHERNET_CABLE')!;
  return (section['results'] as Obj[]).find((candidate) => candidate['code'] === 'A1MT')!;
}

function exportA1mt(workspace: ReturnType<DcscService['sessions']['getWorkspace']>): Obj {
  if (!workspace) throw new Error('missing workspace');
  const data = buildExportData({ workspace, solution: workspace.solution, fileTypes: ['XML'],
    validationMode: workspace.validationMode });
  const configuration = (data['configurations'] as Obj[]).find((candidate) => candidate['id'] === workspace.rackArea[0]?.id)!;
  const section = (configuration['sections'] as Obj[]).find((candidate) => candidate['name'] === 'ETHERNET_CABLE')!;
  return (section['results'] as Obj[]).find((candidate) => candidate['code'] === 'A1MT')!;
}

it('retains authoritative auto-derived selections through configure, export, restart, undo and redo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcsc-auto-derived-'));
  roots.push(root);
  const config = ConfigSchema.parse({ files: { persistSessions: true, sessionFile: join(root, 'sessions.json') },
    logLevel: 'silent' });
  let service = new DcscService(config);
  services.push(service);
  const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
  const rackId = (rackFixture['response'] as Obj)['configuration'] as Obj;
  const id = String(rackId['id']);
  const tabs = [{ title: 'Power', type: 'hardware', subTabs: [{ title: 'Power', sections: [{ name: 'PDU',
    features: [{ code: 'CE6L', max: 4, description: 'PDU' }], results: [],
  }] }] }];
  const sourceDerived = structuredClone(derivedFixture['configuration'] as RawConfiguration);
  const raw: RawConfiguration = {
    ...sourceDerived, id, code: '7D6DCTO1WW', sliceCtoCode: '7D6DCTO1WW', type: 'rack', quantity: 1,
    totalPrice: 12_256.01, tabs,
  };
  const rack = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw,
    configurationId: id, reduced: reduceConfiguration(raw, id), primed: true });
  const serverRaw: RawConfiguration = { id: 'server-1', code: 'SERVER', sliceCtoCode: 'SERVER', tabs: [] };
  service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: serverRaw,
    configurationId: 'server-1', reduced: reduceConfiguration(serverRaw, 'server-1'), primed: true,
    workspaceId: rack.workspaceId });
  let workspace = service.sessions.getWorkspace(rack.workspaceId)!;
  workspace.rackArea = [{ id, code: '7D6DCTO1WW', type: 'rack', size: 42,
    rackItems: [{ id: 'server-1', code: 'SERVER', type: 'server', size: 1, position: 1 }] }];
  const hydrated = { ...structuredClone((rackFixture['response'] as Obj)['configuration'] as RawConfiguration),
    tabs, unSelectableCharacters: structuredClone(raw.unSelectableCharacters) };
  const records = structuredClone(derivedFixture['autoDerivedResults'] as Obj[]);
  for (const record of records) {
    (record['derivePart'] as Obj)['targetWorkspaceId'] = id;
    record['appliedConfigurations'] = [id];
  }
  vi.spyOn(service.http, 'send').mockImplementation(async (request) => {
    if (request.endpoint === 'rack_recustomize') return { raw: { configurations: [hydrated] } } as never;
    const accepted = structuredClone(hydrated);
    (accepted.tabs![0]!.subTabs![0]!.sections![0]! as Obj)['results'] = [{ code: 'CE6L', quantity: 1 }];
    accepted.totalPrice = 12_881.01;
    return { raw: { configurations: [accepted], autoDerivedResults: records } } as never;
  });

  await service.configurePdu(workspace.id, id, { pduCode: 'CE6L', expectedRevision: workspace.revision,
    ctx: service.newCtx() });
  workspace = service.sessions.getWorkspace(workspace.id)!;
  expect(a1mt(workspace.configurations.get(rack.id)!.raw)).toMatchObject({ derived: true, quantity: 1 });
  expect(exportA1mt(workspace)).toMatchObject({ derived: true, quantity: 1 });
  expect((workspace.serverState['autoDerivedResults'] as Obj[])[0]).toMatchObject({ id: 'rack-1@rule@rack-1' });
  const configuredRevision = workspace.revision;

  await service.close();
  services.splice(services.indexOf(service), 1);
  service = new DcscService(config);
  services.push(service);
  workspace = service.sessions.getWorkspace(rack.workspaceId)!;
  expect(a1mt(workspace.configurations.get(rack.id)!.raw)['derived']).toBe(true);
  expect(exportA1mt(workspace)['derived']).toBe(true);
  expect(await service.sessions.undoWorkspace(workspace.id, configuredRevision)).toBe(true);
  workspace = service.sessions.getWorkspace(workspace.id)!;
  expect(a1mt(workspace.configurations.get(rack.id)!.raw)['derived']).toBe(false);
  expect(workspace.serverState['autoDerivedResults']).toBeUndefined();
  expect(await service.sessions.redoWorkspace(workspace.id, workspace.revision)).toBe(true);
  workspace = service.sessions.getWorkspace(workspace.id)!;
  expect(a1mt(workspace.configurations.get(rack.id)!.raw)['derived']).toBe(true);
  expect(exportA1mt(workspace)['derived']).toBe(true);
});
