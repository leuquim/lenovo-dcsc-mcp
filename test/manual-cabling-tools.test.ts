import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

import { registerManualCablingTools, type ManualCablingService } from '../src/mcp/manualCablingTools.js';
import type { RequestCtx } from '../src/http/request.js';

type Obj = Record<string, unknown>;
type Reply = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: Obj) => Promise<Reply>;

function setup() {
  const connection = { id: 'connection_0123456789abcdef0123', network: 'Management', topology: '1GbE_Copper',
    type: 'AUTO', source: { configurationId: 'server-1', portName: 'RJ45 mgmt', portNumber: '1' },
    destination: { configurationId: 'switch-1', portName: 'RJ45', portNumber: '2' },
    cable: { part: 'AVFT' }, compatibleCables: Array.from({ length: 20 }, (_, index) => ({
      part: `C${index}`, description: `Compatible cable ${index} ${'x'.repeat(1_200)}`,
    })) };
  const inspectManualCabling = vi.fn().mockReturnValue({ workspace: 'workspace-1', revision: 7,
    report: { connections: [connection], ports: [
      { configurationId: 'server-1', name: 'RJ45 mgmt', number: '1', topologies: ['1GbE_Copper'] },
      { configurationId: 'switch-1', name: 'RJ45', number: '2', topologies: ['1GbE_Copper'] },
    ] } });
  const editManualCabling = vi.fn().mockResolvedValue({ workspace: 'workspace-1', revision: 8,
    connection: { ...connection, type: 'MANUAL' } });
  const service: ManualCablingService = { newCtx: () => ({}) as RequestCtx,
    inspectManualCabling, editManualCabling };
  const handlers = new Map<string, Handler>();
  registerManualCablingTools({ registerTool(name: string, _definition: unknown, callback: Handler) {
    handlers.set(name, callback); return { remove() {}, update() {} };
  } } as unknown as McpServer, service);
  return { handlers, inspectManualCabling, editManualCabling, connection };
}

function json(reply: Reply): Obj {
  return JSON.parse(reply.content[0]!.text) as Obj;
}

describe('manual cabling MCP tools', () => {
  it('pages inspection losslessly with a revision-bound executable continuation', async () => {
    const value = setup();
    const root = await value.handlers.get('dcsc_cabling_connections')!({ session: 'workspace-1', path: [], offset: 0, limit: 20 });
    expect(root.isError).not.toBe(true);
    const report = json(root);
    expect(report).toMatchObject({ workspace: 'workspace-1', workspaceRevision: 7,
      revisionScope: 'workspace', path: [], total: 2 });
    const connectionEntry = (report['items'] as Obj[]).find(item => item['key'] === 'connections')!;
    expect(connectionEntry).toMatchObject({ key: 'connections', type: 'array',
      next: { tool: 'dcsc_cabling_connections', arguments: {
        session: 'workspace-1', expectedWorkspaceRevision: 7, path: ['connections'], offset: 0, limit: 20,
      } } });
    const next = (connectionEntry['next'] as Obj)['arguments'] as Obj;
    const detail = await value.handlers.get('dcsc_cabling_connections')!(next);
    const detailJson = json(detail);
    const row = (detailJson['items'] as Obj[])[0]!;
    expect(row).toMatchObject({ key: '0', type: 'object', next: {
      tool: 'dcsc_cabling_connections', arguments: { path: ['connections', '0'] },
    } });
    const rowDetail = await value.handlers.get('dcsc_cabling_connections')!(
      ((row['next'] as Obj)['arguments'] as Obj));
    expect(JSON.stringify(json(rowDetail))).toContain(value.connection.id);
    expect(Buffer.byteLength(rowDetail.content[0]!.text)).toBeLessThan(8_000);
    expect(value.inspectManualCabling).toHaveBeenLastCalledWith('workspace-1', 7);
  });

  it('requires the inspected workspace revision and returns executable inspection args', async () => {
    const value = setup();
    const reply = await value.handlers.get('dcsc_edit_cabling_connection')!({
      session: 'workspace-1', connectionId: value.connection.id,
      destination: { configurationId: 'switch-1', portName: 'RJ45', portNumber: '2' },
      expectedRevision: 7,
    });
    expect(reply.isError).not.toBe(true);
    expect(value.editManualCabling).toHaveBeenCalledWith('workspace-1', expect.objectContaining({
      connectionId: value.connection.id, expectedRevision: 7,
      destination: { configurationId: 'switch-1', portName: 'RJ45', portNumber: '2' },
      ctx: expect.any(Object),
    }));
    expect(json(reply)).toMatchObject({ workspace: 'workspace-1', workspaceRevision: 8,
      revisionScope: 'workspace', connection: { id: value.connection.id, type: 'MANUAL' },
      inspect: { tool: 'dcsc_cabling_connections', arguments: {
        session: 'workspace-1', expectedWorkspaceRevision: 8, path: ['connections'], offset: 0, limit: 20,
      } } });
    expect(Buffer.byteLength(reply.content[0]!.text)).toBeLessThan(8_000);
    expect((json(reply)['connection'] as Obj)['compatibleCables']).toBeUndefined();

    await value.handlers.get('dcsc_edit_cabling_connection')!({
      session: 'workspace-1', connectionId: value.connection.id,
      cablePart: '3802', expectedRevision: 8,
    });
    expect(value.editManualCabling).toHaveBeenLastCalledWith('workspace-1', expect.objectContaining({
      connectionId: value.connection.id, cablePart: '3802', expectedRevision: 8,
      ctx: expect.any(Object),
    }));
  });

  it('rejects an empty edit before service I/O and reports service errors through the typed tool surface', async () => {
    const value = setup();
    const empty = await value.handlers.get('dcsc_edit_cabling_connection')!({
      session: 'workspace-1', connectionId: value.connection.id, expectedRevision: 7,
    });
    expect(empty.isError).toBe(true);
    expect(empty.content[0]!.text).toMatch(/source, destination or cable-part/);
    expect(value.editManualCabling).not.toHaveBeenCalled();

    value.inspectManualCabling.mockImplementationOnce(() => { throw new Error('workspace revision mismatch'); });
    const stale = await value.handlers.get('dcsc_cabling_connections')!({
      session: 'workspace-1', expectedWorkspaceRevision: 6, path: [], offset: 0, limit: 20,
    });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toMatch(/revision mismatch/);
  });

  it('exposes the other accepted row after an occupied-port swap without unbounded cable choices', async () => {
    const value = setup();
    const accepted = { workspace: 'workspace-1', revision: 8,
      connection: { ...value.connection, type: 'MANUAL' },
      swappedConnections: [{ ...value.connection, id: 'connection_abcdef01234567890123', type: 'MANUAL',
        destination: { ...value.connection.destination, portNumber: '3' } }],
    };
    value.editManualCabling.mockResolvedValueOnce(accepted);
    const reply = await value.handlers.get('dcsc_edit_cabling_connection')!({ session: 'workspace-1',
      connectionId: value.connection.id, destination: value.connection.destination, expectedRevision: 7 });
    expect(reply.isError).not.toBe(true);
    expect(json(reply)['swappedConnections']).toEqual([expect.objectContaining({
      id: 'connection_abcdef01234567890123', type: 'MANUAL',
      destination: { configurationId: 'switch-1', portName: 'RJ45', portNumber: '3' },
    })]);
    expect((json(reply)['swappedConnections'] as Obj[])[0]).not.toHaveProperty('compatibleCables');
    expect(Buffer.byteLength(reply.content[0]!.text)).toBeLessThan(8_000);
  });
});
