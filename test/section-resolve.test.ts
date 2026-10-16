import { describe, expect, it } from 'vitest';

import { buildIndex, resolveSection, suggestSections } from '../src/model/index.js';
import { applyChange, reduceConfiguration } from '../src/domain/reduce.js';
import type { RawConfiguration } from '../src/model/types.js';

/**
 * A launch tree with the shape that broke mutations: DCSC's internal section
 * `name` differs from the `description` the option listings print, and the
 * section carries no results yet.
 */
const raw = {
  code: '7DJ5CTO1WW',
  sliceCtoCode: '7DJ5CTO1WW',
  totalPrice: 100,
  tabs: [
    {
      title: 'Storage',
      subTabs: [
        {
          title: 'Internal Storage',
          sections: [
            {
              name: 'FRONT_NONRAID_HDD',
              description: 'Front HDD not in RAID Array',
              singleEntry: false,
              results: [],
              features: [{ code: 'C1F1', description: '3.2TB NVMe', min: 0, max: 8, unitPrice: 5864.5 }],
            },
          ],
        },
        {
          title: 'M.2/7MM Boot Enablement',
          sections: [
            {
              name: 'M.2_SSD',
              description: 'M.2 SSD',
              singleEntry: true,
              results: [{ code: 'BXMH', quantity: 2 }],
              features: [{ code: 'BXMH', description: '960GB M.2', min: 0, max: 2, unitPrice: 2174.5 }],
            },
          ],
        },
      ],
    },
  ],
} as unknown as RawConfiguration;

const index = buildIndex(raw);

describe('section resolution', () => {
  it('resolves DCSC internal name, display title and synthetic id to the same section', () => {
    const byName = resolveSection(index, 'FRONT_NONRAID_HDD');
    const byTitle = resolveSection(index, 'Front HDD not in RAID Array');
    const byId = resolveSection(index, 'storage.front-nonraid-hdd');

    expect(byName?.name).toBe('FRONT_NONRAID_HDD');
    expect(byTitle?.name).toBe('FRONT_NONRAID_HDD');
    expect(byId?.name).toBe('FRONT_NONRAID_HDD');
  });

  it('is case-insensitive', () => {
    expect(resolveSection(index, 'front hdd not in raid array')?.name).toBe('FRONT_NONRAID_HDD');
  });

  it('returns undefined for an unknown section rather than inventing one', () => {
    expect(resolveSection(index, 'Nonexistent Section')).toBeUndefined();
  });

  it('offers candidates when resolution fails', () => {
    const hints = suggestSections(index, 'HDD');
    expect(hints.join(' ')).toContain('FRONT_NONRAID_HDD');
  });
});

describe('applyChange into an empty section', () => {
  it('carries the sub-tab so DCSC can locate a section that reduce dropped', () => {
    const reduced = reduceConfiguration(raw, 'US__test0', 'cto', 'HPC and AI - Systems');
    // reduce keeps only sections with results, so the drive bay section is absent.
    expect(reduced.sections.find((s) => s.name === 'FRONT_NONRAID_HDD')).toBeUndefined();

    const ref = resolveSection(index, 'Front HDD not in RAID Array')!;
    const next = applyChange(reduced, {
      sectionName: ref.name,
      code: 'C1F1',
      quantity: 4,
      subTabTitle: ref.subTab,
      multipleSelectable: ref.section.singleEntry !== true,
    });

    const created = next.sections.find((s) => s.name === 'FRONT_NONRAID_HDD');
    expect(created).toBeDefined();
    expect(created?.subTabTitle).toBe('Internal Storage');
    expect(created?.multipleSelectable).toBe(true);
    expect(created?.results).toEqual([{ code: 'C1F1', quantity: 4, type: 'hardware' }]);
  });

  it('replaces rather than appends in a single-select section', () => {
    const reduced = reduceConfiguration(raw, 'US__test0', 'cto', 'HPC and AI - Systems');
    const ref = resolveSection(index, 'M.2 SSD')!;
    const next = applyChange(reduced, {
      sectionName: ref.name,
      code: 'BXMH',
      quantity: 1,
      subTabTitle: ref.subTab,
      multipleSelectable: ref.section.singleEntry !== true,
    });

    const sec = next.sections.find((s) => s.name === 'M.2_SSD');
    expect(sec?.results).toEqual([{ code: 'BXMH', quantity: 1, type: 'hardware' }]);
  });
});
