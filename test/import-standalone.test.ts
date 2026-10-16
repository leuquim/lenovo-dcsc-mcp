import { describe, expect, it } from 'vitest';

import {
  parseStandaloneImportResponse,
  reconcileImportedSoftwareCatalog,
} from '../src/domain/importStandalone.js';
import {
  buildProductServiceExportEnvelope,
  buildStandaloneSoftwareExportEnvelope,
  setStandaloneSoftwareQuantity,
} from '../src/domain/standalone.js';

describe('standalone CFXML import responses', () => {
  it('restores software quantity, unit price, extended price and the complete envelope', () => {
    const envelope = {
      type: 'lfo',
      configuration: [],
      country: 'US',
      currency: 'USD',
      capturedUnknown: { retained: true },
      standaloneData: [
        {
          id: 'software-id',
          code: '7S1S002WWW',
          description: 'Windows Server license',
          price: 234.5,
          priceNotAvailable: false,
          type: 'software',
          quantity: 3,
          showPrice: true,
          prices: [{ priceTypeId: 1, price: 234.5, priceNotAvailable: false }],
          capturedLine: true,
        },
      ],
      groups: [
        {
          name: 'Config 1',
          products: [
            {
              id: 'software-id',
              code: '7S1S002WWW',
              quantity: 3,
              price: 703.5,
              unitPrice: 234.5,
              type: 'standalone',
            },
          ],
        },
      ],
      missingParts: [],
      removedParts: [],
    };

    const imported = parseStandaloneImportResponse([envelope]);
    expect(imported?.kind).toBe('software');
    if (!imported || imported.kind !== 'software') throw new Error('software import missing');
    expect(imported.state.selections).toEqual([
      expect.objectContaining({
        id: 'software-id',
        code: '7S1S002WWW',
        quantity: 3,
        unitPrice: 234.5,
        totalPrice: 703.5,
      }),
    ]);
    expect(imported.state.features[0]).toMatchObject({
      code: '7S1S002WWW',
      unitPrice: 234.5,
      raw: { capturedLine: true },
    });
    expect(imported.envelope).toEqual(envelope);
    expect(imported.envelope).not.toBe(envelope);
    expect(imported.diagnostics.warnings[0]).toContain('not the original vendor/category catalog');

    const changed = setStandaloneSoftwareQuantity(imported.state, '7S1S002WWW', 4);
    expect(changed.selections[0]).toMatchObject({ quantity: 4, totalPrice: 938 });
    expect(buildStandaloneSoftwareExportEnvelope(changed, {}).data.standaloneData).toEqual([
      expect.objectContaining({ code: '7S1S002WWW', quantity: 4, price: 234.5 }),
    ]);

    const reconciled = reconcileImportedSoftwareCatalog(imported.state, {
      kind: 'standalone-software',
      launchRaw: { current: true },
      portalRaw: { current: true },
      features: [
        {
          ...imported.state.features[0]!,
          unitPrice: 999,
          path: {
            tab: 'OS & Software',
            subTab: 'Microsoft',
            section: 'Licenses',
          },
          raw: { currentCatalogFeature: true },
        },
      ],
      selections: [],
    });
    expect(reconciled.portalRaw).toEqual({ current: true });
    expect(reconciled.features[0]).toMatchObject({
      unitPrice: 234.5,
      path: { subTab: 'Microsoft' },
      raw: { currentCatalogFeature: true },
    });
    expect(reconciled.selections[0]).toMatchObject({
      quantity: 3,
      unitPrice: 234.5,
      totalPrice: 703.5,
      feature: { unitPrice: 234.5, raw: { currentCatalogFeature: true } },
    });
  });

  it('restores one selected product service with independent product and service quantities', () => {
    const imported = parseStandaloneImportResponse([
      {
        type: 'service',
        country: 'US',
        currency: 'USD',
        configuration: [
          {
            code: '7D73CTO1WW',
            services: [
              {
                code: '5WS7B99623',
                description: '3Yr Premier NBD Resp SR630 V3',
                price: 1637,
                type: 'Warranty Service Upgrades',
                capturedCatalogField: true,
              },
            ],
            capturedConfigurationField: true,
          },
        ],
        summary: [
          {
            code: '7D73CTO1WW',
            description: 'ThinkSystem SR630 V3-3yr Base Warranty',
            quantity: 3,
            unitPrice: 3274,
            totalPrice: 9822,
            results: [
              {
                code: '5WS7B99623',
                description: '3Yr Premier NBD Resp SR630 V3',
                quantity: 2,
                unitPrice: 1637,
                type: 'Warranty Service Upgrades',
              },
            ],
          },
        ],
        serviceAndorRequest: {
          ctoCode: '7D73CTO1WW',
          subCategory: 'Point of Sale',
          sections: [
            {
              name: 'A la Carte|Column2|3 Year',
              description: 'A la Carte|Column2',
              type: 'servicesAndor',
              results: [
                {
                  code: '5WS7B99623',
                  description: '3Yr Premier NBD Resp SR630 V3',
                  quantity: 2,
                },
              ],
            },
          ],
          delta: { section: 'A la Carte', featureCode: '5WS7B99623', quantity: 2 },
        },
      },
    ]);

    expect(imported?.kind).toBe('service');
    if (!imported || imported.kind !== 'service') throw new Error('service import missing');
    expect(imported.state.product).toEqual({
      code: '7D73CTO1WW',
      quantity: 3,
      description: 'ThinkSystem SR630 V3-3yr Base Warranty',
    });
    expect(imported.state.selections).toEqual([
      expect.objectContaining({
        code: '5WS7B99623',
        quantity: 2,
        characterName: 'Warranty Service Upgrades',
        section: 'A la Carte',
        sectionName: 'A la Carte|Column2|3 Year',
      }),
    ]);
    expect(imported.state.catalogRaw).toMatchObject({ capturedConfigurationField: true });
    expect(imported.state.summaryRaw).toEqual([
      expect.objectContaining({ quantity: 3, totalPrice: 9822 }),
    ]);

    const exported = buildProductServiceExportEnvelope(imported.state);
    expect(exported.data).toEqual([
      {
        code: '7D73CTO1WW',
        quantity: 3,
        services: [{ serviceCode: '5WS7B99623', quantity: 2 }],
      },
    ]);
    expect(exported.serviceAndorRequest).toMatchObject({
      ctoCode: '7D73CTO1WW',
      delta: { section: 'A la Carte', featureCode: '5WS7B99623', quantity: 2 },
      sections: [
        {
          source: 'A la Carte',
          results: [
            {
              code: '5WS7B99623',
              ctoCode: '7D73CTO1WW',
              quantity: 2,
              characterName: 'Warranty Service Upgrades',
            },
          ],
        },
      ],
    });
  });

  it('interprets browser standaloneData price as unit price when groups are absent', () => {
    const imported = parseStandaloneImportResponse({ type: 'lfo', configuration: [],
      standaloneData: [{ id: 'sku', code: 'SW', quantity: 3, price: 234.5 }] });
    expect(imported?.state.selections[0]).toMatchObject({ quantity: 3, unitPrice: 234.5, totalPrice: 703.5 });
  });

  it('leaves ordinary hardware responses to the existing importer', () => {
    expect(
      parseStandaloneImportResponse([{ type: 'cto', configuration: [{ id: 'hardware' }] }]),
    ).toBeUndefined();
  });

  it('restores standalone software alongside ordinary configurations', () => {
    const result = parseStandaloneImportResponse([
      {
        type: 'cto',
        configuration: [{ id: 'hardware', code: '7D73CTO1WW' }],
        standaloneData: [
          {
            id: 'software',
            code: '7S1S002WWW',
            description: 'Windows Server license',
            quantity: 3,
            price: 234.5,
            prices: [],
          },
        ],
        groups: [
          {
            name: 'Config 1',
            products: [
              { id: 'hardware', code: '7D73CTO1WW', type: 'hardware', quantity: 1 },
              {
                id: 'software',
                code: '7S1S002WWW',
                type: 'standalone',
                quantity: 3,
                unitPrice: 234.5,
                price: 703.5,
              },
            ],
          },
        ],
      },
    ]);
    expect(result?.kind).toBe('software');
    if (!result || result.kind !== 'software') throw new Error('mixed software missing');
    expect(result.state.selections[0]).toMatchObject({
      quantity: 3,
      unitPrice: 234.5,
      totalPrice: 703.5,
    });
    expect(result.envelope['configuration']).toEqual([
      { id: 'hardware', code: '7D73CTO1WW' },
    ]);
  });

  it('rejects service response shapes beyond the captured single-product selection', () => {
    expect(() =>
      parseStandaloneImportResponse([
        { type: 'service', configuration: [{}, {}], summary: [{}, {}] },
      ]),
    ).toThrow('exactly one serviced product');
  });
});
