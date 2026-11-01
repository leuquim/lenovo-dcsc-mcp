import { describe, expect, it, vi } from 'vitest';

import {
  browseStandaloneSoftware,
  buildProductServiceExportEnvelope,
  buildServiceCatalogDownload,
  buildStandaloneSoftwareExportEnvelope,
  findParts,
  launchProductServices,
  launchStandaloneSoftware,
  removeProductService,
  searchServiceProducts,
  searchSoftwareForProduct,
  serviceCatalogCodes,
  selectProductService,
  selectStandaloneSoftware,
  setStandaloneSoftwareQuantity,
  summariseProductServices,
} from '../src/domain/standalone.js';
import type { DcscHttpClient, RequestCtx } from '../src/http/request.js';

const ctx = {
  corrId: 'standalone-test',
  locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
  solution: { solutionMode: 'General Purpose', masterSlices: ['GP', 'HPCGPALL', 'HPCGPRYO'] },
} satisfies RequestCtx;

// Representative subset of dcsc-software-flow.json captured 2026-10-15.
const softwareFeature = {
  softwareCode: '7S1SCTO8WW',
  code: '7S1S002WWW',
  description:
    'Windows Server 2025 Standard Additional License (2 core) (No Media/Key) (Reseller POS Only)',
  announceDate: '2024-11-05',
  withdrawnDate: '2999-12-31',
  priceNotAvailable: false,
  unitPrice: 234.5,
  type: 'software',
  prices: [{ priceTypeId: 1, price: 234.5, priceNotAvailable: false }],
  showPrice: true,
  preSelectedQuantity: 0,
  optionAttributes: { Type: 'Standard', License: '2 core' },
  marketingTag: [],
  inventory: null,
  capturedExtra: { mustSurvive: true },
};

