import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import type { FabricOptions } from '../src/domain/fabric.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
const fabric: FabricOptions = {
  topologies: [{ id: 'topology:1GbE_Copper', shortName: '1GbE_Copper', description: 'Ethernet' }],
  networkTypes: [{ id: 'network:Management', name: 'Management', defaultNetworkTechnology: '1GbE_Copper',
    defaultLayout: 'Centralized', defaultMainSwitch: 'A', defaultMainSwitchOption: 'SWITCH-A',
    defaultCableType: 'Cat5E', defaultCableColor: 'Green', mainSwitchTrunks: 1 }],
  networkDevices: ['A', 'B'].map(code => ({ id: `device:${code}`, option: `SWITCH-${code}`, feature: code,
    description: `Switch ${code}`, topologies: ['1GbE_Copper'], topologyConnectors: { '1GbE_Copper': 48 } })),
  cables: [{ id: 'cable:1', featureCode: 'CABLE', description: 'Cable', category: 'Cat5E',
    topologies: ['1GbE_Copper'], compatibility: [] }],
  nodeRoles: [{ id: 'role:compute', role: 'Compute', description: 'Compute' }],
  selectedServices: [], storageControllers: [], storageSwitches: [],
};
type Reply = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;
function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const raw = { id: 'node', code: 'SERVER', quantity: 1, tabs: [], connectors: [
    { port: 'RJ45', portNumber: '1', topologies: ['1GbE_Copper'], connectorFunction: 'Network' },
  ] };
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
function setGraph(service: DcscService, workspace: ReturnType<typeof setup>['workspace']) {
  return service.sessions.transact(workspace.id, { history: 'restore' }, draft => {
    draft.serverState.connections = [{ sourceId: 'node', destinationId: 'switch', cablePart: 'CABLE' }];
    delete draft.serverState.connectionGraphInvalidation;
  });
}

