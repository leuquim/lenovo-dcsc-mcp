import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import {
  fetchCategoryDetail,
  fetchLfoCodes,
  resolveCategoryDetailRoute,
} from '../src/domain/specialtyCatalog.js';
import { DcscContractDriftError } from '../src/http/errors.js';

const services: DcscService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});

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

describe('R1: Sub-Category Detail & CTO-to-LFO Mapping', () => {
  describe('resolveCategoryDetailRoute', () => {
    it('routes standard categories to /category_detail/{id}', () => {
      const route = resolveCategoryDetailRoute('STG@Servers@Rack Server');
      expect(route.endpoint).toBe('category_detail');
      expect(route.path).toBe('/category_detail/STG%40Servers%40Rack%20Server');
    });

    it('routes Software Defined Infrastructure categories to /multiprod_category_detail/{prefix}', () => {
      const route = resolveCategoryDetailRoute(
        'STG@Servers@Software Defined Infrastructure@ThinkAgile HX',
      );
      expect(route.endpoint).toBe('multiprod_category_detail');
      expect(route.path).toBe(
        `/multiprod_category_detail/${encodeURIComponent('STG@Software Defined Infrastructure')}`,
      );
    });

    it('routes Converged Systems categories to /multiprod_category_detail/{prefix}', () => {
      const route = resolveCategoryDetailRoute('STG@Converged Systems@ThinkAgile VX');
      expect(route.endpoint).toBe('multiprod_category_detail');
      expect(route.path).toBe(
        `/multiprod_category_detail/${encodeURIComponent('STG@Converged Systems')}`,
      );
    });

    it('routes TruScale categories via isTruScale flag', () => {
      const route = resolveCategoryDetailRoute('STG@Servers@ThinkSystem SR650', true);
      expect(route.endpoint).toBe('truscale_category_detail');
      expect(route.path).toBe(
        '/reference_solution/categories/truscale/STG%40Servers%40ThinkSystem%20SR650',
      );
    });

    it('routes categoryIds containing truscale to /reference_solution/categories/truscale/{id}', () => {
      const route = resolveCategoryDetailRoute('STG@TruScale@Infrastructure');
      expect(route.endpoint).toBe('truscale_category_detail');
      expect(route.path).toBe(
        '/reference_solution/categories/truscale/STG%40TruScale%40Infrastructure',
      );
    });
  });

  describe('fetchCategoryDetail', () => {
    it('rejects empty or whitespace categoryId', async () => {
      const service = setupService();
      await expect(fetchCategoryDetail(service.http, service.newCtx(), '')).rejects.toThrow(
        'A non-empty categoryId is required',
      );
      await expect(fetchCategoryDetail(service.http, service.newCtx(), '   ')).rejects.toThrow(
        'A non-empty categoryId is required',
      );
    });

    it('fetches and parses category detail with signCustomize=true query param', async () => {
      const service = setupService();
      const mockRaw = {
        children: [
          {
            categoryId: 'STG@Servers@SR650',
            name: 'ThinkSystem SR650 V3',
            products: [{ code: '7D73CTO1WW', description: 'ThinkSystem SR650 V3' }],
          },
        ],
        paths: [{ id: 'STG', name: 'Storage' }, { id: 'STG@Servers', name: 'Servers' }],
        totalCount: 1,
        overview: 'Industry-standard rack server',
      };

      const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
        raw: mockRaw,
        requestId: 'req-cat-1',
      } as never);

      const result = await fetchCategoryDetail(
        service.http,
        service.newCtx(),
        'STG@Servers@Rack Server',
      );

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'category_detail',
          method: 'GET',
          path: '/category_detail/STG%40Servers%40Rack%20Server',
          query: { signCustomize: 'true' },
          timeoutClass: 'fast',
        }),
      );

      expect(result.totalCount).toBe(1);
      expect(result.children).toHaveLength(1);
      expect(result.paths).toHaveLength(2);
      expect(result.overview).toBe('Industry-standard rack server');
    });

    it('fetches TruScale category detail when option is specified', async () => {
      const service = setupService();
      const mockRaw = {
        children: [{ categoryId: 'TRUSCALE_NODE_1', name: 'TruScale Dedicated Node' }],
        totalCount: 1,
      };

      const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
        raw: mockRaw,
        requestId: 'req-tru-1',
      } as never);

      const result = await fetchCategoryDetail(service.http, service.newCtx(), {
        categoryId: 'STG@Servers@SR650',
        isTruScale: true,
      });

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'truscale_category_detail',
          method: 'GET',
          path: '/reference_solution/categories/truscale/STG%40Servers%40SR650',
          query: { signCustomize: 'true' },
        }),
      );

      expect(result.totalCount).toBe(1);
    });

    it('throws DcscContractDriftError when upstream returns invalid shape', async () => {
      const service = setupService();
      vi.spyOn(service.http, 'send').mockResolvedValue({
        raw: 'plain string is invalid',
        requestId: 'req-bad-1',
      } as never);

      await expect(
        fetchCategoryDetail(service.http, service.newCtx(), 'STG@Servers'),
      ).rejects.toThrow(DcscContractDriftError);
    });
  });

  describe('fetchLfoCodes', () => {
    it('fetches and normalizes string array of LFO codes from GET /lfos/cto_filter_lfo', async () => {
      const service = setupService();
      const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
        raw: ['7D73CTO1WW', '7Y51CTO1WW', '7Z71CTO1WW'],
        requestId: 'req-lfo-1',
      } as never);

      const result = await fetchLfoCodes(service.http, service.newCtx());

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'lfos_cto_filter_lfo',
          method: 'GET',
          path: '/lfos/cto_filter_lfo',
          timeoutClass: 'fast',
        }),
      );

      expect(result.lfoCodes).toEqual(['7D73CTO1WW', '7Y51CTO1WW', '7Z71CTO1WW']);
    });

    it('handles object array containing code property', async () => {
      const service = setupService();
      vi.spyOn(service.http, 'send').mockResolvedValue({
        raw: [{ code: '7D73CTO1WW' }, { code: '7Y51CTO1WW' }],
        requestId: 'req-lfo-2',
      } as never);

      const result = await fetchLfoCodes(service.http, service.newCtx());
      expect(result.lfoCodes).toEqual(['7D73CTO1WW', '7Y51CTO1WW']);
    });

    it('handles wrapper object with lfoCodes array', async () => {
      const service = setupService();
      vi.spyOn(service.http, 'send').mockResolvedValue({
        raw: { lfoCodes: ['7D73CTO1WW'] },
        requestId: 'req-lfo-3',
      } as never);

      const result = await fetchLfoCodes(service.http, service.newCtx());
      expect(result.lfoCodes).toEqual(['7D73CTO1WW']);
    });

    it('handles empty response gracefully', async () => {
      const service = setupService();
      vi.spyOn(service.http, 'send').mockResolvedValue({
        raw: [],
        requestId: 'req-lfo-4',
      } as never);

      const result = await fetchLfoCodes(service.http, service.newCtx());
      expect(result.lfoCodes).toEqual([]);
    });

    it('throws DcscContractDriftError on non-array, non-object upstream payload', async () => {
      const service = setupService();
      vi.spyOn(service.http, 'send').mockResolvedValue({
        raw: 12345,
        requestId: 'req-lfo-bad',
      } as never);

      await expect(fetchLfoCodes(service.http, service.newCtx())).rejects.toThrow(
        DcscContractDriftError,
      );
    });
  });
});