const softwarePortal = {
  tabs: [
    {
      title: 'OS & Software',
      subTabs: [
        {
          title: 'Microsoft',
          sections: [
            {
              name: 'T1KB',
              description: 'Windows Server 2025 ROK',
              subCategorys: [
                {
                  name: 'T1KD',
                  description: 'Windows Server 2025 Additional License',
                  features: [softwareFeature],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  serverMetadata: { revision: 'captured' },
};

const softwareLaunch = {
  softwareTabs: [{ tabTypeIdentifier: 'software', title: 'OS & Software' }],
  softwareHipoDerivedItems: [],
  errors: [],
};

// Representative subset of dcsc-service-flow.json captured 2026-10-15.
const serviceFeature = {
  code: '5WS7B99623',
  description: '3Yr Premier NBD Resp SR630 V3',
  type: 'Warranty Service Upgrades',
  characterName: 'Warranty Service Upgrades',
  unitPrice: 1637,
  prices: [{ priceTypeId: 1, price: 1637, priceNotAvailable: false }],
  productNumber: '7D73CTO1WW',
  preSelectedQuantity: 1,
  facets: [{ facetName: 'Term', facetValue: '3 Year', facetID: 'WARRANTYPERIOD' }],
  capturedExtra: { mustSurvive: true },
};

const serviceGraph = {
  totalPrices: [],
  subCategory: 'Point of Sale',
  tabs: [
    {
      title: 'Services',
      type: 'servicesAndor',
      subTabs: [
        {
          title: 'A la Carte|Column2',
          type: 'servicesAndor',
          sections: [
            {
              name: 'A la Carte|Column2|3 Year',
              description: '3 Year',
              features: [serviceFeature],
              results: [],
            },
          ],
        },
      ],
    },
  ],
};

const serviceResult = {
  code: serviceFeature.code,
  description: serviceFeature.description,
  quantity: 1,
  type: 'service',
  characterName: serviceFeature.characterName,
};

function graphWithResults(
  graph: typeof serviceGraph,
  results: Array<Record<string, unknown>>,
): typeof serviceGraph {
  const selected = structuredClone(graph);
  selected.tabs[0]!.subTabs[0]!.sections[0]!.results = results as typeof selected.tabs[0]['subTabs'][0]['sections'][0]['results'];
  return selected;
}

describe('global part lookup', () => {
  it('uses the captured query contract and does not invent pagination metadata', async () => {
    const raw = [
      {
        code: '7D73CTO1WW',
        description: 'ThinkSystem SR630 V3-3yr Base Warranty',
        type: 'CTO',
        price: 0.01,
        capturedExtra: true,
      },
    ];
    const send = vi.fn().mockResolvedValue({ raw });

    const result = await findParts({ send } as unknown as DcscHttpClient, ctx, {
      keyword: ' 7D73 ',
      types: ['SOFTWARE', 'SERVICE', 'HARDWARE'],
      mode: 'CTO',
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'findpart',
        method: 'GET',
        path: '/findpart',
        query: {
          keyword: '7D73',
          type: 'SOFTWARE,SERVICE,HARDWARE',
          mode: 'CTO',
          controlExpressModal: true,
          serviceCto: true,
        },
      }),
    );
    expect(result).toMatchObject({
      upstreamCompleteness: 'unknown',
      items: [
        {
          code: '7D73CTO1WW',
          type: 'CTO',
          nextAction: 'launch_configuration',
        },
      ],
    });
    expect(result.raw).toBe(raw);
    expect(result.items[0]?.raw).toBe(raw[0]);
    expect(result).not.toHaveProperty('total');
  });
});

describe('standalone software', () => {
  it('launches both captured catalogs and preserves their complete raw responses', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ raw: softwareLaunch })
      .mockResolvedValueOnce({ raw: softwarePortal });

    const state = await launchStandaloneSoftware(
      { send } as unknown as DcscHttpClient,
      ctx,
    );

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/ctos/standalone_software/launch',
        query: { controlExpressModal: true, serviceCto: true },
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/software/portal/launch',
        query: { controlExpressModal: true, serviceCto: true },
      }),
    ]);
    expect(state.launchRaw).toBe(softwareLaunch);
    expect(state.portalRaw).toBe(softwarePortal);
    expect(state.features[0]?.raw).toBe(softwareFeature);
    expect(state.features[0]).toMatchObject({
      code: '7S1S002WWW',
      softwareCode: '7S1SCTO8WW',
      unitPrice: 234.5,
      attributes: { Type: 'Standard', License: '2 core' },
      path: {
        tab: 'OS & Software',
        subTab: 'Microsoft',
        section: 'Windows Server 2025 ROK',
        subCategory: 'Windows Server 2025 Additional License',
      },
    });
  });

  it('browses locally, changes quantity locally, and builds the captured LFO export shape', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ raw: softwareLaunch })
      .mockResolvedValueOnce({ raw: softwarePortal });
    const launched = await launchStandaloneSoftware(
      { send } as unknown as DcscHttpClient,
      ctx,
    );

    const page = browseStandaloneSoftware(launched, {
      query: '7S1S002WWW',
      path: { subTab: 'Microsoft' },
      limit: 10,
    });
    expect(page).toMatchObject({ totalInFetchedCatalog: 1, upstreamCompleteness: 'unknown' });

    const selected = selectStandaloneSoftware(launched, {
      code: '7S1S002WWW',
      quantity: 1,
      id: 'captured-id',
    });
    const changed = setStandaloneSoftwareQuantity(selected, '7S1S002WWW', 3);
    expect(send).toHaveBeenCalledTimes(2);
    expect(changed.selections[0]).toMatchObject({
      id: 'captured-id',
      unitPrice: 234.5,
      totalPrice: 703.5,
      quantity: 3,
    });

    const envelope = buildStandaloneSoftwareExportEnvelope(changed, {
      workspace: { rackArea: [], nonRackArea: [] },
      configurations: [],
    });
    expect(envelope.endpoint).toBe('/lfos/export_zip');
    expect(envelope.data.standaloneData).toEqual([
      expect.objectContaining({
        id: 'captured-id',
        code: '7S1S002WWW',
        quantity: 3,
        price: 234.5,
        type: 'software',
        showPrice: true,
        inventory: null,
      }),
    ]);
    expect(envelope.groups).toEqual([
      expect.objectContaining({
        name: 'Config 1',
        parent: null,
        index: -1,
        products: [
          expect.objectContaining({
            code: '7S1S002WWW',
            type: 'standalone',
            unitPrice: 234.5,
            groupId: 'Config 1',
          }),
        ],
      }),
    ]);
  });
});

