import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import type { FabricOptions } from '../src/domain/fabric.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import type { SendInput } from '../src/http/request.js';
import { DcscService } from '../src/mcp/service.js';

type Obj = Record<string, unknown>;

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/parity/switch-provisioning.json', import.meta.url), 'utf8',
)) as Obj;
const services: DcscService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
});

const fabric: FabricOptions = {
  topologies: [{ id: 'topology:1GbE_Copper', shortName: '1GbE_Copper', description: 'Ethernet' }],
  networkTypes: [{
    id: 'network:Management',
    name: 'Management',
    defaultNetworkTechnology: '1GbE_Copper',
    defaultLayout: 'Centralized',
    defaultMainSwitch: 'BPC7',
    defaultMainSwitchOption: '7D5FCTOFWW',
    defaultCableType: 'Cat5E',
    defaultCableColor: 'Green',
    mainSwitchTrunks: 1,
  }],
  networkDevices: [{
    id: 'device:BPC7:7D5FCTOFWW',
    feature: 'BPC7',
    option: '7D5FCTOFWW',
    description: 'NVIDIA SN2201 1GbE Managed Switch with Cumulus (PSE)',
    topologies: ['1GbE_Copper'],
    topologyConnectors: { '1GbE_Copper': 48 },
  }],
  cables: [{
    id: 'cable:Cat5E',
    featureCode: '3802',
    description: 'Cat5E cable',
    category: 'Cat5E',
    topologies: ['1GbE_Copper'],
    compatibility: [],
  }],
  nodeRoles: [],
  leafNodeCabling: [
    { id: 'leaf-cabling:minimal-distance', description: 'Minimal distance cabling (lower cost)' },
    { id: 'leaf-cabling:balanced', description: 'Balance Connections across leaf switches (best performance)' },
  ],
  selectedServices: [],
  storageControllers: [],
  storageSwitches: [],
};

function setup(failAt = '') {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const solution = {
    solutionMode: 'HPC and AI - Systems',
    masterSlices: ['HPCGP', 'HPCRYO', 'HPCGPALL', 'HPCGPRYO'],
  };
  const captured = fixture['workspace'] as Obj;
  const configurations = captured['configurations'] as Obj[];
  let workspaceId = '';
  for (const base of configurations) {
    const id = String(base['id']);
    const raw = {
      ...base,
      tabs: [],
      type: id === 'rack-1' ? 'rack' : id === 'server-1' ? 'server' : 'switch',
    };
    const session = service.sessions.create({
      locale: service.locale,
      solution,
      mode: 'cto',
      raw,
      configurationId: id,
      reduced: reduceConfiguration(raw, id),
      primed: true,
      ...(workspaceId ? { workspaceId } : {}),
    });
    workspaceId = session.workspaceId;
  }
  const workspace = service.sessions.getWorkspace(workspaceId)!;
  workspace.rackArea = structuredClone(captured['rackArea']) as Obj[];
  workspace.rackArea[0]!.size = 42;
  workspace.serverState = {
    ...structuredClone(captured),
    autoConnectSettings: { autoAddPDU: false, autoAddSwitch: true, p2pCabling: true },
    connections: [{ id: 'stale-before-preference-close' }],
  };
  vi.spyOn(service, 'fabricOptions').mockResolvedValue(structuredClone(fabric));
  const calls: SendInput[] = [];
  let generatedId = '';
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
    calls.push(request);
    if (request.endpoint === failAt) throw new Error(`Injected ${failAt}`);
    const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
    if (request.endpoint === 'switch_calculation') {
      return { raw: fixture['calculationResponse'] } as never;
    }
    if (request.endpoint === 'automatic_switch_launch') {
      return { raw: fixture['launch'] } as never;
    }
    if (request.endpoint === 'racks_customize') {
      const rackArea = structuredClone(body['rackArea']) as Obj[];
      const rackItems = rackArea[0]!['rackItems'] as Obj[];
      const generated = rackItems.find(item => !['server-1', 'manual-switch-1'].includes(String(item['id'])))!;
      generatedId = String(generated['id']);
      generated['position'] = 6;
      if (failAt === 'malformed-layout') {
        return { raw: { rackArea: 'invalid', nonRackArea: [], connections: [] } } as never;
      }
      if (failAt === 'dropped-generated-switch') {
        rackArea[0]!['rackItems'] = rackItems.filter(item => String(item['id']) !== generatedId);
      }
      return { raw: { rackArea, nonRackArea: [], connections: [] } } as never;
    }
    if (request.endpoint === 'workspace_autoDerive') {
      return { raw: {
        configurations: [{ ...(fixture['launch'] as Obj), id: generatedId, totalPrice: 1450, quantity: 1 }],
        autoDerivedResults: [{ id: 'leaf-installation', appliedConfigurations: [generatedId] }],
      } } as never;
    }
    throw new Error(`Unexpected ${request.endpoint}`);
  });
  return { service, workspace, calls, send };
}

