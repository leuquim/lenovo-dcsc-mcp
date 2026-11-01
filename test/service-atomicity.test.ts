import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import type { RawConfiguration } from '../src/model/types.js';
import { SessionPersistenceError } from '../src/http/persistenceError.js';

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.close())); });
const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };

function raw(quantity = 0): RawConfiguration {
  return { code: 'RACKCTO', sliceCtoCode: 'RACKCTO', quantity: 1, totalPrice: 100,
    tabs: [{ title: 'Power', type: 'hardware', subTabs: [{ title: 'Power', sections: [{
      name: 'PDU', singleEntry: true, features: [{ code: 'PDU1', max: 4, description: 'PDU' }],
      results: quantity ? [{ code: 'PDU1', quantity }] : [],
    }] }] }],
  };
}

function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'error' }));
  services.push(service);
  const value = raw();
  const session = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: value,
    configurationId: 'US__rack0', reduced: reduceConfiguration(value, 'US__rack0'), primed: true });
  const workspace = service.sessions.getWorkspace(session.workspaceId)!;
  workspace.rackArea = [{ id: session.configurationId, code: 'RACKCTO', type: 'rack', size: 42, rackItems: [] }];
  return { service, session, workspace, ctx: service.newCtx({ solution }) };
}

function state(service: DcscService) {
  const result = structuredClone(service.sessions.listWorkspaces());
  for (const workspace of result) {
    workspace.lastAccessAt = 0;
    for (const session of workspace.configurations.values()) session.lastAccessAt = 0;
  }
  return result;
}

