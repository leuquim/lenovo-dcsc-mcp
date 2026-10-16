import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  applySoftwareDerivePatch,
  isSoftwareDerivePatch,
  type SoftwareDerivePatch,
} from '../src/domain/softwareDerive.js';
import type { RawConfiguration } from '../src/model/types.js';

const raw = JSON.parse(readFileSync(
  new URL('./fixtures/parity/sr630-launch.json', import.meta.url), 'utf8',
)) as RawConfiguration;
const capturedPatch = JSON.parse(readFileSync(
  new URL('./fixtures/parity/sr630-software-quantity-response.json', import.meta.url), 'utf8',
)) as SoftwareDerivePatch;

describe('new software engine response reconciliation', () => {
  it('recognizes the captured partial response and rejects a normal empty envelope', () => {
    expect(isSoftwareDerivePatch(capturedPatch)).toBe(true);
    expect(isSoftwareDerivePatch({ configurations: [] })).toBe(false);
  });

  it('matches the SPA merge contract for the captured quantity response', () => {
    const current = structuredClone(raw);
    current.hipoDerivedItems = [
      { targetCtoCode: 'HARDWARE_DERIVED', derivedByHw: true },
      ...(current.hipoDerivedItems as Record<string, unknown>[]),
    ];
    current.gross = true;
    current.rewardPriceDisplay = 'keep-current';
    const before = structuredClone(current);
    const patchBefore = structuredClone(capturedPatch);

    const next = applySoftwareDerivePatch(current, capturedPatch);

    expect(next).not.toBe(current);
    expect(current).toEqual(before);
    expect(capturedPatch).toEqual(patchBefore);
    expect(next.tabs?.filter((tab) => tab.type !== 'software')).toEqual(
      current.tabs?.filter((tab) => tab.type !== 'software'),
    );
    expect(next.tabs?.find((tab) => tab.type === 'software')).toEqual({
      ...capturedPatch.softwareTabs[0], hideOnPage: false,
    });
    expect(next.hipoDerivedItems).toEqual([
      { targetCtoCode: 'HARDWARE_DERIVED', derivedByHw: true },
      ...capturedPatch.softwareHipoDerivedItems,
    ]);
    expect(next.totalPrices).toEqual([
      { priceTypeId: 1, price: 15_955.01, priceNotAvailable: false },
    ]);
    expect(next.totalPrice).toBe(15_955.01);
    expect(next.priceNotAvailable).toBe(false);
    expect(next.flashPrices).toEqual(capturedPatch.flashPrices);
    expect(next.gross).toBe(true);
    expect(next.rewardPriceDisplay).toBe('keep-current');

    const management = (next.unSelectableCharacters as Record<string, unknown>[])
      .find((item) => item.name === 'SYSTEM_MANAGEMENT_UPGRADE');
    expect(management?.results).toEqual([
      { code: 'BRPJ', derived: true, swDerived: true, quantity: 1 },
    ]);
  });

  it('removes stale software-derived hardware results and adds only allowed derived codes', () => {
    const current = structuredClone(raw);
    current.unSelectableCharacters = [{
      name: 'TEST',
      results: [
        { code: 'KEEP', quantity: 2 },
        { code: 'STALE', quantity: 1, swDerived: true },
        { code: 'ALREADY', quantity: 1 },
      ],
    }];
    const patch = structuredClone(capturedPatch);
    patch.allHardwareFeatures = { TEST: ['NEW', 'ALREADY'] };
    patch.derivedHardwareFeatures = { NEW: 3, ALREADY: 7, OUTSIDE_SECTION: 2 };

    const next = applySoftwareDerivePatch(current, patch);
    expect((next.unSelectableCharacters as Record<string, unknown>[])[0]?.results).toEqual([
      { code: 'KEEP', quantity: 2 },
      { code: 'ALREADY', quantity: 1 },
      { code: 'NEW', derived: true, swDerived: true, quantity: 3 },
    ]);
  });

  it('uses the SPA price fallback when pricing is hidden', () => {
    const current = structuredClone(raw);
    current.showPrice = false;
    current.totalPrices = [{ priceTypeId: 1, price: 123, priceNotAvailable: false }];
    current.totalPrice = 999;

    const next = applySoftwareDerivePatch(current, capturedPatch);
    expect(next.totalPrices).toEqual(current.totalPrices);
    expect(next.totalPrice).toBe(123);
  });

  it('rejects an incomplete response or a configuration with no software tab', () => {
    expect(() => applySoftwareDerivePatch(raw, { softwareTabs: [] }))
      .toThrow('expected the partial software response shape');
    const noSoftware = structuredClone(raw);
    noSoftware.tabs = (noSoftware.tabs ?? []).filter((tab) => tab.type !== 'software');
    expect(() => applySoftwareDerivePatch(noSoftware, capturedPatch))
      .toThrow('without a software tab');
  });
});
