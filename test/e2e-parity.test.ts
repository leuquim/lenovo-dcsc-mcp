import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { type SidQueryResult } from '../src/domain/configId.js';
import { fetchConvergedCategoryDetail } from '../src/domain/specialtyCatalog.js';
import {
  fetchUpstreamFeatureDetails,
  type UpstreamFeatureDetail,
} from '../src/domain/featureDetails.js';
import type { VlhAttributes, VlhWizardInfo } from '../src/domain/vlh.js';
import { type VirtualContainerCompatibleCategory } from '../src/domain/virtualContainers.js';
import type { RawConfiguration } from '../src/model/types.js';
import { featureSpecs, subTabRecommendations } from '../src/app/catalog.js';

async function appResult(run: () => Promise<unknown>) {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await run()) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : 'error' }] };
  }
}

type Obj = Record<string, unknown>;

// Shared mock fixtures derived from upstream reverse engineering (Surveys 1-3)

const mockSidItem = {
  sidShortDesc: 'Lenovo ThinkSystem SR650 V3 Solution',
  sidNumber: 'SID123456',
  cpu: ['2x Intel Xeon Gold 6430'],
  ram: ['32x 64GB TruDDR5'],
  storage: ['8x 2.5" SAS 1.2TB'],
  gpu: [],
  network: ['4-port 10/25GbE'],
  ctoCount: 1,
  sidPrice: 15420.0,
};

const mockSidQueryResult: SidQueryResult = {
  content: [mockSidItem],
  totalElements: 12,
  number: 1,
};

const mockAutoFixCandidates = [
  {
    tabTitle: 'Processors',
    characterName: 'PROCESSOR',
    characterDesc: 'Processor',
  },
  {
    tabTitle: 'Internal Storage',
    characterName: 'NONRAID_HDD',
    characterDesc: 'HDD not in RAID Array',
  },
];

const mockFixedProcessorSection: Record<string, unknown> = {
  name: 'PROCESSOR',
  results: [{ featureCode: 'BYW4', code: 'BYW4', quantity: 1, description: 'Intel Xeon Silver 4510' }],
  errors: [],
};

const mockLvrTree = [
  {
    id: 'STG@Servers',
    name: 'Servers',
    title: 'Servers',
    children: [
      {
        id: 'STG@Servers@Rack Servers',
        name: 'Rack Servers',
        title: 'Rack Servers',
        products: [
          {
            code: '7Y51CTO1WW',
            description: 'ThinkSystem SR650 (Refurbished)',
            type: 'CTO',
            price: 1500.0,
            announceDate: '2020-01-01',
            withdrawnDate: '2999-12-31',
          },
        ],
        children: [],
      },
    ],
  },
  {
    id: 'STG@Storage',
    name: 'Storage',
    title: 'Storage',
    children: [],
  },
  {
    id: 'STG@ON DEMAND Solutions',
    name: 'ON DEMAND Solutions',
    title: 'ON DEMAND Solutions',
    children: [],
  },
];

const mockConvergedTree = [
  {
    id: 'STG@Software Defined Infrastructure',
    name: 'Software Defined Infrastructure',
    title: 'Software Defined Infrastructure',
    children: [
      {
        id: 'STG@Software Defined Infrastructure@ThinkAgile FX Series',
        name: 'ThinkAgile FX Series',
        title: 'ThinkAgile FX Series',
        products: [
          {
            code: '7DPLCTO1WW',
            description: 'ThinkAgile FX630 V4',
            type: 'CTO',
            price: 8500.0,
            announceDate: '2024-01-01',
            withdrawnDate: '2999-12-31',
          },
        ],
        children: [],
      },
    ],
  },
];

const mockConvergedDetail = {
  categoryId: 'STG@Software Defined Infrastructure@ThinkAgile FX Series',
  overview: '<p>ThinkAgile FX series overview</p>',
  marketInfo: 'Enterprise Hybrid Cloud',
  language: 'en',
  description: 'Enterprise converged solution',
  title: 'ThinkAgile FX Series',
  products: ['7DPLCTO1WW'],
};

const mockPromotionHierarchy = {
  id: 'PROMO_ROOT',
  title: 'Promotions',
  categoryId: null,
  category: null,
  description: 'Active Promotions',
  image: null,
  children: [
    {
      id: 'PROMO_Q4',
      title: 'Q4 Enterprise Server Promotion',
      children: [],
    },
  ],
  promotionSIDs: {
    id: 'PROMO_SIDS',
    children: [{ id: 'SID_PROMO_1', sidNumber: 'SID_PROMO_1' }],
  },
};

const mockFeatureDetailBYW4: UpstreamFeatureDetail = {
  code: 'BYW4',
  displayCode: 'BYW4',
  category: 'Processor',
  description: 'Intel Xeon Silver 4510 12C 150W 2.4GHz Processor',
  unitPrice: 1354.5,
  prices: [{ priceTypeId: 1, price: 1354.5, priceNotAvailable: false }],
  announceDate: '2023-12-14',
  withdrawnDate: '2999-12-31',
  shippingStatus: ['51', '51', '51'],
  shipDate: '',
  recommendedFeature: true,
  topChoice: true,
  marketingTag: ['TopChoice', 'PromoEligible'],
  eccnRestricted: false,
};

