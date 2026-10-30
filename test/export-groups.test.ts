import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildExportGroups } from '../src/domain/exportGroups.js';
import type { RawConfiguration } from '../src/model/types.js';

it.each([1, 2])('matches captured physical storage commercial rows for %i placements', quantity => {
  const capture = JSON.parse(readFileSync(new URL('./fixtures/parity/storage-placement-commercial.json', import.meta.url), 'utf8')) as {
    components: Array<{ role: string; raw: RawConfiguration; onePlacement: object[]; twoPlacements: object[] }>;
  };
  const controller = capture.components.find(component => component.role === 'controller')!;
  const mainSwitch = capture.components.find(component => component.role === 'mainSwitch')!;
  const configs = capture.components.map(component => ({ configurationId: String(component.raw.id), raw: component.raw,
    product: { code: String(component.raw.code) } }));
  const rackItems = configs.flatMap(config => Array.from({ length: quantity }, (_, index) => ({
    id: `${config.configurationId}-physical-${index}`, code: config.product.code, type: config.raw.type,
    position: 1 + index * 3, size: 1, quantity: 0,
  })));
  const workspace = {
    configurations: new Map(configs.map(config => [config.configurationId, config])),
    rackArea: [{ id: 'rack', rackItems }],
    serverState: {
      storageConnectionNetworks: [{ name: 'SAN',
        controller: { id: controller.raw.id, option: controller.raw.code, hardwareType: 'storage' },
        mainSwitch: { id: mainSwitch.raw.id, option: mainSwitch.raw.code, hardwareType: 'switch' },
      }],
      cloneDependency: Object.fromEntries(configs.map(config => [config.configurationId, [config.configurationId,
        ...rackItems.filter(item => item.code === config.product.code).map(item => item.id)]])),
    },
  };
  const products = buildExportGroups(workspace)[0]!.products;
  for (const component of capture.components) {
    expect(products.filter(product => product.id === component.raw.id).map(product => ({
      code: product.code, type: product.type, quantity: product.quantity, price: product.price, unitPrice: product.unitPrice,
    }))).toEqual(quantity === 1 ? component.onePlacement : component.twoPlacements);
    expect(component.raw.quantity).toBe(1);
  }
});

const lfoCapture = JSON.parse(readFileSync(
  new URL('./fixtures/parity/lfo-export-groups.json', import.meta.url), 'utf8',
)) as {
  configurationId: string;
  mode: 'lfo';
  raw: RawConfiguration;
  expected: Array<{ code: string; type: string; quantity: number; price: number; unitPrice: number }>;
};

const asCtoCapture = JSON.parse(readFileSync(
  new URL('./fixtures/parity/lfo-as-cto-export-groups.json', import.meta.url), 'utf8',
)) as {
  configurationId: string;
  mode: 'lfo-as-cto';
  raw: RawConfiguration;
  expected: Array<{ code: string; type: string; quantity: number; price: number; unitPrice: number }>;
};

const server = {
  id: 'server-raw-id',
  sliceCtoCode: '7D73CTO1WW',
  description: 'ThinkSystem SR630 V3-3yr Base Warranty',
  quantity: 1,
  totalPrice: 16_174.51,
  totalPrices: [{ priceTypeId: 1, price: 16_172.51, priceNotAvailable: false }],
  showPrice: true,
  shippingStatus: ['30', '30', '30', '30', '30', '30'],
  hipoDerivedItems: [
    {
      targetCtoCode: '7S0XCTO6WW',
      targetCtoCodeDescription: 'XClarity One',
      targetCtoQuantity: 1,
      targetCtoPrice: 304.5,
      targetCtoUnitPrice: 1,
      targetCTOPrices: [{ priceTypeId: 1, price: 1, priceNotAvailable: false }],
      features: [
        { featureCode: 'SCJD', quantity: 1, unitPrice: 304.5, subCategory: 'FlatFee' },
      ],
    },
    {
      targetCtoCode: '7S0XCTO5WW',
      targetCtoCodeDescription: 'XClarity Controller Platin-FOD',
      targetCtoQuantity: 1,
      targetCtoPrice: 209.5,
      targetCtoUnitPrice: 1,
      targetCTOPrices: [{ priceTypeId: 1, price: 1, priceNotAvailable: false }],
      features: [
        { featureCode: 'SBCV', quantity: 1, unitPrice: 209.5, subCategory: 'FlatFee' },
      ],
    },
  ],
  hipoServiceCtoServices: [
    {
      targetCto: '7Q01CTO2WW',
      description: 'SERVER CO2 OFFSET',
      price: 191,
      priceNotAvailable: false,
    },
    {
      targetCto: '7Q01CTS4WW',
      description: 'SERVER PREMIER 24X7 4HR RESP',
      price: 1829,
      priceNotAvailable: false,
    },
    {
      targetCto: '7Q01CTSAWW',
      description: 'SERVER KEEP YOUR DRIVE ADD-ON',
      price: 173,
      priceNotAvailable: false,
    },
  ],
  tabs: [],
} as unknown as RawConfiguration;

