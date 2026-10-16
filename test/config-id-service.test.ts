import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import type { RawConfiguration } from '../src/model/types.js';

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
const feature = { featureCode: 'A2HP', quantity: 1, description: 'Configuration ID 01 test' };
function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const raw: RawConfiguration = { id: 'config-1', code: '7DCECTO1WW', lfoCode: '7DCE100GNA',
    type: 'server', totalPrice: 100, quantity: 1,
    hipoDerivedItems: [{ targetCtoCode: '5374CM1', features: [] }],
    tabs: [{ title: 'Hardware', type: 'hardware', subTabs: [{ title: 'Firmware', sections: [
      { name: 'UEFI', features: [{ code: 'BFYE' }, { code: 'BFYB' }], results: [{ code: 'BFYE', quantity: 1 }] },
    ] }] }],
  };
  const locale = { ...service.locale, country: 'ES', currency: 'EUR' };
  const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
  const session = service.sessions.create({ locale, solution, mode: 'lfo-as-cto', raw,
    configurationId: raw.id!, reduced: reduceConfiguration(raw, raw.id!), primed: true });
  const workspace = service.sessions.getWorkspace(session.id)!;
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
    expect(request.ctx?.locale).toEqual(locale);
    if (request.path === '/rmp/mip') return { raw: { 5374: [feature] } } as never;
    if (request.path === '/ctos/racks/customize/non_rack') return { raw: [
      { code: raw.code, type: 'server', size: 4, weight: 23.56 },
    ] } as never;
    if (request.path === '/ctos/export_zip') return { stream: Readable.from(['fixture']) } as never;
    if (request.path === '/ctos/autoDerive') {
      expect(request.body).toMatchObject({ kind: 'json', value: {
        customizingIds: ['config-1'], workspaceInformation: { nonRackData: [
          expect.objectContaining({ id: 'config-1', size: 4, configIdFeatures: [feature] }),
        ] },
      } });
      const updated = structuredClone(raw);
      updated.tabs![0]!.subTabs![0]!.sections![0]!.results = [{ code: 'BFYB', quantity: 1 }];
      return { raw: { configurations: [updated] } } as never;
    }
    throw new Error(`Unexpected request ${request.path}`);
  });
  return { service, session, workspace, send };
}

it('enriches both export scopes with authoritative geometry and CONFIG_ID without mutating saved state', async () => {
  const { service, session, workspace, send } = setup();
  const before = structuredClone({ raw: session.raw, layout: workspace.nonRackArea, revision: workspace.revision });
  for (const scope of ['configuration', 'workspace'] as const) {
    await service.exportZip(session.id, { fileName: 'fixture', fileTypes: ['XML'], scope, ctx: service.newCtx() });
    const request = send.mock.calls.at(-1)![0];
    expect(request.body?.kind).toBe('form');
    if (request.body?.kind !== 'form') throw new Error('Missing form');
    const data = JSON.parse(request.body.fields.data!);
    expect(data.workspaceInformation.nonRackData[0]).toMatchObject({ size: 4, configIdFeatures: [feature] });
    expect(data.workspace.nonRackArea[0]).toMatchObject({ size: 4, derivedResults: [
      { ...feature, name: 'CONFIG_ID' },
    ] });
  }
  expect(send.mock.calls.filter(([request]) => request.path === '/rmp/mip')).toHaveLength(1);
  expect({ raw: session.raw, layout: workspace.nonRackArea, revision: workspace.revision }).toEqual(before);
});

it('derives and durably commits configuration-ID metadata with the hardware edit', async () => {
  const { service, session, workspace } = setup();
  const write = vi.fn(); service.sessions.setPersistenceWriter(write);
  await service.configure(session, [{ section: 'UEFI', code: 'BFYB', quantity: 1 }], service.newCtx());
  expect(workspace.nonRackArea[0]).toMatchObject({ id: 'config-1', size: 4, configIdFeatures: [feature] });
  expect(session.index.selected.get('BFYB')).toBe(1);
  expect(write).toHaveBeenCalledTimes(1);
  await service.sessions.undoWorkspace(workspace.id);
  expect(workspace.nonRackArea).toEqual([]);
  expect(session.index.selected.get('BFYE')).toBe(1);
});

it('publishes neither physical metadata nor selections if persistence rejects the edit', async () => {
  const { service, session, workspace } = setup();
  const before = structuredClone({ raw: session.raw, layout: workspace.nonRackArea, revision: workspace.revision });
  service.sessions.setPersistenceWriter(() => { throw new Error('disk failed'); });
  await expect(service.configure(session, [{ section: 'UEFI', code: 'BFYB', quantity: 1 }], service.newCtx())).rejects.toThrow();
  expect({ raw: session.raw, layout: workspace.nonRackArea, revision: workspace.revision }).toEqual(before);
});
