import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';
import type { RawConfiguration } from '../src/model/types.js';

type Reply = { isError?: boolean; content: Array<{ text?: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;
const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); });

function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
  const raw: RawConfiguration = { code: 'NODE', sliceCtoCode: 'NODE', quantity: 1, totalPrice: 100, tabs: [] };
  const session = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw,
    configurationId: 'US__node', reduced: reduceConfiguration(raw, 'US__node'), primed: true });
  const workspace = service.sessions.getWorkspace(session.workspaceId)!;
  workspace.rackArea = [{ id: session.configurationId, code: 'NODE', type: 'rack', size: 42, rackItems: [] }];
  const handlers = new Map<string, Handler>();
  const schemas = new Map<string, Record<string, unknown>>();
  registerTools({ registerTool(name: string, config: { inputSchema: Record<string, unknown> }, handler: Handler) {
    handlers.set(name, handler); schemas.set(name, config.inputSchema);
  } } as unknown as McpServer, service);
  vi.spyOn(service, 'fabricOptions').mockResolvedValue({ nodeRoles: [{ role: 'Compute' }, { role: 'Storage' }] } as never);
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => ({
    raw: request.path.endsWith('/non_rack') ? [{ code: 'NODE', type: 'rack', size: 42 }]
      : request.path.endsWith('/launch') ? raw : { configurations: [raw] },
  }) as never);
  return { service, session, workspace, handlers, schemas, send };
}

