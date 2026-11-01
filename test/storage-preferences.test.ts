import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import type { FabricOptions } from '../src/domain/fabric.js';
import {
  addStorageConnectionNetwork,
  buildStorageConnectionNetwork,
  DIRECT_ATTACHED,
  listStorageExpansions,
  reconfigureStorageConnectionNetwork,
} from '../src/domain/storagePreferences.js';

const fabric: FabricOptions = {
  topologies: [], networkDevices: [], networkTypes: [], cables: [], selectedServices: [], nodeRoles: [],
  storageSwitches: [{
    id: 'storage-switch:7DHNCTO1WW:C1FM', option: '7DHNCTO1WW', featureCode: 'C1FM',
    description: 'ThinkSystem DB710S', price: 0.01, futureSwitchField: 'lookup-only',
  }],
  storageControllers: [{
    id: 'storage-controller:4587LC2', option: '4587LC2', featureCode: '',
    description: 'ThinkSystem D1224', price: 0.01, futureControllerField: 'lookup-only',
    expansions: [{ option: '4587LC2', featureCode: '', description: 'D1224 expansion', price: 0.01,
      maximum: 8, futureExpansionField: 'lookup-only' }],
  }, {
    id: 'storage-controller:no-expansion', option: '7D4FCTO1WW', featureCode: 'BCBN',
    description: 'Drive Pack Upgrade', expansions: [],
  }],
};

describe('storage preference reconfiguration', () => {
  const definition = () => ({ ...buildStorageConnectionNetwork(fabric, {
    name: 'SAN', controllerId: fabric.storageControllers[0]!.id,
  }), futureField: { retained: true } });

  it('changes an unlaunched controller and resets its expansion, preserving other preferences', () => {
    const current = definition();
    const result = reconfigureStorageConnectionNetwork([current], fabric, 'SAN', {
      controllerId: 'storage-controller:no-expansion', layout: 'Minimal Cabling', type: 'Balance Warehouse',
    });
    expect(result[0]).toEqual({ ...current, controller: { option: '7D4FCTO1WW', featureCode: 'BCBN' },
      expansion: {}, maximumExpansions: 0, layout: 'Minimal Cabling', type: 'Balance Warehouse' });
    expect(current.controller.option).toBe('4587LC2');
  });

  it('preserves managed identities for unchanged choices and enforces the website controller lock', () => {
    const current = definition();
    current.controller.id = 'managed-controller';
    expect(reconfigureStorageConnectionNetwork([current], fabric, 'SAN', {
      controllerId: fabric.storageControllers[0]!.id,
    })[0]!.controller).toEqual(current.controller);
    expect(() => reconfigureStorageConnectionNetwork([current], fabric, 'SAN', {
      controllerId: fabric.storageControllers[1]!.id,
    })).toThrow('locks the controller');
  });

  it('allows layout changes when placed but rejects type changes until controllers are unracked', () => {
    const current = definition();
    current.controller.id = 'managed-controller';
    const placed = new Set(['managed-controller']);
    expect(reconfigureStorageConnectionNetwork([current], fabric, 'SAN', {
      layout: 'Minimal Cabling',
    }, placed)[0]).toMatchObject({ layout: 'Minimal Cabling', controller: { id: 'managed-controller' } });
    expect(() => reconfigureStorageConnectionNetwork([current], fabric, 'SAN', {
      type: 'Balance Warehouse',
    }, placed)).toThrow('out of their racks');
    expect(reconfigureStorageConnectionNetwork([current], fabric, 'SAN', {
      type: 'Balance Warehouse',
    })[0]!.type).toBe('Balance Warehouse');
  });

  it('resets SAN selection identity only for a changed product and retains unrelated fields', () => {
    const current = definition();
    current.mainSwitch = { hardwareType: 'switch', option: '7DHNCTO1WW', featureCode: 'C1FM', id: 'managed-switch' };
    expect(reconfigureStorageConnectionNetwork([current], fabric, 'SAN', {
      switchId: fabric.storageSwitches[0]!.id,
    })[0]!.mainSwitch).toEqual(current.mainSwitch);
    expect(reconfigureStorageConnectionNetwork([current], fabric, 'SAN', {
      switchId: DIRECT_ATTACHED,
    })[0]).toMatchObject({ mainSwitch: { hardwareType: 'switch', option: '', featureCode: '' },
      futureField: { retained: true } });
    expect(reconfigureStorageConnectionNetwork([current], fabric, 'SAN', {
      switchId: DIRECT_ATTACHED,
    })[0]!.mainSwitch).not.toHaveProperty('id');
  });

  it('checks expansion capacity and placement, retaining identities for quantity-only edits', () => {
    const current = definition();
    current.expansion.id = 'managed-expansion';
    expect(reconfigureStorageConnectionNetwork([current], fabric, 'SAN', {
      expansionQuantity: 4,
    })[0]).toMatchObject({ maximumExpansions: 4, expansion: { id: 'managed-expansion', quantity: 4 } });
    for (const quantity of [-1, 0.5, 9]) expect(() => reconfigureStorageConnectionNetwork([current], fabric,
      'SAN', { expansionQuantity: quantity })).toThrow('integer between');
    expect(() => reconfigureStorageConnectionNetwork([current], fabric, 'SAN', {
      expansionQuantity: 4,
    }, new Set(['managed-expansion']))).toThrow('out of their racks');
    expect(() => reconfigureStorageConnectionNetwork([current], fabric, 'SAN', {})).toThrow('at least one');
  });
});

