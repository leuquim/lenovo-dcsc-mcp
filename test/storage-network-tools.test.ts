import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { ConfigSchema } from '../src/config/schema.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { buildExportGroups } from '../src/domain/exportGroups.js';
import type { FabricOptions } from '../src/domain/fabric.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';
import { SessionPersistenceError } from '../src/http/persistenceError.js';

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
const captured = JSON.parse(readFileSync(new URL('./fixtures/parity/storage-network-create.json', import.meta.url), 'utf8'));
const fabric: FabricOptions = { topologies: [], networkDevices: [], networkTypes: [], cables: [],
  selectedServices: [], nodeRoles: [], storageSwitches: [], storageControllers: [{
    id: 'controller-captured', option: '7D4FCTO6WW', featureCode: 'BCBN', description: 'Captured controller', expansions: [],
  }] };
const input = { name: 'Parity Storage', controllerId: 'controller-captured' };
type Reply = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;
function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const raw = { id: 'node', code: 'SERVER', quantity: 1, selectedStorageNetwork: null, tabs: [] };
  const session = service.sessions.create({ locale: service.locale,
    solution: { solutionMode: 'HPC and AI - Systems', masterSlices: ['HPC'] }, mode: 'cto', raw,
    configurationId: raw.id, reduced: reduceConfiguration(raw, raw.id), primed: true });
  const workspace = service.sessions.getWorkspace(session.id)!;
  const catalog = vi.spyOn(service, 'fabricOptions').mockResolvedValue(fabric);
  const send = vi.spyOn(service.http, 'send');
  const handlers = new Map<string, Handler>();
  registerTools({ registerTool(name: string, _definition: unknown, callback: Handler) {
    handlers.set(name, callback); return { remove() {}, update() {} };
  } } as unknown as McpServer, service);
  return { service, session, workspace, catalog, send, handlers };
}

