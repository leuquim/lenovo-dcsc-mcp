import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import type { RawConfiguration } from '../src/model/types.js';

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.close())); });

function raw(quantity = 1): RawConfiguration {
  return {
    code: 'TESTCTO', sliceCtoCode: 'TESTCTO', quantity: 1, totalPrice: 100,
    tabs: [{ title: 'Memory', type: 'hardware', subTabs: [{ title: 'Memory', sections: [{
      name: 'MEMORY', singleEntry: true,
      features: [{ code: 'DIMM', max: 16, description: 'DIMM' }],
      results: [{ code: 'DIMM', quantity }],
    }] }] }],
  };
}

function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'error' }));
  services.push(service);
  const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
  const configuration = raw();
  const session = service.sessions.create({
    locale: service.locale, solution, mode: 'cto', raw: configuration,
    configurationId: 'US__test0', reduced: reduceConfiguration(configuration, 'US__test0'), primed: true,
  });
  return { service, session, ctx: service.newCtx({ solution }) };
}

describe('configuration state regressions', () => {
  it('refreshes placed physical features after an edit and undo, retaining unrelated envelope metadata', async () => {
    const { service, session, ctx } = setup();
    const workspace = service.sessions.getWorkspace(session.id)!;
    workspace.nonRackArea = [{ id: session.configurationId, code: session.product.code, type: 'server',
      size: 1, configIdFeatures: [{ featureCode: 'CONFIG-ID' }],
      features: [{ name: 'MEMORY', results: [{ code: 'DIMM', quantity: 1 }] }] }];
    vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [raw(2)] } } as never);
    await service.configure(session, [{ section: 'MEMORY', code: 'DIMM', quantity: 2 }], ctx);
    expect(workspace.nonRackArea[0]).toMatchObject({ size: 1,
      features: [{ name: 'MEMORY', results: [{ code: 'DIMM', quantity: 2 }] }] });
    const exported = buildExportData({ workspace, solution: workspace.solution, fileTypes: ['XML'], validationMode: 'guided' });
    expect(exported.workspaceInformation).toMatchObject({ nonRackData: [{
      features: [{ name: 'MEMORY', results: [{ code: 'DIMM', quantity: 2 }] }],
    }] });
    await service.undo(session);
    expect(workspace.nonRackArea[0]).toMatchObject({
      features: [{ name: 'MEMORY', results: [{ code: 'DIMM', quantity: 1 }] }],
    });
  });
  it('marks existing connections stale after a changed selection or configuration undo', async () => {
    const { service, session, ctx } = setup();
    const workspace = service.sessions.getWorkspace(session.id)!;
    workspace.serverState.connections = [{ sourceId: session.configurationId, destinationId: 'switch', cablePart: 'CABLE' }];
    vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [raw(2)] } } as never);
    await service.configure(session, [{ section: 'MEMORY', code: 'DIMM', quantity: 2 }], ctx);
    expect(workspace.serverState.connectionGraphInvalidation).toBeDefined();
    expect(() => buildExportData({ workspace, solution: workspace.solution, fileTypes: ['XML'], validationMode: 'guided' }))
      .toThrow('connection graph predates');
    delete workspace.serverState.connectionGraphInvalidation;
    await service.undo(session, session.revision);
    expect(session.index.selected.get('DIMM')).toBe(1);
    expect(workspace.serverState.connectionGraphInvalidation).toBeDefined();
  });

  it('does not stale a current graph when an unchanged selection is returned', async () => {
    const { service, session, ctx } = setup();
    const workspace = service.sessions.getWorkspace(session.id)!;
    workspace.serverState.connections = [{ sourceId: session.configurationId, destinationId: 'switch' }];
    vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [raw(1)] } } as never);
    await service.configure(session, [{ section: 'MEMORY', code: 'DIMM', quantity: 2 }], ctx);
    expect(workspace.serverState.connectionGraphInvalidation).toBeUndefined();
  });
  it('retains client-owned sales quantity when deriving a per-unit configuration', async () => {
    const { service, session, ctx } = setup();
    await service.setQuantity(session, 4);
    vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [raw(2)] } } as never);
    await service.configure(session, [{ section: 'MEMORY', code: 'DIMM', quantity: 2 }], ctx);
    expect(session.raw.quantity).toBe(4);
    expect(session.reduced.quantity).toBe(4);
    expect(session.index.selected.get('DIMM')).toBe(2);
  });

  it('a failed request leaves raw, projection, revision and undo history unchanged', async () => {
    const { service, session, ctx } = setup();
    const before = structuredClone(session);
    vi.spyOn(service.http, 'send').mockRejectedValue(new Error('forced upstream failure'));
    await expect(service.configure(session, [{ section: 'MEMORY', code: 'DIMM', quantity: 8 }], ctx)).rejects.toThrow('forced');
    // Access timestamps are observational; selected state and history must be exact.
    expect(session.raw).toEqual(before.raw);
    expect(session.reduced).toEqual(before.reduced);
    expect(session.index).toEqual(before.index);
    expect(session.revision).toBe(before.revision);
    expect(session.snapshots).toEqual(before.snapshots);
    expect(await service.undo(session)).toBe(false);
  });

  it('undo restores the same selection in every representation', async () => {
    const { service, session, ctx } = setup();
    vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [raw(8)] } } as never);
    await service.configure(session, [{ section: 'MEMORY', code: 'DIMM', quantity: 8 }], ctx);
    expect(session.index.selected.get('DIMM')).toBe(8);
    expect(await service.undo(session)).toBe(true);
    expect(session.index.selected.get('DIMM')).toBe(1);
    expect(session.reduced.sections[0]?.results[0]?.quantity).toBe(1);
    expect(session.raw.tabs?.[0]?.subTabs?.[0]?.sections?.[0]?.results?.[0]?.quantity).toBe(1);
  });

  it('checks expectedRevision inside the mutation lock', async () => {
    const { service, session, ctx } = setup();
    const send = vi.spyOn(service.http, 'send').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { raw: { configurations: [raw(8)] } } as never;
    });
    const results = await Promise.allSettled([
      service.configure(session, [{ section: 'MEMORY', code: 'DIMM', quantity: 8 }], ctx, 1),
      service.configure(session, [{ section: 'MEMORY', code: 'DIMM', quantity: 4 }], ctx, 1),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(session.revision).toBe(2);
  });
});