const rack = {
  id: 'rack-raw-id',
  sliceCtoCode: '7D6DCTO1WW',
  description: 'Lenovo ThinkSystem 42U Onyx Heavy Duty Rack Cabinet',
  quantity: 1,
  totalPrice: 12_706.51,
  totalPrices: [{ priceTypeId: 1, price: 12_706.51, priceNotAvailable: false }],
  showPrice: true,
  shippingStatus: ['10', '10', '30', '30', '30', '30'],
  tabs: [
    {
      title: 'Services',
      subTabs: [
        {
          title: 'Warranty',
          sections: [
            {
              name: 'Lenovo Recommends|Better',
              results: [
                {
                  code: '5WS7B98700',
                  quantity: 1,
                  description: '3Yr Premier 24x7 4Hr Resp 42U Rack',
                  price: 589,
                  type: 'service',
                },
              ],
              features: [
                {
                  code: '5WS7B98700',
                  description: '3Yr Premier 24x7 4Hr Resp 42U Rack',
                  unitPrice: 589,
                  prices: [{ priceTypeId: 1, price: 589, priceNotAvailable: false }],
                },
              ],
            },
            // The website exposes the same selected service in multiple
            // service sections but emits it once in the export group.
            {
              name: 'A la Carte|Column3|3 Years',
              results: [{ code: '5WS7B98700', quantity: 1, type: 'service' }],
              features: [{ code: '5WS7B98700', unitPrice: 589 }],
            },
          ],
        },
      ],
    },
  ],
} as unknown as RawConfiguration;

