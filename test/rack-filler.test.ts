import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  buildRackFiller,
  projectRackFiller,
} from '../src/domain/rackFiller.js';
import type { RawConfiguration } from '../src/model/types.js';

type Obj = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/parity/rack-filler-contract.json', import.meta.url), 'utf8')) as Obj;

describe('browser rack filler projection', () => {
  it('matches the captured one-server 42U filler and pre-derive configuration results', () => {
    const rack = structuredClone(fixture['rack'] as Obj);
    const configuration = structuredClone(fixture['configuration'] as RawConfiguration);
    const before = structuredClone({ rack, configuration });
    const result = projectRackFiller(rack, configuration);
    const expected = fixture['expected'] as Obj;

    expect(result.filler).toEqual(expected['filler']);
    expect(result.rack['filler']).toEqual(expected['filler']);
    expect(result.rack['baseFeatureCode']).toBe(expected['baseFeatureCode']);
    const mechanical = (result.configuration.unSelectableCharacters as Obj[])
      .find((section) => section['name'] === 'MECH_DERIVE_FCS')!;
    expect(mechanical['results']).toEqual(expected['results']);
    expect(result.selections).toEqual([
      { code: '4275', quantity: 8, derived: true },
      { code: '4271', quantity: 1, derived: true },
    ]);
    const pdu = (result.rack['features'] as Obj[]).find((section) => section['name'] === 'PDU')!;
    expect((pdu['results'] as Obj[])[0]).toMatchObject({ code: 'CE6L', forAutoConnect: true });
    expect({ rack, configuration }).toEqual(before);
  });

  it('flags a changed filler only when the packed filler differs from the selected one', () => {
    const rack = structuredClone(fixture['rack'] as Obj);
    const packed = projectRackFiller(rack, structuredClone(fixture['configuration'] as RawConfiguration));
    expect(projectRackFiller(rack, packed.configuration).fillerHasChanged).toBe(false);
    const fuller = { ...rack, rackItems: [...(rack['rackItems'] as Obj[]), { position: 41, size: 1 }] };
    const repacked = projectRackFiller(fuller, packed.configuration);
    expect(repacked.fillerHasChanged).toBe(true);
  });

  it('packs only contiguous free positions in 5U, then 3U, then 1U runs', () => {
    expect(buildRackFiller({
      size: 15,
      rackItems: [{ position: 2, size: 2 }],
      featureItems: [{ location: 'u_space', position: 10, size: 2 }],
      lockedSpace: [15],
    })).toEqual([
      { position: 0, size: 1 },
      { position: 3, size: 5 },
      { position: 8, size: 1 },
      { position: 11, size: 3 },
    ]);
  });

  it('does not invent filler for an empty rack unless the SPA force path is requested', () => {
    expect(buildRackFiller({ size: 8, rackItems: [], featureItems: [] })).toEqual([]);
    expect(buildRackFiller({ size: 8, rackItems: [], featureItems: [] }, true)).toEqual([
      { position: 0, size: 5 },
      { position: 5, size: 3 },
    ]);
  });

  it('matches native catalog gating instead of selecting unsupported filler codes', () => {
    const configuration = structuredClone(fixture['configuration'] as RawConfiguration);
    const mechanical = (configuration.unSelectableCharacters as Obj[])
      .find((section) => section['name'] === 'MECH_DERIVE_FCS')!;
    mechanical['features'] = (mechanical['features'] as Obj[]).filter((feature) => feature['code'] !== '4273');
    const result = projectRackFiller(
      { size: 9, rackItems: [{ position: 6, size: 1 }] }, configuration);
    expect(result.selections).toEqual([{ code: '4275', quantity: 1, derived: true }]);
    expect(result.filler).toEqual([{ position: 0, size: 5 }, { position: 6, size: 3 }]);
  });

  it('can retain a selected filler code when an imported projection omitted its feature catalog', () => {
    const configuration = structuredClone(fixture['configuration'] as RawConfiguration);
    const mechanical = (configuration.unSelectableCharacters as Obj[])
      .find((section) => section['name'] === 'MECH_DERIVE_FCS')!;
    mechanical['features'] = [];
    mechanical['results'] = [
      { code: 'BNVL', quantity: 1, derived: true },
      { code: '4275', quantity: 2, derived: true },
    ];
    const result = projectRackFiller({ size: 10, rackItems: [{ position: 6, size: 5 }] }, configuration);
    expect(result.selections).toEqual([{ code: '4275', quantity: 1, derived: true }]);
    const projected = (result.configuration.unSelectableCharacters as Obj[])
      .find((section) => section['name'] === 'MECH_DERIVE_FCS')!;
    expect(projected['results']).toEqual([
      { code: 'BNVL', quantity: 1, derived: true },
      { code: '4275', quantity: 1, derived: true },
    ]);
  });

  it('uses extension-kit AUEE as the SPA extensionResult source', () => {
    const configuration = structuredClone(fixture['configuration'] as RawConfiguration);
    const mechanical = (configuration.unSelectableCharacters as Obj[])
      .find((section) => section['name'] === 'MECH_DERIVE_FCS')!;
    mechanical['features'] = [
      ...(mechanical['features'] as Obj[]),
      { code: 'B34A' },
    ];
    (configuration.unSelectableCharacters as Obj[]).push({
      name: 'EXTENSION_KIT',
      results: [{ code: 'AUEE', quantity: 1 }],
    });
    const result = projectRackFiller({ size: 5, rackItems: [{ position: 6, size: 1 }] }, configuration);
    expect(result.selections).toEqual([{ code: 'B34A', quantity: 1, derived: true }]);
  });
});

it('preserves native MGX power-shelf results without inventing standard filler parts', () => {
  const mgx = JSON.parse(readFileSync(new URL('./fixtures/parity/mgx-rack-filler.json', import.meta.url), 'utf8')) as Obj;
  const configuration = mgx['configuration'] as RawConfiguration;
  const before = structuredClone(configuration);
  const projected = projectRackFiller(mgx['rack'] as Obj, configuration);
  expect(projected.selections).toEqual([]);
  expect(configuration).toEqual(before);
  const mechanical = (projected.configuration.unSelectableCharacters as Obj[])[0]!;
  const compact = (values: Obj[]) => values.map(r => ({ code: r['code'], quantity: r['quantity'] }));
  expect(compact(mechanical['results'] as Obj[])).toEqual(compact(mgx['expected'] as Obj[]));
});

it('reprices native chassis-clone filler changes and keeps unavailable prices explicit', async () => {
  const { repriceRackFillers } = await import('../src/domain/rackFiller.js');
  const captured = JSON.parse(readFileSync(new URL('./fixtures/parity/chassis-clone-filler-price.json', import.meta.url), 'utf8')) as {
    before: RawConfiguration; after: RawConfiguration;
  };
  const staged = { ...captured.before, unSelectableCharacters: captured.after.unSelectableCharacters };
  const result = repriceRackFillers(captured.before, staged);
  expect(result.totalPrice).toBe(captured.after.totalPrice);
  expect(result.totalPrices).toEqual(captured.after.totalPrices);
  expect(result['nonSoftwareTotalPrices']).toEqual(captured.after['nonSoftwareTotalPrices']);
  const missing = structuredClone(captured.before);
  for (const section of missing.unSelectableCharacters as Obj[]) for (const feature of section['features'] as Obj[]) {
    if (feature.code === '4275') { feature.unitPrice = null; feature.prices = []; }
  }
  const unavailable = repriceRackFillers(missing, staged);
  expect(unavailable.totalPrice).toBeNull();
  expect(unavailable.priceNotAvailable).toBe(true);
});
