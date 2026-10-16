import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import type { ProductServiceState, StandaloneSoftwareState } from '../src/domain/standalone.js';
import { SessionPersistenceError } from '../src/session/persistenceError.js';

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.close())); });
const solution = { solutionMode: 'General Purpose', masterSlices: ['GP', 'HPCGPALL', 'HPCGPRYO'] };
const xml = '<CFXML><CFData><ProductLineItem><ProductIdentification><PartnerProductIdentification><ProprietaryProductIdentifier>7S1S002WWW</ProprietaryProductIdentifier></PartnerProductIdentification></ProductIdentification></ProductLineItem></CFData></CFXML>';
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}-import-response.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
}
function setup(payload: Record<string, unknown>) {
  const service = new DcscService(ConfigSchema.parse({ logLevel: 'silent', files: { persistSessions: false } }));
  services.push(service);
  vi.spyOn(service, 'resolveSolution').mockResolvedValue(solution);
  const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: [payload] } as never);
  return { service, send, ctx: service.newCtx({ solution }) };
}

describe('atomic standalone import integration', () => {
  it('restores software-only state without inventing hardware and persists the complete envelope once', async () => {
    const payload = fixture('software-qty3');
    const { service, ctx } = setup(payload);
    const persist = vi.fn();
    service.sessions.setPersistenceWriter(persist);
    const result = await service.importConfig({ content: xml, ctx });
    expect(result.sessions).toEqual([]);
    expect(result.standaloneKind).toBe('software');
    expect(persist).toHaveBeenCalledTimes(1);
    const workspace = service.sessions.getWorkspace(result.workspaceId)!;
    const state = workspace.serverState.standaloneSoftwareState as StandaloneSoftwareState;
    expect(state.selections[0]).toMatchObject({ quantity: 3, unitPrice: 234.5, totalPrice: 703.5 });
    expect(workspace.serverState.standaloneData).toEqual(payload.standaloneData);
    expect(result.diagnostics.warnings).toHaveLength(1);
  });

  it('restores service catalog and multiplicative quantities in a service-only workspace', async () => {
    const { service, ctx } = setup(fixture('service-qty'));
    const result = await service.importConfig({ content: xml, ctx });
    expect(result.sessions).toEqual([]);
    expect(result.standaloneKind).toBe('service');
    const workspace = service.sessions.getWorkspace(result.workspaceId)!;
    const state = workspace.serverState.standaloneServiceState as ProductServiceState;
    expect(state.product.quantity).toBe(3);
    expect(state.selections[0]?.quantity).toBe(2);
    expect(state.summaryRaw).toEqual(expect.arrayContaining([expect.objectContaining({ totalPrice: 9822 })]));
  });

  it('restores mixed hardware and software together and infers the returned hardware mode', async () => {
    const payload = fixture('software-qty3');
    payload.type = 'cto';
    payload.configuration = [{ id: 'US__imported', code: 'NODE', sliceCtoCode: 'NODE', quantity: 4, tabs: [] }];
    const { service, ctx } = setup(payload);
    const result = await service.importConfig({ content: xml, ctx });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ mode: 'cto', raw: { quantity: 4 } });
    expect(service.sessions.getWorkspace(result.workspaceId)?.serverState.standaloneSoftwareState).toBeDefined();
  });

  it('rolls back the import on disk failure', async () => {
    const { service, ctx, send } = setup(fixture('software-qty3'));
    const cause = new Error('disk full');
    const persist = vi.fn(() => { throw cause; });
    service.sessions.setPersistenceWriter(persist);
    const failure = await service.importConfig({ content: xml, ctx }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionPersistenceError);
    expect(failure).toMatchObject({
      code: 'DCSC_LOCAL_NOT_COMMITTED',
      localNotCommitted: true,
      remoteApplied: true,
      cause,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(service.sessions.listWorkspaces()).toHaveLength(0);
  });

  it('rejects replacing an existing software basket or joining an independent service basket', async () => {
    const { service, ctx, send } = setup(fixture('software-qty3'));
    const result = await service.importConfig({ content: xml, ctx });
    const workspace = service.sessions.getWorkspace(result.workspaceId)!;
    const before = structuredClone(workspace.serverState);
    const revision = workspace.revision;
    await expect(service.importConfig({ content: xml, ctx, workspaceId: workspace.id })).rejects.toThrow('already contains standalone software');
    send.mockResolvedValue({ raw: [fixture('service-qty')] } as never);
    await expect(service.importConfig({ content: xml, ctx, workspaceId: workspace.id })).rejects.toThrow('separate service workspace');
    expect(workspace.revision).toBe(revision);
    expect(workspace.serverState).toEqual(before);
  });

  it('rejects an unknown workspace before sending the file', async () => {
    const { service, ctx, send } = setup(fixture('software-qty3'));
    await expect(service.importConfig({ content: xml, ctx, workspaceId: 'missing' })).rejects.toThrow('not found');
    expect(send).not.toHaveBeenCalled();
  });
});