describe('export grouping', () => {
  it('matches the captured browser server group and separates inclusive prices', () => {
    const products = buildExportGroups(server, 'server-config')[0]!.products;

    expect(products).toHaveLength(6);
    expect(products[0]).toEqual({
      id: 'server-config',
      quantity: 1,
      price: 13_465.51,
      prices: [{ priceTypeId: 1, price: 16_172.51, priceNotAvailable: false }],
      type: 'hardware',
      description: 'ThinkSystem SR630 V3-3yr Base Warranty',
      shippingStatus: ['30', '30', '30', '30', '30', '30'],
      asMultiProd: false,
      priceNotAvailable: false,
      unitPrice: 13_465.51,
      code: '7D73CTO1WW',
      showPrice: true,
      specialBid: false,
      groupId: 'Config 1',
    });
    expect(products.slice(1, 3)).toMatchObject([
      {
        code: '7S0XCTO6WW',
        type: 'hipo',
        quantity: 1,
        price: 306.5,
        unitPrice: 305.5,
        targetCtoUnitPrice: 1,
      },
      {
        code: '7S0XCTO5WW',
        type: 'hipo',
        quantity: 1,
        price: 211.5,
        unitPrice: 210.5,
        targetCtoUnitPrice: 1,
      },
    ]);
    expect(products.slice(3).map((product) => [product.code, product.type, product.price])).toEqual([
      ['7Q01CTO2WW', 'servicectohipo', 191],
      ['7Q01CTS4WW', 'servicectohipo', 1829],
      ['7Q01CTSAWW', 'servicectohipo', 173],
    ]);
  });

  it('includes traditional selected services once and subtracts them from hardware', () => {
    const products = buildExportGroups(rack, 'rack-config')[0]!.products;

    expect(products).toHaveLength(2);
    expect(products[0]).toMatchObject({
      code: '7D6DCTO1WW',
      type: 'hardware',
      price: 12_117.51,
      unitPrice: 12_117.51,
    });
    expect(products[1]).toEqual({
      id: 'rack-config',
      code: '5WS7B98700',
      description: '3Yr Premier 24x7 4Hr Resp 42U Rack',
      quantity: 1,
      price: 589,
      prices: [{ priceTypeId: 1, price: 589, priceNotAvailable: false }],
      type: 'service',
      unitPrice: 589,
      showPrice: true,
      asMultiProd: false,
      groupId: 'Config 1',
    });
  });

  it('matches captured LFO added-option grouping without counting repeated sections', () => {
    const workspace = {
      configurations: new Map([
        ['lfo-session', {
          configurationId: lfoCapture.configurationId,
          raw: lfoCapture.raw,
          product: { code: '7DCE100GNA' },
          mode: lfoCapture.mode,
        }],
      ]),
    };
    const compact = buildExportGroups(workspace)[0]!.products.map(
      ({ code, type, quantity, price, unitPrice }) => ({ code, type, quantity, price, unitPrice }),
    );

    expect(compact).toEqual(lfoCapture.expected);
    expect(compact.filter(({ type }) => type === 'added-options')).toHaveLength(3);
    // Single-configuration exports do not carry the session mode. The captured
    // LFO code/underlying-CTO pair is the wire-level fallback for that scope.
    expect(buildExportGroups(lfoCapture.raw, lfoCapture.configurationId)[0]!.products.map(
      ({ code, type, quantity, price, unitPrice }) => ({ code, type, quantity, price, unitPrice }),
    )).toEqual(lfoCapture.expected);
  });

  it('preserves a non-unit LFO option quantity while deduplicating its repeated section', () => {
    const raw = structuredClone(lfoCapture.raw) as RawConfiguration & {
      tabs: Array<{ subTabs: Array<{ sections: Array<{ results: Array<{ code: string; quantity: number }> }> }> }>;
    };
    raw.totalPrice = 6479.5;
    for (const tab of raw.tabs) {
      for (const subTab of tab.subTabs) {
        for (const section of subTab.sections) {
          const premier = section.results.find(({ code }) => code === '5WS7C02329');
          if (premier) premier.quantity = 2;
        }
      }
    }

    const products = buildExportGroups(raw, lfoCapture.configurationId)[0]!.products;
    expect(products[0]).toMatchObject({ code: '7DCE100GNA', price: 3934.5, unitPrice: 3934.5 });
    expect(products.filter(({ code }) => code === '5WS7C02329')).toEqual([
      expect.objectContaining({ type: 'added-options', quantity: 2, price: 2308, unitPrice: 1154 }),
    ]);
  });

  it('uses captured CTO commercial grouping for a preconfigured model launched as CTO', () => {
    const workspace = {
      configurations: new Map([
        ['as-cto-session', {
          configurationId: asCtoCapture.configurationId,
          raw: asCtoCapture.raw,
          product: { code: '7DCE100GNA' },
          mode: asCtoCapture.mode,
        }],
      ]),
    };
    const compact = buildExportGroups(workspace)[0]!.products.map(
      ({ code, type, quantity, price, unitPrice }) => ({ code, type, quantity, price, unitPrice }),
    );

    expect(compact).toEqual(asCtoCapture.expected);
    expect(compact[0]).toMatchObject({ code: '7DCECTO1WW', type: 'hardware', unitPrice: 5130.01 });
    expect(compact.some(({ type }) => type === 'added-options')).toBe(false);
    expect(buildExportGroups(
      asCtoCapture.raw,
      asCtoCapture.configurationId,
      asCtoCapture.mode,
    )[0]!.products.map(
      ({ code, type, quantity, price, unitPrice }) => ({ code, type, quantity, price, unitPrice }),
    )).toEqual(asCtoCapture.expected);
  });

  it('uses authoritative session ids and includes every workspace configuration', () => {
    const workspace = {
      configurations: new Map([
        [
          'session-server',
          {
            configurationId: 'server-config',
            raw: server,
            product: { code: '7D73CTO1WW' },
          },
        ],
        [
          'session-rack',
          {
            configurationId: 'rack-config',
            raw: rack,
            product: { code: '7D6DCTO1WW' },
          },
        ],
      ]),
    };

    const group = buildExportGroups(workspace)[0]!;
    expect(group).toMatchObject({ name: 'Config 1', parent: null, index: -1 });
    expect(group.products).toHaveLength(8);
    expect(new Set(group.products.map((product) => product.id))).toEqual(
      new Set(['server-config', 'rack-config']),
    );
    expect(group.products.some((product) => product.id === 'server-raw-id')).toBe(false);
  });

  it('matches the browser Clone Multiple commercial group while retaining distinct configurations', () => {
    const clone = structuredClone(server);
    clone.id = 'clone-raw-id';
    const workspace = {
      serverState: { cloneDependency: {
        'server-config': ['server-config', 'clone-config'],
        'rack-config': ['rack-config'],
      } },
      configurations: new Map([
        ['session-server', { configurationId: 'server-config', raw: server, product: { code: '7D73CTO1WW' } }],
        ['session-rack', { configurationId: 'rack-config', raw: rack, product: { code: '7D6DCTO1WW' } }],
        ['session-clone', { configurationId: 'clone-config', raw: clone, product: { code: '7D73CTO1WW' } }],
      ]),
    };
    const products = buildExportGroups(workspace)[0]!.products;

    expect(products).toHaveLength(8);
    expect(products.filter(product => product.id === 'clone-config')).toEqual([]);
    expect(products.slice(0, 6)).toEqual([
      expect.objectContaining({ id: 'server-config', code: '7D73CTO1WW', type: 'hardware',
        quantity: 2, price: 26_931.02, unitPrice: 13_465.51 }),
      expect.objectContaining({ id: 'server-config', code: '7S0XCTO6WW', type: 'hipo',
        quantity: 2, price: 306.5, unitPrice: 305.5 }),
      expect.objectContaining({ id: 'server-config', code: '7S0XCTO5WW', type: 'hipo',
        quantity: 2, price: 211.5, unitPrice: 210.5 }),
      expect.objectContaining({ id: 'server-config', code: '7Q01CTO2WW', type: 'servicectohipo',
        quantity: 2, price: 191 }),
      expect.objectContaining({ id: 'server-config', code: '7Q01CTS4WW', type: 'servicectohipo',
        quantity: 2, price: 1829 }),
      expect.objectContaining({ id: 'server-config', code: '7Q01CTSAWW', type: 'servicectohipo',
        quantity: 2, price: 173 }),
    ]);
    expect(products.slice(6).map(product => product.id)).toEqual(['rack-config', 'rack-config']);
  });

  it('uses the dependency key as root when the browser serializes the clone before it', () => {
    const clone = structuredClone(server);
    clone.id = 'clone-raw-id';
    const workspace = {
      serverState: { cloneDependency: { 'server-config': ['clone-config', 'server-config'] } },
      configurations: new Map([
        ['session-server', { configurationId: 'server-config', raw: server, product: { code: '7D73CTO1WW' } }],
        ['session-clone', { configurationId: 'clone-config', raw: clone, product: { code: '7D73CTO1WW' } }],
      ]),
    };

    const products = buildExportGroups(workspace)[0]!.products;

    expect(products.filter(product => product.id === 'clone-config')).toEqual([]);
    expect(products[0]).toMatchObject({
      id: 'server-config', code: '7D73CTO1WW', quantity: 2, price: 26_931.02, unitPrice: 13_465.51,
    });
  });

  it('collapses imported clone members when only root availability metadata was hydrated', () => {
    const clone = structuredClone(server);
    clone.shippingStatus = [];
    const workspace = {
      serverState: { cloneDependency: { 'server-config': ['server-config', 'clone-config'] } },
      configurations: new Map([
        ['session-server', { configurationId: 'server-config', raw: server, product: { code: '7D73CTO1WW' } }],
        ['session-clone', { configurationId: 'clone-config', raw: clone, product: { code: '7D73CTO1WW' } }],
      ]),
    };

    const products = buildExportGroups(workspace)[0]!.products;

    expect(products[0]).toMatchObject({
      id: 'server-config', code: '7D73CTO1WW', quantity: 2, price: 26_931.02,
      shippingStatus: ['30', '30', '30', '30', '30', '30'],
    });
    expect(products.filter(product => product.id === 'clone-config')).toEqual([]);
  });

  it('treats an omitted unavailable flag as false only on a numerically priced linked service', () => {
    const root = structuredClone(server);
    const clone = structuredClone(server);
    const rootService = (root.hipoServiceCtoServices as Array<Record<string, unknown>>)[0]!;
    const cloneService = (clone.hipoServiceCtoServices as Array<Record<string, unknown>>)[0]!;
    delete rootService['priceNotAvailable'];
    const workspace = {
      serverState: { cloneDependency: { root: ['root', 'clone'] } },
      configurations: new Map([
        ['root', { configurationId: 'root', raw: root, product: { code: '7D73CTO1WW' } }],
        ['clone', { configurationId: 'clone', raw: clone, product: { code: '7D73CTO1WW' } }],
      ]),
    };
    expect(() => buildExportGroups(workspace)).not.toThrow();
    expect(rootService).not.toHaveProperty('priceNotAvailable');
    cloneService['priceNotAvailable'] = true;
    expect(() => buildExportGroups(workspace)).toThrow(/divergent commercial/);
    cloneService['priceNotAvailable'] = false;
    cloneService['price'] = Number(cloneService['price']) + 1;
    expect(() => buildExportGroups(workspace)).toThrow(/divergent commercial/);
  });

  it('rejects a linked clone group whose commercial selections or prices diverged', () => {
    const clone = structuredClone(server);
    clone.totalPrice = (clone.totalPrice ?? 0) + 1;
    const workspace = {
      serverState: { cloneDependency: { 'server-config': ['server-config', 'clone-config'] } },
      configurations: new Map([
        ['session-server', { configurationId: 'server-config', raw: server, product: { code: '7D73CTO1WW' } }],
        ['session-clone', { configurationId: 'clone-config', raw: clone, product: { code: '7D73CTO1WW' } }],
      ]),
    };
    expect(() => buildExportGroups(workspace)).toThrow(/divergent commercial selections or prices/);
    workspace.serverState.cloneDependency['server-config'] = ['clone-config', 'server-config'];
    expect(() => buildExportGroups(workspace)).toThrow(/divergent commercial selections or prices/);
  });

  it('scales quantities without multiplying per-line prices twice', () => {
    const quantityEight = structuredClone(server);
    quantityEight.quantity = 8;
    const products = buildExportGroups(quantityEight, 'server-8')[0]!.products;
    const hardware = products[0]!;
    const hipo = products.find((product) => product.code === '7S0XCTO6WW')!;
    const service = products.find((product) => product.code === '7Q01CTS4WW')!;

    expect(hardware).toMatchObject({ quantity: 8, unitPrice: 13_465.51, price: 107_724.08 });
    expect(hipo).toMatchObject({ quantity: 8, unitPrice: 305.5, price: 306.5 });
    expect(service).toMatchObject({ quantity: 8, unitPrice: 1829, price: 1829 });
  });

  it('splits single-use HIPO features from repeated quantities like the browser', () => {
    const raw = structuredClone(server);
    raw.quantity = 3;
    raw.hipoDerivedItems = [
      {
        targetCtoCode: 'SOFTWARE',
        targetCtoCodeDescription: 'Mixed license',
        targetCtoQuantity: 1,
        targetCtoPrice: 25,
        targetCtoUnitPrice: 1,
        features: [
          { featureCode: 'SETUP', quantity: 1, unitPrice: 10, subCategory: 'Single-use' },
          { featureCode: 'SEAT', quantity: 1, unitPrice: 5, subCategory: 'Per-device' },
        ],
      },
    ];
    raw.hipoServiceCtoServices = [];
    raw.totalPrice = 126;

    const products = buildExportGroups(raw, 'mixed')[0]!.products;
    expect(products.slice(1)).toMatchObject([
      { code: 'SOFTWARE', quantity: 1, unitPrice: 16, price: 27 },
      { code: 'SOFTWARE', quantity: 2, unitPrice: 6, price: 27 },
    ]);
  });

  it('rejects a single configuration without an authoritative id', () => {
    const raw = structuredClone(server);
    delete raw.id;
    expect(() => buildExportGroups(raw)).toThrowError(/configuration id is required/);
  });
});

