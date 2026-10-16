import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { projectAutoDerivedSelections } from '../src/domain/autoDerivedSelections.js';
import type { RawConfiguration } from '../src/model/types.js';

type Obj = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/parity/pdu-auto-derived-selection.json', import.meta.url), 'utf8')) as Obj;

describe('auto-derived selection projection', () => {
  it('matches the browser export projection while retaining the full server record', () => {
    const configuration = fixture['configuration'] as RawConfiguration;
    const records = fixture['autoDerivedResults'];
    const before = structuredClone({ configuration, records });
    const result = projectAutoDerivedSelections(configuration, records);
    const section = (result.configuration.unSelectableCharacters as Obj[])[0]!;
    expect((section['results'] as Obj[])[0]).toMatchObject({
      code: 'A1MT', quantity: 1, derived: true, forAutoConnect: false,
    });
    expect(result.applied).toEqual([{
      recordId: 'rack-1@rule@rack-1', section: 'ETHERNET_CABLE', code: 'A1MT', quantity: 1,
    }]);
    expect((result.autoDerivedResults[0] as Obj)['opaqueFutureField']).toEqual({ retained: true });
    expect({ configuration, records }).toEqual(before);
  });

  it('does not invent selections or apply records with ambiguous identity/status/type', () => {
    const source = fixture['configuration'] as RawConfiguration;
    const accepted = (fixture['autoDerivedResults'] as Obj[])[0]!;
    for (const changed of [
      { ...accepted, invalid: true },
      { ...accepted, override: true },
      { ...accepted, derivePartType: 'SERVICE' },
      { ...accepted, appliedConfigurations: ['other-rack'] },
      { ...accepted, derivePart: { ...(accepted['derivePart'] as Obj), targetWorkspaceId: 'other-rack' } },
      { ...accepted, feature: { ...(accepted['feature'] as Obj), code: 'OTHER' } },
    ]) {
      const result = projectAutoDerivedSelections(source, [changed]);
      expect(result.applied).toEqual([]);
      expect(((result.configuration.unSelectableCharacters as Obj[])[0]!['results'] as Obj[])[0]!['derived'])
        .toBe(false);
      expect(result.autoDerivedResults).toEqual([changed]);
    }
  });

  it('retains an accepted but unmatched record without creating a result', () => {
    const source = structuredClone(fixture['configuration'] as RawConfiguration);
    (source.unSelectableCharacters as Obj[])[0]!['results'] = [];
    const result = projectAutoDerivedSelections(source, fixture['autoDerivedResults']);
    expect(result.applied).toEqual([]);
    expect((result.configuration.unSelectableCharacters as Obj[])[0]!['results']).toEqual([]);
    expect(result.autoDerivedResults).toEqual(fixture['autoDerivedResults']);
  });
});
