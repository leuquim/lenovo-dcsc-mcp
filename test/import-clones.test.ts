import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expandImportedClones } from '../src/domain/importClones.js';
import type { RawConfiguration } from '../src/model/types.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/browser-quantity-import-contract.json', import.meta.url), 'utf8')) as {
  cases: Array<{ requestedQuantity: number; configuration: RawConfiguration[]; group: unknown;
    workspace: { nonRackArea: Array<Record<string, unknown>>; rackArea: unknown[] }; settledCustomizeRequest?: { configurationIds: string[] } }>;
};

describe('browser-equivalent compressed CFXML clone import', () => {
  it.each(fixture.cases)('restores $requestedQuantity physical copies without multiplying per-unit features', example => {
    const source = { configuration: example.configuration, groups: [example.group], workspace: example.workspace };
    const before = structuredClone(source);
    const expanded = expandImportedClones(source);
    expect(source).toEqual(before);
    expect(expanded.configuration).toHaveLength(example.requestedQuantity);
    expect(expanded.workspace.nonRackArea).toHaveLength(example.requestedQuantity);
    expect(expanded.configuration.every(raw => raw.quantity === 1)).toBe(true);
    const ids = expanded.configuration.map(raw => raw.id);
    expect(ids).toEqual(example.workspace.nonRackArea[0]!.originalIds);
    if (example.settledCustomizeRequest) expect(ids).toEqual(example.settledCustomizeRequest.configurationIds);
    expect(expanded.configuration.reduce((sum, raw) => sum + (raw.totalPrice ?? 0), 0)).toBeCloseTo(15650.51 * example.requestedQuantity, 2);
    expect(expanded.groups).toEqual(source.groups);
    expect(expanded.workspace.nonRackArea.map(item => item.originalIds)).toEqual(ids.map(id => [id]));
    expect((expanded as Record<string, unknown>).cloneDependency).toEqual({ [ids[0]!]: ids });
  });

  it('rejects duplicate or conflicting clone identities before changing the original envelope', () => {
    const example = fixture.cases[0]!;
    const source = { configuration: example.configuration, workspace: structuredClone(example.workspace) };
    source.workspace.nonRackArea[0]!.originalIds = ['config-primary', 'config-primary'];
    const before = structuredClone(source);
    expect(() => expandImportedClones(source)).toThrow('inconsistent identities');
    expect(source).toEqual(before);
  });

  it('preserves native clone ownership and safely replaces the exact legacy singleton fallback', () => {
    const example = fixture.cases[0]!;
    const ids = example.workspace.nonRackArea[0]!.originalIds as string[];
    const root = ids[0]!;
    const source = {
      configuration: example.configuration,
      workspace: example.workspace,
      cloneDependency: Object.fromEntries(ids.map(id => [id, [id]])),
      cloneDependencyColor: {
        [root]: { color: '#abcdef', darkColor: '#123456', dependBy: ids },
      },
    };
    const before = structuredClone(source);
    const expanded = expandImportedClones(source);
    expect(source).toEqual(before);
    expect(expanded.cloneDependency).toEqual({ [root]: ids });
    expect(expanded.cloneDependencyColor).toEqual(source.cloneDependencyColor);
  });

  it('rejects overlapping dependency or color ownership atomically', () => {
    const example = fixture.cases[0]!;
    const ids = example.workspace.nonRackArea[0]!.originalIds as string[];
    const root = ids[0]!;
    const dependencyConflict = {
      configuration: example.configuration,
      workspace: example.workspace,
      cloneDependency: { [root]: ids.slice(0, 2), [ids[2]!]: ids.slice(2) },
    };
    const dependencyBefore = structuredClone(dependencyConflict);
    expect(() => expandImportedClones(dependencyConflict)).toThrow(/conflicts with validated expansion/);
    expect(dependencyConflict).toEqual(dependencyBefore);

    const colorConflict = {
      configuration: example.configuration,
      workspace: example.workspace,
      cloneDependencyColor: {
        [root]: { dependBy: ids },
        [ids[1]!]: { dependBy: [ids[1]!] },
      },
    };
    const colorBefore = structuredClone(colorConflict);
    expect(() => expandImportedClones(colorConflict)).toThrow(/overlapping roots/);
    expect(colorConflict).toEqual(colorBefore);
  });

  it('rejects a non-overlapping color partition that disagrees with validated native ownership', () => {
    const example = fixture.cases[1]!;
    const ids = example.workspace.nonRackArea[0]!.originalIds as string[];
    const source = {
      configuration: example.configuration,
      workspace: example.workspace,
      cloneDependencyColor: Object.fromEntries(ids.map(id => [id, { dependBy: [id] }])),
    };
    const before = structuredClone(source);
    expect(() => expandImportedClones(source)).toThrow(/color ownership conflicts/);
    expect(source).toEqual(before);
  });

  it('preserves server-owned member order when the validated root is not first', () => {
    const example = fixture.cases[0]!;
    const workspace = structuredClone(example.workspace);
    const sourceId = String(workspace.nonRackArea[0]!.id);
    const ids = workspace.nonRackArea[0]!.originalIds as string[];
    const reordered = [ids[1]!, sourceId, ...ids.slice(2)];
    workspace.nonRackArea[0]!.originalIds = reordered;
    const expanded = expandImportedClones({ configuration: example.configuration, workspace });
    expect((expanded as Record<string, unknown>).cloneDependency).toEqual({ [sourceId]: reordered });
  });

  it('preserves an inactive native presentation color with empty ownership', () => {
    const source = {
      configuration: [{ id: 'server', code: 'SERVER', type: 'server', quantity: 1 }],
      workspace: { rackArea: [], nonRackArea: [{ id: 'server', type: 'server', quantity: 1 }] },
      cloneDependency: { server: ['server'] },
      cloneDependencyColor: {
        server: { color: '#111111', dependBy: ['server'] },
        'missing-storage-template': { color: '#222222', dependBy: [] },
      },
    };
    const before = structuredClone(source);
    expect(expandImportedClones(source)).toEqual(before);
    expect(source).toEqual(before);
  });

  it('rejects empty color ownership for an active ordinary dependency', () => {
    const source = {
      configuration: [{ id: 'server', code: 'SERVER', type: 'server', quantity: 1 }],
      workspace: { rackArea: [], nonRackArea: [{ id: 'server', type: 'server', quantity: 1 }] },
      cloneDependency: { server: ['server'] },
      cloneDependencyColor: { server: { color: '#111111', dependBy: [] } },
    };
    const before = structuredClone(source);
    expect(() => expandImportedClones(source)).toThrow(/empty ownership for an active clone identity/);
    expect(source).toEqual(before);
  });

  it('accepts empty ownership for an explicitly managed unplaced storage template', () => {
    const source = {
      configuration: [{ id: 'template', code: 'STORAGE', type: 'storage', quantity: 1 }],
      workspace: { rackArea: [], nonRackArea: [] },
      networkingInformation: { storageNetworks: [{
        name: 'Captured SAN', controller: { id: 'template', option: 'STORAGE' }, expansion: {}, mainSwitch: {},
      }] },
      cloneDependency: { template: ['template'] },
      cloneDependencyColor: { template: { color: '#111111', dependBy: [] } },
    };
    const before = structuredClone(source);
    expect(expandImportedClones(source)).toEqual(before);
    expect(source).toEqual(before);
  });

  it('preserves physical-only storage colors without treating aliases as editable clones', () => {
    const source = {
      configuration: [
        { id: 'rack', code: 'RACK', type: 'rack', quantity: 1 },
        { id: 'storage-a', code: 'STORAGE', type: 'storage', quantity: 1 },
        { id: 'storage-b', code: 'STORAGE', type: 'storage', quantity: 1 },
      ],
      workspace: { nonRackArea: [], rackArea: [{ id: 'rack', type: 'rack', children: [
        { id: 'storage-a', type: 'storage' }, { id: 'storage-b', type: 'storage' },
      ] }] },
      networkingInformation: { storageNetworks: [{
        name: 'Captured SAN', controller: { option: 'STORAGE' }, expansion: {}, mainSwitch: {},
      }] },
      cloneDependencyColor: {
        'missing-managed-template': { color: '#222222', dependBy: ['storage-a', 'storage-b'] },
      },
    };
    const before = structuredClone(source);
    expect(expandImportedClones(source)).toEqual(before);
    expect(source).toEqual(before);
  });

  it('rejects a physical storage color that mixes component roles', () => {
    const source = {
      configuration: [
        { id: 'rack', code: 'RACK', type: 'rack', quantity: 1 },
        { id: 'storage-a', code: 'STORAGE', type: 'storage', quantity: 1 },
        { id: 'switch-a', code: 'SWITCH', type: 'switch', quantity: 1 },
      ],
      workspace: { nonRackArea: [], rackArea: [{ id: 'rack', type: 'rack', children: [
        { id: 'storage-a', type: 'storage' }, { id: 'switch-a', type: 'switch' },
      ] }] },
      networkingInformation: { storageNetworks: [{
        name: 'Captured SAN', controller: { option: 'STORAGE' }, expansion: {}, mainSwitch: { option: 'SWITCH' },
      }] },
      cloneDependencyColor: {
        'missing-managed-template': { dependBy: ['storage-a', 'switch-a'] },
      },
    };
    const before = structuredClone(source);
    expect(() => expandImportedClones(source)).toThrow(/mixes different managed component types or product codes/);
    expect(source).toEqual(before);
  });

  it('rejects storage presentation metadata that contradicts explicit dependency ownership', () => {
    const source = {
      configuration: [
        { id: 'rack', code: 'RACK', type: 'rack', quantity: 1 },
        { id: 'storage-a', code: 'STORAGE', type: 'storage', quantity: 1 },
        { id: 'storage-b', code: 'STORAGE', type: 'storage', quantity: 1 },
      ],
      workspace: { nonRackArea: [], rackArea: [{ id: 'rack', type: 'rack', children: [
        { id: 'storage-a', type: 'storage' }, { id: 'storage-b', type: 'storage' },
      ] }] },
      networkingInformation: { storageNetworks: [{
        name: 'Captured SAN', controller: { option: 'STORAGE' }, expansion: {}, mainSwitch: {},
      }] },
      cloneDependency: { 'storage-a': ['storage-a'], 'storage-b': ['storage-b'] },
      cloneDependencyColor: {
        'missing-managed-template': { dependBy: ['storage-a', 'storage-b'] },
      },
    };
    const before = structuredClone(source);
    expect(() => expandImportedClones(source)).toThrow(/conflicts with explicit clone dependency ownership/);
    expect(source).toEqual(before);
  });

  it('accepts exact physical storage metadata backed by an explicit managed template dependency', () => {
    const source = {
      configuration: [
        { id: 'rack', code: 'RACK', type: 'rack', quantity: 1 },
        { id: 'template', code: 'STORAGE', type: 'storage', quantity: 1 },
        { id: 'storage-a', code: 'STORAGE', type: 'storage', quantity: 1 },
        { id: 'storage-b', code: 'STORAGE', type: 'storage', quantity: 1 },
      ],
      workspace: { nonRackArea: [], rackArea: [{ id: 'rack', type: 'rack', children: [
        { id: 'storage-a', type: 'storage' }, { id: 'storage-b', type: 'storage' },
      ] }] },
      networkingInformation: { storageNetworks: [{
        name: 'Captured SAN', controller: { id: 'template', option: 'STORAGE' }, expansion: {}, mainSwitch: {},
      }] },
      cloneDependency: { template: ['template', 'storage-a', 'storage-b'] },
      cloneDependencyColor: {
        template: { dependBy: ['storage-a', 'storage-b'] },
      },
    };
    const before = structuredClone(source);
    expect(expandImportedClones(source)).toEqual(before);
    expect(source).toEqual(before);
  });

  it('rejects rootless color ownership for ordinary physical configurations', () => {
    const source = {
      configuration: [
        { id: 'server-a', code: 'SERVER', type: 'server', quantity: 1 },
        { id: 'server-b', code: 'SERVER', type: 'server', quantity: 1 },
      ],
      workspace: { rackArea: [], nonRackArea: [
        { id: 'server-a', type: 'server' }, { id: 'server-b', type: 'server' },
      ] },
      cloneDependencyColor: {
        'missing-root': { color: '#222222', dependBy: ['server-a', 'server-b'] },
      },
    };
    const before = structuredClone(source);
    expect(() => expandImportedClones(source)).toThrow(/must contain its root exactly once/);
    expect(source).toEqual(before);
  });
});
