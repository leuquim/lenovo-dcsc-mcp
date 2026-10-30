import { describe, expect, it } from 'vitest';

import { reconcileImportedCloneOwnership } from '../src/domain/importCloneOwnership.js';

describe('imported clone color ownership classification', () => {
  it('keeps inactive empty presentation metadata out of the ownership partition', () => {
    const colors = { orphan: { color: '#123456', dependBy: [] } };
    const result = reconcileImportedCloneOwnership({
      dependency: { server: ['server'] },
      colors,
      provenance: [],
      activeConfigurationIds: new Set(['server']),
      storageRoots: new Set(),
      storageAliases: new Map(),
      configurations: [],
    });
    expect(result).toEqual({ dependency: { server: ['server'] }, colors, changed: false });
  });

  it('rejects an empty color for an active ordinary dependency', () => {
    expect(() => reconcileImportedCloneOwnership({
      dependency: { server: ['server'] },
      colors: { server: { dependBy: [] } },
      provenance: [],
      activeConfigurationIds: new Set(['server']),
      storageRoots: new Set(),
      storageAliases: new Map(),
      configurations: [],
    })).toThrow(/empty ownership for an active clone identity/);
  });

  it('accepts only the complete physical alias set for rootless storage color metadata', () => {
    const input = {
      dependency: { template: ['template', 'physical-a', 'physical-b'] },
      provenance: [],
      activeConfigurationIds: new Set(['template']),
      storageRoots: new Set(['template']),
      storageAliases: new Map([
        ['physical-a', 'template'],
        ['physical-b', 'template'],
      ]),
      configurations: [],
    };
    expect(reconcileImportedCloneOwnership({
      ...input,
      colors: { 'missing-template': { dependBy: ['physical-a', 'physical-b'] } },
    }).changed).toBe(false);
    expect(() => reconcileImportedCloneOwnership({
      ...input,
      colors: { 'missing-template': { dependBy: ['physical-a'] } },
    })).toThrow(/incomplete or conflicting managed storage ownership/);
  });

  it('rejects duplicate physical storage presentation owners', () => {
    expect(() => reconcileImportedCloneOwnership({
      dependency: { template: ['template', 'physical-a', 'physical-b'] },
      colors: {
        'presentation-a': { dependBy: ['physical-a', 'physical-b'] },
        'presentation-b': { dependBy: ['physical-a', 'physical-b'] },
      },
      provenance: [],
      activeConfigurationIds: new Set(['template']),
      storageRoots: new Set(['template']),
      storageAliases: new Map([
        ['physical-a', 'template'],
        ['physical-b', 'template'],
      ]),
      configurations: [],
    })).toThrow(/overlapping roots/);
  });

  it('rejects an active ordinary root repointed to storage aliases', () => {
    expect(() => reconcileImportedCloneOwnership({
      dependency: { ordinary: ['ordinary'], template: ['template', 'physical-a', 'physical-b'] },
      colors: { ordinary: { dependBy: ['physical-a', 'physical-b'] } },
      provenance: [],
      activeConfigurationIds: new Set(['ordinary', 'template']),
      storageRoots: new Set(['template']),
      storageAliases: new Map([
        ['physical-a', 'template'],
        ['physical-b', 'template'],
      ]),
      configurations: [],
    })).toThrow(/conflicting managed storage ownership/);
  });

  it('rejects a managed storage root that omits an alias and absorbs an ordinary configuration', () => {
    expect(() => reconcileImportedCloneOwnership({
      dependency: { template: ['template', 'physical-a', 'ordinary'] },
      colors: { template: { dependBy: ['template', 'physical-a', 'ordinary'] } },
      provenance: [],
      activeConfigurationIds: new Set(['template', 'ordinary']),
      storageRoots: new Set(['template']),
      storageAliases: new Map([
        ['physical-a', 'template'],
        ['physical-b', 'template'],
      ]),
      configurations: [],
    })).toThrow(/incomplete or conflicting managed storage ownership/);
  });

  it('validates unrelated inert storage colors after reconciling ordinary provenance', () => {
    const colors = {
      c1: { dependBy: ['c1', 'c2'] },
      orphan: { color: '#123456', dependBy: [] },
      storagePresentation: { dependBy: ['physical-a', 'physical-b'] },
    };
    const result = reconcileImportedCloneOwnership({
      dependency: { c1: ['c1', 'c2'], template: ['template', 'physical-a', 'physical-b'] },
      colors,
      provenance: [{
        sourceId: 'c1',
        ids: ['c1', 'c2'],
        original: { id: 'c1', quantity: 2, originalIds: ['c1', 'c2'] },
      }],
      activeConfigurationIds: new Set(['c1', 'c2', 'template']),
      storageRoots: new Set(['template']),
      storageAliases: new Map([
        ['physical-a', 'template'],
        ['physical-b', 'template'],
      ]),
      configurations: [],
    });
    expect(result).toEqual({
      dependency: { c1: ['c1', 'c2'], template: ['template', 'physical-a', 'physical-b'] },
      colors,
      changed: false,
    });
  });
});

it('preserves native color member order independently of physical placement order', () => {
  const colors = { root: { dependBy: ['member', 'root'], color: '#123456' } };
  const result = reconcileImportedCloneOwnership({
    dependency: { root: ['root', 'member'] }, colors,
    provenance: [{ sourceId: 'root', ids: ['root', 'member'], original: {
      id: 'root', quantity: 2, originalIds: ['root', 'member'],
    } }],
    activeConfigurationIds: new Set(['root', 'member']), storageRoots: new Set(), configurations: [],
  });
  expect(result.colors).toEqual(colors);
  expect(result.changed).toBe(false);
});
