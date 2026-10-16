import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  parseStoragePlacementResponse,
  resolveStoragePhysicalAliases,
  stageStorageNetworkPlacement,
} from '../src/domain/storagePlacement.js';
import type { RackObject } from '../src/domain/rack.js';
import type { StorageConnectionNetwork } from '../src/domain/storagePreferences.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/parity/storage-physical-placement.json', import.meta.url), 'utf8',
)) as {
  network: StorageConnectionNetwork;
  components: { controller: RackObject; mainSwitch: RackObject };
  first: {
    physicalIds: { controller: string; mainSwitch: string };
    dependency: Record<string, string[]>;
    colorDependency: Record<string, { dependBy: string[] }>;
    accepted: Record<'controller' | 'mainSwitch', { position: number; size: number; quantity: number }>;
  };
  second: {
    physicalIds: { controller: string; mainSwitch: string };
    dependency: Record<string, string[]>;
    colorDependency: Record<string, { dependBy: string[] }>;
    accepted: Record<'controller' | 'mainSwitch', { position: number; size: number; quantity: number }>;
  };
};

const rack = (): RackObject => ({
  id: 'rack-1', code: '7D6DCTO1WW', type: 'rack', size: 42, lockedSpace: [], rackItems: [],
});

function components(ids: { controller: string; mainSwitch: string }) {
  return [
    { role: 'controller' as const, physicalId: ids.controller, configuration: fixture.components.controller },
    { role: 'mainSwitch' as const, physicalId: ids.mainSwitch, configuration: fixture.components.mainSwitch },
  ];
}

function acceptedResponse(staged: ReturnType<typeof stageStorageNetworkPlacement>, values: typeof fixture.first.accepted) {
  const rackArea = structuredClone(staged.rackArea);
  const items = rackArea[0]!.rackItems as RackObject[];
  for (const entry of staged.physicalItems) {
    const item = items.find(candidate => candidate.id === entry.physicalId)!;
    Object.assign(item, values[entry.role]);
    if (entry.role === 'controller') {
      item.originalId = 'browser-returned-source';
      item.controllerExpansion = { controllerId: entry.physicalId, expansionIds: [] };
    }
  }
  return { rackArea, nonRackArea: [], connections: [] };
}

