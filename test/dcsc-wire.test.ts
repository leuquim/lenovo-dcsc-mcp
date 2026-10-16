import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { serializeSections } from '../src/domain/dcscWire.js';
import {
  applyCatalogChange,
  applyChange,
  buildAutoDeriveRequest,
  reduceConfiguration,
} from '../src/domain/reduce.js';
import type { RawConfiguration } from '../src/model/types.js';

const raw = JSON.parse(readFileSync(new URL('./fixtures/parity/sr630-launch.json', import.meta.url), 'utf8')) as RawConfiguration;
const browserSections = JSON.parse(readFileSync(new URL('./fixtures/parity/sr630-browser-sections.json', import.meta.url), 'utf8')) as unknown;

describe('DCSC wire selections', () => {
  it('matches all 34 sections of the captured anonymous website request', () => {
    expect(serializeSections(raw)).toEqual(browserSections);
  });

  it('does not mutate or alias the canonical raw response', () => {
    const before = structuredClone(raw);
    const dto = reduceConfiguration(raw, 'US__test0');
    dto.sections[0]!.results[0]!.quantity = 99;
    (dto.hipoDerivedItems[0] as Record<string, unknown>).description = 'changed';
    expect(raw).toEqual(before);
  });

  it('applies a draft change without altering the committed wire view', () => {
    const dto = reduceConfiguration(raw, 'US__test0');
    const before = structuredClone(dto);
    const changed = applyChange(dto, { sectionName: 'MEMORY', code: 'BWHS', quantity: 8 });
    expect(changed.sections.find((section) => section.name === 'MEMORY')?.results[0]?.quantity).toBe(8);
    expect(dto).toEqual(before);
  });

  it('selects the complete warranty package and replaces only the prior A la Carte choice', () => {
    const dto = reduceConfiguration(raw, 'US__test0');
    const changed = applyCatalogChange(dto, raw, {
      sectionName: 'A la Carte|Column2|5 Years', code: 'QA05', quantity: 1,
    });
    const packages = changed.sections.filter((section) => section.source === 'A la Carte');
    expect(packages).toHaveLength(1);
    expect(packages[0]?.results.map((result) => [result.code, result.characterName])).toEqual([
      ['QA05', 'SERVICE_TERM_CFC'], ['QAKT', 'SERVICE_UPSELL_CFC'],
      ['QA07', 'SERVICE_TYPE_CFC'], ['QA0F', 'PREMIER_CFC'],
    ]);
    expect(changed.delta).toEqual({ section: 'A la Carte' });
    expect(changed.sections.filter((section) => section.source === 'Add ons')).toEqual(
      dto.sections.filter((section) => section.source === 'Add ons'),
    );
    expect(changed.sections.filter((section) => section.type === 'software')).toEqual(
      dto.sections.filter((section) => section.type === 'software'),
    );
  });

  it('edits a derived software licence while preserving its group and maintenance anchors', () => {
    const dto = reduceConfiguration(raw, 'US__test0');
    const before = structuredClone(dto);
    const changed = applyCatalogChange(dto, raw, {
      sectionName: 'T1GT', code: 'SCJD', quantity: 2,
    });

    expect(changed.hipoDerivedItems).toEqual(expect.arrayContaining([expect.objectContaining({
      targetCtoCode: '7S0XCTO6WW', features: expect.arrayContaining([expect.objectContaining({ featureCode: 'SCJD', quantity: 2, userChanged: true })]),
    })]));
    expect(changed.sections.find((section) => section.name === 'T1GT')?.results).toEqual([
      expect.objectContaining({ code: 'T1GU', quantity: 1, type: 'software' }),
      expect.objectContaining({
        code: 'SCJD', quantity: 2, type: 'hipo', productNumber: '7S0XCTO6WW',
        ctoCode: '7S0XCTO6WW', derived: true,
      }),
    ]);
    expect(changed.sections.find((section) => section.name === 'SW_MAINT_TYPE')).toEqual(
      dto.sections.find((section) => section.name === 'SW_MAINT_TYPE'),
    );
    expect(changed.sections.find((section) => section.name === 'SW_MAINT_DURATION')).toEqual(
      dto.sections.find((section) => section.name === 'SW_MAINT_DURATION'),
    );
    expect(changed.delta).toEqual({
      section: 'T1GT',
      productNumber: '7S0XCTO6WW',
      featureCode: 'SCJD',
      quantity: 2,
      isClear: false,
      mergeCtoCode: '7S0XCTO6WW',
      type: 'hipo',
      previousQuantity: 1,
    });
    expect(dto).toEqual(before);
  });

  it('serializes a new software group anchor and leaves derived lines for the server to regenerate', () => {
    const dto = reduceConfiguration(raw, 'US__test0');
    const changed = applyCatalogChange(dto, raw, {
      sectionName: 'T1CZ', code: 'T1D0', quantity: 1,
    });

    expect(changed.sections.find((section) => section.name === 'T1CZ')).toEqual({
      name: 'T1CZ',
      productNumber: '7S1SCTO5WW',
      isMultiCto: false,
      multipleSelectable: false,
      isSwType: true,
      type: 'software',
      subTabTitle: 'Microsoft',
      results: [{
        code: 'T1D0', productNumber: '7S1SCTO5WW', quantity: 1,
        type: 'software', hardMandatory: false,
      }],
    });
    expect(changed.sections
      .filter((section) => section.type === 'software')
      .flatMap((section) => section.results)
      .some((result) => result.type === 'hipo')).toBe(false);
    expect(changed.sections.find((section) => section.name === 'SW_MAINT_TYPE')).toEqual(
      dto.sections.find((section) => section.name === 'SW_MAINT_TYPE'),
    );
    expect(changed.delta).toEqual({
      section: 'T1CZ',
      productNumber: '7S1SCTO5WW',
      featureCode: 'T1D0',
      quantity: 0,
      isClear: false,
      mergeCtoCode: '7S1SCTO5WW',
      type: 'software',
    });
  });

  it('maps Guided/Expert and Auto-Correct to independently captured request flags', () => {
    const dto = reduceConfiguration(raw, 'US__test0');
    const flags = (validationMode: 'guided' | 'expert', autoCorrect?: boolean) =>
      buildAutoDeriveRequest(dto, { validationMode, ...(autoCorrect === undefined ? {} : { autoCorrect }) })
        .customizingFlags;

    expect(flags('guided')).toEqual(expect.objectContaining({ autoDerive: true, autoVariant: true }));
    expect(flags('guided', false)).toEqual(expect.objectContaining({ autoDerive: true, autoVariant: false }));
    expect(flags('expert')).toEqual(expect.objectContaining({ autoDerive: true, autoVariant: false }));
    expect(() => flags('expert', true)).toThrow('Auto-Correct cannot be enabled in Expert mode.');
  });
});
