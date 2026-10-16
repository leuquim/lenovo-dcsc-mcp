import { describe, expect, it, vi } from 'vitest';

import {
  findRackCapacity,
  type RackCapacityIncompleteError,
  type RackCapacityProbeRequest,
} from '../src/domain/rackCapacity.js';

interface FixtureLayout {
  accepted: number;
  positions: number[];
  emptyWeightKg: number;
  totalWeightKg: number;
  marker?: string;
}

describe('findRackCapacity', () => {
  it('finds 42 one-U nodes from an authoritative partial layout in fewer than ten calls', async () => {
    const requested: number[] = [];
    const result = await findRackCapacity({
      physicalSizeU: 1,
      requestBudget: 10,
      probe: partialLayoutProbe(42, requested),
    });

    expect(requested).toEqual([1, 2, 4, 8, 16, 32, 64]);
    expect(result).toMatchObject({
      capacity: 42,
      calls: 7,
      physicalSizeU: 1,
      evidence: 'partial-layout',
    });
    expect(result.acceptedLayout?.positions).toEqual(
      Array.from({ length: 42 }, (_unused, index) => index + 1),
    );
  });

  it('uses physical size only for candidate seed positions and keeps DCSC authoritative', async () => {
    const requested: number[] = [];
    const result = await findRackCapacity({
      physicalSizeU: 2,
      requestBudget: 10,
      probe: partialLayoutProbe(21, requested),
    });

    expect(requested).toEqual([1, 2, 4, 8, 16, 32]);
    expect(result.capacity).toBe(21);
    expect(result.acceptedLayout?.positions.at(-1)).toBe(41);
  });

  it('retains the complete partial layout, including authoritative weight metadata', async () => {
    let partial: FixtureLayout | undefined;
    const result = await findRackCapacity({
      physicalSizeU: 1,
      requestBudget: 8,
      probe: async (request) => {
        const accepted = Math.min(request.requestedCount, 10);
        const layout = layoutFor(request, accepted, 'server-partial-response');
        if (accepted < request.requestedCount) partial = layout;
        return { kind: 'layout', acceptedCount: accepted, layout };
      },
    });

    expect(result.capacity).toBe(10);
    expect(result.acceptedLayout).toBe(partial);
    expect(result.acceptedLayout).toMatchObject({
      accepted: 10,
      emptyWeightKg: 120,
      totalWeightKg: 370,
      marker: 'server-partial-response',
    });
  });

  it('uses binary search only after an explicit capacity rejection', async () => {
    const requested: number[] = [];
    const result = await findRackCapacity({
      physicalSizeU: 1,
      requestBudget: 16,
      probe: async (request) => {
        requested.push(request.requestedCount);
        if (request.requestedCount > 37) {
          return { kind: 'capacity-rejected', reason: 'explicit placement capacity error' };
        }
        return {
          kind: 'layout',
          acceptedCount: request.requestedCount,
          layout: layoutFor(request, request.requestedCount),
        };
      },
    });

    expect(requested.slice(0, 7)).toEqual([1, 2, 4, 8, 16, 32, 64]);
    expect(result).toMatchObject({
      capacity: 37,
      evidence: 'capacity-rejection-bound',
    });
    expect(result.acceptedLayout?.accepted).toBe(37);
  });

  it('reports zero fit from either an empty authoritative layout or explicit first-node rejection', async () => {
    const empty = await findRackCapacity({
      physicalSizeU: 4,
      requestBudget: 1,
      probe: async (request) => ({
        kind: 'layout', acceptedCount: 0, layout: layoutFor(request, 0),
      }),
    });
    const rejected = await findRackCapacity({
      physicalSizeU: 4,
      requestBudget: 1,
      probe: async () => ({ kind: 'capacity-rejected', reason: 'incompatible rack' }),
    });

    expect(empty).toMatchObject({ capacity: 0, evidence: 'partial-layout' });
    expect(empty.acceptedLayout).toBeDefined();
    expect(rejected).toEqual({
      capacity: 0,
      calls: 1,
      physicalSizeU: 4,
      evidence: 'capacity-rejection-bound',
    });
  });

  it('throws an actionable incomplete error rather than returning the accepted lower bound', async () => {
    const probe = vi.fn(partialLayoutProbe(42, []));

    await expect(
      findRackCapacity({ physicalSizeU: 1, requestBudget: 6, probe }),
    ).rejects.toMatchObject({
      name: 'RackCapacityIncompleteError',
      calls: 6,
      requestBudget: 6,
      acceptedLowerBound: 32,
      rejectedUpperBound: undefined,
      message: expect.stringMatching(/capacity remains incomplete.*at least 32.*larger.*budget.*no capacity was guessed/i),
    } satisfies Partial<RackCapacityIncompleteError>);
    expect(probe).toHaveBeenCalledTimes(6);
  });

  it('stops at the safe probe ceiling even when the server accepts every request', async () => {
    const requested: number[] = [];
    const probe = vi.fn(async (request: RackCapacityProbeRequest) => {
      requested.push(request.requestedCount);
      return {
        kind: 'layout' as const,
        acceptedCount: request.requestedCount,
        layout: { accepted: request.requestedCount },
      };
    });

    await expect(findRackCapacity({
      physicalSizeU: 1,
      requestBudget: 40,
      maxProbeCount: 128,
      probe,
    })).rejects.toMatchObject({
      name: 'RackCapacityIncompleteError',
      calls: 8,
      acceptedLowerBound: 128,
      rejectedUpperBound: undefined,
      maxProbeCount: 128,
      message: expect.stringMatching(/safe probe ceiling of 128.*raise it only.*No capacity was guessed/i),
    });
    expect(requested).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);
    expect(Math.max(...requested)).toBe(128);
    expect(probe).toHaveBeenCalledTimes(8);
  });

  it('propagates request errors and rejects malformed or inconsistent layouts', async () => {
    const upstream = new Error('HTTP 503 from rack customize');
    await expect(findRackCapacity({
      physicalSizeU: 1,
      requestBudget: 4,
      probe: async () => { throw upstream; },
    })).rejects.toBe(upstream);

    await expect(findRackCapacity({
      physicalSizeU: 1,
      requestBudget: 4,
      probe: async (request) => ({
        kind: 'layout', acceptedCount: request.requestedCount + 1, layout: {},
      }),
    })).rejects.toThrow(/Invalid rack capacity response/);

    let call = 0;
    await expect(findRackCapacity({
      physicalSizeU: 1,
      requestBudget: 4,
      probe: async (request) => {
        call += 1;
        return {
          kind: 'layout',
          acceptedCount: call === 1 ? 1 : 0,
          layout: layoutFor(request, call === 1 ? 1 : 0),
        };
      },
    })).rejects.toThrow(/Inconsistent rack capacity response/);

    await expect(findRackCapacity({
      physicalSizeU: 1,
      requestBudget: 4,
      maxProbeCount: Number.MAX_SAFE_INTEGER + 1,
      probe: async () => ({ kind: 'capacity-rejected' }),
    })).rejects.toThrow(/maxProbeCount must be a positive safe integer/);
  });
});

function partialLayoutProbe(capacity: number, requested: number[]) {
  return async (request: RackCapacityProbeRequest) => {
    requested.push(request.requestedCount);
    const accepted = Math.min(capacity, request.requestedCount);
    return {
      kind: 'layout' as const,
      acceptedCount: accepted,
      layout: layoutFor(request, accepted),
    };
  };
}

function layoutFor(
  request: RackCapacityProbeRequest,
  accepted: number,
  marker?: string,
): FixtureLayout {
  return {
    accepted,
    positions: Array.from(
      { length: accepted },
      (_unused, index) => request.positionForOrdinal(index + 1),
    ),
    emptyWeightKg: 120,
    totalWeightKg: 120 + accepted * 25,
    ...(marker ? { marker } : {}),
  };
}
