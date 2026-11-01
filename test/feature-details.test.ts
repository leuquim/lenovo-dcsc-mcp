import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import { featureSpecs, smartRecommendations, subTabRecommendations } from '../src/app/catalog.js';
import {
  fetchUpstreamFeatureDetails,
  summarizeFeatureSpec,
  type UpstreamFeatureDetail,
} from '../src/domain/featureDetails.js';
import {
  fetchSmartLfoRecommendation,
  fetchSubTabRecommendations,
  fetchSummaryRecommendations,
  type SubTabRecommendation,
} from '../src/domain/recommendations.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import type { RawConfiguration } from '../src/model/types.js';

type Obj = Record<string, unknown>;

const services: DcscService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});

const mockUpstreamFeatures: UpstreamFeatureDetail[] = [
  {
    code: 'BYW4',
    displayCode: 'BYW4',
    category: 'Processor',
    description: 'Intel Xeon Silver 4510 12C 150W 2.4GHz Processor',
    unitPrice: 1354.5,
    prices: [{ priceTypeId: 1, price: 1354.5, priceNotAvailable: false }],
    priceNotAvailable: false,
    priceNotCredible: false,
    noCharge: false,
    specialBid: false,
    type: 'hardware',
    announceDate: '2023-12-14',
    withdrawnDate: '2999-12-31',
    shippingStatus: ['51', '51', '51', '51', '51', '51'],
    shipDate: '2024-01-15',
    productNumber: '7D73CTO1WW',
    recommendedFeature: true,
    topChoice: true,
    eccnRestricted: false,
    attributeMap: { Sockets: '1', TDP: '150W' },
    marketingTag: ['BestValue', 'NewGeneration'],
  },
  {
    code: 'OLD1',
    description: 'Legacy Controller',
    withdrawnDate: '2021-05-01',
    recommendedFeature: false,
    topChoice: false,
  },
];

const mockSubTabRecommendations: SubTabRecommendation[] = [
  {
    subTab: 'Storage SW',
    title: 'Storage Optimization',
    content: 'If Bundle is selected, add-ons like Easy Tier or Flashcopy cannot be selected.',
    linkText: 'Learn more',
    link: 'https://lenovo.com/storage',
  },
  {
    subTab: 'Microsoft',
    title: 'Why Choose ROK?',
    content: '- Competitive Pricing\n- 90 Day Free Support\n- Tuned and Tested Media',
  },
];

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
  type Reply = { isError?: boolean; content: Array<{ text: string }> };
  const wrap = (run: (args: Obj) => Promise<unknown>) => async (args: Obj): Promise<Reply> => {
    try {
      return { content: [{ text: JSON.stringify(await run(args)) }] };
    } catch (error) {
      return { isError: true, content: [{ text: String(error) }] };
    }
  };
  return new Map<string, (args: Obj) => Promise<Reply>>([
    ['subTabRecommendations', wrap((args) => subTabRecommendations(service, args))],
    ['featureSpecs', wrap((args) => featureSpecs(service, args as Parameters<typeof featureSpecs>[1]))],
    ['smartRecommendations', wrap((args) => smartRecommendations(service, args))],
  ]);
}

