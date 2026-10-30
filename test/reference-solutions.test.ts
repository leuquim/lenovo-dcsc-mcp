import { afterEach, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import { referencePath, referenceRows } from '../src/domain/referenceSolutions.js';
import { registerReferenceSolutionTools } from '../src/mcp/referenceSolutionTools.js';
import { workspaceDetailSource } from '../src/model/workspaceProjection.js';

type Obj = Record<string, unknown>;
const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); });
const solution = { solutionMode: 'General Purpose', masterSlices: ['GP', 'HPCGPALL', 'HPCGPRYO'] };
function setup() {
  const service = new DcscService(ConfigSchema.parse({ logLevel: 'silent', files: { persistSessions: false } }));
  services.push(service);
  vi.spyOn(service, 'resolveSolution').mockResolvedValue(solution);
  return service;
}
function payload(): Obj {
  return { type: 'cto', configuration: [{ id: 'US__native', code: '7DGDCTO1WW', quantity: 1, tabs: [] }],
    configurationMode: solution, country: 'US', language: 'en', currency: 'USD',
    missingParts: [{ productCode: 'OLD', description: 'Retired part' }],
    workspace: { rackArea: [], nonRackArea: [] }, opaqueNativeField: { preserved: true } };
}
function handlers(service: DcscService) {
  const handlers = new Map<string, (args: Obj) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>>();
  registerReferenceSolutionTools({ registerTool(name: string, _spec: unknown, handler: typeof handlers extends Map<string, infer H> ? H : never) {
    handlers.set(name, handler);
  } } as unknown as McpServer, service);
  return handlers;
}

it('retains category data while exposing every category ID and breadcrumb', () => {
  const tree = { id: 'root', name: 'Solutions', future: { retained: true }, children: [
    { id: 'child', name: 'Backup', sidList: [{ sidNumber: 'SID0000978' }], children: [] },
  ] };
  expect(referenceRows(tree, 'categories')).toEqual([
    { id: 'root', name: 'Solutions', future: { retained: true }, breadcrumb: ['Solutions'], childIds: ['child'] },
    { id: 'child', name: 'Backup', sidList: [{ sidNumber: 'SID0000978' }], breadcrumb: ['Solutions', 'Backup'], childIds: [] },
  ]);
  expect(() => referencePath({ view: 'solutions', categoryId: '../private' })).toThrow('categoryId');
  expect(() => referencePath({ view: 'validation' })).toThrow('crnId');
});

it('caches catalogs by locale and mode, returns independent data, and always revalidates live', async () => {
  const service = setup();
  const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: [{ crnId: 'SID1' }] } as never);
  const query = { view: 'solutions' as const, categoryId: 'category' };
  const first = await service.referenceSolutions(query, service.newCtx());
  (first.raw as Obj[])[0]!['crnId'] = 'tampered';
  expect((await service.referenceSolutions(query, service.newCtx())).raw).toEqual([{ crnId: 'SID1' }]);
  expect(send).toHaveBeenCalledTimes(1);
  await service.referenceSolutions(query, service.newCtx({ locale: { country: 'DE', geo: 'EMEA', language: 'de', currency: 'EUR' } }));
  expect(send).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 2; i++) await service.referenceSolutions({ view: 'validation', crnId: 'SID1' }, service.newCtx());
  expect(send).toHaveBeenCalledTimes(4);
  expect(send.mock.calls[3]![0].path).toBe('/reference_solution/CRNs/SID1/validate');
});

it('customizes into an atomic new workspace, preserving native state and pageable diagnostics', async () => {
  const service = setup();
  const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: payload() } as never);
  const persist = vi.fn(); service.sessions.setPersistenceWriter(persist);
  const result = await service.launchReferenceSolution('SID0000978', service.newCtx());
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toMatchObject({ method: 'GET', path: '/reference_solution/CRNs/SID0000978/customize' });
  expect(persist).toHaveBeenCalledTimes(1);
  const workspace = service.sessions.getWorkspace(result.workspaceId)!;
  expect(workspace.configurations.size).toBe(1);
  expect(workspace.serverState).toMatchObject({ crnId: 'SID0000978', opaqueNativeField: { preserved: true } });
  expect(workspaceDetailSource(workspace)['importDiagnostics']).toMatchObject({ missingParts: [{ productCode: 'OLD' }] });
});

it('rolls back a failed durable reference import and rejects invalid identifiers before any HTTP', async () => {
  const service = setup();
  const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: JSON.stringify(payload()) } as never);
  service.sessions.setPersistenceWriter(() => { throw new Error('disk full'); });
  await expect(service.launchReferenceSolution('SID1', service.newCtx())).rejects.toThrow('Durable session commit failed');
  expect(service.sessions.listWorkspaces()).toHaveLength(0);
  send.mockClear();
  await expect(service.launchReferenceSolution('../invalid', service.newCtx())).rejects.toThrow('crnId');
  expect(send).not.toHaveBeenCalled();
});

it('keeps large catalog descriptions lossless and rejects changed continuation context', async () => {
  const service = setup();
  vi.spyOn(service.http, 'send').mockResolvedValue({ raw: [{ crnId: 'SID1', description: 'x'.repeat(20_000) }] } as never);
  const browse = handlers(service).get('dcsc_reference_solutions')!;
  const first = await browse({ view: 'solutions', catalog: 'deployment-ready', categoryId: 'category', offset: 0, limit: 15 });
  expect(first.isError).not.toBe(true);
  expect(Buffer.byteLength(first.content[0]!.text)).toBeLessThan(8_000);
  const page = JSON.parse(first.content[0]!.text) as Obj;
  const detail = ((page['entries'] as Obj[])[0]!['detail'] as Obj)['arguments'] as Obj;
  const next = await browse(detail);
  expect(next.isError).not.toBe(true);
  expect(next.content[0]!.text).toContain('description');
  const stale = await browse({ ...detail, categoryId: 'other' });
  expect(stale.isError).toBe(true);
  expect(stale.content[0]!.text).toContain('context changed');
});
