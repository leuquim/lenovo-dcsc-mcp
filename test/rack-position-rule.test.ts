import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import {
  getHardwareRuleInRack,
  type RackPositionRuleInput,
} from '../src/domain/rackPositionRule.js';
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

const validSampleInput: RackPositionRuleInput = {
  rack: {
    code: '7D2NCTO1WW',
    machineType: '7D2N',
    sliceCtoCode: null,
    size: 42,
    rackItem: {
      code: '7D73CTO1WW',
      machineType: '7D73',
      sliceCtoCode: null,
      type: 'Server',
      asVLH: false,
    },
  },
  configurations: [
    {
      configurationId: 'cfg-rack-1',
      core: { chassis: '7D2N' },
      sectionResults: [],
      unSelectableCharacters: [],
      selectedTopologies: {},
      selectedStorageNetwork: {},
      connectors: [],
    },
    {
      configurationId: 'cfg-server-1',
      core: { model: 'SR650V3' },
      sectionResults: [],
      unSelectableCharacters: [],
      selectedTopologies: {},
      selectedStorageNetwork: {},
      connectors: [],
    },
  ],
};

describe('R2: Rack U-Position Placement Rules (getHardwareRuleInRack)', () => {
  it('posts payload to /racks/ctos/position/rule and returns normalized bounds and rules', async () => {
    const service = setupService();
    const mockUpstreamResponse = {
      rackItemResponse: {
        code: '7D73CTO1WW',
        lowestPosition: 1,
        highestPosition: 42,
        rule: {
          mtMinMaxRule: { min: 1, max: 12 },
          productMinMaxRule: { min: 1, max: 6 },
        },
      },
    };

    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: mockUpstreamResponse,
      requestId: 'req-rack-rule-1',
    } as never);

    const result = await getHardwareRuleInRack(service.http, service.newCtx(), validSampleInput);

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'racks_ctos_position_rule',
        method: 'POST',
        path: '/racks/ctos/position/rule',
        body: {
          kind: 'json',
          value: {
            rack: validSampleInput.rack,
            configurations: validSampleInput.configurations,
          },
        },
        timeoutClass: 'fast',
      }),
    );

    expect(result.lowestPosition).toBe(1);
    expect(result.highestPosition).toBe(42);
    expect(result.serverRule.mtMinMaxRule).toEqual({ min: 1, max: 12 });
    expect(result.serverRule.productMinMaxRule).toEqual({ min: 1, max: 6 });
  });

  it('handles flat upstream response where rackItemResponse wrapper is omitted', async () => {
    const service = setupService();
    const mockFlatResponse = {
      lowestPosition: 3,
      highestPosition: 36,
      serverRule: {
        mtMinMaxRule: { min: 2, max: 8 },
      },
    };

    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: mockFlatResponse,
      requestId: 'req-rack-rule-2',
    } as never);

    const result = await getHardwareRuleInRack(service.http, service.newCtx(), validSampleInput);

    expect(result.lowestPosition).toBe(3);
    expect(result.highestPosition).toBe(36);
    expect(result.serverRule.mtMinMaxRule).toEqual({ min: 2, max: 8 });
  });

  it('provides empty serverRule when upstream rule is undefined', async () => {
    const service = setupService();
    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: {
        rackItemResponse: {
          lowestPosition: 1,
          highestPosition: 48,
        },
      },
      requestId: 'req-rack-rule-3',
    } as never);

    const result = await getHardwareRuleInRack(service.http, service.newCtx(), validSampleInput);

    expect(result.lowestPosition).toBe(1);
    expect(result.highestPosition).toBe(48);
    expect(result.serverRule).toEqual({});
  });

  it('validates rackItem with asVLH and sliceCtoCode attributes', async () => {
    const service = setupService();
    const vlhInput: RackPositionRuleInput = {
      ...validSampleInput,
      rack: {
        ...validSampleInput.rack,
        rackItem: {
          code: '7D73CTO1WW',
          machineType: '7D73',
          sliceCtoCode: 'SLICE_AI_100',
          type: 'Storage',
          asVLH: true,
        },
      },
    };

    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: {
        rackItemResponse: {
          lowestPosition: 5,
          highestPosition: 20,
        },
      },
    } as never);

    const result = await getHardwareRuleInRack(service.http, service.newCtx(), vlhInput);

    expect(result.lowestPosition).toBe(5);
    expect(result.highestPosition).toBe(20);
    const sentBody = sendSpy.mock.calls[0]![0].body;
    expect(sentBody?.kind).toBe('json');
    if (sentBody?.kind === 'json') {
      const val = sentBody.value as { rack: { rackItem: { asVLH?: boolean; sliceCtoCode?: string } } };
      expect(val.rack.rackItem.asVLH).toBe(true);
      expect(val.rack.rackItem.sliceCtoCode).toBe('SLICE_AI_100');
    }
  });

  it('rejects input with missing rack code or invalid size', async () => {
    const service = setupService();

    const missingRackCode = {
      ...validSampleInput,
      rack: { ...validSampleInput.rack, code: '' },
    };
    await expect(
      getHardwareRuleInRack(service.http, service.newCtx(), missingRackCode),
    ).rejects.toThrow();

    const negativeSize = {
      ...validSampleInput,
      rack: { ...validSampleInput.rack, size: -1 },
    };
    await expect(
      getHardwareRuleInRack(service.http, service.newCtx(), negativeSize),
    ).rejects.toThrow();
  });

  it('rejects input with missing rackItem code or type', async () => {
    const service = setupService();

    const missingItemCode = {
      ...validSampleInput,
      rack: {
        ...validSampleInput.rack,
        rackItem: { ...validSampleInput.rack.rackItem, code: '' },
      },
    };
    await expect(
      getHardwareRuleInRack(service.http, service.newCtx(), missingItemCode),
    ).rejects.toThrow();

    const missingItemType = {
      ...validSampleInput,
      rack: {
        ...validSampleInput.rack,
        rackItem: { ...validSampleInput.rack.rackItem, type: '' },
      },
    };
    await expect(
      getHardwareRuleInRack(service.http, service.newCtx(), missingItemType),
    ).rejects.toThrow();
  });

  it('throws DcscContractDriftError when upstream returns invalid positions or shape', async () => {
    const service = setupService();
    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: {
        rackItemResponse: {
          lowestPosition: 'not-a-number',
          highestPosition: 42,
        },
      },
      requestId: 'req-bad-pos',
    } as never);

    await expect(
      getHardwareRuleInRack(service.http, service.newCtx(), validSampleInput),
    ).rejects.toThrow(DcscContractDriftError);
  });
});
