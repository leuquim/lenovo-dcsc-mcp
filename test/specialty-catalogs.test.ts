import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import { registerCatalogTools } from '../src/mcp/catalogTools.js';
import {
  fetchConvergedCategoryDetail,
  fetchConvergedCatalog,
  fetchLvrCatalog,
  fetchPromotionHierarchies,
  fetchPromotionLfos,
  fetchPromotionOptions,
  fetchPromotionSids,
  fetchSpecialtyCatalog,
} from '../src/domain/specialtyCatalog.js';
import {
  referencePath,
  referenceRows,
} from '../src/domain/referenceSolutions.js';
import type { CategoryNode } from '../src/schemas/catalog.js';

type Obj = Record<string, unknown>;

const services: DcscService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});

const mockLvrTree: CategoryNode[] = [
  {
    id: 'STG@Servers',
    name: 'Servers',
    children: [
      {
        id: 'STG@Servers@Rack',
        name: 'Rack Servers',
        products: [
          {
            code: '7D73CTO1WW',
            description: 'ThinkSystem SR650 V3 Certified Refurbished',
            type: 'CTO',
            price: 2450.0,
            announceDate: '2023-01-10',
            withdrawnDate: '2999-12-31',
          },
          {
            code: '7Y51CTO1WW',
            description: 'ThinkSystem SR530 Refurbished',
            type: 'CTO',
            price: 1200.0,
            announceDate: '2019-01-01',
            withdrawnDate: '2022-01-01',
          },
        ],
      },
    ],
  },
  {
    id: 'STG@Storage',
    name: 'Storage',
    children: [
      {
        id: 'STG@Storage@DE',
        name: 'ThinkSystem DE Series',
        products: [
          {
            code: '7Y70CTO1WW',
            description: 'ThinkSystem DE4000H Refurbished Hybrid',
            type: 'CTO',
            price: 4500.0,
            withdrawnDate: '2999-12-31',
          },
        ],
      },
    ],
  },
];

const mockConvergedTree: CategoryNode[] = [
  {
    id: 'STG@Software Defined Infrastructure',
    name: 'Software Defined Infrastructure',
    children: [
      {
        id: 'STG@Software Defined Infrastructure@ThinkAgile FX',
        name: 'ThinkAgile FX Series',
        products: [
          {
            code: '7DPLCTO1WW',
            description: 'ThinkAgile FX630 V4',
            type: 'CTO',
            price: 8900.0,
            withdrawnDate: '2999-12-31',
          },
        ],
      },
    ],
  },
];

const mockCategoryDetail = {
  categoryId: 'STG@Software Defined Infrastructure@ThinkAgile FX',
  title: 'ThinkAgile FX Series',
  overview: '<p>High performance hybrid cloud platform</p>',
  marketInfo: 'Enterprise cloud ready',
  description: 'Detailed description of FX series',
  image: 'https://dcsc.lenovo.com/images/fx630.png',
  shipStatus: 1,
};

const mockPromotionHierarchy = {
  id: 'PROMO_ROOT',
  title: 'Lenovo Q4 Promotion Catalog',
  categoryId: 'PROMO_ROOT',
  category: 'Promotions',
  description: 'Active hardware and solution promotions',
  image: null,
  children: [
    {
      id: 'PROMO_SERVERS',
      name: 'Server Promotions',
      title: 'Server Promotions',
      children: [],
    },
  ],
  promotionLfos: { id: 'PLFO_1', children: [] },
  promotionOptions: { id: 'POPT_1', children: [] },
  promotionSIDs: { id: 'PSID_1', children: [] },
};

function setupService() {
  const service = new DcscService(
    ConfigSchema.parse({ logLevel: 'silent', files: { persistSessions: false } }),
  );
  services.push(service);
  vi.spyOn(service, 'resolveSolution').mockResolvedValue({
    solutionMode: 'General Purpose',
    masterSlices: ['GP'],
  });
  return service;
}