describe('Feature Details & Smart Recommendations (R4)', () => {
  describe('fetchUpstreamFeatureDetails', () => {
    it('queries POST /ctos/featureDetails with proper payload and extracts spec items', async () => {
      const service = setupService();
      const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
        raw: [{ id: 'sess-1', ctoCode: '7D73CTO1WW', features: mockUpstreamFeatures }],
        requestId: 'req-spec-1',
      } as never);

      const features = await fetchUpstreamFeatureDetails(
        service.http,
        service.newCtx(),
        '7D73CTO1WW',
        'sess-1',
        ['BYW4', 'OLD1'],
      );

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '/ctos/featureDetails',
          body: {
            kind: 'json',
            value: [
              {
                id: 'sess-1',
                ctoCode: '7D73CTO1WW',
                resultFeatures: [
                  { code: 'BYW4', ctoCode: '7D73CTO1WW' },
                  { code: 'OLD1', ctoCode: '7D73CTO1WW' },
                ],
              },
            ],
          },
        }),
      );

      expect(features).toHaveLength(2);
      expect(features[0]?.code).toBe('BYW4');
      expect(features[0]?.unitPrice).toBe(1354.5);
      expect(features[0]?.topChoice).toBe(true);
      expect(features[0]?.shippingStatus).toEqual(['51', '51', '51', '51', '51', '51']);
    });

    it('returns empty array immediately without HTTP call when codes list is empty', async () => {
      const service = setupService();
      const sendSpy = vi.spyOn(service.http, 'send');

      const features = await fetchUpstreamFeatureDetails(
        service.http,
        service.newCtx(),
        '7D73CTO1WW',
        'sess-1',
        [],
      );

      expect(features).toEqual([]);
      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  describe('summarizeFeatureSpec', () => {
    it('summarizes lifecycle, supply, commercial, and pricing flags accurately', () => {
      const summary1 = summarizeFeatureSpec(mockUpstreamFeatures[0]!);
      expect(summary1.code).toBe('BYW4');
      expect(summary1.lifecycle.announceDate).toBe('2023-12-14');
      expect(summary1.lifecycle.withdrawnDate).toBe('2999-12-31');
      expect(summary1.lifecycle.isWithdrawn).toBe(false);
      expect(summary1.supply.shippingStatus).toEqual(['51', '51', '51', '51', '51', '51']);
      expect(summary1.supply.shipDate).toBe('2024-01-15');
      expect(summary1.commercial.topChoice).toBe(true);
      expect(summary1.commercial.recommendedFeature).toBe(true);
      expect(summary1.commercial.marketingTag).toEqual(['BestValue', 'NewGeneration']);
      expect(summary1.pricing.unitPrice).toBe(1354.5);
      expect(summary1.attributes).toEqual({ Sockets: '1', TDP: '150W' });

      const summary2 = summarizeFeatureSpec(mockUpstreamFeatures[1]!);
      expect(summary2.code).toBe('OLD1');
      expect(summary2.lifecycle.withdrawnDate).toBe('2021-05-01');
      expect(summary2.lifecycle.isWithdrawn).toBe(true);
      expect(summary2.commercial.topChoice).toBe(false);
    });
  });

  describe('fetchSubTabRecommendations', () => {
    it('queries GET /recommendations/sub_tabs with mode and selectedProducts parameters', async () => {
      const service = setupService();
      const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
        raw: mockSubTabRecommendations,
      } as never);

      const recs = await fetchSubTabRecommendations(
        service.http,
        service.newCtx(),
        'CTO',
        '7D73CTO1WW',
      );

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          path: '/recommendations/sub_tabs',
          query: {
            mode: 'CTO',
            selectedProducts: '7D73CTO1WW',
          },
        }),
      );

      expect(recs).toHaveLength(2);
      expect(recs[0]?.subTab).toBe('Storage SW');
      expect(recs[0]?.content).toContain('Easy Tier');
    });

    it('rejects empty productCode with an actionable error', async () => {
      const service = setupService();
      await expect(
        fetchSubTabRecommendations(service.http, service.newCtx(), 'CTO', '   '),
      ).rejects.toThrow('non-empty productCode');
    });
  });

  describe('fetchSummaryRecommendations', () => {
    it('queries POST /recommendations/summary with cross-sell payload and mode query', async () => {
      const service = setupService();
      const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
        raw: { recommendations: [{ code: 'ATT1', title: 'Attach Warranty' }] },
      } as never);

      const payload = {
        selectedProductDataLists: [
          [{ code: '7D73CTO1WW', id: 'sess-1', quantity: 1, features: [{ code: 'BYW4', quantity: 1 }] }],
        ],
      };

      const result = await fetchSummaryRecommendations(
        service.http,
        service.newCtx(),
        payload,
        'CTO',
      );

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '/recommendations/summary',
          query: { type: 'CTO', mode: 'CTO' },
          body: { kind: 'json', value: payload },
        }),
      );

      expect(result).toMatchObject({
        recommendations: [{ code: 'ATT1' }],
      });
    });
  });

  describe('fetchSmartLfoRecommendation & Preload', () => {
    it('queries POST /smart/recommend/lfo/{country}/{ctoCode} with payload and isMultiCto query', async () => {
      const service = setupService();
      const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
        raw: { lfoResponses: [{ productCode: '7D731001US', name: 'SR650 V3 TopChoice LFO' }] },
      } as never);

      const result = await fetchSmartLfoRecommendation(
        service.http,
        service.newCtx(),
        'US',
        '7D73CTO1WW',
        { sections: [], lfoProducts: [] },
        true,
      );

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '/smart/recommend/lfo/US/7D73CTO1WW',
          query: { isMultiCto: 'true' },
        }),
      );

      expect(result).toMatchObject({
        lfoResponses: [{ productCode: '7D731001US' }],
      });
    });

    it('rejects invalid country codes or empty ctoCode', async () => {
      const service = setupService();
      await expect(
        fetchSmartLfoRecommendation(service.http, service.newCtx(), 'USA', '7D73CTO1WW'),
      ).rejects.toThrow('valid 2-letter ISO country code');

      await expect(
        fetchSmartLfoRecommendation(service.http, service.newCtx(), 'US', ''),
      ).rejects.toThrow('non-empty ctoCode');
    });
  });

  describe('Recommendation and feature-spec app functions', () => {
    it('calls subTabRecommendations with either productCode or an active session', async () => {
      const service = setupService();
      vi.spyOn(service.http, 'send').mockResolvedValue({
        raw: mockSubTabRecommendations,
      } as never);

      const handlers = getToolHandlers(service);
      const subtabTool = handlers.get('subTabRecommendations')!;
      expect(subtabTool).toBeDefined();

      // 1. With explicit productCode
      const resCode = await subtabTool({ productCode: '7D73CTO1WW' });
      expect(resCode.isError).toBeFalsy();
      const bodyCode = JSON.parse(resCode.content[0]?.text ?? '{}') as {
        productCode: string;
        count: number;
        recommendations: SubTabRecommendation[];
      };
      expect(bodyCode.productCode).toBe('7D73CTO1WW');
      expect(bodyCode.count).toBe(2);

      // 2. With session
      const raw: RawConfiguration = {
        id: 'cfg-test-1',
        code: '7D73CTO1WW',
        quantity: 1,
        tabs: [],
      };
      const session = service.sessions.create({
        raw,
        configurationId: 'cfg-test-1',
        locale: service.locale,
        solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
        mode: 'cto',
        primed: true,
        reduced: reduceConfiguration(raw, 'cfg-test-1'),
      });

      const resSession = await subtabTool({ session: session.id });
      expect(resSession.isError).toBeFalsy();
      const bodySession = JSON.parse(resSession.content[0]?.text ?? '{}') as {
        productCode: string;
        count: number;
      };
      expect(bodySession.productCode).toBe('7D73CTO1WW');

      // 3. Error when neither provided
      const resErr = await subtabTool({});
      expect(resErr.isError).toBe(true);
    });

    it('calls featureSpecs and returns summarized upstream specs', async () => {
      const service = setupService();
      vi.spyOn(service.http, 'send').mockResolvedValue({
        raw: [{ id: 'sess-1', ctoCode: '7D73CTO1WW', features: mockUpstreamFeatures }],
      } as never);

      const handlers = getToolHandlers(service);
      const featTool = handlers.get('featureSpecs')!;
      expect(featTool).toBeDefined();

      const res = await featTool({
        ctoCode: '7D73CTO1WW',
        codes: ['BYW4', 'OLD1'],
      });

      expect(res.isError).toBeFalsy();
      const body = JSON.parse(res.content[0]?.text ?? '{}') as {
        ctoCode: string;
        count: number;
        features: Array<{ code: string; supply: { shippingStatus?: string[] }; commercial: { topChoice: boolean } }>;
      };

      expect(body.ctoCode).toBe('7D73CTO1WW');
      expect(body.count).toBe(2);
      expect(body.features[0]?.code).toBe('BYW4');
      expect(body.features[0]?.supply.shippingStatus).toEqual(['51', '51', '51', '51', '51', '51']);
      expect(body.features[0]?.commercial.topChoice).toBe(true);
    });

    it('calls smartRecommendations for both smart-lfo and summary recommendations', async () => {
      const service = setupService();
      vi.spyOn(service.http, 'send').mockImplementation(async (req) => {
        if (req.path.startsWith('/smart/recommend/lfo/')) {
          return { raw: { lfoResponses: [{ productCode: '7D731001US' }] } } as never;
        }
        if (req.path === '/recommendations/summary') {
          return { raw: { summary: [{ attached: true }] } } as never;
        }
        throw new Error(`Unexpected path: ${req.path}`);
      });

      const handlers = getToolHandlers(service);
      const smartTool = handlers.get('smartRecommendations')!;
      expect(smartTool).toBeDefined();

      // 1. smart-lfo mode
      const lfoRes = await smartTool({
        type: 'smart-lfo',
        ctoCode: '7D73CTO1WW',
        country: 'US',
      });
      expect(lfoRes.isError).toBeFalsy();
      const lfoBody = JSON.parse(lfoRes.content[0]?.text ?? '{}') as {
        type: string;
        result: { lfoResponses: Array<{ productCode: string }> };
      };
      expect(lfoBody.type).toBe('smart-lfo');
      expect(lfoBody.result.lfoResponses[0]?.productCode).toBe('7D731001US');

      // 2. summary mode
      const summaryRes = await smartTool({
        type: 'summary',
        ctoCode: '7D73CTO1WW',
      });
      expect(summaryRes.isError).toBeFalsy();
      const summaryBody = JSON.parse(summaryRes.content[0]?.text ?? '{}') as {
        type: string;
        result: { summary: Array<{ attached: boolean }> };
      };
      expect(summaryBody.type).toBe('summary');
      expect(summaryBody.result.summary[0]?.attached).toBe(true);
    });
  });
});
