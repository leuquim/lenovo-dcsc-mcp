import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { applyCatalogChange, reduceConfiguration } from '../src/domain/reduce.js';
import type { RawConfiguration } from '../src/model/types.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/rack-power-multi.json', import.meta.url), 'utf8')) as {
  raw: RawConfiguration;
  edits: Array<{ sectionName: string; code: string; quantity: number }>;
  expected: Record<string, Array<{ code: string; quantity: number }> | number>;
};

describe('rack power multi-code selections', () => {
  it('retains independent PDU and line-cord codes while preserving the captured wire flag', () => {
    let reduced = reduceConfiguration(fixture.raw, 'rack');
    for (const edit of fixture.edits) reduced = applyCatalogChange(reduced, fixture.raw, edit);

    for (const name of ['PDU', 'LINECORD']) {
      const section = reduced.sections.find(candidate => candidate.name === name);
      expect(section?.multipleSelectable).toBe(false);
      expect(section?.results.map(result => ({ code: result.code, quantity: result.quantity })))
        .toEqual(fixture.expected[name]);
    }
  });

  it('removes one power code without dropping the other code in that section', () => {
    let reduced = reduceConfiguration(fixture.raw, 'rack');
    for (const edit of fixture.edits) reduced = applyCatalogChange(reduced, fixture.raw, edit);
    reduced = applyCatalogChange(reduced, fixture.raw, { sectionName: 'PDU', code: 'C0D8', quantity: 0 });

    expect(reduced.sections.find(section => section.name === 'PDU')).toMatchObject({
      multipleSelectable: false,
      results: [expect.objectContaining({ code: 'CE6L', quantity: 2 })],
    });
    expect(reduced.delta).toMatchObject({ featureCode: 'C0D8', quantity: 0,
      previousFeatureCode: 'C0D8', previousQuantity: 3 });
  });

  it('continues replacing catalog sections explicitly marked single-entry', () => {
    const raw = structuredClone(fixture.raw);
    raw.tabs![0]!.subTabs![0]!.sections![0]!.singleEntry = true;
    let reduced = reduceConfiguration(raw, 'rack');
    reduced = applyCatalogChange(reduced, raw, fixture.edits[0]!);
    reduced = applyCatalogChange(reduced, raw, fixture.edits[1]!);
    expect(reduced.sections.find(section => section.name === 'PDU')?.results)
      .toEqual([expect.objectContaining({ code: 'C0D8', quantity: 3 })]);
  });
});
