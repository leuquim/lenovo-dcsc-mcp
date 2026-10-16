import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildIndex, resolveSection } from '../src/model/index.js';
import type { RawConfiguration } from '../src/model/types.js';

describe('software group and filter discovery', () => {
  it('indexes the selected groups and filters returned by a current SR630 launch', () => {
    const raw = JSON.parse(
      readFileSync('test/fixtures/parity/sr630-launch.json', 'utf8'),
    ) as RawConfiguration;
    const index = buildIndex(raw);

    const group = index.byCode.get('T1GU')?.find((feature) => feature.sectionName === 'T1GT');
    expect(group).toMatchObject({
      description: 'XClarity One - Managed Device',
      selectedQty: 1,
      tab: 'OS & Software',
      subTab: 'XClarity',
    });
    expect(index.selected.get('T1GU')).toBe(1);

    const type = resolveSection(index, 'T1GT/T1GU/SW_MAINT_TYPE');
    const duration = resolveSection(index, 'T1GT/T1GU/SW_MAINT_DURATION');
    expect(type).toMatchObject({
      name: 'T1GT/T1GU/SW_MAINT_TYPE',
      title: 'Select XClarity Type*',
      tab: 'OS & Software',
      subTab: 'XClarity',
    });
    expect(duration).toMatchObject({
      name: 'T1GT/T1GU/SW_MAINT_DURATION',
      title: 'Software Entitlement Duration*',
    });
    expect(type?.id).not.toBe(duration?.id);
    expect(index.byCode.get('T1Q7')).toContainEqual(
      expect.objectContaining({ section: type?.id, selectedQty: 1 }),
    );
    expect(index.byCode.get('SMD3')).toContainEqual(
      expect.objectContaining({ section: duration?.id, selectedQty: 1 }),
    );
    expect(index.selected.get('T1Q7')).toBe(1);
    expect(index.selected.get('SMD3')).toBe(1);
  });

  it('keeps multiple selected groups addressable and does not double-count derived codes', () => {
    const parent = 'PARENT_WITH_A_NAME_LONG_ENOUGH_TO_COLLIDE_AFTER_THE_STABLE_ID_LIMIT';
    const raw = {
      tabs: [{
        title: 'OS & Software',
        subTabs: [{
          title: 'Licensing',
          sections: [{
            name: parent,
            description: 'Software licensing',
            selectedItems: ['GROUP_ALPHA', 'GROUP_BETA'],
            results: [{ code: 'SHARED', quantity: 2 }],
            features: [{ code: 'SHARED', description: 'Derived final SKU', max: 10 }],
            groups: [
              {
                code: 'GROUP_ALPHA',
                description: 'Alpha edition',
                filters: [{
                  name: 'MAINTENANCE_TERM',
                  description: 'Alpha term',
                  value: 'SHARED',
                  quantity: 2,
                  items: [{ code: 'SHARED', description: 'Three years' }],
                }],
              },
              {
                code: 'GROUP_BETA',
                description: 'Beta edition',
                filters: [{
                  name: 'MAINTENANCE_TERM',
                  description: 'Beta term',
                  value: 'SHARED',
                  quantity: 2,
                  items: [{ code: 'SHARED', description: 'Three years' }],
                }],
              },
            ],
          }],
        }],
      }],
    } as unknown as RawConfiguration;

    const index = buildIndex(raw);
    const alphaName = `${parent}/GROUP_ALPHA/MAINTENANCE_TERM`;
    const betaName = `${parent}/GROUP_BETA/MAINTENANCE_TERM`;
    const alpha = resolveSection(index, alphaName);
    const beta = resolveSection(index, betaName);

    expect(index.byCode.get('GROUP_ALPHA')).toContainEqual(
      expect.objectContaining({ selectedQty: 1 }),
    );
    expect(index.byCode.get('GROUP_BETA')).toContainEqual(
      expect.objectContaining({ selectedQty: 1 }),
    );
    expect(index.selected.get('GROUP_ALPHA')).toBe(1);
    expect(index.selected.get('GROUP_BETA')).toBe(1);
    expect(alpha?.name).toBe(alphaName);
    expect(beta?.name).toBe(betaName);
    expect(alpha?.id).not.toBe(beta?.id);
    expect(alpha?.id).toMatch(/-2$/);
    expect(beta?.id).toMatch(/-3$/);
    expect(index.byCode.get('SHARED')).toHaveLength(3);
    expect(index.selected.get('SHARED')).toBe(2);
  });

  it('does not publish nested filters until their group is selected', () => {
    const raw = {
      tabs: [{ title: 'Software', subTabs: [{ title: 'Apps', sections: [{
        name: 'APP',
        selectedItems: [],
        groups: [{
          code: 'APP_GROUP',
          description: 'Application',
          filters: [{ name: 'EDITION', value: 'PRO', items: [{ code: 'PRO' }] }],
        }],
      }] }] }],
    } as unknown as RawConfiguration;

    const index = buildIndex(raw);
    expect(index.byCode.get('APP_GROUP')).toContainEqual(expect.objectContaining({ selectedQty: 0 }));
    expect(resolveSection(index, 'APP/APP_GROUP/EDITION')).toBeUndefined();
    expect(index.byCode.has('PRO')).toBe(false);
    expect(index.selected.has('PRO')).toBe(false);
  });
});