describe('unavailable export hardware pricing', () => {
  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY])(
    'keeps totalPrice=%s unavailable without fabricating a hardware remainder', totalPrice => {
      const raw = { ...structuredClone(server), totalPrice } as unknown as RawConfiguration;
      const products = buildExportGroups(raw, 'unpriced-server')[0]!.products;
      expect(products.find(product => product.type === 'hardware')).toMatchObject({
        price: null, unitPrice: null, priceNotAvailable: true, quantity: 1,
      });
      // Independently quoted attached products retain their authoritative price.
      expect(products.find(product => product.code === '7S0XCTO6WW')).toMatchObject({
        price: 306.5, unitPrice: 305.5, priceNotAvailable: false,
      });
    },
  );

  it('preserves a genuinely priced zero and an explicit unavailable flag', () => {
    const raw = { id: 'zero', sliceCtoCode: 'ZERO', totalPrice: 0, quantity: 1,
      tabs: [], hipoDerivedItems: [], hipoServiceCtoServices: [] } as unknown as RawConfiguration;
    expect(buildExportGroups(raw)[0]!.products[0]).toMatchObject({
      price: 0, unitPrice: 0, priceNotAvailable: false,
    });
    expect(buildExportGroups({ ...raw, priceNotAvailable: true })[0]!.products[0]).toMatchObject({
      price: null, unitPrice: null, priceNotAvailable: true,
    });
  });
});