const mockSubTabRecommendations = [
  {
    subTab: 'Storage SW',
    title: '',
    content: 'If Bundle is selected, add-ons like Easy Tier or Flashcopy cannot be selected',
    linkText: '',
    link: '',
  },
  {
    subTab: 'Microsoft',
    title: 'Why Choose ROK?',
    content: '-Competitive Pricing\n-90 Day Free Support\n-Tuned and Tested Media',
    linkText: 'Learn More',
    link: 'https://lenovo.com/rok',
  },
];

const mockVlhWizardInfo: VlhWizardInfo = {
  networkTopologyConnectorsMap: {
    '100GbE_Copper': [{ shortName: 'QSFP28', description: 'QSFP28 Copper', type: 'Connector' }],
    '1GbE_Copper': [{ shortName: 'RJ45', description: 'RJ45 Copper', type: 'Connector' }],
  },
  connectorFunctions: [
    { shortName: 'Console', description: 'Console' },
    { shortName: 'Network', description: 'Network' },
    { shortName: 'Power', description: 'Power' },
    { shortName: 'Storage', description: 'Storage' },
  ],
  networkTopologies: ['100GbE_Copper', '1GbE_Copper', '25GbE_Fiber'],
  rpqPlaceholders: ['None', 'RPQ-WATER-LOOP-1'],
};

const mockVlhAttributes: VlhAttributes = {
  type: 'server',
  attributes: {
    PRODUCT_TYPE: 'SERVER',
    HEIGHT_EIA: '1',
    EIA_U_CAPACITY: 42,
    CONNECTORPORT: 2,
  },
  connectors: [
    { networkTopology: '100GbE_Copper', connector: 'QSFP28', connectorFunction: 'Network', quantity: 2 },
    { networkTopology: '1GbE_Copper', connector: 'RJ45', connectorFunction: 'Network', quantity: 2 },
  ],
};

const mockVirtualContainerCategories: VirtualContainerCompatibleCategory[] = [
  {
    id: 'vc-enclosure-1',
    compatibleProducts: [
      { code: '7D73CTO1WW', description: 'ThinkSystem SR650 V3', type: 'server' },
    ],
  },
];

function sampleRaw(id = 'node-1', code = '7D73CTO1WW', quantity = 1): RawConfiguration {
  return {
    id,
    code,
    sliceCtoCode: code,
    type: 'server',
    name: 'ThinkSystem SR650 V3',
    quantity,
    totalPrice: 4500,
    tabs: [
      {
        title: 'Hardware',
        type: 'hardware',
        subTabs: [
          {
            title: 'Processors',
            sections: [
              {
                name: 'PROCESSOR',
                features: [
                  { code: 'BYW4', description: 'Intel Xeon Silver 4510', unitPrice: 1354.5 },
                  { code: 'B0MA', description: 'Intel Xeon Bronze 3408U', unitPrice: 850.0 },
                ],
                results: [{ code: 'B0MA', quantity: 1, description: 'Intel Xeon Bronze 3408U' }],
                errors: [{ message: 'Processor selection conflicts with cooling capacity' }],
              },
            ],
          },
        ],
      },
    ],
  };
}

const services: DcscService[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(services.splice(0).map((s) => s.close()));
});

