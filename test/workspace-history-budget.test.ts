import { describe, expect, it } from 'vitest';

import { trimHistoryToBudget } from '../src/session/SessionStore.js';

describe('workspace undo history budget', () => {
  it('keeps the newest snapshots that fit the byte budget, and always at least one', () => {
    const entry = (revision: number, size: number) => ({ revision, state: { blob: 'x'.repeat(size) } });
    const entries = [entry(1, 100), entry(2, 100), entry(3, 100), entry(4, 100)];
    expect(trimHistoryToBudget(entries, 250).map((e) => e.revision)).toEqual([3, 4]);
    expect(trimHistoryToBudget(entries, 10_000).map((e) => e.revision)).toEqual([1, 2, 3, 4]);
    expect(trimHistoryToBudget([entry(1, 100), entry(2, 5_000)], 1_000).map((e) => e.revision)).toEqual([2]);
    expect(trimHistoryToBudget([], 1_000)).toEqual([]);
  });
});
