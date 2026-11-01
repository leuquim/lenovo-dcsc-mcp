/**
 * Regressions for the defects found while building the B200 AI factory example.
 *
 * Each test here maps to something that shipped wrong and was only caught by
 * reading a BOM back, not by any existing check.
 */
import { describe, expect, it } from 'vitest';

import { assessRackDensity } from '../src/domain/power.js';
import { listPduCatalog } from '../src/domain/pdu.js';
import { SessionStore } from '../src/session/SessionStore.js';
import type { ConfigIndex } from '../src/model/index.js';
import type { RawConfiguration } from '../src/model/types.js';

const locale = { country: 'US', geo: 'NA', language: 'en', currency: 'USD' } as const;
const solution = { solutionMode: 'HPC and AI - Systems', masterSlices: [] } as never;

function makeStore(): { store: SessionStore; wsId: string; first: string; second: string } {
  const store = new SessionStore();
  const raw = { tabs: [], totalPrice: 100, quantity: 1 } as unknown as RawConfiguration;
  const a = store.create({
    locale,
    solution,
    mode: 'cto',
    raw,
    configurationId: 'US__aaa0',
    reduced: { sliceCtoCode: 'A' } as never,
    primed: true,
  });
  const b = store.create({
    locale,
    solution,
    mode: 'cto',
    raw,
    configurationId: 'US__bbb0',
    reduced: { sliceCtoCode: 'B' } as never,
    primed: true,
    workspaceId: a.workspaceId,
  });
  return { store, wsId: a.workspaceId, first: a.id, second: b.id };
}

describe('handle scope resolution', () => {
  it('distinguishes a configuration handle from its parent workspace', () => {
    const { store, wsId, first } = makeStore();

    const asConfig = store.resolveHandle(first);
    expect(asConfig?.kind).toBe('configuration');

    const asWorkspace = store.resolveHandle(wsId);
    expect(asWorkspace?.kind).toBe('workspace');
  });

  it('does not widen a configuration handle to the whole workspace', () => {
    // The export bug: getWorkspace(configId) returns the parent, so a
    // seven-product workspace exported everything when one node was asked for.
    const { store, wsId, first } = makeStore();

    expect(store.getWorkspace(first)?.id).toBe(wsId);
    expect(store.getWorkspace(first)?.configurations.size).toBe(2);

    const resolved = store.resolveHandle(first);
    expect(resolved?.kind).toBe('configuration');
    if (resolved?.kind !== 'configuration') throw new Error('unreachable');
    expect(resolved.session.id).toBe(first);
  });

  it('returns undefined for an unknown handle rather than guessing', () => {
    const { store } = makeStore();
    expect(store.resolveHandle('sess_nope')).toBeUndefined();
  });
});

describe('rack density advisory', () => {
  it('stays quiet for conventional density', () => {
    expect(assessRackDensity(12, 'air')?.level).toBe('standard');
  });

  it('flags the 47 kW air-cooled B200 rack that DCSC priced without comment', () => {
    const advisory = assessRackDensity(46.8, 'air');
    expect(advisory?.level).toBe('containment-required');
    expect(advisory?.message).toMatch(/rear-door heat exchanger|containment/i);
  });

  it('escalates beyond practical air cooling', () => {
    expect(assessRackDensity(72, 'air')?.level).toBe('liquid-recommended');
  });

  it('exempts direct water cooling, which carries its own heat out', () => {
    expect(assessRackDensity(80, 'direct water')).toBeUndefined();
  });
});

describe('PDU catalog line cords', () => {
  const index = (features: unknown[]): ConfigIndex =>
    ({ features, byCode: new Map(), selected: new Map() }) as unknown as ConfigIndex;

  it('classifies LINECORD rows separately from jumper cords', () => {
    const catalog = listPduCatalog({
      index: index([
        { code: 'C0CS', description: '63A PDU', sectionName: 'PDU', selectedQty: 4 },
        { code: '6252', description: 'C19-C20 jumper', sectionName: 'RACK_POWERCABLE', selectedQty: 0 },
        { code: '6504', description: '32A 3ph line cord', sectionName: 'LINECORD', selectedQty: 0 },
      ]),
    });
    const sections = catalog.options.map((o) => o.section.toUpperCase());
    expect(sections).toContain('LINECORD');
    expect(sections).toContain('RACK_POWERCABLE');
  });

  it('keeps line cords reachable behind a long run of jumper cords', () => {
    // The real defect: DCSC returns ~44 non-PDU power options with the first 25
    // all RACK_POWERCABLE, and the listing sliced the mixed list to 20. Every
    // LINECORD fell off the end silently, so the rack shipped with PDUs and no
    // way to reach facility power. Bucketing by section is what fixes it.
    const many = [
      ...Array.from({ length: 25 }, (_, i) => ({
        code: `J${i}`,
        description: 'jumper',
        sectionName: 'RACK_POWERCABLE',
        selectedQty: 0,
      })),
      { code: '6504', description: '32A 3ph line cord', sectionName: 'LINECORD', selectedQty: 0 },
    ];
    const catalog = listPduCatalog({ index: index(many) });

    const flatFirst20 = catalog.options.slice(0, 20);
    expect(flatFirst20.some((o) => o.section.toUpperCase() === 'LINECORD')).toBe(false);

    const lineCords = catalog.options.filter((o) => o.section.toUpperCase() === 'LINECORD');
    expect(lineCords).toHaveLength(1);
    expect(lineCords[0]?.code).toBe('6504');
  });
});