describe('configuration controls', () => {
  it('persists Guided Auto-Correct off and carries it into subsequent edits', async () => {
    const { service, session, ctx } = setup();
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [raw()] } } as never);
    const workspace = service.sessions.getWorkspace(session.workspaceId)!;
    const result = await service.setConfigurationControls(session.id, { autoCorrect: false, expectedRevision: workspace.revision, ctx });
    expect(result).toMatchObject({ validationMode: 'guided', autoCorrect: false });
    expect(session.autoCorrect).toBe(false);
    await service.configure(session, [{ section: 'MEMORY', code: 'DIMM', quantity: 1 }], ctx);
    for (const [request] of send.mock.calls) {
      expect(request.query).toMatchObject({ guideMode: true });
      expect(request.body).toMatchObject({ value: { customizingFlags: { autoDerive: true, autoVariant: false } } });
    }
  });

  it('forces Auto-Correct off in Expert mode and rejects the conflicting combination before HTTP', async () => {
    const { service, session, ctx } = setup();
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [raw()] } } as never);
    await expect(service.setConfigurationControls(session.id, { validationMode: 'expert', autoCorrect: true, ctx })).rejects.toThrow('cannot be enabled');
    expect(send).not.toHaveBeenCalled();
    await service.setConfigurationControls(session.id, { validationMode: 'expert', ctx });
    expect(session.validationMode).toBe('expert');
    expect(session.autoCorrect).toBe(false);
    expect(send.mock.calls[0]?.[0].query).toMatchObject({ guideMode: false });
  });

  it('does not publish control changes if the derive fails', async () => {
    const { service, session, ctx } = setup();
    const workspace = service.sessions.getWorkspace(session.workspaceId)!;
    const revision = workspace.revision;
    vi.spyOn(service.http, 'send').mockRejectedValue(new Error('upstream failure'));
    await expect(service.setConfigurationControls(session.id, { validationMode: 'expert', ctx })).rejects.toThrow('upstream failure');
    expect(session.validationMode).toBe('guided');
    expect(session.autoCorrect).toBe(true);
    expect(workspace.revision).toBe(revision);
  });
});
