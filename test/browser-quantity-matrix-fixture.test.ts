import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  buildStandaloneSoftwareExportEnvelope,
  type StandaloneSoftwareState,
} from '../src/domain/standalone.js';

const fixture = JSON.parse(
  readFileSync('test/fixtures/parity/browser-quantity-matrix.json', 'utf8'),
) as {
  hardwareMatrix: Array<{
    requestedQuantity: number;
    exportPayloadConfigurationCount: number;
    rawConfigurationQuantities: number[];
    xmlGroup: { quantity: number; unitListPrice: number };
    products: Array<{
      code: string;
      quantity: number;
      unitListPrice: number;
      feature?: { code: string; quantity: number; unitListPrice: number };
      termFeature?: { code: string; quantity: number };
    }>;
  }>;
  standaloneSoftwareQuantity3: {
    code: string;
    quantity: number;
    unitPrice: number;
    extendedPrice: number;
    request: {
      standaloneData: { price: number };
      groupProduct: { price: number; unitPrice: number };
    };
    importResponse: {
      standaloneData: { price: number };
      groupProduct: { price: number; unitPrice: number };
    };
  };
};

describe('headless browser quantity parity fixture', () => {
  it('records clone handoff and aggregate XML quantities without scaling child features', () => {
    const baselinePrices = fixture.hardwareMatrix[0]!.products.map((product) => product.unitListPrice);

    for (const row of fixture.hardwareMatrix) {
      expect(row.exportPayloadConfigurationCount).toBe(row.requestedQuantity);
      expect(row.rawConfigurationQuantities).toEqual(
        Array.from({ length: row.requestedQuantity }, () => 1),
      );
      expect(row.products).toHaveLength(6);
      expect(row.products.map((product) => product.quantity)).toEqual(
        Array.from({ length: 6 }, () => row.requestedQuantity),
      );
      expect(row.products.map((product) => product.unitListPrice)).toEqual(baselinePrices);
      expect(row.xmlGroup.quantity).toBe(6);
      expect(row.xmlGroup.unitListPrice).toBeCloseTo(15_650.51 * row.requestedQuantity, 2);
      expect(row.products.find((product) => product.feature?.code === 'SCJD')?.feature)
        .toMatchObject({ quantity: 1, unitListPrice: 304.5 });
      expect(row.products.find((product) => product.feature?.code === 'SBCV')?.feature)
        .toMatchObject({ quantity: 1, unitListPrice: 209.5 });
      expect(
        row.products
          .filter((product) => product.termFeature?.code === 'QA0Y')
          .every((product) => product.termFeature?.quantity === 36),
      ).toBe(true);
    }
  });

  it('keeps standalone software unit and extended prices in their browser wire fields', () => {
    const captured = fixture.standaloneSoftwareQuantity3;
    const feature = {
      code: captured.code,
      description: 'Windows Server 2025 Standard Additional License (2 core)',
      unitPrice: captured.unitPrice,
      priceNotAvailable: false,
      showPrice: true,
      prices: [{ priceTypeId: 1, price: captured.unitPrice, priceNotAvailable: false }],
      attributes: {},
      path: { tab: 'OS & Software', subTab: 'Microsoft', section: 'Windows' },
      raw: { announceDate: '2024-11-05', withdrawnDate: '2999-12-31' },
    };
    const state = {
      kind: 'standalone-software',
      launchRaw: {},
      portalRaw: {},
      features: [feature],
      selections: [{
        id: 'captured-id',
        kind: 'software',
        code: captured.code,
        quantity: captured.quantity,
        unitPrice: captured.unitPrice,
        totalPrice: captured.extendedPrice,
        feature,
      }],
    } satisfies StandaloneSoftwareState;

    const envelope = buildStandaloneSoftwareExportEnvelope(state, {});
    const standalone = envelope.data.standaloneData[0] as Record<string, unknown>;
    const groupProduct = envelope.groups[0]!.products[0]!;

    expect(standalone['price']).toBe(captured.request.standaloneData.price);
    expect(groupProduct.price).toBe(captured.request.groupProduct.price);
    expect(groupProduct.unitPrice).toBe(captured.request.groupProduct.unitPrice);
    expect(captured.importResponse).toEqual(captured.request);
  });
});