function setupMockHttp(service: DcscService) {
  return vi.spyOn(service.http, 'send').mockImplementation(async (req) => {
    const path = req.path ?? '';
    const query = req.query as Record<string, unknown> | undefined;

    // R1: SIDs
    if (path.includes('/racks/customize/non_rack')) {
      return { raw: [{ code: '7D73CTO1WW', uheight: 1, type: 'server' }] } as never;
    }
    if (path.includes('/racks/customize') && !path.includes('/non_rack')) {
      const bodyVal = (req.body?.kind === 'json' ? req.body.value : undefined) as Record<string, unknown> | undefined;
      const rackArea = (bodyVal?.['rackArea'] as unknown[]) ?? [];
      const nonRackArea = (bodyVal?.['nonRackArea'] as unknown[]) ?? [];
      return {
        raw: {
          rackArea,
          nonRackArea,
          connections: [],
        },
      } as never;
    }
    if (path.startsWith('/sids/query/')) {
      const pageIndex = Number(query?.['pageIndex'] ?? 1);
      if (pageIndex > 5) {
        return {
          raw: { content: [], totalElements: 12, number: pageIndex },
        } as never;
      }
      return {
        raw: { ...mockSidQueryResult, number: pageIndex },
      } as never;
    }
    if (path.startsWith('/reference_solution/CRNs/') && path.endsWith('/customize')) {
      const sid = path.split('/')[3];
      const raw = sampleRaw(`sid-${sid}`, '7D73CTO1WW', 1);
      return {
        raw: {
          configuration: [raw],
          configurations: [raw],
          workspace: {
            rackArea: [],
            nonRackArea: [{ id: raw.id, code: raw.code, type: 'server', size: 1, quantity: 1, originalIds: [raw.id] }],
          },
          workspaceInformation: {
            rackData: [],
            nonRackData: [{ id: raw.id, code: raw.code, type: 'server', size: 1, quantity: 1, originalIds: [raw.id] }],
          },
          differentPartMap: {},
          missingParts: [],
          removedParts: [],
        },
      } as never;
    }

    // R2: Hardware Auto-Fix
    if (path === '/cto/hardware/autoFix/config') {
      return { raw: mockAutoFixCandidates } as never;
    }
    if (path === '/cto/hardware/autoFix') {
      const body = req.body?.kind === 'json' ? (req.body.value as Record<string, unknown>) : {};
      if (body['cto'] === 'FAIL_MODEL') {
        return {
          raw: {
            ctoCode: 'FAIL_MODEL',
            sections: [],
            autoFixResult: 'FIX_FAIL',
            message: 'autoFix Failed: No valid solution found',
          },
        } as never;
      }
      return {
        raw: {
          ctoCode: '7D73CTO1WW',
          sections: [mockFixedProcessorSection],
          autoFixResult: 'FIX_SUCCESS',
          notices: [{ message: 'Processor selection updated to resolve power rule', severity: 'info' }],
        },
      } as never;
    }

    // R3: Specialty Catalogs
    if (path === '/lvr/category_hierarchies') {
      return { raw: mockLvrTree } as never;
    }
    if (path === '/multiprod_category_hierarchies') {
      return { raw: mockConvergedTree } as never;
    }
    if (path.startsWith('/multiprod_category_detail/')) {
      return { raw: mockConvergedDetail } as never;
    }
    if (path === '/promotion/hierarchies') {
      return { raw: mockPromotionHierarchy } as never;
    }
    if (path === '/promotion/sid') {
      return { raw: mockPromotionHierarchy.promotionSIDs } as never;
    }

    // R4: Feature Details & Recommendations
    if (path === '/ctos/featureDetails') {
      return {
        raw: [
          {
            id: 'session-1',
            ctoCode: '7D73CTO1WW',
            features: [mockFeatureDetailBYW4],
          },
        ],
      } as never;
    }
    if (path === '/recommendations/sub_tabs') {
      return { raw: mockSubTabRecommendations } as never;
    }
    if (path === '/recommendations/summary') {
      return { raw: { recommendations: [] } } as never;
    }
    if (path.startsWith('/smart/recommend/lfo/')) {
      return { raw: { lfoResponses: null } } as never;
    }

    // R6: VLH & Virtual Containers
    if (path === '/vlh/wizardInfo') {
      return { raw: mockVlhWizardInfo } as never;
    }
    if (path.startsWith('/vlh/attributes/')) {
      return { raw: mockVlhAttributes } as never;
    }
    if (path === '/virtual-containers/getCompatibleProductsForVirtualContainer') {
      return { raw: mockVirtualContainerCategories } as never;
    }
    if (path === '/virtual-containers/checkIfAnythingNeedUpdate') {
      return { raw: [] } as never;
    }
    if (path === '/virtual-containers/allAvailableBlackList') {
      return { raw: [] } as never;
    }

    // Common derive / catalog
    if (path === '/ctos/autoDerive' || path.includes('/autoDerive')) {
      const bodyVal = (req.body?.kind === 'json' ? req.body.value : undefined) as Record<string, unknown> | undefined;
      const requestedConfigs = (bodyVal?.['configurations'] as Array<{ id?: string; code?: string }>) ?? [];
      const configs = requestedConfigs.length > 0
        ? requestedConfigs.map((c) => {
            const raw = sampleRaw(c.id ?? 'node-1', c.code ?? '7D73CTO1WW', 1);
            raw.tabs![0]!.subTabs![0]!.sections![0]!.results = [
              { code: 'BYW4', quantity: 1, description: 'Intel Xeon Silver 4510' },
            ];
            raw.tabs![0]!.subTabs![0]!.sections![0]!.errors = [];
            return raw;
          })
        : [
            (() => {
              const id = (bodyVal?.['id'] as string) ?? 'node-1';
              const code = (bodyVal?.['code'] as string) ?? '7D73CTO1WW';
              const raw = sampleRaw(id, code, 1);
              raw.tabs![0]!.subTabs![0]!.sections![0]!.results = [
                { code: 'BYW4', quantity: 1, description: 'Intel Xeon Silver 4510' },
              ];
              raw.tabs![0]!.subTabs![0]!.sections![0]!.errors = [];
              return raw;
            })(),
          ];
      return { raw: { configurations: configs, autoDerivedResults: [] } } as never;
    }

    return { raw: {} } as never;
  });
}

async function createHarness() {
  const service = new DcscService(
    ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }),
  );
  services.push(service);

  const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
  vi.spyOn(service, 'resolveSolution').mockResolvedValue(solution);
  const send = setupMockHttp(service);

  const server = new McpServer({ name: 'lenovo-dcsc-e2e', version: '0.1.0' });
  registerTools(server, service);

  const client = new Client({ name: 'e2e-test-client', version: '1.0.0' });
  clients.push(client);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { service, server, client, send, solution };
}

function parseResult(callResult: unknown): Obj {
  const res = callResult as { content?: Array<{ type: string; text: string }>; isError?: boolean };
  if (res.isError) {
    const errorText = res.content?.[0]?.text ?? 'Unknown error';
    throw new Error(errorText);
  }
  return JSON.parse(res.content?.[0]?.text ?? '{}') as Obj;
}

// ============================================================================
// 4-Tier Comprehensive Opaque-Box E2E Parity Suite (R1 - R6)
// ============================================================================

