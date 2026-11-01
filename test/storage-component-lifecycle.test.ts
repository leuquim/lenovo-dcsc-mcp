import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  NATIVE_DETACHED_STORAGE_COMMERCIAL_DIFFERENCE,
  readDetachedStorageComponents,
  retainReplacedStorageComponents,
} from '../src/domain/storageComponentLifecycle.js';
import {
  managedStorageComponentIds,
  storageComponentQuantities,
  storagePhysicalTemplateIds,
  type StorageConnectionNetwork,
} from '../src/domain/storagePreferences.js';
import { removeWorkspaceReferences } from '../src/domain/workspaceReferences.js';
import type { WorkspaceSession } from '../src/model/session.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/parity/storage-san-replacement.json', import.meta.url), 'utf8',
)) as {
  definitionName: string;
  template: { id: string; code: string; type: 'switch' };
  physical: { id: string; rackId: string; position: number; code: string; type: 'switch' };
  before: { mainSwitch: Record<string, unknown>; cloneDependency: string[] };
  after: { mainSwitch: Record<string, unknown>; mcpCorrectedPhysicalQuantity: number; nativeCommercialDifference: string };
};

const controller = {
  hardwareType: 'storage', option: '7DP4CTO1WW', featureCode: 'BF3C', id: 'controller-template',
};

function networks(): { before: StorageConnectionNetwork[]; after: StorageConnectionNetwork[] } {
  const base = {
    name: fixture.definitionName,
    maximumExpansions: 0,
    type: 'General Storage' as const,
    layout: 'Fully Redundant' as const,
    controller,
    expansion: {},
  };
  return {
    before: [{ ...base, mainSwitch: structuredClone(fixture.before.mainSwitch) }],
    after: [{ ...base, mainSwitch: structuredClone(fixture.after.mainSwitch) }],
  };
}

function shape() {
  const { before, after } = networks();
  const serverState: Record<string, unknown> = {
    storageConnectionNetworks: before,
    cloneDependency: {
      'controller-template': ['controller-template'],
      [fixture.template.id]: fixture.before.cloneDependency,
    },
    cloneDependencyColor: {
      [fixture.template.id]: { color: '#25d0bb', dependBy: fixture.before.cloneDependency },
    },
  };
  const rackArea = [{ id: fixture.physical.rackId, code: 'RACK', type: 'rack', rackItems: [{
    id: fixture.physical.id,
    code: fixture.physical.code,
    type: fixture.physical.type,
    position: fixture.physical.position,
    size: 1,
    quantity: 1,
  }] }];
  return { before, after, serverState, rackArea, nonRackArea: [] };
}

function workspaceForRemoval(source: ReturnType<typeof shape>): WorkspaceSession {
  return {
    id: 'workspace', locale: {} as WorkspaceSession['locale'], solution: {} as WorkspaceSession['solution'],
    revision: 1, createdAt: 0, updatedAt: 0, history: [], future: [], configurations: new Map(), racks: new Map(),
    rackArea: structuredClone(source.rackArea), nonRackArea: [], floorItems: [], rackSummaries: [], cables: [],
    powerSelections: [], serverState: structuredClone(source.serverState),
  } as unknown as WorkspaceSession;
}