describe('service transaction boundaries', () => {
  it('does not publish a new launch when persistence fails', async () => {
    const { service, ctx } = setup();
    const before = state(service);
    const send = vi.spyOn(service.http, 'send').mockImplementation(async (request) => ({
      raw: request.path.endsWith('/launch') ? raw() : { configurations: [raw()] },
    }) as never);
    const cause = new Error('disk full');
    const persist = vi.fn(() => { throw cause; });
    service.sessions.setPersistenceWriter(persist);
    const failure = await service.launch({ productCode: 'RACKCTO', mode: 'cto', solution, ctx })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionPersistenceError);
    expect(failure).toMatchObject({
      code: 'DCSC_LOCAL_NOT_COMMITTED',
      localNotCommitted: true,
      remoteApplied: true,
      cause,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(state(service)).toEqual(before);
  });

  it('rolls back the entire PDU edit when DCSC ignores a requested selection', async () => {
    const { service, workspace, session, ctx } = setup();
    const before = state(service);
    vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [raw()] } } as never);
    await expect(service.configurePdu(workspace.id, session.configurationId, { pduCode: 'PDU1', quantity: 2, ctx }))
      .rejects.toThrow('did not accept');
    expect(state(service)).toEqual(before);
  });

  it('persists the accepted PDU tree and power selection in one write', async () => {
    const { service, workspace, session, ctx } = setup();
    vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [raw(2)] } } as never);
    const write = vi.fn();
    service.sessions.setPersistenceWriter(write);
    await service.configurePdu(workspace.id, session.configurationId, { pduCode: 'PDU1', quantity: 2, ctx });
    expect(write).toHaveBeenCalledTimes(1);
    expect(session.index.selected.get('PDU1')).toBe(2);
    expect(workspace.powerSelections).toEqual([{ rackId: session.configurationId, pduCode: 'PDU1' }]);
  });

  it('rolls back a PDU removal when the server retains the selected line', async () => {
    const { service, workspace, session, ctx } = setup();
    vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [raw(2)] } } as never);
    await service.configurePdu(workspace.id, session.configurationId, { pduCode: 'PDU1', quantity: 2, ctx });
    const before = state(service);
    await expect(service.configurePdu(workspace.id, session.configurationId, { pduCode: 'PDU1', quantity: 0, ctx }))
      .rejects.toThrow('did not accept');
    expect(state(service)).toEqual(before);
  });

  it('keeps cables and layout intact when auto-connect persistence fails', async () => {
    const { service, workspace, ctx } = setup();
    workspace.serverState.connections = [{ sourceId: 'manual-source', destinationId: 'manual-target' }];
    const before = state(service);
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: {
      rackArea: [], nonRackArea: [], connections: [], errors: [],
    } } as never);
    const cause = new Error('disk unavailable');
    const persist = vi.fn(() => { throw cause; });
    service.sessions.setPersistenceWriter(persist);
    const failure = await service.runAutoConnect(workspace.id, ctx).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionPersistenceError);
    expect(failure).toMatchObject({
      code: 'DCSC_LOCAL_NOT_COMMITTED',
      localNotCommitted: true,
      remoteApplied: true,
      cause,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].body).toMatchObject({ kind: 'json' });
    expect((send.mock.calls[0]![0].body as { kind: 'json'; value: Record<string, unknown> }).value)
      .not.toHaveProperty('connections');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(state(service)).toEqual(before);
  });

  it('passes physical and preference state but omits prior graph rows from auto-connect', async () => {
    const { service, workspace, ctx } = setup();
    workspace.nonRackArea = [{ id: 'US__loose0', code: 'NODE', type: 'server' }];
    workspace.serverState.clusterPreference = [{ name: 'Management', mainSwitch: { option: 'SW' } }];
    workspace.serverState.connections = [{ sourceId: 'old-source', destinationId: 'old-target' }];
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { connections: [], errors: [] } } as never);
    await service.runAutoConnect(workspace.id, ctx);
    const request = send.mock.calls[0]![0];
    expect(request.body).toMatchObject({ kind: 'json', value: {
      nonRackArea: workspace.nonRackArea,
      clusterPreference: workspace.serverState.clusterPreference,
    } });
    expect((request.body as { kind: 'json'; value: Record<string, unknown> }).value)
      .not.toHaveProperty('connections');
  });

  it('commits partial auto-connect settings with the graph and reuses them on subsequent layout edits', async () => {
    const { service, workspace, ctx } = setup();
    workspace.serverState.networkingInformation = { autoConnectSettings: {
      autoAddPDU: true, autoAddSwitch: true, p2pCabling: true, futureSetting: 'kept',
    } };
    const write = vi.fn();
    service.sessions.setPersistenceWriter(write);
    const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
      if (request.path.endsWith('/autoDerive')) return { raw: { configurations: [] } } as never;
      const body = request.body?.kind === 'json' ? request.body.value as Record<string, unknown> : {};
      return { raw: { rackArea: body.rackArea, nonRackArea: body.nonRackArea, connections: [], errors: [] } } as never;
    });
    const revision = workspace.revision;
    const expected = { autoAddPDU: false, autoAddSwitch: true, p2pCabling: true, futureSetting: 'kept' };
    const result = await service.runAutoConnect(workspace.id, ctx, revision, { autoAddPDU: false });
    expect(result.settings).toEqual(expected);
    expect(workspace.serverState.autoConnectSettings).toEqual(expected);
    expect(workspace.serverState.networkingInformation).toEqual({ autoConnectSettings: expected });
    expect(write).toHaveBeenCalledTimes(1);
    await service.editLayout(workspace.id, { action: 'arrange', ctx });
    for (const [request] of send.mock.calls.filter(([request]) => !request.path.endsWith('/autoDerive'))) {
      expect(request.body).toMatchObject({ kind: 'json', value: { autoConnectSettings: expected } });
    }
    await service.sessions.undoWorkspace(workspace.id);
    await service.sessions.undoWorkspace(workspace.id);
    expect(workspace.serverState.autoConnectSettings).toBeUndefined();
    expect(workspace.serverState.networkingInformation).toMatchObject({ autoConnectSettings: { autoAddPDU: true } });
  });

  it('rejects invalid auto-connect settings before HTTP and rolls valid settings back on a rejected graph', async () => {
    const { service, workspace, ctx } = setup();
    const before = state(service);
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: {
      errors: [{ code: 'INVALID', message: 'No compatible switch' }], connections: [],
    } } as never);
    await expect(service.runAutoConnect(workspace.id, ctx, undefined, { autoAddPDU: 'false' as never }))
      .rejects.toThrow('Invalid auto-connect setting');
    expect(send).not.toHaveBeenCalled();
    await expect(service.runAutoConnect(workspace.id, ctx, undefined, { autoAddPDU: false }))
      .rejects.toThrow('DCSC rejected auto-connect');
    expect(send).toHaveBeenCalledTimes(1);
    expect(state(service)).toEqual(before);
  });

  it('does not leave a newly launched rack behind if layout validation fails', async () => {
    const { service, workspace, ctx } = setup();
    const before = state(service);
    vi.spyOn(service.http, 'send').mockImplementation(async (request) => {
      if (request.path.endsWith('/launch')) return { raw: raw() } as never;
      if (request.path.endsWith('/autoDerive')) return { raw: { configurations: [raw()] } } as never;
      if (request.path.endsWith('/non_rack')) return { raw: [{ code: 'RACKCTO', type: 'rack', size: 42 }] } as never;
      throw new Error('layout rejected');
    });
    await expect(service.addRack(workspace.id, 'RACKCTO', ctx)).rejects.toThrow('layout rejected');
    expect(state(service)).toEqual(before);
  });

  it('rejects a foreign configuration before fetching physical data', async () => {
    const { service, workspace, ctx } = setup();
    const send = vi.spyOn(service.http, 'send');
    await expect(service.placeInRack(workspace.id, { rackId: 'US__rack0', sessionId: 'foreign', ctx }))
      .rejects.toThrow('does not belong');
    expect(send).not.toHaveBeenCalled();
  });

  it('merges a partial workspace derive and moves one physical instance through undo/redo', async () => {
    const { service, workspace, ctx } = setup();
    const nodeRaw = { ...raw(), code: 'NODECTO', sliceCtoCode: 'NODECTO', type: 'server' };
    const node = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: nodeRaw,
      configurationId: 'US__node0', reduced: reduceConfiguration(nodeRaw, 'US__node0'),
      primed: true, workspaceId: workspace.id });
    const paths: string[] = [];
    vi.spyOn(service.http, 'send').mockImplementation(async (request) => {
      paths.push(request.path);
      if (request.path.endsWith('/non_rack')) return { raw: [{ code: 'NODECTO', type: 'server', size: 1 }] } as never;
      if (request.path.endsWith('/autoDerive')) {
        // The live endpoint legitimately omits configurations that did not change.
        return { raw: { configurations: [{ ...nodeRaw, id: node.configurationId, totalPrice: 120 }] } } as never;
      }
      const value = request.body?.kind === 'json' ? request.body.value as Record<string, unknown> : {};
      expect(value.configurations).toHaveLength(2);
      return { raw: { rackArea: value.rackArea, nonRackArea: value.nonRackArea, connections: [] } } as never;
    });
    await service.placeInRack(workspace.id, { rackId: 'US__rack0', sessionId: node.id, position: 3, ctx });
    expect(paths).toEqual(['/ctos/racks/customize/non_rack', '/ctos/racks/customize', '/ctos/autoDerive', '/ctos/racks/customize']);
    expect(workspace.configurations.size).toBe(2);
    expect(node.raw.totalPrice).toBe(120);
    expect(workspace.rackSummaries[0]?.items[0]?.position).toBe(3);
    await service.editLayout(workspace.id, { action: 'unplace', configurationId: node.id, ctx });
    expect(workspace.rackSummaries[0]?.items).toHaveLength(0);
    expect(workspace.nonRackArea[0]?.id).toBe(node.configurationId);
    expect(await service.sessions.undoWorkspace(workspace.id)).toBe(true);
    expect(workspace.rackSummaries[0]?.items[0]?.position).toBe(3);
    expect(workspace.nonRackArea).toHaveLength(0);
    expect(await service.sessions.redoWorkspace(workspace.id)).toBe(true);
    expect(workspace.nonRackArea[0]?.id).toBe(node.configurationId);
  });

  it('rolls back when DCSC corrects a rejected rack placement into the loose area', async () => {
    const { service, workspace, ctx } = setup();
    const nodeRaw = { ...raw(), code: 'NODECTO', sliceCtoCode: 'NODECTO', type: 'server' };
    const node = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: nodeRaw,
      configurationId: 'US__node0', reduced: reduceConfiguration(nodeRaw, 'US__node0'),
      primed: true, workspaceId: workspace.id });
    const before = state(service);
    const beforeRevision = workspace.revision;
    const paths: string[] = [];
    let customizations = 0;
    vi.spyOn(service.http, 'send').mockImplementation(async request => {
      paths.push(request.path);
      if (request.path.endsWith('/non_rack')) {
        return { raw: [{ code: 'NODECTO', type: 'server', size: 8 }] } as never;
      }
      if (request.path.endsWith('/autoDerive')) {
        return { raw: { configurations: [{ ...nodeRaw, id: node.configurationId }] } } as never;
      }
      customizations += 1;
      return { raw: {
        rackArea: [{ ...workspace.rackArea[0], rackItems: [],
          errors: customizations === 1 ? [{ code: '100',
            message: 'This server [NODECTO] can not be placed lower than <3> and higher than <35> inside this Rack.' }] : [] }],
        nonRackArea: [{ id: node.configurationId, code: 'NODECTO', type: 'server',
          position: 1, size: 8, errors: [] }],
        connections: [],
      } } as never;
    });

    await expect(service.placeInRack(workspace.id, {
      rackId: 'US__rack0', sessionId: node.id, position: 1, ctx,
    })).rejects.toThrow('DCSC did not accept the requested rack placement. Workspace was not changed.');
    expect(paths).toEqual(['/ctos/racks/customize/non_rack', '/ctos/racks/customize',
      '/ctos/autoDerive', '/ctos/racks/customize']);
    expect(customizations).toBe(2);
    expect(workspace.revision).toBe(beforeRevision);
    expect(state(service)).toEqual(before);
  });

  it('rejects a multi-U placement crossing reserved space without changing the workspace', async () => {
    const { service, workspace, ctx } = setup();
    workspace.rackArea[0]!.lockedSpace = [42];
    const nodeRaw = { ...raw(), code: 'NODECTO', sliceCtoCode: 'NODECTO', type: 'server' };
    const node = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: nodeRaw,
      configurationId: 'US__node0', reduced: reduceConfiguration(nodeRaw, 'US__node0'),
      primed: true, workspaceId: workspace.id });
    const before = state(service);
    const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
      expect(request.path).toBe('/ctos/racks/customize/non_rack');
      return { raw: [{ code: 'NODECTO', type: 'server', size: 2 }] } as never;
    });
    await expect(service.placeInRack(workspace.id, { rackId: 'US__rack0', sessionId: node.id, position: 41, ctx }))
      .rejects.toThrow('locked rack space');
    expect(send).toHaveBeenCalledTimes(1);
    expect(state(service)).toEqual(before);
  });

  it('rolls back layout and configuration patches if final customization fails', async () => {
    const { service, workspace, ctx } = setup();
    const before = state(service);
    let customizations = 0;
    vi.spyOn(service.http, 'send').mockImplementation(async (request) => {
      if (request.path.endsWith('/autoDerive')) return { raw: { configurations: [{ ...raw(), id: 'US__rack0', totalPrice: 999 }] } } as never;
      if (++customizations === 2) throw new Error('final customize failed');
      return { raw: { rackArea: workspace.rackArea, nonRackArea: [], connections: [] } } as never;
    });
    await expect(service.editLayout(workspace.id, { action: 'arrange', ctx })).rejects.toThrow('final customize failed');
    expect(state(service)).toEqual(before);
  });

  it('replaces cable summaries with the final layout connection graph', async () => {
    const { service, workspace, ctx } = setup();
    for (const id of ['node-a', 'node-b']) {
      const node = { ...raw(), id, code: 'NODE', sliceCtoCode: 'NODE' };
      service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: node,
        configurationId: id, reduced: reduceConfiguration(node, id), primed: true, workspaceId: workspace.id });
    }
    workspace.cables = [{ id: 'obsolete', fromConfigId: 'node-a', fromPort: 'old',
      toConfigId: 'node-b', toPort: 'old' }];
    const connections = [{ id: 'current', sourceId: 'node-a', sourcePortName: 'RJ45', sourcePortNumber: '1',
      destinationId: 'node-b', destinationPortName: 'RJ45', destinationPortNumber: '8', cablePart: 'CAT5', cableType: 'Cat5E' }];
    vi.spyOn(service.http, 'send').mockImplementation(async request => {
      if (request.path.endsWith('/autoDerive')) return { raw: { configurations: [] } } as never;
      return { raw: { rackArea: workspace.rackArea, nonRackArea: [], connections } } as never;
    });
    await service.editLayout(workspace.id, { action: 'arrange', ctx });
    expect(workspace.serverState.connections).toEqual(connections);
    expect(workspace.cables).toEqual([{ id: 'current', fromConfigId: 'node-a', fromPort: 'RJ45 - 1',
      toConfigId: 'node-b', toPort: 'RJ45 - 8', cableCode: 'CAT5', description: 'Cat5E' }]);
    await service.sessions.undoWorkspace(workspace.id);
    expect(workspace.cables[0]?.id).toBe('obsolete');
  });

  it('persists authoritative validation without changing the validated revision', async () => {
    const { service, workspace, ctx } = setup();
    const revision = workspace.revision;
    const write = vi.fn();
    service.sessions.setPersistenceWriter(write);
    vi.spyOn(service.http, 'send').mockImplementation(async (request) => ({ raw:
      request.path === '/lmc_validation' ? [{ uuid: 'job', buildEntityNumber: 'build' }] : ['finish'],
    }) as never);
    const report = await service.validate(workspace.id, ctx);
    expect(report).toMatchObject({ isValid: true, status: 'valid', stale: false, validatedRevision: revision });
    expect(workspace.revision).toBe(revision);
    expect(write).toHaveBeenCalledTimes(3);
    expect(workspace.serverState.validationJobs).toEqual([expect.objectContaining({ status: 'valid', payloadSha256: report.payloadSha256 })]);
  });

  it('does not retrieve a validation result before its descriptor is durable', async () => {
    const { service, workspace, ctx } = setup();
    const cause = new Error('descriptor write failed');
    const persist = vi.fn(() => { throw cause; });
    service.sessions.setPersistenceWriter(persist);
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: [{ uuid: 'job' }] } as never);
    const failure = await service.validate(workspace.id, ctx).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionPersistenceError);
    expect(failure).toMatchObject({
      code: 'DCSC_LOCAL_NOT_COMMITTED',
      localNotCommitted: true,
      remoteApplied: true,
      cause,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(workspace.serverState.validationJobs).toBeUndefined();
  });

  it('marks a concurrent edit stale and keeps local diagnostics tied to the validated snapshot', async () => {
    const { service, workspace, session, ctx } = setup();
    vi.spyOn(service.http, 'send').mockImplementation(async (request) => {
      if (request.path === '/lmc_validation') return { raw: [{ uuid: 'job' }] } as never;
      await service.sessions.transact(session.id, {}, (_draft, target) => {
        target!.raw.expansionMessages = [{ type: 'error', text: 'Error introduced after validation started' }];
      });
      return { raw: ['finish'] } as never;
    });
    const report = await service.validate(workspace.id, ctx);
    expect(report).toMatchObject({ isValid: false, status: 'unavailable', stale: true,
      freshValidationRequired: true, localErrorCount: 0 });
    expect(session.raw.expansionMessages).toHaveLength(1);
  });
});