function snapshot(service: DcscService): unknown {
  const copy = structuredClone(service.sessions.listWorkspaces());
  for (const workspace of copy) {
    workspace.lastAccessAt = 0;
    for (const session of workspace.configurations.values()) session.lastAccessAt = 0;
  }
  return copy;
}

const leafSelection = [{
  networkTypeId: 'network:Management',
  layout: 'Distributed' as const,
  mainDeviceId: 'device:BPC7:7D5FCTOFWW',
  leafDeviceId: 'device:BPC7:7D5FCTOFWW',
  mainTrunks: 1,
  leafTrunks: 1,
  leafCabling: 'Balance Connections across leaf switches (best performance)',
}];

describe('network preference Close switch provisioning', () => {
  it('matches Close provisioning without generating a connection graph', async () => {
    const { service, workspace, calls } = setup();
    const write = vi.fn();
    service.sessions.setPersistenceWriter(write);
    const previousRevision = workspace.revision;

    const result = await service.setNetworkPreferences(workspace.id, {
      selections: leafSelection,
      expectedRevision: previousRevision,
      autoConnect: false,
      ctx: service.newCtx(),
    });

    expect(calls.map(call => call.endpoint)).toEqual([
      'switch_calculation',
      'automatic_switch_launch',
      'racks_customize',
      'workspace_autoDerive',
    ]);
    expect(calls.some(call => call.endpoint === 'auto_connect')).toBe(false);
    expect(calls[0]!.query).toEqual({ autoArrange: true, autoConnect: true, cogValidation: true });
    expect(calls[1]!.path).toBe('/ctos/7D5FCTOFWW/launch');
    expect(calls[2]!.path).toBe('/ctos/racks/customize');
    expect(calls[3]!.path).toBe('/ctos/autoDerive');
    expect(workspace.configurations.size).toBe(4);
    expect([...workspace.configurations.values()]).toContainEqual(expect.objectContaining({
      configurationId: expect.not.stringMatching(/^(rack|server|manual-switch)-1$/),
      raw: expect.objectContaining({ totalPrice: 1450 }),
    }));
    expect(workspace.serverState.clusterPreference).toMatchObject([{
      networkLayout: 'Distributed',
      mainSwitch: { option: '7D5FCTOFWW', feature: 'BPC7' },
      leafSwitch: { option: '7D5FCTOFWW', feature: 'BPC7' },
      trunks: 1,
      leafTrunks: 1,
      leafCabling: 'Balance Connections across leaf switches (best performance)',
    }]);
    expect(result).toMatchObject({
      workspace: workspace.id,
      revision: previousRevision + 1,
      connectionGraphStale: true,
      autoConnectRequired: true,
    });
    expect(workspace.serverState.connectionGraphInvalidation).toBeDefined();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([
    'switch_calculation',
    'automatic_switch_launch',
    'racks_customize',
    'workspace_autoDerive',
  ])('does not publish preferences or a generated leaf after %s fails', async endpoint => {
    const { service, workspace } = setup(endpoint);
    const before = snapshot(service);
    await expect(service.setNetworkPreferences(workspace.id, {
      selections: leafSelection,
      expectedRevision: workspace.revision,
      autoConnect: false,
      ctx: service.newCtx(),
    })).rejects.toThrow(`Injected ${endpoint}`);
    expect(snapshot(service)).toEqual(before);
  });

  it.each([
    ['malformed-layout', /incomplete|rackArea|layout/i],
    ['dropped-generated-switch', /generated|switch|layout/i],
  ] as const)('rejects %s customize output without publishing it', async (failure, message) => {
    const { service, workspace } = setup(failure);
    const before = snapshot(service);
    await expect(service.setNetworkPreferences(workspace.id, {
      selections: leafSelection,
      expectedRevision: workspace.revision,
      autoConnect: false,
      ctx: service.newCtx(),
    })).rejects.toThrow(message);
    expect(snapshot(service)).toEqual(before);
  });

  it('does not publish the remote-applied leaf when persistence fails', async () => {
    const { service, workspace } = setup();
    const before = snapshot(service);
    const write = vi.fn(() => { throw new Error('disk full'); });
    service.sessions.setPersistenceWriter(write);
    await expect(service.setNetworkPreferences(workspace.id, {
      selections: leafSelection,
      expectedRevision: workspace.revision,
      autoConnect: false,
      ctx: service.newCtx(),
    })).rejects.toMatchObject({ remoteApplied: true, localNotCommitted: true });
    expect(snapshot(service)).toEqual(before);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