describe('detached storage component lifecycle', () => {
  it('retains the replaced SAN template and physical alias without making it an active network', () => {
    const source = shape();
    const result = retainReplacedStorageComponents({
      workspace: source,
      previousNetworks: source.before,
      nextNetworks: source.after,
      definitionName: fixture.definitionName,
    });

    expect(result.retained).toEqual([{
      templateId: fixture.template.id,
      code: fixture.template.code,
      type: fixture.template.type,
      roles: ['mainSwitch'],
      physicalIds: [fixture.physical.id],
      sourceNetworkName: fixture.definitionName,
      reason: 'definition-replaced',
      nativeCommercialDifference: NATIVE_DETACHED_STORAGE_COMMERCIAL_DIFFERENCE,
    }]);
    expect(result.detachedStorageComponents).toEqual(result.retained);
    expect(source.serverState.cloneDependency).toEqual({
      'controller-template': ['controller-template'],
      [fixture.template.id]: fixture.before.cloneDependency,
    });
    expect(source.rackArea[0]!.rackItems).toHaveLength(1);
  });

  it('keeps detached roots managed and counts only their physical aliases', () => {
    const source = shape();
    const transition = retainReplacedStorageComponents({
      workspace: source, previousNetworks: source.before, nextNetworks: source.after,
      definitionName: fixture.definitionName,
    });
    source.serverState.storageConnectionNetworks = source.after;
    source.serverState.detachedStorageComponents = transition.detachedStorageComponents;

    expect(managedStorageComponentIds(source.serverState)).toEqual(
      new Set(['controller-template', fixture.template.id]),
    );
    expect(storagePhysicalTemplateIds(source)).toEqual(new Map([[fixture.physical.id, fixture.template.id]]));
    expect(storageComponentQuantities(source).get(fixture.template.id))
      .toBe(fixture.after.mcpCorrectedPhysicalQuantity);
  });

  it('removes a detached record when its root becomes active again', () => {
    const source = shape();
    source.serverState.detachedStorageComponents = [{
      templateId: fixture.template.id, code: fixture.template.code, type: 'switch', roles: ['mainSwitch'],
      physicalIds: [fixture.physical.id], sourceNetworkName: fixture.definitionName,
      reason: 'definition-replaced', nativeCommercialDifference: NATIVE_DETACHED_STORAGE_COMMERCIAL_DIFFERENCE,
    }];
    const result = retainReplacedStorageComponents({
      workspace: source, previousNetworks: source.after, nextNetworks: source.before,
      definitionName: fixture.definitionName,
    });
    expect(result).toEqual({ detachedStorageComponents: [], retained: [] });
  });

  it('prunes an individual physical identity and cascades physical aliases when the template closes', () => {
    const source = shape();
    const transition = retainReplacedStorageComponents({
      workspace: source, previousNetworks: source.before, nextNetworks: source.after,
      definitionName: fixture.definitionName,
    });
    source.serverState.storageConnectionNetworks = source.after;
    source.serverState.detachedStorageComponents = transition.detachedStorageComponents;

    const memberRemoval = workspaceForRemoval(source);
    removeWorkspaceReferences(memberRemoval, new Set([fixture.physical.id]));
    expect(readDetachedStorageComponents(memberRemoval.serverState)[0]!.physicalIds).toEqual([]);
    expect(memberRemoval.serverState.cloneDependency).toMatchObject({ [fixture.template.id]: [fixture.template.id] });

    const templateRemoval = workspaceForRemoval(source);
    removeWorkspaceReferences(templateRemoval, new Set([fixture.template.id]));
    expect(templateRemoval.serverState.detachedStorageComponents).toEqual([]);
    expect(JSON.stringify(templateRemoval.rackArea)).not.toContain(fixture.physical.id);
    expect(templateRemoval.serverState.cloneDependency).not.toHaveProperty(fixture.template.id);
  });

  it('rejects malformed or stale detached identity metadata', () => {
    expect(() => readDetachedStorageComponents({ detachedStorageComponents: [{
      templateId: fixture.template.id, code: fixture.template.code, type: 'switch', roles: ['controller'],
      physicalIds: [], sourceNetworkName: fixture.definitionName, reason: 'definition-replaced',
      nativeCommercialDifference: NATIVE_DETACHED_STORAGE_COMMERCIAL_DIFFERENCE,
    }] })).toThrow(/conflicting type and role/i);

    const source = shape();
    source.serverState.storageConnectionNetworks = source.after;
    source.serverState.detachedStorageComponents = [{
      templateId: fixture.template.id, code: fixture.template.code, type: 'switch', roles: ['mainSwitch'],
      physicalIds: ['missing-physical'], sourceNetworkName: fixture.definitionName,
      reason: 'definition-replaced', nativeCommercialDifference: NATIVE_DETACHED_STORAGE_COMMERCIAL_DIFFERENCE,
    }];
    expect(() => storagePhysicalTemplateIds(source)).toThrow(/physical identities do not match/i);
  });
});
