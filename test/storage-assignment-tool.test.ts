import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { registerStorageTools } from '../src/mcp/storageTools.js';
import { DcscService } from '../src/mcp/service.js';
import { SessionPersistenceError } from '../src/session/persistenceError.js';

type Reply = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;
const services: DcscService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

function setup() {
  const service = new DcscService(ConfigSchema.parse({
    files: { persistSessions: false },
    logLevel: 'silent',
  }));
  services.push(service);
  const raw = {
    id: 'server-id', code: '7D73CTOHWW', sliceCtoCode: '7D73CTOHWW', type: 'server',
    quantity: 1, selectedStorageNetwork: null, connectors: [{ sourceFeature: 'ATZV' }],
    tabs: [{ title: 'Base', subTabs: [{ title: 'Base', sections: [] }] }],
  };
  const session = service.sessions.create({
    locale: service.locale,
    solution: { solutionMode: 'HPC and AI - Systems', masterSlices: ['HPCGP'] },
    mode: 'cto',
    raw,
    configurationId: raw.id,
    reduced: reduceConfiguration(raw, raw.id, 'cto', 'HPC and AI - Systems'),
    primed: true,
  });
  const workspace = service.sessions.getWorkspace(session.id)!;
  workspace.serverState.storageConnectionNetworks = [{
    name: 'Primary SAN', maximumExpansions: 0, type: 'General Storage', layout: 'Fully Redundant',
    controller: { option: '7DJ0CTO1WW', featureCode: '', id: 'controller-id', hardwareType: 'storage' },
    expansion: {}, mainSwitch: { hardwareType: 'switch' },
  }];
  const handlers = new Map<string, Handler>();
  registerStorageTools({
    registerTool(name: string, _definition: unknown, callback: Handler) {
      handlers.set(name, callback);
      return { remove() {}, update() {} };
    },
  } as unknown as McpServer, service);
  return { service, session, workspace, handlers };
}