function json(reply: Reply): Record<string, unknown> {
  return JSON.parse(reply.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('mutating tool revision contracts', () => {
  it.each(['standaloneSoftwareState', 'standaloneServiceState'])('lists, inspects and durably closes %s without hardware', async key => {
    const { service, handlers } = setup();
    const created = await service.sessions.createManyAtomic([], {
      newWorkspaceId: 'standalone', workspaceContext: { locale: service.locale,
        solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] } },
      workspaceState: { serverState: { [key]: { selections: [] } } },
    });
    const write = vi.fn();
    service.sessions.setPersistenceWriter(write);
    const list = json(await handlers.get('dcsc_session_list')!({ session: 'standalone', limit: 15, offset: 0 }));
    expect(list.total).toBe(1);
    const info = json(await handlers.get('dcsc_workspace_get')!({ session: 'standalone' }));
    expect(info.revision).toBe(created.workspace.revision);
    expect(info.next).toHaveProperty('tool', 'dcsc_workspace_get');
    const closed = await handlers.get('dcsc_session_close')!({ session: 'standalone', expectedRevision: 1 });
    expect(json(closed).closed).toBe(true);
    expect(service.sessions.getWorkspace('standalone')).toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0].some((workspace: { id: string }) => workspace.id === 'standalone')).toBe(false);
  });

  it('keeps a standalone basket when its last hardware configuration is closed', async () => {
    const { service, session, workspace, handlers } = setup();
    workspace.rackArea = [];
    workspace.serverState.standaloneSoftwareState = { selections: [{ code: 'SW', quantity: 4 }] };
    const write = vi.fn();
    service.sessions.setPersistenceWriter(write);
    const result = await handlers.get('dcsc_session_close')!({ session: session.id, expectedRevision: 1 });
    expect(json(result).closed).toBe(true);
    expect(service.sessions.get(session.id)).toBeUndefined();
    expect(service.sessions.getWorkspace(workspace.id)?.serverState.standaloneSoftwareState).toEqual({ selections: [{ code: 'SW', quantity: 4 }] });
    expect(write.mock.calls[0]![0]).toHaveLength(1);
  });

  it('rejects an ambiguous workspace clone instead of duplicating its first product', async () => {
    const { service, session, workspace } = setup();
    await service.cloneConfiguration({ sessionHandle: session.id, count: 1 });
    await expect(service.cloneConfiguration({ sessionHandle: workspace.id, count: 1 })).rejects.toThrow('one configuration target');
    expect(workspace.configurations.size).toBe(2);
  });

  it('drains an asynchronous durable write before service shutdown completes', async () => {
    const { service, session } = setup();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    service.sessions.setPersistenceWriter(async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
    });
    const mutation = service.setQuantity(session, 4);
    await entered;
    let closed = false;
    const shutdown = service.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    await Promise.all([mutation, shutdown]);
    expect(closed).toBe(true);
    expect(session.raw.quantity).toBe(4);
  });

  it.each([
    ['dcsc_configure', { salesQuantity: 2 }],
    ['dcsc_undo', { scope: 'configuration' }],
    ['dcsc_session_close', {}],
    ['dcsc_rack_add', { rackCode: 'NODE' }],
    ['dcsc_rack_edit', { action: 'place', rackId: 'US__node', configuration: 'missing' }],
    ['dcsc_auto_connect', {}],
    ['dcsc_cabling_set', { changes: [{ action: 'edit', connectionId: 'connection_00000000000000000000', cablePart: 'X' }] }],
    ['dcsc_floor_set', { change: { kind: 'place', rackId: 'US__node', x: 0, y: 0 } }],
    ['dcsc_rack_edit', { action: 'clone', count: 1 }],
    ['dcsc_pdu_set', { rackId: 'US__node', pduCode: 'PDU', quantity: 1 }],
    ['dcsc_network_set', { change: { kind: 'nodeRole', role: 'Compute' } }],
  ])('%s rejects stale revisions before changing state', async (name, args) => {
    const { service, session, workspace, handlers, schemas, send } = setup();
    expect(schemas.get(name)).toHaveProperty('expectedRevision');
    const before = JSON.stringify({ raw: session.raw, rack: workspace.rackArea, revision: workspace.revision });
    const result = await handlers.get(name)!({ session: session.id, ...args, expectedRevision: 999 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(json(result))).toMatch(/revision conflict/i);
    expect(JSON.stringify({ raw: session.raw, rack: workspace.rackArea, revision: workspace.revision })).toBe(before);
    expect(service.sessions.list()).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['dcsc_configure', { salesQuantity: 2 }, { salesQuantity: 3 }],
    ['dcsc_rack_edit', { action: 'clone', count: 1 }, { action: 'clone', count: 2 }],
    ['dcsc_network_set', { change: { kind: 'nodeRole', role: 'Compute' } }, { change: { kind: 'nodeRole', role: 'Storage' } }],
    ['dcsc_floor_set', { change: { kind: 'place', rackId: 'US__node', x: 0, y: 0 } }, { change: { kind: 'place', rackId: 'US__node', x: 1, y: 0 } }],
  ])('%s commits exactly once for concurrent calls at the same revision', async (name, first, second) => {
    const { session, workspace, handlers } = setup();
    const handler = handlers.get(name)!;
    const results = await Promise.all([first, second].map(args => handler({ session: session.id, ...args, expectedRevision: 1 })));
    expect(results.filter(result => !result.isError)).toHaveLength(1);
    expect(JSON.stringify(json(results.find(result => result.isError)!))).toMatch(/revision conflict/i);
    expect(workspace.revision).toBe(2);
  });

  it('compares workspace revision for layout even when given a configuration handle', async () => {
    const { service, session, workspace, handlers, send } = setup();
    await service.sessions.transact(workspace.id, {}, draft => { draft.label = 'workspace-only change'; });
    expect(session.revision).toBe(1);
    expect(workspace.revision).toBe(2);
    const result = await handlers.get('dcsc_rack_edit')!({ session: session.id, action: 'place',
      rackId: 'US__node', configuration: session.id, expectedRevision: 1 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(json(result))).toMatch(/workspace/);
    expect(send).not.toHaveBeenCalled();
  });

  it('compares the workspace revision for configuration edits given a configuration handle', async () => {
    const { service, session, workspace, handlers } = setup();
    await service.sessions.transact(workspace.id, {}, draft => { draft.label = 'workspace-only change'; });
    const stale = await handlers.get('dcsc_configure')!({ session: session.id, salesQuantity: 2, expectedRevision: 1 });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(json(stale))).toMatch(/revision conflict/i);
    const result = await handlers.get('dcsc_configure')!({ session: session.id, salesQuantity: 2, expectedRevision: 2 });
    expect(result.isError).not.toBe(true);
    expect(session.raw.quantity).toBe(2);
    expect(json(result).revision).toBe(3);
    expect(workspace.revision).toBe(3);
  });
});