describe('storage definition creation', () => {
  it('applies storage preference regeneration with the native switch-calculation then customize sequence', async () => {
    const { service, workspace, send } = setup();
    await service.addStorageNetwork(workspace.id, { input, ctx: service.newCtx() });
    workspace.nonRackArea = [{ id: 'node', code: 'SERVER', type: 'server', size: 1 }];
    send.mockImplementation(async request => {
      if (request.path === '/switch_calculation') return { raw: [] } as never;
      expect(request.path).toBe('/ctos/racks/customize');
      const body = request.body?.kind === 'json' ? request.body.value as Record<string, unknown> : {};
      return { raw: { rackArea: body.rackArea, nonRackArea: body.nonRackArea, connections: [], errors: [] } } as never;
    });
    const result = await service.reconfigureStorageNetwork(workspace.id, { name: input.name,
      changes: { layout: 'Minimal Cabling' }, expectedRevision: workspace.revision,
      autoConnect: true, ctx: service.newCtx() });
    expect(result).toMatchObject({ connectionCount: 0, connectionGraphStale: false, autoConnectRequired: false });
    expect(send.mock.calls.map(([request]) => request.path)).toEqual(['/switch_calculation', '/ctos/racks/customize']);
  });

  it('retains a replaced SAN switch as one physical unit, supports inspection and restores the definition on undo', async () => {
    const { service, workspace, handlers } = setup();
    await service.addStorageNetwork(workspace.id, { input, ctx: service.newCtx() });
    const raw = { id: 'san-template', code: 'SAN', type: 'switch', quantity: 1, totalPrice: 100, tabs: [] };
    const san = service.sessions.create({ locale: workspace.locale, solution: workspace.solution, mode: 'cto',
      raw, configurationId: raw.id, reduced: reduceConfiguration(raw, raw.id), primed: true, workspaceId: workspace.id });
    await service.sessions.transact(workspace.id, { history: 'restore' }, draft => {
      (draft.serverState.storageConnectionNetworks as Array<Record<string, unknown>>)[0]!.mainSwitch = {
        id: raw.id, option: raw.code, featureCode: 'BASE', hardwareType: 'switch',
      };
      draft.nonRackArea = [{ id: 'san-alias', code: 'SAN', type: 'switch', size: 1 }];
      draft.serverState.cloneDependency = { [raw.id]: [raw.id, 'san-alias'] };
    });
    const before = structuredClone({ raw: san.raw, state: workspace.serverState, physical: workspace.nonRackArea });
    const reply = await handlers.get('dcsc_edit_storage_network')!({ session: workspace.id, action: 'update',
      name: input.name, changes: { switchId: 'direct-attached' }, expectedRevision: workspace.revision });
    expect(reply.isError, reply.content[0]?.text).not.toBe(true);
    const result = JSON.parse(reply.content[0]!.text);
    expect(result.retainedComponents).toMatchObject([{ templateId: raw.id, physicalCount: 1,
      nativeCommercialDifference: 'website-counts-detached-template' }]);
    expect(san.raw).toEqual(before.raw);
    expect(workspace.nonRackArea).toEqual(before.physical);
    expect(workspace.serverState.cloneDependency).toEqual(before.state.cloneDependency);
    expect(buildExportGroups(workspace).flatMap(group => group.products).find(product => product.id === raw.id))
      .toMatchObject({ quantity: 1, price: 100 });
    const retained = await handlers.get(result.retainedHardware.tool)!(result.retainedHardware.arguments);
    expect(retained.isError).not.toBe(true);
    expect(retained.content[0]!.text).toContain('san-alias');
    await service.sessions.undoWorkspace(workspace.id);
    expect(workspace.serverState).toEqual(before.state);
    expect(workspace.nonRackArea).toEqual(before.physical);
    await service.sessions.redoWorkspace(workspace.id);
    expect(workspace.serverState.detachedStorageComponents).toMatchObject([{ templateId: raw.id, physicalIds: ['san-alias'] }]);
  });

  it('updates preferences through the registered tool with CAS, stale-graph protection and undo', async () => {
    const { service, workspace, handlers, send, catalog } = setup();
    await service.addStorageNetwork(workspace.id, { input, ctx: service.newCtx() });
    await service.sessions.transact(workspace.id, { history: 'restore' }, draft => {
      draft.serverState.connections = [{ id: 'prior-connection', network: 'Management',
        from: { id: 'node', port: '1' }, to: { id: 'switch', port: '1' } }];
    });
    const before = structuredClone(workspace.serverState);
    const handler = handlers.get('dcsc_edit_storage_network')!;
    const missingCas = await handler({ session: workspace.id, action: 'update', name: input.name,
      changes: { layout: 'Minimal Cabling' } });
    expect(missingCas.isError).toBe(true);
    const revision = workspace.revision;
    const reply = await handler({ session: workspace.id, action: 'update', name: input.name,
      changes: { layout: 'Minimal Cabling', expansionQuantity: 0 }, expectedRevision: revision });
    expect(reply.isError).not.toBe(true);
    const result = JSON.parse(reply.content[0]!.text);
    expect(result).toMatchObject({ revision: revision + 1, connectionGraphStale: true, autoConnectRequired: true });
    expect(workspace.serverState.storageConnectionNetworks).toMatchObject([{ name: input.name,
      layout: 'Minimal Cabling', maximumExpansions: 0 }]);
    expect(() => buildExportData({ workspace, solution: workspace.solution,
      fileTypes: ['XML'], validationMode: 'guided' })).toThrow('connection graph predates');
    expect(send).not.toHaveBeenCalled();
    expect((await handlers.get(result.inspect.tool)!(result.inspect.arguments)).isError).not.toBe(true);
    catalog.mockClear();
    const stale = await handler({ session: workspace.id, action: 'update', name: input.name,
      changes: { layout: 'Fully Redundant' }, expectedRevision: revision });
    expect(stale.isError).toBe(true);
    expect(catalog).not.toHaveBeenCalled();
    await service.sessions.undoWorkspace(workspace.id);
    expect(workspace.serverState).toEqual(before);
  });

  it('rolls back a storage preference update when regeneration or durable saving fails', async () => {
    const { service, workspace, send } = setup();
    await service.addStorageNetwork(workspace.id, { input, ctx: service.newCtx() });
    workspace.nonRackArea = [{ id: 'node', code: 'SERVER', type: 'server', size: 1 }];
    const before = structuredClone(workspace.serverState);
    const revision = workspace.revision;
    send.mockRejectedValue(new Error('connection service unavailable'));
    await expect(service.reconfigureStorageNetwork(workspace.id, { name: input.name,
      changes: { layout: 'Minimal Cabling' }, expectedRevision: revision,
      autoConnect: true, ctx: service.newCtx() })).rejects.toThrow('connection service unavailable');
    expect(workspace.serverState).toEqual(before);
    expect(workspace.revision).toBe(revision);
    service.sessions.setPersistenceWriter(() => { throw new Error('disk full'); });
    await expect(service.reconfigureStorageNetwork(workspace.id, { name: input.name,
      changes: { layout: 'Minimal Cabling' }, expectedRevision: revision, ctx: service.newCtx() }))
      .rejects.toMatchObject({ localNotCommitted: true, remoteApplied: false });
    expect(workspace.serverState).toEqual(before);
    expect(workspace.revision).toBe(revision);
  });

  it('preserves client-owned storage assignments when derive or cabling omits them', async () => {
    const { service, workspace, session, send } = setup();
    await service.addStorageNetwork(workspace.id, { input, ctx: service.newCtx() });
    await service.sessions.transact(workspace.id, {}, draft => {
      draft.configurations.get(session.id)!.raw.selectedStorageNetwork = input.name;
      draft.nonRackArea = [{ id: session.configurationId, code: 'SERVER', type: 'server' }];
    });
    const response = { id: session.configurationId, code: 'SERVER', quantity: 1, tabs: [] };
    send.mockResolvedValue({ raw: { configurations: [response], connections: [], errors: [] } } as never);
    await service.configure(session, [], service.newCtx());
    expect(session.raw.selectedStorageNetwork).toBe(input.name);
    await service.runAutoConnect(workspace.id, service.newCtx());
    expect(session.raw.selectedStorageNetwork).toBe(input.name);
    expect(session.reduced.selectedStorageNetwork).toBe(input.name);
  });

  it('renames definitions and assignment references atomically, with explicit removal and undo', async () => {
    const { service, workspace, session, send, handlers } = setup();
    await service.addStorageNetwork(workspace.id, { input, ctx: service.newCtx() });
    await service.sessions.transact(workspace.id, {}, draft => {
      draft.configurations.get(session.id)!.raw.selectedStorageNetwork = input.name;
      draft.serverState.selectedStorageNetwork = { [session.configurationId]: input.name };
    });
    const renamed = await handlers.get('dcsc_edit_storage_network')!({ session: workspace.id,
      action: 'rename', name: input.name, newName: 'Renamed', expectedRevision: workspace.revision });
    expect(renamed.isError).not.toBe(true);
    expect(session.raw.selectedStorageNetwork).toBe('Renamed');
    expect(session.reduced.selectedStorageNetwork).toBe('Renamed');
    expect(workspace.serverState.selectedStorageNetwork).toEqual({ [session.configurationId]: 'Renamed' });
    const revision = workspace.revision;
    await expect(service.editStorageNetwork(workspace.id, { action: 'remove', name: 'Renamed' })).rejects.toThrow(/clearAssignments/);
    expect(workspace.revision).toBe(revision);
    const removed = await handlers.get('dcsc_edit_storage_network')!({ session: workspace.id,
      action: 'remove', name: 'Renamed', clearAssignments: true, expectedRevision: revision });
    expect(removed.isError).not.toBe(true);
    expect(workspace.serverState.storageConnectionNetworks).toEqual([]);
    expect(session.raw.selectedStorageNetwork).toBe('');
    await service.sessions.undoWorkspace(workspace.id);
    expect(session.raw.selectedStorageNetwork).toBe('Renamed');
    expect(workspace.serverState.storageConnectionNetworks).toMatchObject([{ name: 'Renamed' }]);
    expect(send).not.toHaveBeenCalled();
  });

  it('registers an atomic local edit matching the website and returns executable inspection', async () => {
    const { service, session, workspace, handlers, send, catalog } = setup();
    const beforeRevision = workspace.revision;
    const write = vi.fn();
    service.sessions.setPersistenceWriter(write);
    const reply = await handlers.get('dcsc_add_storage_network')!({ session: workspace.id,
      name: input.name, expectedRevision: beforeRevision });
    expect(reply.isError).not.toBe(true);
    const result = JSON.parse(reply.content[0]!.text);
    expect(result).toMatchObject({ workspace: workspace.id, revision: beforeRevision + 1, storageNetworkCount: 1 });
    expect(workspace.serverState.storageConnectionNetworks).toEqual(captured.storageConnectionNetworks);
    expect(session.raw.selectedStorageNetwork).toBeNull();
    expect(catalog.mock.calls[0]![0].locale).toEqual(workspace.locale);
    expect(send).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    const inspected = await handlers.get(result.inspect.tool)!(result.inspect.arguments);
    expect(inspected.isError).not.toBe(true);
    expect(inspected.content[0]!.text).toContain('Parity Storage');
    const exported = buildExportData({ workspace, solution: workspace.solution, validationMode: 'guided', fileTypes: ['XML'] });
    expect(exported.networkingInformation).toMatchObject({ storageNetworks: captured.storageConnectionNetworks });
    await service.sessions.undoWorkspace(workspace.id);
    expect(workspace.serverState.storageConnectionNetworks).toBeUndefined();
    const stale = await handlers.get(result.inspect.tool)!(result.inspect.arguments);
    expect(stale.isError).toBe(true);
  });

  it('preserves imported definitions and rejects duplicates or stale calls without publishing', async () => {
    const { service, workspace, catalog } = setup();
    const old = { ...captured.storageConnectionNetworks[0], name: 'Imported', future: { retained: true } };
    workspace.serverState.networkingInformation = { storageNetworks: [old], unrelated: 'kept' };
    await service.addStorageNetwork(workspace.id, { input, ctx: service.newCtx() });
    expect(workspace.serverState.storageConnectionNetworks).toEqual([old, ...captured.storageConnectionNetworks]);
    expect(workspace.serverState.networkingInformation).toMatchObject({ unrelated: 'kept' });
    const before = structuredClone(workspace.serverState);
    const revision = workspace.revision;
    await expect(service.addStorageNetwork(workspace.id, { input, ctx: service.newCtx() })).rejects.toThrow(/already exists/);
    expect(workspace.serverState).toEqual(before);
    expect(workspace.revision).toBe(revision);
    catalog.mockClear();
    await expect(service.addStorageNetwork(workspace.id, { input: { ...input, name: 'New' },
      expectedRevision: revision - 1, ctx: service.newCtx() })).rejects.toThrow(/revision/i);
    expect(catalog).not.toHaveBeenCalled();
    expect(workspace.serverState).toEqual(before);
  });

  it('rolls back on persistence failure and reports no remote mutation', async () => {
    const { service, workspace, send } = setup();
    const revision = workspace.revision;
    const before = structuredClone(workspace.serverState);
    service.sessions.setPersistenceWriter(() => { throw new Error('disk full'); });
    const error = await service.addStorageNetwork(workspace.id, { input, ctx: service.newCtx() }).catch(error => error);
    expect(error).toBeInstanceOf(SessionPersistenceError);
    expect(error).toMatchObject({ localNotCommitted: true, remoteApplied: false });
    expect(workspace.revision).toBe(revision);
    expect(workspace.serverState).toEqual(before);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps malformed imported definitions inspectable while refusing destructive edits', async () => {
    const { service, workspace, handlers } = setup();
    workspace.serverState.storageConnectionNetworks = { unknownEnvelope: 'retained' };
    const detail = await handlers.get('dcsc_workspace_layout')!({ session: workspace.id,
      path: ['storageNetworks'], expectedRevision: workspace.revision, offset: 0, limit: 20 });
    expect(detail.isError).not.toBe(true);
    expect(detail.content[0]!.text).toContain('retained');
    const before = structuredClone(workspace.serverState);
    await expect(service.addStorageNetwork(workspace.id, { input, ctx: service.newCtx() })).rejects.toThrow(/malformed/);
    expect(workspace.serverState).toEqual(before);
  });

  it('exposes stable expansion IDs that can be used directly in storage creation', async () => {
    const { service, workspace, catalog, handlers } = setup();
    catalog.mockResolvedValue({ ...fabric, storageControllers: [{ ...fabric.storageControllers[0]!,
      expansions: [{ option: 'EXPANSION', featureCode: 'E1', description: 'Expansion', maximum: 4, future: true }],
    }] });
    const reply = await handlers.get('dcsc_fabric_options')!({ session: workspace.id,
      collection: 'storageControllers', offset: 0, limit: 20 });
    expect(reply.isError).not.toBe(true);
    const controller = JSON.parse(reply.content[0]!.text).items[0];
    expect(controller.expansions[0]).toMatchObject({ future: true, controllerId: controller.id });
    await service.addStorageNetwork(workspace.id, { input: { ...input,
      expansionId: controller.expansions[0].id, expansionQuantity: 2 }, ctx: service.newCtx() });
    expect(workspace.serverState.storageConnectionNetworks).toMatchObject([{ maximumExpansions: 2,
      expansion: { option: 'EXPANSION', featureCode: 'E1' } }]);
  });
});
