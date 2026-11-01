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
  const inspectNativeManualCabling = vi.fn().mockResolvedValue({ workspace: 'workspace-1', revision: 7, report: { choices: Array.from({ length: 50 }, (_, i) => ({ part: `C${i}`, selection: { quantity: 1 } })) } });
  const createNativeManualCabling = vi.fn().mockResolvedValue({ workspace: 'workspace-1', revision: 8, connection: { ...connection, type: 'MANUAL' } });
  const inspectManualCableChoices = vi.fn().mockImplementation(() => inspectManualCabling());
  // Stands in for src/app/cabling.ts: the dispatch mirrors inspectCabling and applyCablingChanges.
  const service: ManualCablingService = { newCtx: () => ({}) as RequestCtx,
    inspectCabling: async (session, input) => input.candidate
      ? inspectNativeManualCabling(session, { ...input.candidate, expectedRevision: input.expectedRevision!, ctx: input.ctx })
      : input.refreshConnectionId
        ? inspectManualCableChoices(session, input.refreshConnectionId, input.expectedRevision, input.ctx)
        : inspectManualCabling(session, input.expectedRevision),
    applyCablingChanges: async (session, changes, expectedRevision, ctx) => {
      let revision = expectedRevision;
      const results = [];
      for (const change of changes) {
        const { action, ...rest } = change;
        const result = action === 'create'
          ? await createNativeManualCabling(session, { ...rest, expectedRevision: revision, ctx })
          : await editManualCabling(session, { ...rest, expectedRevision: revision, ctx });
        revision = result.revision;
        results.push({ action, result });
      }
      return { workspace: session, revision, results };
    } };
  const handlers = new Map<string, Handler>();
  registerManualCablingTools({ registerTool(name: string, _definition: unknown, callback: Handler) {
    handlers.set(name, callback); return { remove() {}, update() {} };
  } } as unknown as McpServer, service);
  return { handlers, inspectManualCabling, inspectManualCableChoices, editManualCabling, inspectNativeManualCabling, createNativeManualCabling, connection };
}

function json(reply: Reply): Obj {
  return JSON.parse(reply.content[0]!.text) as Obj;
}

