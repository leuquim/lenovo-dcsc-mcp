import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyCatalogChange, reduceConfiguration } from '../src/domain/reduce.js';
import type { RawConfiguration } from '../src/model/types.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/software-edit-contracts.json', import.meta.url), 'utf8')) as {
  cases: Array<{name: string; change: {sectionName: string;code: string;quantity: number};before: RawConfiguration;
    expected: {sections: unknown; delta: unknown};after: RawConfiguration}>;
};
const pricedCal = JSON.parse(readFileSync(new URL('./fixtures/parity/software-priced-cal-quantity.json', import.meta.url), 'utf8')) as {
  before: RawConfiguration;
  change: { sectionName: string; code: string; quantity: number };
  expected: { sections: unknown; hipoDerivedItems: unknown; delta: unknown };
};

describe('software website selection contracts', () => {
  it('matches the complete priced CAL quantity-three request, including merged CTO HIPO and duplicate derived results', () => {
    const raw = structuredClone(pricedCal.before);
    const reduced = reduceConfiguration(raw, 'capture');
    const original = structuredClone(reduced);
    const result = applyCatalogChange(reduced, raw, pricedCal.change);
    expect(result.sections).toEqual(pricedCal.expected.sections);
    expect(result.hipoDerivedItems).toEqual(pricedCal.expected.hipoDerivedItems);
    expect(result.delta).toEqual(pricedCal.expected.delta);
    expect(reduced).toEqual(original);
    expect(raw).toEqual(pricedCal.before);
  });

  it('does not change the same feature in a different software product or group', () => {
    const raw = structuredClone(pricedCal.before);
    const items = raw.hipoDerivedItems as Array<Record<string, unknown>>;
    const paid = items.find(item => item.targetCtoCode === '7S1SCTOAWW')!;
    const otherProduct = structuredClone(paid);
    otherProduct.targetCtoCode = 'OTHER-CTO';
    const otherGroup = structuredClone(paid);
    (otherGroup.features as Array<Record<string, unknown>>)[0]!.swSubCategory = 'OTHER-GROUP';
    items.push(otherProduct, otherGroup);
    const reduced = reduceConfiguration(raw, 'capture');
    const result = applyCatalogChange(reduced, raw, pricedCal.change);
    expect(result.hipoDerivedItems.slice(-2)).toEqual([otherProduct, otherGroup]);
    expect(result.hipoDerivedItems.slice(0, -2)).toEqual(pricedCal.expected.hipoDerivedItems);
  });

  it.each(fixture.cases)('matches browser $name without mutating canonical state', ({before,change,expected}) => {
    const original = structuredClone(before);
    const reduced = reduceConfiguration(before, 'capture');
    const originalReduced = structuredClone(reduced);
    const result = applyCatalogChange(reduced,before,change);
    expect(result.sections.filter(section=>section.type==='software')).toEqual(expected.sections);
    expect(result.delta).toEqual(expected.delta);
    expect(before).toEqual(original);
    expect(reduced).toEqual(originalReduced);
  });

  it('rejects invalid group quantities and unknown filter choices', () => {
    const raw = fixture.cases[0]!.before;
    const reduced = reduceConfiguration(raw,'capture');
    expect(()=>applyCatalogChange(reduced,raw,{sectionName:'T1GT',code:'T1GU',quantity:4})).toThrow('group selection accepts');
    expect(()=>applyCatalogChange(reduced,raw,{sectionName:'T1GT/T1GU/SW_MAINT_DURATION',code:'wrong',quantity:1})).toThrow('has no choice');
  });

  it('does not edit an unselected software group filter', () => {
    const raw = fixture.cases[1]!.after;
    const reduced = reduceConfiguration(raw,'capture');
    expect(()=>applyCatalogChange(reduced,raw,{sectionName:'T1GT/T1GU/SW_MAINT_DURATION',code:'SMD5',quantity:1})).toThrow(/Select software group|Unknown section/);
  });
});
