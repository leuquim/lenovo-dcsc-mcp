import { describe, expect, it } from 'vitest';

import {
  browseCatalog,
  flatten,
  searchCatalog,
  searchCatalogPage,
  type Catalog,
} from '../src/domain/catalog.js';
import { toSolutionContext, type SolutionModeInfo } from '../src/domain/context.js';
import { buildIndex, searchFeatures } from '../src/model/index.js';
import { projectOptions, projectSummary, projectTab } from '../src/model/project.js';
import type { RawConfiguration } from '../src/model/types.js';
import type { CategoryNode } from '../src/schemas/catalog.js';

const tree: CategoryNode[] = [
  {
    id: 'servers',
    name: 'Servers',
    products: [],
    children: [
      {
        id: 'rack',
        name: 'Rack Servers',
        products: Array.from({ length: 7 }, (_, i) => ({
          code: `SR${i}`,
          description: `ThinkSystem rack server ${i}`,
          type: 'CTO' as const,
          withdrawnDate: i === 6 ? '2000-01-01' : '2999-12-31',
        })),
      },
    ],
  },
];

const catalog: Catalog = { tree, entries: flatten(tree), fetchedAt: 1 };

describe('catalog pagination', () => {
  it('reports the true search total and enumerates pages without gaps', () => {
    const first = searchCatalogPage(catalog, { query: 'rack server', limit: 2 });
    const second = searchCatalogPage(catalog, {
      query: 'rack server',
      limit: 2,
      offset: first.offset + first.items.length,
    });
    const third = searchCatalogPage(catalog, {
      query: 'rack server',
      limit: 2,
      offset: second.offset + second.items.length,
    });

    expect(first.total).toBe(6);
    expect([...first.items, ...second.items, ...third.items].map((p) => p.code)).toEqual([
      'SR0',
      'SR1',
      'SR2',
      'SR3',
      'SR4',
      'SR5',
    ]);
  });

  it('keeps the original array helper compatible', () => {
    expect(searchCatalog(catalog, { query: 'rack server', limit: 2 }).map((p) => p.code)).toEqual([
      'SR0',
      'SR1',
    ]);
  });

  it('paginates direct products while retaining their true browse total', () => {
    const result = browseCatalog(catalog, ['Servers', 'Rack Servers'], {
      offset: 2,
      limit: 3,
    });

    expect(result.page).toEqual({ offset: 2, limit: 3, total: 6 });
    expect(result.products.map((p) => p.code)).toEqual(['SR2', 'SR3', 'SR4']);
  });
});

const modes: SolutionModeInfo[] = [
  { mode: 'General Purpose', masterSlices: ['GP'] },
  { mode: 'HPC and AI - Systems', masterSlices: ['HPCGP'] },
];

describe('solution mode resolution', () => {
  it('defaults only when the preferred mode is omitted', () => {
    expect(toSolutionContext(modes)).toEqual({
      solutionMode: 'General Purpose',
      masterSlices: ['GP'],
    });
    expect(toSolutionContext(modes, 'hpc and ai - systems').solutionMode).toBe(
      'HPC and AI - Systems',
    );
  });

  it('rejects an explicit unknown mode and lists valid values', () => {
    expect(() => toSolutionContext(modes, 'HPC and AI')).toThrowError(
      /Unknown solution mode.*General Purpose.*HPC and AI - Systems/,
    );
    expect(() => toSolutionContext(modes, '')).toThrowError(/Unknown solution mode/);
  });
});

const raw = {
  sliceCtoCode: 'TESTCTO1WW',
  description: 'Test server',
  type: 'CTO',
  quantity: 1,
  totalPrice: 100,
  tabs: [
    {
      title: 'Storage & Drives',
      subTabs: [
        {
          title: 'Drives',
          sections: [
            {
              name: 'FRONT_DRIVE',
              description: 'Front drives',
              results: [],
              features: Array.from({ length: 20 }, (_, i) => ({
                code: `DRIVE${String(i).padStart(2, '0')}`,
                description: `Fast rack drive ${i} ${'long description '.repeat(8)}`,
                min: 0,
                max: 8,
                unitPrice: i,
              })),
            },
          ],
        },
      ],
    },
  ],
} as unknown as RawConfiguration;

describe('option projections', () => {
  const index = buildIndex(raw);

  it('publishes stable selectors and a ready-to-use configure target', () => {
    const summary = projectSummary({
      sessionId: 'sess-1',
      revision: 1,
      raw,
      index,
      currency: 'USD',
      country: 'US',
      pricedAt: 0,
    });
    const tab = projectTab({
      sessionId: 'sess-1',
      revision: 1,
      index,
      tab: 'Storage & Drives',
      currency: 'USD',
    });
    const found = searchFeatures(index, { query: 'rack drive', limit: 2 });
    const view = projectOptions({
      sessionId: 'sess-1',
      revision: 1,
      currency: 'USD',
      index,
      items: found.items,
      total: found.total,
      offset: found.offset,
      limit: found.limit,
      query: 'rack drive',
    });

    expect(summary.tabs[0]).toMatchObject({
      id: 'Storage & Drives',
      title: 'Storage & Drives',
    });
    expect(tab.tabId).toBe('Storage & Drives');
    expect(tab.sections[0]).toMatchObject({
      id: 'storage-drives.front-drive',
      sectionName: 'FRONT_DRIVE',
    });
    expect(view.options[0]).toMatchObject({
      tabId: 'Storage & Drives',
      sectionId: 'storage-drives.front-drive',
      sectionName: 'FRONT_DRIVE',
      configure: { section: 'storage-drives.front-drive', code: 'DRIVE00' },
    });
  });

  it('advances by the retained count and preserves every search selector', () => {
    const found = searchFeatures(index, {
      query: 'rack drive',
      tab: 'Storage & Drives',
      section: 'storage-drives.front-drive',
      filter: 'selectable',
      limit: 20,
    });
    const view = projectOptions({
      sessionId: 'sess-1',
      revision: 1,
      currency: 'USD',
      index,
      items: found.items,
      total: found.total,
      offset: found.offset,
      limit: found.limit,
      query: 'rack drive',
      tab: 'Storage & Drives',
      section: 'storage-drives.front-drive',
      filter: 'selectable',
      maxBytes: 2_000,
    });

    expect(view.options.length).toBeGreaterThan(0);
    expect(view.options.length).toBeLessThan(found.items.length);
    expect(view.next).toEqual({ tool: 'dcsc_list_options', arguments: {
      session: 'sess-1', query: 'rack drive', tab: 'Storage & Drives',
      section: 'storage-drives.front-drive', filter: 'selectable',
      offset: view.options.length, limit: found.limit,
    } });
  });

  it('enumerates byte-trimmed pages exactly once', () => {
    const seen: string[] = [];
    let offset = 0;

    while (offset < index.features.length) {
      const found = searchFeatures(index, { query: 'rack drive', limit: 20, offset });
      const view = projectOptions({
        sessionId: 'sess-1',
        revision: 1,
        currency: 'USD',
        index,
        items: found.items,
        total: found.total,
        offset: found.offset,
        limit: found.limit,
        query: 'rack drive',
        maxBytes: 2_000,
      });

      expect(view.options.length).toBeGreaterThan(0);
      seen.push(...view.options.map((option) => option.code));
      offset += view.options.length;
    }

    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => `DRIVE${String(i).padStart(2, '0')}`));
    expect(new Set(seen).size).toBe(20);
  });
});