describe('storage preference builder', () => {
  it('matches the captured unassigned controller-only Add Storage definition', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/storage-network-create.json', import.meta.url), 'utf8'));
    const capturedFabric: FabricOptions = { ...fabric, storageControllers: [{
      id: 'storage-controller:captured', option: '7D4FCTO6WW', featureCode: 'BCBN',
      description: 'Captured default controller', expansions: [],
    }] };
    expect(buildStorageConnectionNetwork(capturedFabric, {
      name: 'Parity Storage', controllerId: 'storage-controller:captured',
    })).toEqual(fixture.storageConnectionNetworks[0]);
  });

  it('builds the exact compact Add Storage schema with the UI defaults', () => {
    const network = buildStorageConnectionNetwork(fabric, {
      name: 'Primary SAN', controllerId: 'storage-controller:4587LC2', switchId: DIRECT_ATTACHED,
    });
    expect(network).toEqual({
      name: 'Primary SAN', maximumExpansions: 1, type: 'General Storage', layout: 'Fully Redundant',
      controller: { hardwareType: 'storage', option: '4587LC2', featureCode: '' },
      expansion: { hardwareType: 'storage', option: '4587LC2', featureCode: '' },
      mainSwitch: { hardwareType: 'switch' },
    });
    expect(JSON.stringify(network)).not.toContain('lookup-only');
  });

  it('resolves switch and expansion choices by stable IDs and validates quantities', () => {
    const expansion = listStorageExpansions(fabric.storageControllers[0]!)[0]!;
    expect(expansion).toMatchObject({ controllerId: 'storage-controller:4587LC2', maximum: 8 });
    const network = buildStorageConnectionNetwork(fabric, {
      name: 'Warehouse', type: 'Balance Warehouse', layout: 'Minimal Cabling',
      controllerId: 'storage-controller:4587LC2', expansionId: expansion.id, expansionQuantity: 6,
      switchId: 'storage-switch:7DHNCTO1WW:C1FM',
    });
    expect(network).toMatchObject({
      maximumExpansions: 6, type: 'Balance Warehouse', layout: 'Minimal Cabling',
      expansion: { hardwareType: 'storage', option: '4587LC2', featureCode: '', quantity: 6 },
      mainSwitch: { hardwareType: 'switch', option: '7DHNCTO1WW', featureCode: 'C1FM' },
    });
    expect(() => buildStorageConnectionNetwork(fabric, {
      name: 'Too many', controllerId: 'storage-controller:4587LC2', expansionQuantity: 9,
    })).toThrow(/exceeds.*maximum of 8/i);
  });

  it('represents controllers without expansions and rejects impossible quantities', () => {
    expect(buildStorageConnectionNetwork(fabric, {
      name: 'Expansion disabled', controllerId: 'storage-controller:4587LC2', expansionQuantity: 0,
    })).toMatchObject({
      maximumExpansions: 0,
      expansion: { hardwareType: 'storage', option: '4587LC2', featureCode: '', quantity: 0 },
    });
    expect(buildStorageConnectionNetwork(fabric, {
      name: 'Controller only', controllerId: 'storage-controller:no-expansion', expansionQuantity: 0,
    })).toMatchObject({ maximumExpansions: 0, expansion: { hardwareType: 'storage' } });
    expect(() => buildStorageConnectionNetwork(fabric, {
      name: 'Invalid', controllerId: 'storage-controller:no-expansion', expansionQuantity: 1,
    })).toThrow(/has no expansion.*must be 0/i);
  });

  it('preserves existing networks and enforces the UI unique-name rule', () => {
    const existing = [{
      name: 'Existing', maximumExpansions: 0, type: 'General Storage' as const,
      layout: 'Fully Redundant' as const, controller: {}, expansion: {}, mainSwitch: {}, future: true,
    }];
    const updated = addStorageConnectionNetwork(existing, fabric, {
      name: 'New SAN', controllerId: 'storage-controller:no-expansion',
    });
    expect(updated[0]).toEqual(existing[0]);
    expect(updated[0]).not.toBe(existing[0]);
    expect(() => addStorageConnectionNetwork(existing, fabric, {
      name: ' existing ', controllerId: 'storage-controller:no-expansion',
    })).toThrow(/already exists.*unique name/i);
  });

  it('rejects stale network names and non-stable catalog selections with candidate IDs', () => {
    expect(() => buildStorageConnectionNetwork(fabric, {
      name: 'Bad', controllerId: '4587LC2',
    })).toThrow(/Unknown controllerId.*storage-controller:4587LC2/i);
  });
});
