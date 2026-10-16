import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import type { RawConfiguration } from '../src/model/types.js';

const services: DcscService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

describe('service scale-out planning', () => {
  it.each([
    { nodes: 1, racks: 1, fullest: 1, last: 1, totalWeight: 145, clusterKW: 0.1 },
    { nodes: 8, racks: 1, fullest: 8, last: 8, totalWeight: 320, clusterKW: 0.8 },
    { nodes: 42, racks: 1, fullest: 42, last: 42, totalWeight: 1170, clusterKW: 4.2 },
    { nodes: 43, racks: 2, fullest: 42, last: 1, totalWeight: 1315, clusterKW: 4.3 },
  ])(
    'uses authoritative 42-node capacity for a $nodes-node plan',
    async ({ nodes, racks, fullest, last, totalWeight, clusterKW }) => {
      const { service, session, customizeCounts, totalRequests } = setup(42);
      const before = structuredClone(session.raw);

      const plan = await service.scaleOut({
        sessionHandle: session.id,
        nodes,
        rackCode: 'RACK42',
        ctx: service.newCtx({ solution: session.solution }),
      });

      expect(plan).toMatchObject({
        nodeCode: 'NODE1U',
        nodeSizeU: 1,
        nodeWeightKg: 25,
        rackCode: 'RACK42',
        rackSizeU: 42,
        nodes,
        nodesPerRack: 42,
        racksNeeded: racks,
        fullestRackNodes: fullest,
        lastRackNodes: last,
        fullestRackWeightKg: 120 + fullest * 25,
        lastRackWeightKg: 120 + last * 25,
        totalWeightKg: totalWeight,
        totalListPrice: nodes * 1_250.5,
        currency: 'EUR',
        priceScope: 'configured-nodes-only',
        excludedCosts: ['rack cabinets', 'PDUs and cords', 'switches and cables', 'other workspace infrastructure'],
      });
      expect(plan.clusterPower?.maxKW).toBe(clusterKW);
      expect(plan.powerPerRack?.maxKW).toBe(fullest / 10);
      expect(plan.lastRackPower?.maxKW).toBe(last / 10);
      expect(session.raw).toEqual(before);
      expect(customizeCounts).toEqual([1, 2, 4, 8, 16, 32, 64]);
      if (nodes === 42) {
        expect(customizeCounts.length).toBeLessThan(10);
        expect(totalRequests()).toBeLessThan(10);
      }
    },
  );

  it('uses returned empty-rack weight for the partial final rack', async () => {
    const { service, session } = setup(42);
    const plan = await service.scaleOut({
      sessionHandle: session.id,
      nodes: 43,
      rackCode: 'RACK42',
      ctx: service.newCtx({ solution: session.solution }),
    });

    // The envelope says 100 kg; authoritative customize says 120 kg.
    expect(plan.fullestRackWeightKg).toBe(1_170);
    expect(plan.lastRackWeightKg).toBe(145);
    expect(plan.totalWeightKg).toBe(1_315);
    expect(plan.powerPerRack?.inputPowerW.max).toBe(4_200);
    expect(plan.lastRackPower?.inputPowerW.max).toBe(100);
  });

  it('rejects unavailable pricing after capacity measurement without mutating the source', async () => {
    const { service, session, customizeCounts } = setup(42, { includePrice: false });
    const before = structuredClone(session.raw);

    await expect(service.scaleOut({
      sessionHandle: session.id,
      nodes: 8,
      rackCode: 'RACK42',
      ctx: service.newCtx({ solution: session.solution }),
    })).rejects.toThrow(/did not return an available node price/i);

    expect(session.raw).toEqual(before);
    expect(customizeCounts).toEqual([1, 2, 4, 8, 16, 32, 64]);
  });
});

function setup(
  capacity: number,
  options: { includePrice?: boolean } = {},
) {
  const service = new DcscService(
    ConfigSchema.parse({
      logLevel: 'error',
      locale: { country: 'DE', geo: 'EMEA', language: 'en', currency: 'EUR' },
      pacing: { perToolRequestBudget: 40 },
      files: { persistSessions: false },
    }),
  );
  services.push(service);
  const raw = nodeRaw(options.includePrice !== false);
  const configurationId = 'DE__scale0';
  const session = service.sessions.create({
    locale: service.locale,
    solution: { solutionMode: 'General Purpose', masterSlices: ['ISG'] },
    mode: 'cto',
    raw,
    configurationId,
    reduced: reduceConfiguration(raw, configurationId),
    primed: true,
  });

  const customizeCounts: number[] = [];
  let requests = 0;
  vi.spyOn(service.http, 'send').mockImplementation(async (request) => {
    requests += 1;
    if (request.path === '/ctos/racks/customize/non_rack') {
      return {
        raw: [
          {
            code: 'RACK42',
            type: 'rack',
            size: 42,
            weight: 100,
            description: 'Fixture 42U rack',
          },
          {
            code: 'NODE1U',
            type: 'server',
            size: 1,
            weight: 25,
            description: 'Fixture 1U node',
          },
        ],
      } as never;
    }
    if (request.path === '/ctos/racks/customize') {
      if (request.body?.kind !== 'json') throw new Error('Expected JSON rack customize body');
      const payload = request.body.value as {
        rackArea: Array<Record<string, unknown> & { rackItems: Array<Record<string, unknown>> }>;
      };
      const requestedRack = payload.rackArea[0];
      if (!requestedRack) throw new Error('Fixture received no rack');
      const requestedItems = requestedRack.rackItems;
      customizeCounts.push(requestedItems.length);
      const acceptedItems = requestedItems.slice(0, capacity).map((item, index) => ({
        ...item,
        position: index + 1,
        endPosition: index + 2,
        size: 1,
      }));
      const rejectedItems = requestedItems.slice(capacity);
      return {
        raw: {
          rackArea: [
            {
              ...requestedRack,
              size: 42,
              emptyRackWeight: 120,
              totalWeight: 120 + acceptedItems.length * 25,
              stableStatus: 'PASSED',
              rackItems: acceptedItems,
              errors: [],
            },
          ],
          nonRackArea: rejectedItems,
          connections: [],
          errors: [],
          fixtureFutureField: { preserved: true },
        },
      } as never;
    }
    throw new Error(`Unexpected request ${request.path}`);
  });

  return { service, session, customizeCounts, totalRequests: () => requests };
}

function nodeRaw(includePrice: boolean): RawConfiguration {
  return {
    id: 'DE__scale0',
    sliceCtoCode: 'NODE1U',
    description: 'Fixture 1U node',
    type: 'server',
    quantity: 1,
    ...(includePrice ? { totalPrice: 1_250.5 } : {}),
    tabs: [],
    powerReportResponse: {
      powerReport: {
        inputPower: { idle: 40, loadFactorResult: 80, max: 100, worst: 120 },
        inputCurrent: { idle: 0.2, loadFactorResult: 0.4, max: 0.5, worst: 0.6 },
        apparentPower: { idle: 45, loadFactorResult: 85, max: 110, worst: 130 },
        heatGeneration: { idle: 136, loadFactorResult: 273, max: 341, worst: 409 },
        operatingVoltage: '230V-AC',
        loadFactor: 80,
        empty: false,
        warningMessages: [],
      },
    },
  };
}