describe('storage physical placement', () => {
  it('stages the first browser placement with templates-only wire configurations', () => {
    const staged = stageStorageNetworkPlacement({
      rackArea: [rack()], nonRackArea: [], storageConnectionNetworks: [fixture.network],
      cloneDependency: { 'rack-1': ['rack-1'], unrelated: ['unrelated', 'unrelated-alias'] },
      rackId: 'rack-1', networkName: fixture.network.name, components: components(fixture.first.physicalIds),
    });

    expect(staged.templateConfigurationIds).toEqual(['controller-template', 'switch-template']);
    expect(staged.wireConfigurations.map(value => value.id)).toEqual(['controller-template', 'switch-template']);
    expect(JSON.stringify(staged.wireConfigurations)).not.toContain('physical-1');
    expect(staged.cloneDependency).toEqual({
      ...fixture.first.dependency,
      unrelated: ['unrelated', 'unrelated-alias'],
    });
    expect(staged.physicalToTemplate).toEqual({
      'controller-physical-1': 'controller-template',
      'switch-physical-1': 'switch-template',
    });
    expect((staged.rackArea[0]!.rackItems as RackObject[])).toEqual([
      {
        id: 'controller-physical-1', code: '7DP4CTO1WW', type: 'storage', position: 1,
        features: [{ name: 'BASE', results: [{
          code: 'BF3C', quantity: 1, installations: [],
          description: 'Lenovo ThinkSystem Storage 2U NVMe Chassis', type: 'hardware',
        }] }],
        description: 'Lenovo ThinkSystem DS3200 Storage Array', name: 'Controller',
      },
      {
        id: 'switch-physical-1', code: '7DHNCTO1WW', type: 'switch', position: 1,
        features: [{ name: 'BASE', results: [{
          code: 'C1FM', quantity: 1, installations: [], description: 'DB710S 8-port base', type: 'hardware',
        }] }],
        description: 'Lenovo ThinkSystem DB710S', name: 'Switch',
      },
    ]);
    expect(staged.physicalItems.every(item => item.originalId === undefined && item.controllerExpansion === undefined)).toBe(true);
  });

  it('reuses templates for a repeated placement while preserving prior aliases byte-for-byte', () => {
    const first = stageStorageNetworkPlacement({
      rackArea: [rack()], nonRackArea: [], storageConnectionNetworks: [fixture.network],
      cloneDependency: { 'rack-1': ['rack-1'] }, rackId: 'rack-1', networkName: fixture.network.name,
      components: components(fixture.first.physicalIds),
    });
    const second = stageStorageNetworkPlacement({
      rackArea: first.rackArea, nonRackArea: first.nonRackArea,
      storageConnectionNetworks: [fixture.network], cloneDependency: first.cloneDependency,
      rackId: 'rack-1', networkName: fixture.network.name, components: components(fixture.second.physicalIds),
    });

    expect(second.templateConfigurationIds).toEqual(first.templateConfigurationIds);
    expect(second.cloneDependency).toEqual(fixture.second.dependency);
    expect(Object.fromEntries(Object.entries(fixture.second.colorDependency)
      .map(([id, color]) => [id, color.dependBy]))).toEqual({
      'controller-template': fixture.second.dependency['controller-template'],
      'switch-template': fixture.second.dependency['switch-template'],
    });
    expect((second.rackArea[0]!.rackItems as RackObject[]).map(item => item.id)).toEqual([
      'controller-physical-1', 'switch-physical-1', 'controller-physical-2', 'switch-physical-2',
    ]);
  });

  it('validates DCSC placements and retains returned source/controller metadata', () => {
    const staged = stageStorageNetworkPlacement({
      rackArea: [rack()], nonRackArea: [], storageConnectionNetworks: [fixture.network],
      rackId: 'rack-1', networkName: fixture.network.name, components: components(fixture.first.physicalIds),
    });
    const accepted = parseStoragePlacementResponse(acceptedResponse(staged, fixture.first.accepted), staged);
    expect(accepted.map(item => ({ role: item.role, position: item.position, size: item.size, quantity: item.quantity }))).toEqual([
      { role: 'controller', ...fixture.first.accepted.controller },
      { role: 'mainSwitch', ...fixture.first.accepted.mainSwitch },
    ]);
    expect(accepted[0]).toMatchObject({
      originalId: 'browser-returned-source',
      controllerExpansion: { controllerId: 'controller-physical-1', expansionIds: [] },
    });
    expect(() => parseStoragePlacementResponse({ rackArea: [rack()], nonRackArea: [], connections: [] }, staged))
      .toThrow(/did not retain storage physical/i);
  });

  it('resolves placed aliases to managed templates without synthesizing configurations', () => {
    const staged = stageStorageNetworkPlacement({
      rackArea: [rack()], nonRackArea: [], storageConnectionNetworks: [fixture.network],
      cloneDependency: { 'rack-1': ['rack-1'] }, rackId: 'rack-1', networkName: fixture.network.name,
      components: components(fixture.first.physicalIds),
    });
    const aliases = resolveStoragePhysicalAliases({
      rackArea: staged.rackArea, nonRackArea: staged.nonRackArea,
      storageConnectionNetworks: [fixture.network], cloneDependency: staged.cloneDependency,
    });
    expect(aliases.map(value => ({
      physicalId: value.physicalId, templateId: value.templateId, roles: value.roles,
      networkNames: value.networkNames, area: value.area, rackId: value.rackId,
    }))).toEqual([
      {
        physicalId: 'controller-physical-1', templateId: 'controller-template', roles: ['controller'],
        networkNames: ['Parity Physical Storage'], area: 'rack', rackId: 'rack-1',
      },
      {
        physicalId: 'switch-physical-1', templateId: 'switch-template', roles: ['mainSwitch'],
        networkNames: ['Parity Physical Storage'], area: 'rack', rackId: 'rack-1',
      },
    ]);
  });

  it('rejects stale definitions, reused identities and uncaptured expansion placement', () => {
    expect(() => stageStorageNetworkPlacement({
      rackArea: [rack()], nonRackArea: [], storageConnectionNetworks: [fixture.network],
      rackId: 'rack-1', networkName: 'missing', components: components(fixture.first.physicalIds),
    })).toThrow(/storage network.*unknown/i);

    expect(() => stageStorageNetworkPlacement({
      rackArea: [{ ...rack(), rackItems: [{ id: 'controller-physical-1', code: 'other', type: 'server' }] }],
      nonRackArea: [], storageConnectionNetworks: [fixture.network], rackId: 'rack-1',
      networkName: fixture.network.name, components: components(fixture.first.physicalIds),
    })).toThrow(/already exists/i);

    const withExpansion = structuredClone(fixture.network);
    withExpansion.expansion = {
      hardwareType: 'storage', option: '7D1ACTO1WW', featureCode: 'BASE', id: 'expansion-template',
    };
    expect(() => stageStorageNetworkPlacement({
      rackArea: [rack()], nonRackArea: [], storageConnectionNetworks: [withExpansion],
      rackId: 'rack-1', networkName: withExpansion.name, components: components(fixture.first.physicalIds),
    })).toThrow(/expansion placement is not captured/i);
  });

  it('rejects unsafe managed-template alias graphs instead of silently dropping members', () => {
    const base = stageStorageNetworkPlacement({
      rackArea: [rack()], nonRackArea: [], storageConnectionNetworks: [fixture.network],
      rackId: 'rack-1', networkName: fixture.network.name, components: components(fixture.first.physicalIds),
    });
    expect(() => resolveStoragePhysicalAliases({
      rackArea: [rack()], nonRackArea: [], storageConnectionNetworks: [fixture.network],
      cloneDependency: base.cloneDependency,
    })).toThrow(/aliases missing physical identity/i);

    const wrongType = structuredClone(base.rackArea);
    const controller = (wrongType[0]!.rackItems as RackObject[])
      .find(item => item.id === fixture.first.physicalIds.controller)!;
    controller.type = 'switch';
    expect(() => resolveStoragePhysicalAliases({
      rackArea: wrongType, nonRackArea: [], storageConnectionNetworks: [fixture.network],
      cloneDependency: base.cloneDependency,
    })).toThrow(/does not match.*code and type/i);

    expect(() => resolveStoragePhysicalAliases({
      rackArea: base.rackArea, nonRackArea: [], storageConnectionNetworks: [fixture.network],
      cloneDependency: {
        foreign: ['foreign', 'controller-template', fixture.first.physicalIds.controller],
        'switch-template': ['switch-template', fixture.first.physicalIds.mainSwitch],
      },
    })).toThrow(/nested under dependency root foreign/i);

    const conflictingRole = structuredClone(fixture.network);
    conflictingRole.mainSwitch = {
      ...conflictingRole.mainSwitch,
      id: 'controller-template', option: '7DP4CTO1WW', hardwareType: 'switch',
    };
    expect(() => resolveStoragePhysicalAliases({
      rackArea: base.rackArea, nonRackArea: [], storageConnectionNetworks: [fixture.network, conflictingRole],
      cloneDependency: base.cloneDependency,
    })).toThrow(/conflicting code, type or component roles/i);
  });
});
