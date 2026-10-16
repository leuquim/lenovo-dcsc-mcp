import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { cloneConfigurationRaw } from '../src/domain/configurationIdentity.js';
import type { RawConfiguration } from '../src/model/types.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/parity/sr630-launch.json', import.meta.url), 'utf8'),
) as RawConfiguration;

describe('cloneConfigurationRaw', () => {
  it('rewrites canonical root identity fields without changing quantity or the source', () => {
    const source: RawConfiguration = {
      ...structuredClone(fixture),
      id: 'US__source',
      workspaceId: 'US__source',
      configurationId: 'US__source',
      quantity: 7,
    };
    const before = structuredClone(source);

    const clone = cloneConfigurationRaw(source, 'US__source', 'US__clone');

    expect(clone).not.toBe(source);
    expect(clone).toMatchObject({
      id: 'US__clone',
      workspaceId: 'US__clone',
      configurationId: 'US__clone',
      quantity: 7,
    });
    expect(source).toEqual(before);
    expect(clone.tabs).not.toBe(source.tabs);
  });

  it('preserves modern network-name topology keys and unrelated opaque values', () => {
    const source: RawConfiguration = {
      id: 'US__source',
      workspaceId: 'US__source',
      quantity: 3,
      selectedTopologies: {
        Management: {
          selectedConnectors: [{ id: 'connector-1', note: 'US__source' }],
        },
        Storage: { networkTechnology: 'RoCEv2' },
      },
      opaqueServerState: {
        literal: 'US__source',
        nested: [{ description: 'configuration US__source remains descriptive data' }],
      },
      tabs: [],
    };

    const clone = cloneConfigurationRaw(source, 'US__source', 'US__clone');

    expect(clone.selectedTopologies).toEqual(source.selectedTopologies);
    expect(Object.keys(clone.selectedTopologies as object)).toEqual(['Management', 'Storage']);
    expect(clone.opaqueServerState).toEqual(source.opaqueServerState);
    expect(clone.opaqueServerState).not.toBe(source.opaqueServerState);
    expect(JSON.stringify(clone.opaqueServerState)).toContain('US__source');
    expect(clone.quantity).toBe(3);
  });

  it('renames only an exact legacy selectedTopologies configuration key', () => {
    const source: RawConfiguration = {
      id: 'US__source',
      selectedTopologies: {
        US__source: { Management: { selectedConnectors: [] } },
        Management: { futureSelection: 'preserved' },
        'prefix-US__source': { opaque: true },
      },
      tabs: [],
    };

    const clone = cloneConfigurationRaw(source, 'US__source', 'US__clone');

    expect(clone.selectedTopologies).toEqual({
      US__clone: { Management: { selectedConnectors: [] } },
      Management: { futureSelection: 'preserved' },
      'prefix-US__source': { opaque: true },
    });
  });

  it('rejects a legacy topology-key collision instead of dropping either value', () => {
    const source: RawConfiguration = {
      id: 'US__source',
      selectedTopologies: {
        US__source: { legacy: true },
        US__clone: { existing: true },
      },
      tabs: [],
    };

    expect(() => cloneConfigurationRaw(source, 'US__source', 'US__clone'))
      .toThrow(/selectedTopologies already contains US__clone/);
    expect(source.selectedTopologies).toEqual({
      US__source: { legacy: true },
      US__clone: { existing: true },
    });
  });

  it('requires distinct non-empty trimmed identities', () => {
    expect(() => cloneConfigurationRaw({ tabs: [] }, '', 'US__clone')).toThrow(/oldId/);
    expect(() => cloneConfigurationRaw({ tabs: [] }, 'US__source', ' US__clone'))
      .toThrow(/newId/);
    expect(() => cloneConfigurationRaw({ tabs: [] }, 'US__same', 'US__same'))
      .toThrow(/requires a new identity/);
  });
});