describe('product-bound standalone services', () => {
  it('launches auto-derive and service PACs concurrently while retaining both full responses', async () => {
    const serviceCatalog = {
      services: [{ code: '5WS7B99623', price: 1637, facets: serviceFeature.facets }],
      countryActive: true,
      capturedExtra: true,
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({ raw: serviceGraph })
      .mockResolvedValueOnce({ raw: serviceCatalog });

    const state = await launchProductServices(
      { send } as unknown as DcscHttpClient,
      ctx,
      {
        productCode: '7D73CTO1WW',
        productQuantity: 1,
        productDescription: 'ThinkSystem SR630 V3-3yr Base Warranty',
        subCategory: 'Point of Sale',
      },
    );

    expect(send.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/services/autoDerive',
        body: {
          kind: 'json',
          value: { ctoCode: '7D73CTO1WW', subCategory: 'Point of Sale' },
        },
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/service_pacs/7D73CTO1WW',
        query: { serviceCto: true },
      }),
    ]);
    expect(state.optionGraphRaw).toBe(serviceGraph);
    expect(state.catalogRaw).toBe(serviceCatalog);
    expect(state.product).toMatchObject({ code: '7D73CTO1WW', quantity: 1 });
    expect(state.selections).toEqual([]);
    expect(state.options[0]).toMatchObject({
      code: '5WS7B99623',
      unitPrice: 1637,
      preSelectedQuantity: 1,
      section: 'A la Carte',
      sectionName: 'A la Carte|Column2|3 Year',
    });
    expect(state.options[0]?.rawFeature).toBe(serviceFeature);
  });

  it('selects with typed metadata, retrieves authoritative summary, and builds captured export fields', async () => {
    const selectedGraph = { ...graphWithResults(serviceGraph, [serviceResult]), selectedServerMarker: true };
    const summary = {
      totalPrice: 1637,
      products: [{ code: '7D73CTO1WW', services: [{ code: '5WS7B99623', price: 1637 }] }],
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({ raw: serviceGraph })
      .mockResolvedValueOnce({ raw: { services: [serviceFeature] } })
      .mockResolvedValueOnce({ raw: selectedGraph })
      .mockResolvedValueOnce({ raw: summary });
    const http = { send } as unknown as DcscHttpClient;
    const launched = await launchProductServices(http, ctx, {
      productCode: '7D73CTO1WW',
      subCategory: 'Point of Sale',
    });

    const selected = await selectProductService(http, ctx, launched, {
      serviceCode: '5WS7B99623',
      quantity: 1,
    });
    const expectedRequest = {
      ctoCode: '7D73CTO1WW',
      subCategory: 'Point of Sale',
      sections: [
        {
          description: 'A la Carte|Column2',
          source: 'A la Carte',
          name: 'A la Carte|Column2|3 Year',
          type: 'servicesAndor',
          results: [
            {
              code: '5WS7B99623',
              ctoCode: '7D73CTO1WW',
              description: '3Yr Premier NBD Resp SR630 V3',
              quantity: 1,
              type: 'Warranty Service Upgrades',
              characterName: 'Warranty Service Upgrades',
            },
          ],
        },
      ],
      delta: { section: 'A la Carte', featureCode: '5WS7B99623', quantity: 1 },
    };
    expect(send.mock.calls[2]?.[0]).toMatchObject({
      path: '/services/autoDerive',
      body: { kind: 'json', value: expectedRequest },
    });
    expect(selected.optionGraphRaw).toBe(selectedGraph);
    expect(selected.selections[0]?.rawFeature).toEqual(serviceResult);

    const summarised = await summariseProductServices(http, ctx, selected);
    const summaryRequest = [
      {
        code: '7D73CTO1WW',
        quantity: 1,
        services: [{ serviceCode: '5WS7B99623', quantity: 1 }],
      },
    ];
    expect(send.mock.calls[3]?.[0]).toMatchObject({
      path: '/services/summaries',
      body: { kind: 'json', value: summaryRequest },
    });
    expect(summarised.summaryRaw).toBe(summary);

    const exported = buildProductServiceExportEnvelope(summarised);
    expect(exported).toMatchObject({
      endpoint: '/service_pacs/export',
      data: summaryRequest,
      serviceAndorRequest: expectedRequest,
      fields: {
        data: JSON.stringify(summaryRequest),
        serviceAndorRequest: JSON.stringify(expectedRequest),
        multipleProductData: '',
        excelData: 'null',
        groups: '',
        'dcsc-isFromIntegration': 'false',
      },
    });
  });

  it('retains an unrelated add-on while replacing only its own service family', async () => {
    const addOnFeature = {
      ...serviceFeature,
      code: '5PS7B99638',
      description: '3Yr KYD Add-On SR630 V3',
      type: 'Keep Your Drive',
      characterName: 'Keep Your Drive',
      unitPrice: 173,
    };
    const graph = structuredClone(serviceGraph);
    graph.tabs[0]!.subTabs.push({
      title: 'Add ons|Keep Your Drive',
      type: 'servicesAndor',
      sections: [{
        name: 'Add ons|Keep Your Drive|3 Year',
        description: '3 Year',
        features: [addOnFeature],
        results: [],
      }],
    });
    const afterBase = structuredClone(graph);
    (afterBase.tabs[0]!.subTabs[0]!.sections[0]! as {
      results: Array<Record<string, unknown>>;
    }).results = [serviceResult];
    const afterAddOn = structuredClone(afterBase);
    (afterAddOn.tabs[0]!.subTabs[1]!.sections[0]! as {
      results: Array<Record<string, unknown>>;
    }).results = [{
      code: addOnFeature.code,
      ctoCode: '7D73CTO1WW',
      description: addOnFeature.description,
      quantity: 1,
      type: 'service',
      characterName: addOnFeature.characterName,
    }];
    const send = vi
      .fn()
      .mockResolvedValueOnce({ raw: graph })
      .mockResolvedValueOnce({ raw: { services: [serviceFeature, addOnFeature] } })
      .mockResolvedValueOnce({ raw: afterBase })
      .mockResolvedValueOnce({ raw: afterAddOn })
      .mockResolvedValueOnce({ raw: afterBase });
    const http = { send } as unknown as DcscHttpClient;
    const launched = await launchProductServices(http, ctx, {
      productCode: '7D73CTO1WW',
      subCategory: 'Point of Sale',
    });
    const withBase = await selectProductService(http, ctx, launched, {
      serviceCode: serviceFeature.code,
      quantity: 1,
    });
    const withAddOn = await selectProductService(http, ctx, withBase, {
      serviceCode: addOnFeature.code,
      quantity: 1,
    });

    expect(withAddOn.selections.map(({ code }) => code)).toEqual([
      serviceFeature.code,
      addOnFeature.code,
    ]);
    expect(send.mock.calls[3]?.[0]).toMatchObject({
      path: '/services/autoDerive',
      body: {
        kind: 'json',
        value: {
          ctoCode: '7D73CTO1WW',
          sections: [
            {
              source: 'A la Carte',
              results: [expect.objectContaining({
                code: serviceFeature.code,
                type: 'service',
              })],
            },
            {
              source: 'Add ons',
              results: [expect.objectContaining({
                code: addOnFeature.code,
                ctoCode: '7D73CTO1WW',
                type: 'Keep Your Drive',
              })],
            },
          ],
          delta: { section: 'Add ons', featureCode: addOnFeature.code, quantity: 1 },
        },
      },
    });
    const addOnRequest = send.mock.calls[3]?.[0] as {
      body: { value: { sections: Array<{ source: string; results: Array<Record<string, unknown>> }> } };
    };
    expect(addOnRequest.body.value.sections[0]?.results[0]).not.toHaveProperty('ctoCode');

    const removed = await removeProductService(
      http,
      ctx,
      withAddOn,
      addOnFeature.code,
    );
    expect(removed.selections.map(({ code }) => code)).toEqual([serviceFeature.code]);
    expect(send.mock.calls[4]?.[0]).toMatchObject({
      path: '/services/autoDerive',
      body: {
        kind: 'json',
        value: {
          sections: [{
            source: 'A la Carte',
            results: [expect.objectContaining({ code: serviceFeature.code })],
          }],
          delta: { section: 'Add ons' },
        },
      },
    });
    const removalRequest = send.mock.calls[4]?.[0] as {
      body: { value: { sections: Array<{ results: Array<Record<string, unknown>> }> } };
    };
    expect(removalRequest.body.value.sections[0]?.results[0]).not.toHaveProperty('ctoCode');
  });

  it('does not silently select unknown services or invalid quantities', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ raw: serviceGraph })
      .mockResolvedValueOnce({ raw: { services: [serviceFeature] } });
    const http = { send } as unknown as DcscHttpClient;
    const state = await launchProductServices(http, ctx, {
      productCode: '7D73CTO1WW',
      subCategory: 'Point of Sale',
    });

    await expect(
      selectProductService(http, ctx, state, { serviceCode: 'UNKNOWN', quantity: 1 }),
    ).rejects.toThrow('not in the current option graph');
    await expect(
      selectProductService(http, ctx, state, { serviceCode: '5WS7B99623', quantity: 0 }),
    ).rejects.toThrow('positive integer');
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('Services page downloads and product searches', () => {
  it('builds the captured Export form for one product and the Download Catalog form for the country', () => {
    const codes = serviceCatalogCodes({ services: [{ code: '5WS7B99612' }, { code: '5WS7B99608' }, { description: 'no code' }] });
    expect(codes).toEqual(['5WS7B99612', '5WS7B99608']);

    const exported = buildServiceCatalogDownload({ productCode: '7D73CTO1WW', serviceCodes: codes, country: 'US', downloadToken: 1 });
    expect(exported.path).toBe('/service_pacs_download/7D73CTO1WW');
    expect(exported.query).toEqual({});
    expect(JSON.parse(exported.fields['data']!)).toEqual({
      services: [{ serviceCode: '5WS7B99612', facets: '' }, { serviceCode: '5WS7B99608', facets: '' }],
    });
    expect(exported.fields).toMatchObject({ serviceAndorRequest: '', excelData: 'null', cancelDownload: 'false', groups: '' });
    expect(Object.keys(exported.fields)).toHaveLength(14);

    const catalog = buildServiceCatalogDownload({ serviceCodes: codes, country: 'DE', downloadToken: 1793547039768 });
    expect(catalog.path).toBe('/service_pacs_downloadV2');
    expect(catalog.query).toEqual({ download: 'DE', country_or_regions: 'DE', downloadToken: '1793547039768' });
    expect(JSON.parse(catalog.fields['data']!)).toEqual({ services: [] });
  });

  it('searches service products by code or description and software by product ID with the captured query', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ raw: [
        { code: '044913X', type: 'LFO', description: 'Intel OPA 100 Series switch', withdrawn: false },
        { code: '7D73CTO1WW', type: 'CTO', description: 'ThinkSystem SR630 V3', withdrawn: true },
      ] })
      .mockResolvedValueOnce({ raw: softwarePortal });
    const http = { send } as unknown as DcscHttpClient;

    expect(await searchServiceProducts(http, ctx, ' sr630 ')).toEqual([
      { code: '7D73CTO1WW', type: 'CTO', description: 'ThinkSystem SR630 V3', withdrawn: true },
    ]);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      method: 'GET', path: '/service_pacs_product', query: { serviceCto: true },
    }));

    const features = await searchSoftwareForProduct(http, ctx, '7D73CTO1WW', 'CTO');
    expect(features.map(feature => feature.code)).toEqual([softwareFeature.code]);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      method: 'GET', path: '/software/portal/search/7D73CTO1WW', query: { mode: 'cto', serviceCto: true },
    }));
  });
});