describe('manual cabling MCP tools', () => {
  it('pages inspection losslessly with a revision-bound executable continuation', async () => {
    const value = setup();
    const root = await value.handlers.get('dcsc_cabling_get')!({ session: 'workspace-1', path: [], offset: 0, limit: 20 });
    expect(root.isError).not.toBe(true);
    const report = json(root);
    expect(report).toMatchObject({ session: 'workspace-1', revision: 7, path: [], total: 2 });
    const connectionEntry = (report['items'] as Obj[]).find(item => item['key'] === 'connections')!;
    expect(connectionEntry).toMatchObject({ key: 'connections', type: 'array',
      next: { tool: 'dcsc_cabling_get', arguments: {
        session: 'workspace-1', expectedRevision: 7, path: ['connections'], offset: 0, limit: 20,
      } } });
    const next = (connectionEntry['next'] as Obj)['arguments'] as Obj;
    const detail = await value.handlers.get('dcsc_cabling_get')!(next);
    const detailJson = json(detail);
    const row = (detailJson['items'] as Obj[])[0]!;
    expect(row).toMatchObject({ key: '0', type: 'object', next: {
      tool: 'dcsc_cabling_get', arguments: { path: ['connections', '0'] },
    } });
    const rowDetail = await value.handlers.get('dcsc_cabling_get')!(
      ((row['next'] as Obj)['arguments'] as Obj));
    expect(JSON.stringify(json(rowDetail))).toContain(value.connection.id);
    expect(Buffer.byteLength(rowDetail.content[0]!.text)).toBeLessThan(8_000);
    expect(value.inspectManualCabling).toHaveBeenLastCalledWith('workspace-1', 7);
  });

  it('requires the inspected workspace revision and returns executable inspection args', async () => {
    const value = setup();
    const reply = await value.handlers.get('dcsc_cabling_set')!({
      session: 'workspace-1', changes: [{ action: 'edit', connectionId: value.connection.id,
        destination: { configurationId: 'switch-1', portName: 'RJ45', portNumber: '2' } }],
      expectedRevision: 7,
    });
    expect(reply.isError).not.toBe(true);
    expect(value.editManualCabling).toHaveBeenCalledWith('workspace-1', expect.objectContaining({
      connectionId: value.connection.id, expectedRevision: 7,
      destination: { configurationId: 'switch-1', portName: 'RJ45', portNumber: '2' },
      ctx: expect.any(Object),
    }));
    expect(json(reply)).toMatchObject({ session: 'workspace-1', revision: 8,
      results: [{ action: 'edit', connection: { id: value.connection.id, type: 'MANUAL' } }],
      inspect: { tool: 'dcsc_cabling_get', arguments: {
        session: 'workspace-1', expectedRevision: 8, path: ['connections'], offset: 0, limit: 20,
      } } });
    expect(Buffer.byteLength(reply.content[0]!.text)).toBeLessThan(8_000);
    expect((((json(reply)['results'] as Obj[])[0]!)['connection'] as Obj)['compatibleCables']).toBeUndefined();

    await value.handlers.get('dcsc_cabling_set')!({
      session: 'workspace-1', changes: [{ action: 'edit', connectionId: value.connection.id,
        cablePart: '3802', cableQuantities: { oldPart: 2, newPart: 2 } }], expectedRevision: 8,
    });
    expect(value.editManualCabling).toHaveBeenLastCalledWith('workspace-1', expect.objectContaining({
      connectionId: value.connection.id, cablePart: '3802', cableQuantities: { oldPart: 2, newPart: 2 }, expectedRevision: 8,
      ctx: expect.any(Object),
    }));
  });

  it('rejects an empty edit before service I/O and reports service errors through the typed tool surface', async () => {
    const value = setup();
    const empty = await value.handlers.get('dcsc_cabling_set')!({
      session: 'workspace-1', changes: [{ action: 'edit', connectionId: value.connection.id }], expectedRevision: 7,
    });
    expect(empty.isError).toBe(true);
    expect(empty.content[0]!.text).toMatch(/source, destination or cable-part/);
    expect(value.editManualCabling).not.toHaveBeenCalled();

    value.inspectManualCabling.mockImplementationOnce(() => { throw new Error('workspace revision mismatch'); });
    const stale = await value.handlers.get('dcsc_cabling_get')!({
      session: 'workspace-1', expectedRevision: 6, path: [], offset: 0, limit: 20,
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
    const reply = await value.handlers.get('dcsc_cabling_set')!({ session: 'workspace-1',
      changes: [{ action: 'edit', connectionId: value.connection.id, destination: value.connection.destination }], expectedRevision: 7 });
    expect(reply.isError).not.toBe(true);
    const edited = (json(reply)['results'] as Obj[])[0]!;
    expect(edited['swappedConnections']).toEqual([expect.objectContaining({
      id: 'connection_abcdef01234567890123', type: 'MANUAL',
      destination: { configurationId: 'switch-1', portName: 'RJ45', portNumber: '3' },
    })]);
    expect((edited['swappedConnections'] as Obj[])[0]).not.toHaveProperty('compatibleCables');
    expect(Buffer.byteLength(reply.content[0]!.text)).toBeLessThan(8_000);
  });
});


describe('native manual creation tools', () => {
  it('preserves endpoint and revision arguments in cable discovery continuations', async () => {
    const value = setup();
    const candidate = { network: 'Management', topology: '1GbE_Copper', connectionType: 'breakout-4',
      source: value.connection.source, destination: value.connection.destination };
    const args = { session: 'workspace-1', candidate, expectedRevision: 7, path: [], offset: 0, limit: 20 };
    const reply = json(await value.handlers.get('dcsc_cabling_get')!(args));
    const next = ((reply['items'] as Obj[])[0]!['next'] as Obj);
    expect(next).toMatchObject({ tool: 'dcsc_cabling_get', arguments: {
      candidate, expectedRevision: 7, path: ['choices'],
    } });
    await value.handlers.get('dcsc_cabling_get')!(next['arguments'] as Obj);
    expect(value.inspectNativeManualCabling).toHaveBeenCalledTimes(2);
  });
  it('creates native connections with bounded results and propagates rejection', async () => {
    const value = setup();
    const args = { session: 'workspace-1', expectedRevision: 7, changes: [{ action: 'create', network: 'Management', topology: '1GbE_Copper',
      source: value.connection.source, destination: value.connection.destination, cablePart: 'AVFT' }] };
    const reply = json(await value.handlers.get('dcsc_cabling_set')!(args));
    expect(reply).toMatchObject({ revision: 8, results: [{ action: 'create', connection: { type: 'MANUAL' } }], inspect: { tool: 'dcsc_cabling_get' } });
    expect((reply['results'] as Obj[])[0]!['connection']).not.toHaveProperty('compatibleCables');
    expect(value.createNativeManualCabling).toHaveBeenCalledWith('workspace-1', expect.objectContaining({ cablePart: 'AVFT', expectedRevision: 7 }));
    value.createNativeManualCabling.mockRejectedValueOnce(new Error('Native port is already connected'));
    expect((await value.handlers.get('dcsc_cabling_set')!(args)).isError).toBe(true);
  });
});
it('reports all shared-cable branch changes without expanding their compatible catalogs', async () => {
  const value = setup();
  value.editManualCabling.mockResolvedValueOnce({ workspace: 'workspace-1', revision: 8,
    connection: { ...value.connection, category: 'BREAKOUT', divider: 4 },
    updatedConnections: [2, 3, 4].map(n => ({ ...value.connection, id: `branch-${n}`, category: 'BREAKOUT', divider: 4,
      source: { ...value.connection.source, portNumber: String(n) } })),
  });
  const reply = await value.handlers.get('dcsc_cabling_set')!({ session: 'workspace-1', expectedRevision: 7,
    changes: [{ action: 'edit', connectionId: value.connection.id, cablePart: 'AV23' }] });
  expect(reply.isError).not.toBe(true);
  const result = (json(reply)['results'] as Obj[])[0]!;
  expect(result['updatedConnections']).toHaveLength(3);
  expect((result['updatedConnections'] as Obj[]).every(row => row['divider'] === 4 && !('compatibleCables' in row))).toBe(true);
  expect(result).not.toHaveProperty('swappedConnections');
  expect(Buffer.byteLength(reply.content[0]!.text)).toBeLessThan(8_000);
});


it('applies bulk changes in order, each against the revision the previous one produced', async () => {
  const value = setup();
  value.editManualCabling.mockResolvedValueOnce({ workspace: 'workspace-1', revision: 8, connection: value.connection });
  value.createNativeManualCabling.mockResolvedValueOnce({ workspace: 'workspace-1', revision: 9, connection: value.connection });
  const reply = await value.handlers.get('dcsc_cabling_set')!({ session: 'workspace-1', expectedRevision: 7, changes: [
    { action: 'edit', connectionId: value.connection.id, cablePart: 'AV23' },
    { action: 'create', network: 'Management', topology: '1GbE_Copper', cablePart: 'AVFT',
      source: value.connection.source, destination: value.connection.destination },
  ] });
  expect(reply.isError).not.toBe(true);
  expect(json(reply)).toMatchObject({ revision: 9, results: [{ action: 'edit' }, { action: 'create' }] });
  expect(value.editManualCabling).toHaveBeenCalledWith('workspace-1', expect.objectContaining({ expectedRevision: 7 }));
  expect(value.createNativeManualCabling).toHaveBeenCalledWith('workspace-1', expect.objectContaining({ expectedRevision: 8 }));
});

it('retains fresh-choice targeting and the revision guard in inspection continuations', async () => {
  const value = setup();
  const reply = await value.handlers.get('dcsc_cabling_get')!({ session: 'workspace-1',
    expectedRevision: 7, refreshConnectionId: 'row-1', path: [], offset: 0, limit: 20 });
  expect(reply.isError).not.toBe(true);
  expect(value.inspectManualCableChoices).toHaveBeenCalledWith('workspace-1', 'row-1', 7, {});
  const entry = (json(reply)['items'] as Obj[]).find(item => item['key'] === 'connections')!;
  expect(entry).toMatchObject({ next: { arguments: { refreshConnectionId: 'row-1', expectedRevision: 7 } } });
});
