import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import type { FabricOptions } from '../src/domain/fabric.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import type { RawConfiguration } from '../src/model/types.js';

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

function raw(quantity: number): RawConfiguration {
  return {
    id: 'server-1', code: 'SERVER', sliceCtoCode: 'SERVER', type: 'server', name: 'Server',
    description: 'Test server', quantity: 1,
    tabs: [{ title: 'Memory', type: 'hardware', subTabs: [{ title: 'Memory', sections: [{
      name: 'MEMORY', singleEntry: true,
      features: [{ code: 'DIMM', max: 16, description: 'DIMM' }],
      results: [{ code: 'DIMM', quantity }],
    }] }] }],
  };
}

function setup(solutionMode = 'HPC and AI - Systems') {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const solution = { solutionMode, masterSlices: solutionMode === 'General Purpose' ? ['GP'] : ['HPCGP'] };
  const configuration = raw(1);
  const session = service.sessions.create({
    locale: service.locale, solution, mode: 'cto', raw: configuration,
    configurationId: configuration.id!, reduced: reduceConfiguration(configuration, configuration.id!), primed: true,
  });
  const workspace = service.sessions.getWorkspace(session.id)!;
  workspace.nonRackArea = [{ id: session.configurationId, code: 'SERVER', type: 'server',
    description: 'Test server', size: 1 }];
  return { service, session, workspace, ctx: service.newCtx({ solution }) };
}