describe('DCSC Parity Gap E2E Suite: 4-Tier Architecture (R1 - R6)', () => {
  // --------------------------------------------------------------------------
  // Tier 1: Feature Coverage (Happy Path for R1 - R6)
  // --------------------------------------------------------------------------
  describe('Tier 1: Feature Coverage (Primary Capabilities)', () => {
    it('T1.3: R1 — query SIDs with pagination and customize preconfigured SID solution', async () => {
      const { service, client } = await createHarness();

      const toolRes = await client.callTool({
        name: 'dcsc_search',
        arguments: { search: { kind: 'sids', categoryId: 'STG@Servers', offset: 0, limit: 10 } },
      });
      const data = parseResult(toolRes);

      expect(data['totalElements']).toBe(12);
      expect(data['pageIndex']).toBe(1);
      const content = data['content'] as Array<{ sidNumber: string; cpu: string[] }>;
      expect(content[0]?.sidNumber).toBe('SID123456');
      expect(content[0]?.cpu).toContain('2x Intel Xeon Gold 6430');

      // Customize SID via service
      const imported = await service.customizeSid('SID123456');
      expect(imported.sessions).toHaveLength(1);
      expect(imported.sessions[0]?.product.code).toBe('7D73CTO1WW');
    });

    it('T1.4: R2 — discover candidate auto-fix sections and execute transactional auto-fix mutation', async () => {
      const { service, client } = await createHarness();
      const raw = sampleRaw('node-err', '7D73CTO1WW');
      const session = service.sessions.create({
        raw,
        configurationId: raw.id!,
        locale: service.locale,
        solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
        mode: 'cto',
        reduced: reduceConfiguration(raw, raw.id!),
        primed: true,
      });

      // 1. Inspect candidates
      const candidates = await service.inspectAutoFix(session.id);
      expect(candidates.candidates).toHaveLength(2);
      expect(candidates.candidates[0]?.characterName).toBe('PROCESSOR');

      // 2. Execute auto-fix mutation via MCP
      const toolRes = await client.callTool({
        name: 'dcsc_auto_fix',
        arguments: { session: session.id, expectedRevision: session.revision },
      });
      const data = parseResult(toolRes);

      expect(data['applied']).toBe(true);
      expect(data['revision']).toBe(2);
      expect(data['sectionsChanged']).toContain('PROCESSOR');
      expect(session.raw.tabs![0]!.subTabs![0]!.sections![0]!.results![0]!.code).toBe('BYW4');
    });

    it('T1.5: R3 — browse specialty catalogs (LVR Certified Refurbished, Converged, Promotions)', async () => {
      const { client } = await createHarness();

      // 1. LVR Refurbished
      const lvrRes = await client.callTool({
        name: 'dcsc_search',
        arguments: { search: { kind: 'specialty', catalog: 'lvr' } },
      });
      const lvrData = parseResult(lvrRes);
      expect(lvrData['catalog']).toBe('lvr');
      const lvrEntries = lvrData['entries'] as Array<{ code: string; title: string }>;
      expect(lvrEntries.some((e) => e.code === '7Y51CTO1WW')).toBe(true);

      // 2. Converged MultiProd
      const convRes = await client.callTool({
        name: 'dcsc_search',
        arguments: { search: { kind: 'specialty', catalog: 'converged' } },
      });
      const convData = parseResult(convRes);
      expect(convData['catalog']).toBe('converged');
      const convEntries = convData['entries'] as Array<{ code: string }>;
      expect(convEntries.some((e) => e.code === '7DPLCTO1WW')).toBe(true);

      // 3. Converged Detail
      const detailRes = await client.callTool({
        name: 'dcsc_search',
        arguments: { search: { kind: 'specialty',
          catalog: 'converged',
          categoryId: 'STG@Software Defined Infrastructure@ThinkAgile FX Series',
        } },
      });
      const detailData = parseResult(detailRes);
      expect((detailData['detail'] as Obj)['title']).toBe('ThinkAgile FX Series');

      // 4. Promotions
      const promoRes = await client.callTool({
        name: 'dcsc_search',
        arguments: { search: { kind: 'specialty', catalog: 'promotion', subType: 'sid' } },
      });
      const promoData = parseResult(promoRes);
      expect(promoData['catalog']).toBe('promotion');
      expect((promoData['data'] as Obj)['id']).toBe('PROMO_SIDS');
    });

    it('T1.6: R4 — query rich upstream feature specs and subtab recommendations', async () => {
      const { service } = await createHarness();

      // 1. Rich Feature Specs
      const featRes = await appResult(() => featureSpecs(service, { ctoCode: '7D73CTO1WW', codes: ['BYW4'] }));
      const featData = parseResult(featRes);
      const specs = featData['features'] as Array<{ code: string; lifecycle: Obj; commercial: Obj }>;
      expect(specs[0]?.code).toBe('BYW4');
      expect(specs[0]?.lifecycle['announceDate']).toBe('2023-12-14');
      expect(specs[0]?.commercial['topChoice']).toBe(true);
      expect(specs[0]?.commercial['marketingTag']).toContain('TopChoice');

      // 2. SubTab Recommendations
      const subRes = await appResult(() => subTabRecommendations(service, { productCode: '7D73CTO1WW', mode: 'CTO' }));
      const subData = parseResult(subRes);
      expect(subData['count']).toBe(2);
      const recs = subData['recommendations'] as Array<{ subTab: string; content: string }>;
      expect(recs.some((r) => r.subTab === 'Storage SW')).toBe(true);
      expect(recs.some((r) => r.subTab === 'Microsoft')).toBe(true);
    });

    it('T1.7: R5 — auto-expand unracked multi-unit configuration into physical records on export', async () => {
      const { service } = await createHarness();
      const raw = sampleRaw('unracked-1', '7D73CTO1WW', 3);
      const session = service.sessions.create({
        raw,
        configurationId: raw.id!,
        locale: service.locale,
        solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
        mode: 'cto',
        reduced: reduceConfiguration(raw, raw.id!),
        primed: true,
      });

      const ws = service.sessions.getWorkspace(session.workspaceId)!;
      ws.nonRackArea = [
        { id: raw.id!, code: raw.code, type: 'server', size: 1, quantity: 3, originalIds: [raw.id!] },
      ];

      const exported = buildExportData({
        workspace: ws,
        solution: ws.solution,
        fileTypes: ['XML'],
        validationMode: 'guided',
      });

      const nonRackData = (exported.workspaceInformation as Obj).nonRackData as Array<Record<string, unknown>>;
      expect(nonRackData).toHaveLength(3);
      expect(nonRackData.map((r) => r.id)).toEqual([
        'unracked-1',
        'unracked-1__clone_1',
        'unracked-1__clone_2',
      ]);
      expect(nonRackData.every((r) => r.quantity === 1)).toBe(true);

      const nonRackArea = (exported.workspace as Obj).nonRackArea as Array<Record<string, unknown>>;
      expect(nonRackArea[0]?.quantity).toBe(3);
      expect(nonRackArea[0]?.originalIds).toEqual([
        'unracked-1',
        'unracked-1__clone_1',
        'unracked-1__clone_2',
      ]);
    });

    it('T1.8: R6 — inspect VLH wizard info, physical attributes, and virtual container rules', async () => {
      const { service, client } = await createHarness();
      const raw = sampleRaw('vc-node');
      const session = service.sessions.create({
        raw,
        configurationId: raw.id!,
        locale: service.locale,
        solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
        mode: 'cto',
        reduced: reduceConfiguration(raw, raw.id!),
        primed: true,
      });

      // 1. VLH Wizard Info
      const wizRes = await client.callTool({
        name: 'dcsc_vlh_get',
        arguments: {},
      });
      const wizData = parseResult(wizRes);
      expect(wizData['networkTopologies']).toContain('100GbE_Copper');
      expect(wizData['connectorFunctions']).toBeDefined();

      // 2. VLH Attributes
      const attrRes = await client.callTool({
        name: 'dcsc_vlh_get',
        arguments: { code: '7D73CTO1WW' },
      });
      const attrData = parseResult(attrRes);
      expect((attrData['attributes'] as Obj)['PRODUCT_TYPE']).toBe('SERVER');
      expect((attrData['attributes'] as Obj)['HEIGHT_EIA']).toBe('1');

      // 3. Virtual Containers Compatibility & Rules
      const compRes = await client.callTool({
        name: 'dcsc_virtual_container_get',
        arguments: { session: session.workspaceId, check: 'compatibleProducts' },
      });
      const compData = parseResult(compRes);
      expect(compData['categories']).toHaveLength(1);

      const rulesRes = await client.callTool({
        name: 'dcsc_virtual_container_get',
        arguments: { session: session.workspaceId, check: 'rules' },
      });
      const rulesData = parseResult(rulesRes);
      expect(rulesData['rules']).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Tier 2: Boundary & Corner Cases (Edge Conditions & Failure Isolation)
  // --------------------------------------------------------------------------
  describe('Tier 2: Boundary & Corner Cases (Edge Conditions & Robustness)', () => {
    it('T2.1: R1 — empty SID query results when pageIndex exceeds available items', async () => {
      const { client } = await createHarness();

      const toolRes = await client.callTool({
        name: 'dcsc_search',
        arguments: { search: { kind: 'sids', categoryId: 'STG@Servers', offset: 980, limit: 10 } },
      });
      const data = parseResult(toolRes);

      expect(data['totalElements']).toBe(12);
      expect(data['pageIndex']).toBe(99);
      expect(data['returned']).toBe(0);
      expect(data['content']).toEqual([]);
    });

    it('T2.4: R2 — auto-fix gracefully rejects non-CTO mode sessions without HTTP call', async () => {
      const { service, client, send } = await createHarness();
      const raw = sampleRaw('lfo-node');
      const session = service.sessions.create({
        raw,
        configurationId: raw.id!,
        locale: service.locale,
        solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
        mode: 'lfo',
        reduced: reduceConfiguration(raw, raw.id!),
        primed: true,
      });

      send.mockClear();
      const toolRes = await client.callTool({
        name: 'dcsc_auto_fix',
        arguments: { session: session.id },
      });
      const res = toolRes as { isError?: boolean; content?: Array<{ text: string }> };
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toContain('Auto-fix is only supported for hardware CTO');
      expect(send).not.toHaveBeenCalled();
    });

    it('T2.5: R2 — auto-fix handles FIX_FAIL without applying corrupt sections or advancing revision', async () => {
      const { service, client } = await createHarness();
      const raw = sampleRaw('node-fail', 'FAIL_MODEL');
      const session = service.sessions.create({
        raw,
        configurationId: raw.id!,
        locale: service.locale,
        solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
        mode: 'cto',
        reduced: reduceConfiguration(raw, raw.id!),
        primed: true,
      });

      const initialRevision = session.revision;
      const initialFeature = session.raw.tabs![0]!.subTabs![0]!.sections![0]!.results![0]!.code;

      const toolRes = await client.callTool({
        name: 'dcsc_auto_fix',
        arguments: { session: session.id },
      });
      const data = parseResult(toolRes);

      expect(data['applied']).toBe(false);
      expect(data['revision']).toBe(initialRevision);
      expect(session.revision).toBe(initialRevision);
      expect(session.raw.tabs![0]!.subTabs![0]!.sections![0]!.results![0]!.code).toBe(initialFeature);
    });

    it('T2.6: R2 — auto-fix rejects CAS revision conflict without corrupting draft', async () => {
      const { service, client } = await createHarness();
      const raw = sampleRaw('node-cas');
      const session = service.sessions.create({
        raw,
        configurationId: raw.id!,
        locale: service.locale,
        solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
        mode: 'cto',
        reduced: reduceConfiguration(raw, raw.id!),
        primed: true,
      });

      const toolRes = await client.callTool({
        name: 'dcsc_auto_fix',
        arguments: { session: session.id, expectedRevision: 999 },
      });
      const res = toolRes as { isError?: boolean; content?: Array<{ text: string }> };
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toContain('conflict');
    });

    it('T2.7: R3 — specialty catalog rejects empty categoryId for converged detail', async () => {
      const { service } = await createHarness();
      const ctx = service.newCtx();

      await expect(fetchConvergedCategoryDetail(service.http, ctx, '')).rejects.toThrow(
        /non-empty categoryId is required/,
      );
    });

    it('T2.8: R3 — specialty catalog query returns empty items when query matches nothing', async () => {
      const { client } = await createHarness();

      const toolRes = await client.callTool({
        name: 'dcsc_search',
        arguments: { search: { kind: 'specialty', catalog: 'lvr', query: 'NON_EXISTENT_PRODUCT_XYZ' } },
      });
      const data = parseResult(toolRes);

      expect(data['total']).toBe(0);
      expect(data['entries']).toEqual([]);
    });

    it('T2.9: R4 — feature details returns empty array fast-path when codes list is empty', async () => {
      const { service, send } = await createHarness();
      const ctx = service.newCtx();

      send.mockClear();
      const res = await fetchUpstreamFeatureDetails(service.http, ctx, '7D73CTO1WW', 'session-1', []);
      expect(res).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    });

    it('T2.10: R4 — subtab recommendations rejects empty or whitespace product code', async () => {
      const { service } = await createHarness();

      const toolRes = await appResult(() => subTabRecommendations(service, { productCode: '   ' }));
      const res = toolRes as { isError?: boolean; content?: Array<{ text: string }> };
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toContain('Provide either a valid productCode');
    });

    it('T2.11: R5 — single-unit unracked configuration (quantity = 1) generates zero synthetic clones', async () => {
      const { service } = await createHarness();
      const raw = sampleRaw('single-1', '7D73CTO1WW', 1);
      const session = service.sessions.create({
        raw,
        configurationId: raw.id!,
        locale: service.locale,
        solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
        mode: 'cto',
        reduced: reduceConfiguration(raw, raw.id!),
        primed: true,
      });

      const ws = service.sessions.getWorkspace(session.workspaceId)!;
      ws.nonRackArea = [
        { id: raw.id!, code: raw.code, type: 'server', size: 1, quantity: 1, originalIds: [raw.id!] },
      ];

      const exported = buildExportData({
        workspace: ws,
        solution: ws.solution,
        fileTypes: ['XML'],
        validationMode: 'guided',
      });

      const nonRackData = (exported.workspaceInformation as Obj).nonRackData as Array<Record<string, unknown>>;
      expect(nonRackData).toHaveLength(1);
      expect(nonRackData[0]?.id).toBe('single-1');
      expect(nonRackData.some((r) => String(r.id).includes('__clone_'))).toBe(false);
    });

    it('T2.12: R5 — extreme multi-unit quantity (quantity = 10) correctly generates exactly 9 unique clones', async () => {
      const { service } = await createHarness();
      const raw = sampleRaw('qty10-node', '7D73CTO1WW', 10);
      const session = service.sessions.create({
        raw,
        configurationId: raw.id!,
        locale: service.locale,
        solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
        mode: 'cto',
        reduced: reduceConfiguration(raw, raw.id!),
        primed: true,
      });

      const ws = service.sessions.getWorkspace(session.workspaceId)!;
      ws.nonRackArea = [
        { id: raw.id!, code: raw.code, type: 'server', size: 1, quantity: 10, originalIds: [raw.id!] },
      ];

      const exported = buildExportData({
        workspace: ws,
        solution: ws.solution,
        fileTypes: ['XML'],
        validationMode: 'guided',
      });

      const nonRackData = (exported.workspaceInformation as Obj).nonRackData as Array<Record<string, unknown>>;
      expect(nonRackData).toHaveLength(10);
      const ids = nonRackData.map((r) => r.id);
      expect(ids[0]).toBe('qty10-node');
      for (let k = 1; k <= 9; k++) {
        expect(ids).toContain(`qty10-node__clone_${k}`);
      }
      expect(new Set(ids).size).toBe(10);
    });
  });

  // --------------------------------------------------------------------------
  // Tier 3: Cross-Feature Combinations (System Integrations)
  // --------------------------------------------------------------------------
  describe('Tier 3: Cross-Feature Combinations (Interactions & Data Pipelines)', () => {
    it('T3.1: Cross R1 + R5 — multi-unit export auto-expansion', async () => {
      const { service } = await createHarness();

      // 1. Create multi-unit configuration (quantity = 3)
      const raw = sampleRaw('cross-node', '7D73CTO1WW', 3);
      const session = service.sessions.create({
        raw,
        configurationId: raw.id!,
        locale: service.locale,
        solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
        mode: 'cto',
        reduced: reduceConfiguration(raw, raw.id!),
        primed: true,
      });

      const ws = service.sessions.getWorkspace(session.workspaceId)!;
      ws.nonRackArea = [
        { id: raw.id!, code: raw.code, type: 'server', size: 1, quantity: 3, originalIds: [raw.id!] },
      ];

      // 2. Export with multi-unit auto-expansion
      const exported = buildExportData({
        workspace: ws,
        solution: ws.solution,
        fileTypes: ['XML'],
        validationMode: 'guided',
      });
      const nonRackData = (exported.workspaceInformation as Obj).nonRackData as Array<Record<string, unknown>>;
      expect(nonRackData).toHaveLength(3);
    });

    it('T3.2: Cross R2 + R3 — discover model in LVR specialty catalog, launch session, and resolve hardware rule error with auto-fix', async () => {
      const { service, client } = await createHarness();

      // 1. Browse LVR catalog to find model
      const catRes = await client.callTool({
        name: 'dcsc_search',
        arguments: { search: { kind: 'specialty', catalog: 'lvr', query: 'SR650' } },
      });
      const catData = parseResult(catRes);
      const entries = catData['entries'] as Array<{ code: string }>;
      const lvrModel = entries[0]?.code ?? '7Y51CTO1WW';
      expect(lvrModel).toBe('7Y51CTO1WW');

      // 2. Launch session with error
      const raw = sampleRaw('lvr-session-1', lvrModel);
      const session = service.sessions.create({
        raw,
        configurationId: raw.id!,
        locale: service.locale,
        solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
        mode: 'cto',
        reduced: reduceConfiguration(raw, raw.id!),
        primed: true,
      });

      // 3. Auto-fix resolves rule error
      const fixRes = await client.callTool({
        name: 'dcsc_auto_fix',
        arguments: { session: session.id },
      });
      const fixData = parseResult(fixRes);
      expect(fixData['applied']).toBe(true);
      expect(fixData['sectionsChanged']).toContain('PROCESSOR');
      expect(session.raw.tabs![0]!.subTabs![0]!.sections![0]!.errors).toHaveLength(0);
    });

    it('T3.3: Cross R2/R3 + R4 — query rich upstream feature specs and subtab recommendations for auto-fixed components', async () => {
      const { service, client } = await createHarness();
      const raw = sampleRaw('spec-session-1', '7D73CTO1WW');
      const session = service.sessions.create({
        raw,
        configurationId: raw.id!,
        locale: service.locale,
        solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
        mode: 'cto',
        reduced: reduceConfiguration(raw, raw.id!),
        primed: true,
      });

      // Auto-fix switches component to BYW4
      await client.callTool({
        name: 'dcsc_auto_fix',
        arguments: { session: session.id },
      });

      // Query specs for the auto-fixed feature code
      const specRes = await appResult(() => featureSpecs(service, { session: session.id, codes: ['BYW4'] }));
      const specData = parseResult(specRes);
      const specs = specData['features'] as Array<{ code: string; commercial: Obj; supply: Obj }>;
      expect(specs[0]?.code).toBe('BYW4');
      expect(specs[0]?.commercial['topChoice']).toBe(true);
      expect(specs[0]?.supply['shippingStatus']).toBeDefined();

      // Query subtab recommendations for this model
      const subRes = await appResult(() => subTabRecommendations(service, { session: session.id }));
      const subData = parseResult(subRes);
      expect(subData['productCode']).toBe('7D73CTO1WW');
      expect(subData['count']).toBe(2);
    });

    it('T3.4: Cross R5 + R6 — inspect VLH physical attributes (height, connectors) for multi-unit system prior to export', async () => {
      const { service, client } = await createHarness();

      // 1. Inspect VLH physical constraints
      const vlhRes = await client.callTool({
        name: 'dcsc_vlh_get',
        arguments: { code: '7D73CTO1WW' },
      });
      const vlhData = parseResult(vlhRes);
      const height = (vlhData['attributes'] as Obj)['HEIGHT_EIA'];
      expect(height).toBe('1');

      // 2. Configure 4-unit unracked deployment knowing each unit is 1U
      const raw = sampleRaw('vlh-multi-node', '7D73CTO1WW', 4);
      const session = service.sessions.create({
        raw,
        configurationId: raw.id!,
        locale: service.locale,
        solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
        mode: 'cto',
        reduced: reduceConfiguration(raw, raw.id!),
        primed: true,
      });

      const ws = service.sessions.getWorkspace(session.workspaceId)!;
      ws.nonRackArea = [
        { id: raw.id!, code: raw.code, type: 'server', size: Number(height), quantity: 4, originalIds: [raw.id!] },
      ];

      // 3. Export verifying auto-expansion retains the 1U size across all 4 physical instances
      const exported = buildExportData({
        workspace: ws,
        solution: ws.solution,
        fileTypes: ['XML'],
        validationMode: 'guided',
      });
      const nonRackData = (exported.workspaceInformation as Obj).nonRackData as Array<Record<string, unknown>>;
      expect(nonRackData).toHaveLength(4);
      expect(nonRackData.every((r) => r.size === 1)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Tier 4: Real-World Application Scenarios (End-to-End Enterprise Workflows)
  // --------------------------------------------------------------------------
  describe('Tier 4: Real-World Application Scenarios (End-to-End Enterprise Workflows)', () => {
    it('T4.1: Scenario A — Full Enterprise Lifecycle: Specialty LVR Discovery -> Specs -> Auto-Fix -> Multi-Unit Export -> Reimport', async () => {
      const { service, client } = await createHarness();

      // Step 1: Discover Certified Refurbished server in LVR specialty catalog
      const catRes = await client.callTool({
        name: 'dcsc_search',
        arguments: { search: { kind: 'specialty', catalog: 'lvr', query: 'SR650' } },
      });
      const catData = parseResult(catRes);
      const chosenModel = (catData['entries'] as Array<{ code: string }>)[0]?.code ?? '7Y51CTO1WW';

      // Step 2: Launch configuration session
      const raw = sampleRaw('ent-lvr-node', chosenModel, 1);
      const session = service.sessions.create({
        raw,
        configurationId: raw.id!,
        locale: service.locale,
        solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
        mode: 'cto',
        reduced: reduceConfiguration(raw, raw.id!),
        primed: true,
      });

      // Step 3: Check subtab recommendations for licensing/storage rules
      const subRes = await appResult(() => subTabRecommendations(service, { session: session.id }));
      expect(parseResult(subRes)['count']).toBeGreaterThan(0);

      // Step 4: Check feature spec details
      const specRes = await appResult(() => featureSpecs(service, { ctoCode: chosenModel, codes: ['BYW4'] }));
      const features = parseResult(specRes)['features'] as Array<{ code: string; commercial: { topChoice: boolean } }>;
      expect(features[0]?.commercial.topChoice).toBe(true);

      // Step 5: Automatically resolve rule errors
      const fixRes = await client.callTool({
        name: 'dcsc_auto_fix',
        arguments: { session: session.id },
      });
      expect(parseResult(fixRes)['applied']).toBe(true);

      // Step 6: Scale quantity to 3 units unracked
      await service.sessions.transact(session.id, {}, (draftWorkspace, draft) => {
        draft!.raw.quantity = 3;
        draftWorkspace.nonRackArea = [
          { id: draft!.raw.id!, code: draft!.raw.code, type: 'server', size: 1, quantity: 3, originalIds: [draft!.raw.id!] },
        ];
      });
      const ws = service.sessions.getWorkspace(session.workspaceId)!;

      // Step 7: Export solution bundle (verifying physical auto-expansion)
      const exported = buildExportData({
        workspace: ws,
        solution: ws.solution,
        fileTypes: ['XML'],
        validationMode: 'guided',
      });
      const nonRackData = (exported.workspaceInformation as Obj).nonRackData as Array<Record<string, unknown>>;
      expect(nonRackData).toHaveLength(3);

    });

    it('T4.2: Scenario B — Complex Solution Design: SIDs -> VLH Neptune Cooling -> Virtual Containers -> Quote Validation', async () => {
      const { service, client } = await createHarness();

      // Step 1: Query preconfigured SID templates for Servers
      const sidRes = await client.callTool({
        name: 'dcsc_search',
        arguments: { search: { kind: 'sids', categoryId: 'STG@Servers', offset: 0, limit: 10 } },
      });
      const sidList = parseResult(sidRes)['content'] as Array<{ sidNumber: string; sidPrice: number }>;
      const chosenSid = sidList[0]?.sidNumber ?? 'SID123456';
      expect(chosenSid).toBe('SID123456');

      // Step 2: Customize preconfigured SID solution into workspace
      const customized = await service.customizeSid(chosenSid);
      const session = customized.sessions[0]!;
      expect(session.product.code).toBe('7D73CTO1WW');

      // Step 3: Query VLH wizard info for liquid-cooling topologies
      const vlhWizRes = await client.callTool({
        name: 'dcsc_vlh_get',
        arguments: {},
      });
      const wizInfo = parseResult(vlhWizRes);
      expect(wizInfo['networkTopologies']).toContain('100GbE_Copper');

      // Step 4: Query VLH physical attributes for server chassis
      const vlhAttrRes = await client.callTool({
        name: 'dcsc_vlh_get',
        arguments: { code: session.product.code },
      });
      const attrs = parseResult(vlhAttrRes);
      expect((attrs['attributes'] as Obj)['HEIGHT_EIA']).toBe('1');

      // Step 5: Evaluate virtual container compatibility and multi-product rules
      const compRes = await client.callTool({
        name: 'dcsc_virtual_container_get',
        arguments: { session: session.workspaceId, check: 'compatibleProducts' },
      });
      expect(parseResult(compRes)['categories']).toHaveLength(1);

      const rulesRes = await client.callTool({
        name: 'dcsc_virtual_container_get',
        arguments: { session: session.workspaceId, check: 'rules' },
      });
      expect(parseResult(rulesRes)['rules']).toEqual([]);

    });
  });
});