function getToolHandlers(service: DcscService) {
  const handlers = new Map<
    string,
    (args: Obj) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
  >();
  registerCatalogTools(
    {
      registerTool(
        name: string,
        _spec: unknown,
        handler: typeof handlers extends Map<string, infer H> ? H : never,
      ) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer,
    service,
  );
  return handlers;
}

describe('Specialty Catalogs (R3: LVR Refurbished, Converged Systems, Promotions)', () => {
  it('fetches and flattens LVR (Certified Refurbished) catalog hierarchy with proper withdrawn detection', async () => {
    const service = setupService();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: mockLvrTree,
      requestId: 'req-lvr-1',
    } as never);

    const catalog = await fetchLvrCatalog(service.http, service.newCtx());

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/lvr/category_hierarchies',
      }),
    );

    expect(catalog.tree).toHaveLength(2);
    expect(catalog.entries).toHaveLength(3);

    const sr650 = catalog.entries.find((e) => e.code === '7D73CTO1WW');
    expect(sr650).toBeDefined();
    expect(sr650?.description).toBe('ThinkSystem SR650 V3 Certified Refurbished');
    expect(sr650?.path).toEqual(['Servers', 'Rack Servers']);
    expect(sr650?.withdrawn).toBe(false);

    const sr530 = catalog.entries.find((e) => e.code === '7Y51CTO1WW');
    expect(sr530).toBeDefined();
    expect(sr530?.withdrawn).toBe(true);
  });

  it('fetches Converged / MultiProd systems catalog and parses ThinkAgile entries', async () => {
    const service = setupService();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: mockConvergedTree,
      requestId: 'req-converged-1',
    } as never);

    const catalog = await fetchConvergedCatalog(service.http, service.newCtx());

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/multiprod_category_hierarchies',
      }),
    );

    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]?.code).toBe('7DPLCTO1WW');
    expect(catalog.entries[0]?.description).toBe('ThinkAgile FX630 V4');
  });

  it('fetches rich category detail for a converged category and rejects empty categoryId', async () => {
    const service = setupService();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: mockCategoryDetail,
      requestId: 'req-detail-1',
    } as never);

    const detail = await fetchConvergedCategoryDetail(
      service.http,
      service.newCtx(),
      'STG@Software Defined Infrastructure@ThinkAgile FX',
    );

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: `/multiprod_category_detail/${encodeURIComponent('STG@Software Defined Infrastructure@ThinkAgile FX')}`,
      }),
    );

    expect(detail.title).toBe('ThinkAgile FX Series');
    expect(detail.overview).toContain('High performance');

    await expect(
      fetchConvergedCategoryDetail(service.http, service.newCtx(), ''),
    ).rejects.toThrow('non-empty categoryId');
  });

  it('fetches promotion hierarchies, SIDs, LFOs, and options endpoints', async () => {
    const service = setupService();
    const sendSpy = vi.spyOn(service.http, 'send');

    sendSpy.mockResolvedValueOnce({ raw: mockPromotionHierarchy } as never);
    const hier = await fetchPromotionHierarchies(service.http, service.newCtx());
    expect(hier.id).toBe('PROMO_ROOT');
    expect(sendSpy.mock.calls[0]![0]).toMatchObject({
      method: 'GET',
      path: '/promotion/hierarchies',
    });

    sendSpy.mockResolvedValueOnce({ raw: [{ sid: 'SID999' }] } as never);
    const sids = await fetchPromotionSids(service.http, service.newCtx());
    expect(sids).toEqual([{ sid: 'SID999' }]);
    expect(sendSpy.mock.calls[1]![0]).toMatchObject({
      method: 'GET',
      path: '/promotion/sid',
    });

    sendSpy.mockResolvedValueOnce({ raw: [{ lfo: 'LFO100' }] } as never);
    const lfos = await fetchPromotionLfos(service.http, service.newCtx());
    expect(lfos).toEqual([{ lfo: 'LFO100' }]);
    expect(sendSpy.mock.calls[2]![0]).toMatchObject({
      method: 'GET',
      path: '/promotion/lfo',
    });

    sendSpy.mockResolvedValueOnce({ raw: [{ part: '4XF7A1' }] } as never);
    const opts = await fetchPromotionOptions(service.http, service.newCtx(), 'CAT1');
    expect(opts).toEqual([{ part: '4XF7A1' }]);
    expect(sendSpy.mock.calls[3]![0]).toMatchObject({
      method: 'GET',
      path: '/promotion/option',
      query: { categoryId: 'CAT1' },
    });
  });

  it('unifies specialty catalog queries via fetchSpecialtyCatalog dispatcher', async () => {
    const service = setupService();
    vi.spyOn(service.http, 'send').mockImplementation(async (req) => {
      if (req.path === '/lvr/category_hierarchies') return { raw: mockLvrTree } as never;
      if (req.path === '/multiprod_category_hierarchies') return { raw: mockConvergedTree } as never;
      if (req.path.startsWith('/multiprod_category_detail/')) return { raw: mockCategoryDetail } as never;
      if (req.path === '/promotion/hierarchies') return { raw: mockPromotionHierarchy } as never;
      if (req.path === '/promotion/sid') return { raw: [{ sid: 'PROMO_SID' }] } as never;
      throw new Error(`Unexpected path: ${req.path}`);
    });

    const lvrResult = await fetchSpecialtyCatalog(service.http, service.newCtx(), { type: 'lvr' });
    expect(lvrResult.type).toBe('lvr');
    if (lvrResult.type === 'lvr') {
      expect(lvrResult.entries).toHaveLength(3);
    }

    const convResult = await fetchSpecialtyCatalog(service.http, service.newCtx(), {
      type: 'converged',
      categoryId: 'CAT1',
    });
    expect(convResult.type).toBe('converged');
    if (convResult.type === 'converged') {
      expect(convResult.detail?.title).toBe('ThinkAgile FX Series');
    }

    const promoSid = await fetchSpecialtyCatalog(service.http, service.newCtx(), {
      type: 'promotion',
      subType: 'sid',
    });
    expect(promoSid.type).toBe('promotion');
    if (promoSid.type === 'promotion') {
      expect(promoSid.data).toEqual([{ sid: 'PROMO_SID' }]);
    }
  });

  it('extends referenceSolutions with promotions path and row extraction', () => {
    expect(referencePath({ view: 'promotions' })).toBe('/promotion/hierarchies');
    expect(referencePath({ view: 'promotion-sids' })).toBe('/promotion/sid');
    expect(referencePath({ view: 'promotion-lfos' })).toBe('/promotion/lfo');

    const promoRows = referenceRows(mockPromotionHierarchy, 'promotions');
    expect(promoRows.length).toBeGreaterThanOrEqual(1);
    expect(promoRows[0]?.breadcrumb).toEqual(['Lenovo Q4 Promotion Catalog']);
  });

  it('exposes dcsc_specialty_catalog tool for querying LVR, Converged, and Promotion catalogs', async () => {
    const service = setupService();
    vi.spyOn(service.http, 'send').mockImplementation(async (req) => {
      if (req.path === '/lvr/category_hierarchies') return { raw: mockLvrTree } as never;
      if (req.path === '/multiprod_category_hierarchies') return { raw: mockConvergedTree } as never;
      if (req.path === '/promotion/hierarchies') return { raw: mockPromotionHierarchy } as never;
      throw new Error(`Unexpected path: ${req.path}`);
    });

    const handlers = getToolHandlers(service);
    const specialtyTool = handlers.get('dcsc_specialty_catalog')!;
    expect(specialtyTool).toBeDefined();

    // 1. Browse LVR catalog with pagination and query
    const lvrRes = await specialtyTool({
      catalog: 'lvr',
      query: 'SR650',
    });
    expect(lvrRes.isError).toBeFalsy();
    const lvrData = JSON.parse(lvrRes.content[0]?.text ?? '{}') as {
      catalog: string;
      total: number;
      entries: Array<{ code: string }>;
    };
    expect(lvrData.catalog).toBe('lvr');
    expect(lvrData.total).toBe(1);
    expect(lvrData.entries[0]?.code).toBe('7D73CTO1WW');

    // 2. Browse Converged catalog
    const convRes = await specialtyTool({
      catalog: 'converged',
      limit: 10,
    });
    expect(convRes.isError).toBeFalsy();
    const convData = JSON.parse(convRes.content[0]?.text ?? '{}') as {
      catalog: string;
      total: number;
      entries: Array<{ code: string }>;
    };
    expect(convData.catalog).toBe('converged');
    expect(convData.entries[0]?.code).toBe('7DPLCTO1WW');

    // 3. Browse Promotion catalog
    const promoRes = await specialtyTool({
      catalog: 'promotion',
      subType: 'hierarchies',
    });
    expect(promoRes.isError).toBeFalsy();
    const promoData = JSON.parse(promoRes.content[0]?.text ?? '{}') as {
      catalog: string;
      subType: string;
      data: { id: string };
    };
    expect(promoData.catalog).toBe('promotion');
    expect(promoData.data.id).toBe('PROMO_ROOT');
  });
});