describe('dcsc_assign_storage_network', () => {
  it('preserves a prior graph for inspection but prevents stale workspace handoff until successful recabling', async () => {
    const { service, session, workspace } = setup();
    const graph = [{ sourceId: session.configurationId, destinationId: 'controller-id',
      sourcePortName: 'SAS', destinationPortName: 'SAS', cablePart: 'STORAGE-CABLE', network: 'Storage' }];
    workspace.nonRackArea = [{ id: session.configurationId, code: session.product.code, type: 'server' }];
    workspace.serverState.connections = structuredClone(graph);
    const send = vi.spyOn(service.http, 'send').mockResolvedValueOnce({ raw: {
      configurations: [{ ...session.raw, selectedStorageNetwork: 'Primary SAN' }],
    } } as never);
    const result = await service.assignStorageNetwork(session.id, { networkName: 'Primary SAN', ctx: service.newCtx() });
    expect(result.connectionGraphStale).toBe(true);
    expect(workspace.serverState.connections).toEqual(graph);
    const exportWorkspace = () => buildExportData({ workspace, solution: workspace.solution,
      fileTypes: ['XML'], validationMode: 'guided' });
    expect(exportWorkspace).toThrow(/dcsc_add_cabling.*mode="auto"/);
    // A single configuration export does not include the stale workspace graph.
    expect(() => buildExportData({ raw: session.raw, config: session.reduced,
      solution: workspace.solution, fileTypes: ['XML'], validationMode: 'guided' })).not.toThrow();
    await service.sessions.undoWorkspace(workspace.id);
    expect(exportWorkspace).not.toThrow();
    await service.sessions.redoWorkspace(workspace.id);
    expect(exportWorkspace).toThrow(/saved connection graph/);
    send.mockResolvedValueOnce({ raw: { rackArea: [], nonRackArea: workspace.nonRackArea } } as never);
    const revision = workspace.revision;
    await expect(service.runAutoConnect(workspace.id, service.newCtx())).rejects.toThrow(/incomplete connection graph/);
    expect(workspace.revision).toBe(revision);
    expect(exportWorkspace).toThrow(/saved connection graph/);
    send.mockResolvedValueOnce({ raw: { rackArea: [], nonRackArea: workspace.nonRackArea, connections: [], errors: [] } } as never);
    await service.runAutoConnect(workspace.id, service.newCtx());
    expect(workspace.serverState.connections).toEqual([]);
    expect(workspace.serverState.connectionGraphInvalidation).toBeUndefined();
    expect(exportWorkspace).not.toThrow();
  });

  it('registers the browser assignment derive and returns an explicit cabling continuation', async () => {
    const { service, session, workspace, handlers } = setup();
    const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
      const body = request.body && request.body.kind === 'json'
        ? request.body.value as Record<string, unknown>
        : {};
      const configurations = body['configurations'] as Array<Record<string, unknown>>;
      expect(request).toMatchObject({
        path: '/ctos/autoDerive',
        query: { configurationId: session.configurationId, guideMode: true },
      });
      expect(body['customizingIds']).toEqual([session.configurationId]);
      expect(configurations).toHaveLength(1);
      expect(configurations[0]).toMatchObject({
        id: session.configurationId,
        selectedStorageNetwork: 'Primary SAN',
      });
      return { raw: {
        configurations: [{ ...session.raw, selectedStorageNetwork: 'Primary SAN' }],
        autoDerivedResults: [{ id: 'assignment-result' }],
      } } as never;
    });

    const reply = await handlers.get('dcsc_assign_storage_network')!({
      session: session.id,
      networkName: 'Primary SAN',
      expectedRevision: session.revision,
    });
    expect(reply.isError).not.toBe(true);
    const result = JSON.parse(reply.content[0]!.text);
    expect(result).toMatchObject({
      workspace: workspace.id,
      session: session.id,
      configurationId: session.configurationId,
      selectedStorageNetwork: 'Primary SAN',
      autoConnectRequired: true,
      inspect: { tool: 'dcsc_session_info', arguments: { session: session.id } },
      next: { tool: 'dcsc_add_cabling', arguments: { session: workspace.id, mode: 'auto' } },
    });
    expect(result).not.toHaveProperty('connectionCount');
    expect(result.reason).toMatch(/cables were not regenerated/i);
    expect(session.raw.selectedStorageNetwork).toBe('Primary SAN');
    expect(workspace.serverState.storageAssignmentState).toMatchObject({
      autoDerivedResults: [{ id: 'assignment-result' }],
    });
    expect(workspace.serverState.historyInformation).toEqual([
      expect.objectContaining({ command: 'UPDATE' }),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not append UPDATE when the accepted storage assignment is unchanged', async () => {
    const { service, session, workspace } = setup();
    vi.spyOn(service.http, 'send').mockResolvedValue({ raw: {
      configurations: [{ ...session.raw, selectedStorageNetwork: '' }],
    } } as never);

    await service.assignStorageNetwork(session.id, { networkName: null, ctx: service.newCtx() });

    expect(workspace.serverState.historyInformation).toBeUndefined();
  });

  it('rejects an unknown storage name before making a remote request', async () => {
    const { service, session, handlers } = setup();
    const send = vi.spyOn(service.http, 'send');
    const reply = await handlers.get('dcsc_assign_storage_network')!({
      session: session.id,
      networkName: 'Missing SAN',
    });
    expect(reply.isError).toBe(true);
    expect(reply.content[0]!.text).toMatch(/Unknown storage network.*Primary SAN/i);
    expect(send).not.toHaveBeenCalled();
    expect(session.raw.selectedStorageNetwork).toBeNull();
  });

  it('rejects a workspace handle even when that workspace has only one configuration', async () => {
    const { service, workspace, handlers } = setup();
    const send = vi.spyOn(service.http, 'send');
    const reply = await handlers.get('dcsc_assign_storage_network')!({
      session: workspace.id,
      networkName: 'Primary SAN',
    });
    expect(reply.isError).toBe(true);
    expect(reply.content[0]!.text).toMatch(/configuration handle/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('publishes nothing when the assignment transport fails', async () => {
    const { service, session, workspace } = setup();
    const before = structuredClone({
      raw: session.raw,
      serverState: workspace.serverState,
      workspaceRevision: workspace.revision,
      configurationRevision: session.revision,
    });
    vi.spyOn(service.http, 'send').mockRejectedValue(new Error('connection reset'));

    await expect(service.assignStorageNetwork(session.id, {
      networkName: 'Primary SAN',
      ctx: service.newCtx(),
    })).rejects.toThrow(/connection reset/i);
    expect({
      raw: session.raw,
      serverState: workspace.serverState,
      workspaceRevision: workspace.revision,
      configurationRevision: session.revision,
    }).toEqual(before);
    expect(workspace.serverState.historyInformation).toBeUndefined();
  });

  it('rolls back a remotely accepted assignment when persistence fails', async () => {
    const { service, session, workspace } = setup();
    const before = structuredClone({
      raw: session.raw,
      serverState: workspace.serverState,
      workspaceRevision: workspace.revision,
      configurationRevision: session.revision,
    });
    vi.spyOn(service.http, 'send').mockResolvedValue({ raw: {
      configurations: [{ ...session.raw, selectedStorageNetwork: 'Primary SAN' }],
      autoDerivedResults: [{ id: 'accepted-remotely' }],
    } } as never);
    service.sessions.setPersistenceWriter(() => { throw new Error('disk full'); });

    const failure = await service.assignStorageNetwork(session.id, {
      networkName: 'Primary SAN',
      ctx: service.newCtx(),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionPersistenceError);
    expect(failure).toMatchObject({ remoteApplied: true, localNotCommitted: true });
    expect({
      raw: session.raw,
      serverState: workspace.serverState,
      workspaceRevision: workspace.revision,
      configurationRevision: session.revision,
    }).toEqual(before);
  });
});
