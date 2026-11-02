import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { assignConfigIdFeatures, configIdCatalog } from '../src/domain/configIdFeatures.js';

const captured = JSON.parse(readFileSync(
  new URL('./fixtures/parity/rmp-mip-config-ids.json', import.meta.url),
  'utf8',
)) as Record<string, unknown>;

function configuration(id: string, targets = ['5374CM1']): Record<string, unknown> {
  return {
    id,
    hipoDerivedItems: targets.map(targetCtoCode => ({ targetCtoCode, features: [{}] })),
  };
}

describe('configuration-ID feature assignment', () => {
  it('extracts the captured 5374 family instead of guessing another catalog key', () => {
    const catalog = configIdCatalog({
      5374: captured['configurationIds'],
      ulocation: captured['ulocation'],
      unrelated: [{ featureCode: 'WRONG', description: 'Wrong family' }],
    });
    expect(catalog).toHaveLength(42);
    expect(catalog[0]).toEqual({
      featureCode: 'A2HP', quantity: 1, description: 'Configuration ID 01 test',
    });
    expect(catalog[1]?.featureCode).toBe('A2HQ');
  });

  it('assigns IDs only to physical configurations carrying a 5374 HIPO product', () => {
    const result = assignConfigIdFeatures({
      rackData: [],
      nonRackData: [
        { id: 'server-1', type: 'server' },
        { id: 'server-2', type: 'server', configIdFeatures: [{ featureCode: 'STALE' }] },
      ],
      configurations: [configuration('server-1'), configuration('server-2', ['7S0XCTO5WW'])],
      mipCatalog: { 5374: captured['configurationIds'] },
    });
    expect(result.nonRackData[0]?.['configIdFeatures']).toEqual([
      { featureCode: 'A2HP', quantity: 1, description: 'Configuration ID 01 test' },
    ]);
    expect(result.nonRackData[1]?.['configIdFeatures']).toEqual([]);
    expect(result.consumedCatalogFeatures).toBe(1);
  });

  it('uses physical layout order and shares the root mapping with clones', () => {
    const result = assignConfigIdFeatures({
      rackData: [{ id: 'rack', servers: [
        { id: 'clone-a', originalIds: ['root-a'], type: 'server' },
        { id: 'clone-b', originalIds: ['root-a'], type: 'server' },
        { id: 'server-b', type: 'server' },
      ] }],
      nonRackData: [{ id: 'server-c', type: 'server' }],
      configurations: [configuration('root-a'), configuration('server-b'), configuration('server-c')],
      mipCatalog: { 5374: captured['configurationIds'] },
    });
    const items = result.rackData[0]?.['servers'] as Array<Record<string, unknown>>;
    expect(items[0]?.['configIdFeatures']).toEqual(items[1]?.['configIdFeatures']);
    expect((items[0]!['configIdFeatures'] as Array<Record<string, unknown>>)[0]?.['featureCode']).toBe('A2HP');
    expect((items[2]!['configIdFeatures'] as Array<Record<string, unknown>>)[0]?.['featureCode']).toBe('A2HQ');
    expect(((result.nonRackData[0]!['configIdFeatures']) as Array<Record<string, unknown>>)[0]?.['featureCode']).toBe('A2HR');
    expect(result.consumedCatalogFeatures).toBe(3);
  });

  it('consumes one catalog feature per distinct 5374 target and preserves inputs', () => {
    const nonRackData = [{ id: 'server', type: 'server' }];
    const result = assignConfigIdFeatures({
      rackData: [], nonRackData,
      configurations: [configuration('server', ['5374CM1', '5374CM1', '5374CM2'])],
      mipCatalog: { 5374: captured['configurationIds'] },
    });
    expect(nonRackData[0]).not.toHaveProperty('configIdFeatures');
    expect(result.nonRackData[0]?.['configIdFeatures']).toEqual([
      { featureCode: 'A2HP', quantity: 1, description: 'Configuration ID 01 test' },
      { featureCode: 'A2HQ', quantity: 1, description: 'Configuration ID 02' },
    ]);
  });

  it('fails explicitly when the authoritative catalog cannot cover the layout', () => {
    expect(() => assignConfigIdFeatures({
      rackData: [],
      nonRackData: [{ id: 'a' }, { id: 'b' }],
      configurations: [configuration('a'), configuration('b')],
      mipCatalog: { 5374: [{ featureCode: 'A2HP', description: 'Configuration ID 01' }] },
    })).toThrow(/needs at least 2/);
  });
});
