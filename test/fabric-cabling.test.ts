import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { autoConnect, buildClusterPreferences, buildSwitchMapEntry } from '../src/domain/cabling.js';
import { fetchFabricOptions, paginateFabric } from '../src/domain/fabric.js';
import type { DcscHttpClient, RequestCtx, SendInput } from '../src/http/request.js';

const fixture = JSON.parse(readFileSync('test/fixtures/parity/fabric-cabling.json', 'utf8')) as {
  topology: unknown;
  roles: unknown;
  storage: unknown;
  autoConnectResponse: Record<string, unknown>;
};
const ctx = { corrId: 'test', locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' } } as RequestCtx;

function httpReturning(byEndpoint: Record<string, unknown>, calls: SendInput[] = []): DcscHttpClient {
  return { send: async (input: SendInput) => {
    calls.push(input);
    return { status: 200, headers: {}, requestId: undefined, traceId: undefined, durationMs: 1,
      raw: byEndpoint[input.endpoint] };
  } } as unknown as DcscHttpClient;
}

describe('fabric vocabulary', () => {
  it('preserves every endpoint collection and unknown server fields', async () => {
    const fabric = await fetchFabricOptions(httpReturning({
      getTopologies: fixture.topology, node_roles: fixture.roles,
      getStoragePreferences: fixture.storage,
    }), ctx);

    expect(Object.fromEntries(Object.entries(fabric).map(([key, value]) => [key, value.length]))).toEqual({
      topologies: 1, networkDevices: 1, networkTypes: 1, cables: 1, selectedServices: 1,
      nodeRoles: 1, storageSwitches: 1, storageControllers: 1,
    });
    expect(fabric.topologies[0]?.futureTopologyField).toBe(true);
    expect(fabric.nodeRoles[0]?.futureRoleField).toBe('kept');
    expect(fabric.storageControllers[0]?.futureControllerField).toBe('kept');
    expect(fabric.storageControllers[0]?.expansions).toEqual([{ option: '4587LC2', maximum: 8 }]);
    expect(fabric.networkDevices[0]?.id).toBe('network-device:7D5FCTOFWW:BPC7:NVIDIA SN2201');
  });

  it('paginates deterministically and reports the true total', () => {
    const values = Array.from({ length: 5 }, (_, index) => ({ id: `item-${index}` }));
    const first = paginateFabric(values, { limit: 2 });
    const second = paginateFabric(values, { offset: first.nextOffset, limit: 2 });
    const third = paginateFabric(values, { offset: second.nextOffset, limit: 2 });
    expect([first.total, first.nextOffset, second.nextOffset, third.nextOffset]).toEqual([5, 2, 4, undefined]);
    expect([...first.items, ...second.items, ...third.items]).toEqual(values);
  });

  it('builds the same network preference and switch-map shapes as the SPA', async () => {
    const fabric = await fetchFabricOptions(httpReturning({
      getTopologies: fixture.topology, node_roles: fixture.roles,
      getStoragePreferences: fixture.storage,
    }), ctx);
    expect(buildClusterPreferences(fabric.networkDevices, fabric.networkTypes)).toEqual([{
      cableColor: 'Green', cableType: 'Cat5E',
      mainSwitch: { feature: 'BPC7', option: '7D5FCTOFWW', topologyConnectors: { '1GbE_Copper': 48 } },
      maximumPorts: 48, name: 'Management', networkLayout: 'Centralized',
      networkType: '1GbE_Copper', trunks: 1, vlan: [], customCable: undefined,
      leafCableColor: undefined, leafCableType: '', leafSwitch: {}, leafMaximumPorts: 0,
      leafTrunks: 0, leafCabling: '',
    }]);
    expect(buildSwitchMapEntry('switch-1', 'Management', 'main', '7D5FCTOFWW')).toEqual({
      id: 'switch-1', network: 'Management', type: 'main', code: '7D5FCTOFWW',
    });
  });
});

describe('auto-connect state adapter', () => {
  it('passes complete workspace state and preserves complete response state', async () => {
    const calls: SendInput[] = [];
    const priorConnections = [{ id: 'manual-or-stale-row', cablePart: 'OLD' }];
    const payload = {
      rackArea: [{ id: 'rack-1' }],
      nonRackArea: [{ id: 'loose-1' }],
      configurations: [{ id: 'server-1', tabs: [] }],
      floorItems: [{ id: 'grid-cell', rackId: 'rack-1', x: 3, y: 4, futureCellField: true }],
      clusterPreference: [{ name: 'Management' }],
      storageConnectionNetworks: [{ controllerId: 'storage-1', network: 'Storage' }],
      autoConnectSettings: { autoAddPDU: false, autoAddSwitch: true, p2pCabling: true },
      switchMap: [{ id: 'switch-1', usage: 'main', network: 'Management' }],
      virtualContainerIdMapping: { virtual: 'physical' },
      connections: priorConnections,
      futureRequestField: { kept: true },
    };
    const result = await autoConnect(httpReturning({ auto_connect: fixture.autoConnectResponse }, calls), ctx, payload);
    const sent = calls[0]?.body?.kind === 'json'
      ? calls[0].body.value as Record<string, unknown>
      : {};
    const floorItems = sent['floorItems'] as Array<Record<string, unknown>>;
    expect(floorItems[0]?.['futureCellField']).toBe(true);
    expect(sent.storageConnectionNetworks).toEqual([{ controllerId: 'storage-1', network: 'Storage' }]);
    expect(sent.futureRequestField).toEqual({ kept: true });
    expect(sent.cloneDependency).toEqual({ 'server-1': ['server-1'] });
    expect(sent).not.toHaveProperty('connections');
    expect(payload.connections).toEqual(priorConnections);

    expect(result.connections[0]).toMatchObject({
      fromId: 'server-1', toId: 'switch-1', fromPort: 'RJ45 mgmt - 1', toPort: 'RJ45 - 12',
      cableCode: '3760', description: 'Cat5E', network: 'Management', topology: '1GbE_Copper',
    });
    expect(result.connections[0]?.raw.futureConnectionField).toBe('kept');
    expect(result.cables[0]).toMatchObject({ fromConfigId: 'server-1', toConfigId: 'switch-1' });
    expect(result.rawState.futureResponseField).toEqual({ kept: true });
    expect(result.errors).toEqual([{ code: 'FABRIC_WARNING', message: 'example' }]);
    expect(result.messages).toEqual([{ rackId: 'rack-1', messages: ['Review cable routing'] }]);
  });

  it('omits prior graph rows without mutating them when auto-connect fails', async () => {
    const priorConnections = [{ id: 'manual-row', cablePart: '3791' }];
    let sent: Record<string, unknown> | undefined;
    const http = { send: async (input: SendInput) => {
      sent = input.body?.kind === 'json' ? input.body.value as Record<string, unknown> : {};
      throw new Error('connection calculation failed');
    } } as unknown as DcscHttpClient;
    const payload = {
      rackArea: [{ id: 'rack-1' }], configurations: [{ id: 'server-1', tabs: [] }],
      connections: priorConnections,
    };

    await expect(autoConnect(http, ctx, payload)).rejects.toThrow('connection calculation failed');
    expect(sent).not.toHaveProperty('connections');
    expect(payload.connections).toEqual(priorConnections);
  });
});
