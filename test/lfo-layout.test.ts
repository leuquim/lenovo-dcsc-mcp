import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
const contract = JSON.parse(readFileSync(new URL('./fixtures/parity/lfo-import-customize-contract.json', import.meta.url), 'utf8'));
const solution = { solutionMode: 'General Purpose', masterSlices: ['GP', 'HPCGPALL', 'HPCGPRYO'] };
const code = contract.source.product.code as string;
const xml = `<CFXML><CFData><ProductLineItem><ProductIdentification><PartnerProductIdentification><ProprietaryProductIdentifier>${code}</ProprietaryProductIdentifier></PartnerProductIdentification></ProductIdentification></ProductLineItem></CFData></CFXML>`;
function setup(failLayout = false) {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  vi.spyOn(service, 'resolveSolution').mockResolvedValue(solution);
  const raw = { ...contract.import.response.configuration, id: 'US__lfo', lfoCode: code, tabs: [] };
  const payload = { type: 'lfo', configuration: [raw],
    workspace: { rackArea: [], nonRackArea: [{ id: raw.id, type: 'server', quantity: 1 }] } };
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
    if (request.path === '/multiple/cfxml_import') return { raw: [payload] } as never;
    if (request.path === '/ctos/racks/customize/non_rack') {
      return { raw: [{ code, type: 'server', size: 4, weight: 25 }] } as never;
    }
    if (request.path === '/lfos/racks/customize') {
      if (failLayout) throw new Error('LFO layout rejected');
      const body = request.body?.kind === 'json' ? request.body.value as Record<string, unknown> : {};
      return { raw: { rackArea: body.rackArea, nonRackArea: body.nonRackArea, connections: [], errors: [] } } as never;
    }
    if (request.path === '/lfos/export_zip') return { stream: Readable.from(['PKfixture']) } as never;
    throw new Error(`Unexpected request ${request.path}`);
  });
  return { service, send, raw };
}

describe('captured LFO layout lifecycle', () => {
  it('imports through LFO layout validation without injecting CTO or LFO configuration derive', async () => {
    const { service, send, raw } = setup();
    const result = await service.importConfig({ content: xml, ctx: service.newCtx() });
    expect(result.sessions[0]).toMatchObject({ mode: 'lfo', raw });
    expect(send.mock.calls.map(([request]) => request.path)).toEqual([
      '/multiple/cfxml_import', '/ctos/racks/customize/non_rack', '/lfos/racks/customize',
    ]);
    const workspace = service.sessions.getWorkspace(result.workspaceId)!;
    expect(workspace.nonRackArea).toMatchObject([{ id: raw.id, code }]);
    await service.exportZip(workspace.id, { fileName: 'workspace', fileTypes: ['XML'], scope: 'workspace', ctx: service.newCtx() });
    expect(send.mock.lastCall?.[0].path).toBe('/lfos/export_zip');
    await service.exportZip(result.sessions[0]!.id, { fileName: 'configuration', fileTypes: ['XML'], scope: 'configuration', ctx: service.newCtx() });
    expect(send.mock.lastCall?.[0].path).toBe('/lfos/export_zip');
  });

  it('does not publish a partially imported workspace when LFO layout validation fails', async () => {
    const { service } = setup(true);
    const persist = vi.fn();
    service.sessions.setPersistenceWriter(persist);
    await expect(service.importConfig({ content: xml, ctx: service.newCtx() })).rejects.toThrow('LFO layout rejected');
    expect(service.sessions.listWorkspaces()).toHaveLength(0);
    expect(persist).not.toHaveBeenCalled();
  });
});