describe('service action history', () => {
  it('appends UPDATE only for an accepted selection change', async () => {
    const { service, session, workspace, ctx } = setup();
    const send = vi.spyOn(service.http, 'send');
    send.mockResolvedValueOnce({ raw: { configurations: [raw(2)] } } as never);
    await service.configure(session, [{ section: 'MEMORY', code: 'DIMM', quantity: 2 }], ctx);

    expect(workspace.serverState.historyInformation).toEqual([
      expect.objectContaining({
        command: 'UPDATE',
        description: 'Update :  Server SERVER Test server  at Non Rack Area',
        tooltip: '',
      }),
    ]);

    session.raw.selectedTopologies = { Alpha: { value: 1 }, Beta: { value: 2 } };
    const reordered = raw(2);
    reordered.selectedTopologies = { Beta: { value: 2 }, Alpha: { value: 1 } };
    send.mockResolvedValueOnce({ raw: { configurations: [reordered] } } as never);
    await service.configure(session, [{ section: 'MEMORY', code: 'DIMM', quantity: 3 }], ctx);
    expect(workspace.serverState.historyInformation).toHaveLength(1);
  });

  it('does not append on upstream failure or in General Purpose mode', async () => {
    const hpc = setup();
    vi.spyOn(hpc.service.http, 'send').mockRejectedValue(new Error('derive failed'));
    await expect(hpc.service.configure(hpc.session,
      [{ section: 'MEMORY', code: 'DIMM', quantity: 2 }], hpc.ctx)).rejects.toThrow('derive failed');
    expect(hpc.workspace.serverState.historyInformation).toBeUndefined();

    const gp = setup('General Purpose');
    vi.spyOn(gp.service.http, 'send').mockResolvedValue({ raw: { configurations: [raw(2)] } } as never);
    await gp.service.configure(gp.session, [{ section: 'MEMORY', code: 'DIMM', quantity: 2 }], gp.ctx);
    expect(gp.workspace.serverState.historyInformation).toBeUndefined();
  });

  it('records accepted MOVE and REMOVE layout actions from post- and pre-state respectively', async () => {
    const { service, session: node, workspace, ctx } = setup();
    const rackRaw: RawConfiguration = {
      id: 'rack-1', code: 'RACK', sliceCtoCode: 'RACK', type: 'rack', name: 'Rack',
      description: 'Test rack', quantity: 1, tabs: [],
    };
    service.sessions.create({ locale: service.locale, solution: workspace.solution, mode: 'cto', raw: rackRaw,
      configurationId: rackRaw.id!, reduced: reduceConfiguration(rackRaw, rackRaw.id!), primed: true,
      workspaceId: workspace.id });
    workspace.rackArea = [{ id: 'rack-1', code: 'RACK', type: 'rack', name: 'Rack',
      description: 'Test rack', size: 42, rackItems: [] }];
    workspace.serverState.floorInformation = { floorGrid: [{ id: 'rack-1', coordinate: 'A1' }] };
    vi.spyOn(service.http, 'send').mockImplementation(async request => {
      if (request.path.endsWith('/non_rack')) return { raw: [{ code: 'SERVER', type: 'server', size: 1 }] } as never;
      if (request.path.endsWith('/autoDerive')) return { raw: { configurations: [] } } as never;
      const body = request.body?.kind === 'json' ? request.body.value as Record<string, unknown> : {};
      return { raw: { rackArea: body.rackArea, nonRackArea: body.nonRackArea, connections: [] } } as never;
    });

    await service.placeInRack(workspace.id, { rackId: 'rack-1', sessionId: node.id, position: 3, ctx });
    await service.editLayout(workspace.id, { action: 'unplace', configurationId: node.id, ctx });
    await service.editLayout(workspace.id, { action: 'remove', configurationId: node.id, ctx });

    expect((workspace.serverState.historyInformation as Array<Record<string, unknown>>).map(row =>
      [row.command, row.description])).toEqual([
      ['MOVE', 'Move :  Server SERVER Test server  at Rack A1'],
      ['MOVE', 'Move :  Server SERVER Test server  at Non Rack Area'],
      ['REMOVE', 'Remove :  Server SERVER Test server  at Non Rack Area'],
    ]);
  });

  it('records only actual data-network preference changes', async () => {
    const { service, workspace, ctx } = setup();
    const fabric: FabricOptions = {
      topologies: [{ id: 'topology:1GbE', shortName: '1GbE', description: 'Ethernet' }],
      networkTypes: [{ id: 'network:Management', name: 'Management', defaultNetworkTechnology: '1GbE',
        defaultLayout: 'Centralized', defaultMainSwitch: 'A', defaultMainSwitchOption: 'SW-A',
        defaultCableType: 'Cat5E', defaultCableColor: 'Green', mainSwitchTrunks: 1 }],
      networkDevices: ['A', 'B'].map(code => ({ id: `device:${code}`, option: `SW-${code}`, feature: code,
        description: `Switch ${code}`, topologies: ['1GbE'], topologyConnectors: { '1GbE': 48 } })),
      cables: [{ id: 'cable:1', featureCode: 'CABLE', description: 'Cable', category: 'Cat5E',
        topologies: ['1GbE'], compatibility: [] }],
      nodeRoles: [], selectedServices: [], storageControllers: [], storageSwitches: [],
    };
    vi.spyOn(service, 'fabricOptions').mockResolvedValue(fabric);
    const selections = [{ networkTypeId: 'network:Management', mainDeviceId: 'device:B' }];
    await service.setNetworkPreferences(workspace.id, { selections, autoConnect: false, ctx });
    expect(workspace.serverState.historyInformation).toEqual([
      expect.objectContaining({
        command: 'CHANGE',
        description: 'Change :    Modified Data networks: Management,  ',
      }),
    ]);
    await service.setNetworkPreferences(workspace.id, { selections, autoConnect: false, ctx });
    expect(workspace.serverState.historyInformation).toHaveLength(1);
  });

  it('records independent configuration copies as one COPY row with the accepted count', async () => {
    const { service, session, workspace } = setup();
    delete workspace.nonRackArea[0]!.description;

    const result = await service.cloneConfiguration({ sessionHandle: session.id, count: 2 });

    expect(result.clones).toHaveLength(2);
    expect(workspace.serverState.historyInformation).toEqual([
      expect.objectContaining({
        command: 'COPY',
        description: 'Copy x2:  Server SERVER Test server  at Non Rack Area',
      }),
    ]);
  });

  it('records closing a linked clone as removal from its former location', async () => {
    const { service, session, workspace } = setup();
    const cloneRaw = { ...structuredClone(session.raw), id: 'server-2' };
    const clone = service.sessions.create({
      locale: service.locale, solution: workspace.solution, mode: 'cto', raw: cloneRaw,
      configurationId: cloneRaw.id!, reduced: reduceConfiguration(cloneRaw, cloneRaw.id!), primed: true,
      workspaceId: workspace.id,
    });
    workspace.nonRackArea.push({ id: clone.configurationId, code: 'SERVER', type: 'server',
      description: 'Test server', size: 1 });
    workspace.serverState.cloneDependency = {
      [session.configurationId]: [session.configurationId, clone.configurationId],
    };

    await service.closeSession(clone.id);

    expect(workspace.serverState.historyInformation).toEqual([
      expect.objectContaining({
        command: 'REMOVE',
        description: 'Remove :  Server SERVER Test server  at Non Rack Area',
      }),
    ]);
  });

  it('records removal when a fresh raw configuration is closed before physical materialization', async () => {
    const { service, session, workspace } = setup();
    workspace.nonRackArea = [];
    const retainedRaw = { ...raw(1), id: 'server-retained' };
    service.sessions.create({
      locale: service.locale, solution: workspace.solution, mode: 'cto', raw: retainedRaw,
      configurationId: retainedRaw.id!, reduced: reduceConfiguration(retainedRaw, retainedRaw.id!), primed: true,
      workspaceId: workspace.id,
    });

    await service.closeSession(session.id);

    expect(workspace.serverState.historyInformation).toEqual([
      expect.objectContaining({
        command: 'REMOVE',
        description: 'Remove :  Server SERVER   at Non Rack Area',
      }),
    ]);
  });

  it('records floor movement and an accepted occupied-U lock with native locations', async () => {
    const { service, workspace, ctx } = setup();
    workspace.rackArea = [{ id: 'rack-1', code: 'RACK', type: 'rack', name: 'Rack',
      description: 'Test rack', size: 42, lockedSpace: [], rackItems: [{
        id: 'server-1', code: 'SERVER', type: 'server', description: 'Test server', size: 1, position: 3,
      }] }];
    workspace.nonRackArea = [];

    await service.placeOnFloor(workspace.id, 'rack-1', 0, 0);
    let derives = 0;
    vi.spyOn(service.http, 'send').mockImplementation(async request => {
      if (request.path.endsWith('/autoDerive')) {
        derives += 1;
        return { raw: { configurations: [], ...(derives > 1 ? { autoDerivedResults: [{ refresh: true }] } : {}) } } as never;
      }
      const body = request.body?.kind === 'json' ? request.body.value as Record<string, unknown> : {};
      return { raw: { rackArea: body.rackArea, nonRackArea: body.nonRackArea, connections: [] } } as never;
    });
    await service.setRackLock(workspace.id, { target: { itemId: 'server-1' }, locked: true, ctx });
    await service.setRackLock(workspace.id, { target: { itemId: 'server-1' }, locked: true, ctx });

    expect((workspace.serverState.historyInformation as Array<Record<string, unknown>>).map(row =>
      [row.command, row.description])).toEqual([
      ['MOVE', 'Move :  Rack  Test rack  at A1 '],
      ['LOCK', 'Lock :    Locked position 3 occupied by SERVER Test server  at Rack A1'],
    ]);
  });

  it('records rule controls only when their accepted values change', async () => {
    const { service, workspace, ctx } = setup();
    vi.spyOn(service.http, 'send').mockImplementation(async () => ({
      raw: { configurations: [raw(1)] },
    }) as never);

    await service.setConfigurationControls(workspace.id, { validationMode: 'expert', ctx });
    await service.setConfigurationControls(workspace.id, { validationMode: 'expert', ctx });

    expect(workspace.serverState.historyInformation).toEqual([
      expect.objectContaining({
        command: 'CHANGE',
        description: 'Change :    Rule settings modified ',
      }),
    ]);
  });

  it('records accepted topology selection once and rolls a failed recable back without history', async () => {
    const { service, session, workspace, ctx } = setup();
    session.raw.connectors = [{ port: 'RJ45', portNumber: '1', portDescription: 'Network port',
      sourceFeature: 'NIC', connectorFunction: 'Network', topologies: ['1GbE', '10GbE'] }];
    const network = (id: string, name: string, topology: string) => ({
      id, name, defaultNetworkTechnology: topology, defaultLayout: 'Centralized' as const,
      defaultMainSwitch: '', defaultMainSwitchOption: '', defaultCableType: 'Cat5E',
      defaultCableColor: 'Green', mainSwitchTrunks: 1,
    });
    const fabric: FabricOptions = {
      topologies: [
        { id: 'topology:1', shortName: '1GbE', description: '1 GbE' },
        { id: 'topology:10', shortName: '10GbE', description: '10 GbE' },
      ],
      networkTypes: [network('network:1', 'Management', '1GbE'), network('network:10', 'Data', '10GbE')],
      networkDevices: [], cables: [], nodeRoles: [], selectedServices: [], storageControllers: [], storageSwitches: [],
    };
    vi.spyOn(service, 'fabricOptions').mockResolvedValue(fabric);

    await service.applyTopology({ sessionHandle: session.id, topology: '1GbE', autoConnect: false, ctx });
    await service.applyTopology({ sessionHandle: session.id, topology: '1GbE', autoConnect: false, ctx });
    expect((workspace.serverState.historyInformation as Array<Record<string, unknown>>).map(row => row.command))
      .toEqual(['UPDATE']);

    vi.spyOn(service.http, 'send').mockRejectedValueOnce(new Error('recable failed'));
    await expect(service.applyTopology({ sessionHandle: session.id, topology: '10GbE', autoConnect: true, ctx }))
      .rejects.toThrow('recable failed');
    expect((workspace.serverState.historyInformation as Array<Record<string, unknown>>).map(row => row.command))
      .toEqual(['UPDATE']);
    expect(session.raw.selectedTopologies).toHaveProperty('Management');
    expect(session.raw.selectedTopologies).not.toHaveProperty('Data');
  });
});
