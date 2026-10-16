import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { hydrateLockedSpaceFromSpa, projectLockedSpaceToSpa,
  stageRackItemLock, stageRackSpaceLock } from '../src/domain/rackLocks.js';
import type { RackObject } from '../src/domain/rack.js';

type Obj = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/parity/rack-lock-contract.json', import.meta.url), 'utf8',
)) as Obj;

function rackArea(): RackObject[] {
  return structuredClone((fixture['canonical'] as Obj)['rackArea'] as RackObject[]);
}

describe('browser-authoritative rack Lock wire projections', () => {
  it('converts canonical customize positions to the zero-based derive/export rack projection', () => {
    const canonical = rackArea()[0]!;
    expect(projectLockedSpaceToSpa(canonical['lockedSpace'], 42)).toEqual(
      (fixture['deriveAndExportRackData'] as Obj)['lockedSpace']);
    expect(hydrateLockedSpaceFromSpa([41], 42)).toEqual(
      (fixture['customizeRequest'] as Obj)['lockedSpace']);
    expect(hydrateLockedSpaceFromSpa(projectLockedSpaceToSpa([1, 21, 42], 42), 42)).toEqual([1, 21, 42]);
  });

  it('stages direct item Lock and Unlock immutably in canonical state', () => {
    const initial = rackArea();
    (initial[0]!['rackItems'] as Obj[])[0]!['lock'] = false;
    const before = structuredClone(initial);
    const locked = stageRackItemLock(initial, 'server-1', true);
    expect(locked).toMatchObject({ rackId: 'rack-1', position: 1, locked: true });
    expect((locked.rackArea[0]!['rackItems'] as Obj[])[0]!['lock']).toBe(true);
    expect(initial).toEqual(before);
    expect((stageRackItemLock(locked.rackArea, 'server-1', false).rackArea[0]!['rackItems'] as Obj[])[0]!['lock'])
      .toBe(false);
  });

  it('stages empty-U Lock and Unlock with one-based canonical positions', () => {
    const initial = rackArea();
    initial[0]!['lockedSpace'] = [];
    const locked = stageRackSpaceLock(initial, 'rack-1', 42, true);
    expect(locked).toMatchObject({ rackId: 'rack-1', position: 42, locked: true });
    expect(locked.rackArea[0]!['lockedSpace']).toEqual([42]);
    expect(projectLockedSpaceToSpa(locked.rackArea[0]!['lockedSpace'], 42)).toEqual([41]);
    expect(stageRackSpaceLock(locked.rackArea, 'rack-1', 42, false).rackArea[0]!['lockedSpace']).toEqual([]);
  });

  it('rejects occupied, out-of-range and malformed lock positions', () => {
    expect(() => stageRackSpaceLock(rackArea(), 'rack-1', 1, true)).toThrow(/occupied/);
    expect(() => stageRackSpaceLock(rackArea(), 'rack-1', 43, true)).toThrow(/one-based/);
    expect(() => projectLockedSpaceToSpa([0], 42)).toThrow(/one-based/);
    expect(() => hydrateLockedSpaceFromSpa([42], 42)).toThrow(/zero-based/);
  });

  it('requires unambiguous rack and item identities', () => {
    const duplicate = rackArea();
    duplicate.push(structuredClone(duplicate[0]!));
    expect(() => stageRackItemLock(duplicate, 'server-1', true)).toThrow(/exactly once/);
    expect(() => stageRackSpaceLock(duplicate, 'rack-1', 2, true)).toThrow(/exactly once/);
  });
});