describe('network preference consistency', () => {
  it('exposes leaf policies and applies layout, trunks and existing-customer switch controls through registered tools', async () => {
    const { workspace, handlers } = setup();
    const choices = await handlers.get('dcsc_network_get')!({ session: workspace.id,
      collection: 'leafNodeCabling', offset: 0, limit: 20 });
    const policies = JSON.parse(choices.content[0]!.text);
    expect(policies.items).toHaveLength(2);
    const setter = handlers.get('dcsc_network_set')!;
    const updated = await setter({ session: workspace.id, change: { kind: 'preferences', selections: [{
      networkTypeId: 'network:Management', layout: 'Distributed', mainDeviceId: 'device:A',
      leafDeviceId: 'device:B', mainTrunks: 2, leafTrunks: 3,
      leafCabling: policies.items[1].description,
    }] }, expectedRevision: workspace.revision });
    expect(updated.isError).not.toBe(true);
    expect(workspace.serverState.clusterPreference).toMatchObject([{ networkLayout: 'Distributed',
      trunks: 2, leafTrunks: 3, leafSwitch: { option: 'SWITCH-B' },
      leafCabling: policies.items[1].description }]);
    const detached = await setter({ session: workspace.id, change: { kind: 'preferences', selections: [{
      networkTypeId: 'network:Management', layout: 'Centralized',
      mainDeviceId: 'existing-customer-switch', customCableId: 'manual-cable',
    }] }, expectedRevision: workspace.revision });
    expect(detached.isError).not.toBe(true);
    expect(workspace.serverState.clusterPreference).toMatchObject([{ networkLayout: 'Centralized',
      trunks: 0, mainSwitch: {}, customCable: '', leafTrunks: 0 }]);
    expect(workspace.serverState.networkTypes).toMatchObject([{ leafSwitchTrunks: 3 }]);
  });

  it('discovers and edits imported network preferences without resetting their device or other networks', async () => {
    const { service, workspace, handlers } = setup();
    await service.sessions.transact(workspace.id, { history: 'restore' }, draft => {
      draft.serverState.networkingInformation = { clusterPreference: [{
        name: 'Imported Network', networkType: '1GbE_Copper', networkLayout: 'Centralized',
        cableType: 'Cat5E', cableColor: 'Green', mainSwitch: { feature: 'B', option: 'SWITCH-B' },
        trunks: 3, vlan: [], leafSwitch: {}, leafTrunks: 0,
      }] };
    });
    const options = await handlers.get('dcsc_network_get')!({ session: workspace.id,
      collection: 'networkTypes', offset: 0, limit: 20 });
    expect(options.isError).not.toBe(true);
    const result = JSON.parse(options.content[0]!.text);
    expect(result.items).toContainEqual(expect.objectContaining({ id: 'network-type:Imported Network',
      defaultMainSwitch: 'B', mainSwitchTrunks: 3 }));
    await service.setNetworkPreferences(workspace.id, { selections: [{
      networkTypeId: 'network-type:Imported Network', cableColor: '',
    }], ctx: service.newCtx() });
    expect(workspace.serverState.clusterPreference).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Imported Network', trunks: 3, cableColor: '',
        mainSwitch: expect.objectContaining({ option: 'SWITCH-B' }) }),
      expect.objectContaining({ name: 'Management', mainSwitch: expect.objectContaining({ option: 'SWITCH-A' }) }),
    ]));
    expect(fabric.networkTypes).toHaveLength(1);
  });

  it('preserves a selected switch on partial updates and returns a CAS-bound regeneration action', async () => {
    const { service, workspace, handlers, catalog } = setup();
    await service.setNetworkPreferences(workspace.id, { selections: [{ networkTypeId: 'network:Management',
      mainDeviceId: 'device:B' }], ctx: service.newCtx() });
    await setGraph(service, workspace);
    const handler = handlers.get('dcsc_network_set')!;
    const revision = workspace.revision;
    const reply = await handler({ session: workspace.id, change: { kind: 'preferences', selections: [
      { networkTypeId: 'network:Management', cableColor: '' },
    ], autoConnect: false }, expectedRevision: revision });
    expect(reply.isError).not.toBe(true);
    const result = JSON.parse(reply.content[0]!.text);
    expect(result).toMatchObject({ connectionGraphStale: true, autoConnectRequired: true,
      selections: [{ mainDeviceId: 'device:B' }], regenerateConnections: { tool: 'dcsc_auto_connect',
        arguments: { session: workspace.id, expectedRevision: revision + 1 } } });
    expect(workspace.serverState.clusterPreference).toMatchObject([{ cableColor: '',
      mainSwitch: { option: 'SWITCH-B', feature: 'B' } }]);
    expect(() => buildExportData({ workspace, solution: workspace.solution,
      fileTypes: ['XML'], validationMode: 'guided' })).toThrow('connection graph predates');
    catalog.mockClear();
    expect((await handler({ session: workspace.id, change: { kind: 'preferences', selections: [{ networkTypeId: 'network:Management' }] },
      expectedRevision: revision })).isError).toBe(true);
    expect(catalog).not.toHaveBeenCalled();
  });

  it('keeps a graph current for unchanged preferences and rolls back failed regeneration', async () => {
    const { service, workspace, send } = setup();
    const selections = [{ networkTypeId: 'network:Management', mainDeviceId: 'device:B' }];
    await service.setNetworkPreferences(workspace.id, { selections, ctx: service.newCtx() });
    await setGraph(service, workspace);
    const same = await service.setNetworkPreferences(workspace.id, { selections, ctx: service.newCtx() });
    expect(same).toMatchObject({ connectionGraphStale: false, autoConnectRequired: false });
    await service.sessions.transact(workspace.id, { history: 'restore' }, draft => {
      draft.nonRackArea = [{ id: 'node', code: 'SERVER', type: 'server', size: 1 }];
    });
    const before = structuredClone(workspace.serverState);
    const revision = workspace.revision;
    send.mockRejectedValue(new Error('connection calculation failed'));
    await expect(service.setNetworkPreferences(workspace.id, { selections: [
      { networkTypeId: 'network:Management', cableColor: '' },
    ], autoConnect: true, ctx: service.newCtx() })).rejects.toThrow('connection calculation failed');
    expect(workspace.serverState).toEqual(before);
    expect(workspace.revision).toBe(revision);
  });

  it('invalidates the graph after topology or role changes and preserves it on repeat selection', async () => {
    const { service, session, workspace, handlers } = setup();
    await setGraph(service, workspace);
    const topology = handlers.get('dcsc_network_set')!;
    const input = { session: session.id, change: { kind: 'topology', topology: '1GbE_Copper', networkName: 'Management', autoConnect: false } };
    const changed = JSON.parse((await topology(input)).content[0]!.text);
    expect(changed).toMatchObject({ connectionGraphStale: true, session: session.id,
      regenerateConnections: { arguments: { expectedRevision: workspace.revision } } });
    await setGraph(service, workspace);
    expect(JSON.parse((await topology(input)).content[0]!.text).connectionGraphStale).toBe(false);
    const role = handlers.get('dcsc_network_set')!;
    const selected = JSON.parse((await role({ session: session.id, change: { kind: 'nodeRole', role: 'Compute' } })).content[0]!.text);
    expect(selected.connectionGraphStale).toBe(true);
    await setGraph(service, workspace);
    expect(JSON.parse((await role({ session: session.id, change: { kind: 'nodeRole', role: 'Compute' } })).content[0]!.text).connectionGraphStale).toBe(false);
  });
});
