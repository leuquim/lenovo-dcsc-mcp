import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { stageRackedCloneMultiple } from '../src/domain/physicalClone.js';
import type { RackObject } from '../src/domain/rack.js';

type Obj = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/parity/racked-clone-multiple.json', import.meta.url), 'utf8',
)) as Obj;

function fixtureOptions() {
  return {
    rackArea: structuredClone(fixture['rackArea'] as RackObject[]),
    nonRackArea: structuredClone(fixture['nonRackArea'] as RackObject[]),
    sourceId: 'server-1',
    cloneIds: structuredClone(fixture['cloneIds'] as string[]),
    cloneDependency: structuredClone(fixture['cloneDependency']),
  };
}

describe('browser-authoritative racked Clone Multiple staging', () => {
  it('matches the captured direct 1U clone identity, placement, and dependency contract', () => {
    const options = fixtureOptions();
    const before = structuredClone(options);
    const staged = stageRackedCloneMultiple(options);
    const items = staged.rackArea[0]!['rackItems'] as Obj[];

    expect(staged.placements).toEqual([{ configurationId: 'server-2', rackId: 'rack-1', position: 2 }]);
    expect(staged.cloneDependency).toEqual((fixture['expected'] as Obj)['cloneDependency']);
    expect(items).toHaveLength(2);
    const sourceBefore = (before.rackArea[0]!['rackItems'] as Obj[])[0]!;
    expect(items[0]).toEqual(sourceBefore);
    expect(items[1]).toEqual({
      ...sourceBefore,
      id: 'server-2', configurationId: 'server-2', position: 2, lock: false, newHardware: true,
    });
    expect(items[1]).not.toHaveProperty('originalId');
    expect(staged.rackArea[0]!['opaqueRackMetadata']).toEqual({ retained: true });
    expect(items[1]!['opaqueItemMetadata']).toEqual({ retained: true });
    expect(options).toEqual(before);
  });

  it('places multiple clones in the first free contiguous positions while respecting locked U space', () => {
    const options = fixtureOptions();
    options.cloneIds = ['server-2', 'server-3'];
    options.rackArea[0]!['lockedSpace'] = [3];
    const staged = stageRackedCloneMultiple(options);
    expect(staged.placements).toEqual([
      { configurationId: 'server-2', rackId: 'rack-1', position: 2 },
      { configurationId: 'server-3', rackId: 'rack-1', position: 4 },
    ]);
    expect(staged.cloneDependency['server-1']).toEqual(['server-1', 'server-2', 'server-3']);
  });

  it('keeps an established dependency root when cloning one of its dependents', () => {
    const options = fixtureOptions();
    options.sourceId = 'server-2';
    options.cloneIds = ['server-3'];
    const source = structuredClone((options.rackArea[0]!['rackItems'] as Obj[])[0]!);
    source['id'] = 'server-2';
    source['configurationId'] = 'server-2';
    source['position'] = 2;
    (options.rackArea[0]!['rackItems'] as Obj[]).push(source);
    options.cloneDependency = { 'server-1': ['server-1', 'server-2'], 'rack-1': ['rack-1'] };
    const staged = stageRackedCloneMultiple(options);
    expect(staged.cloneDependency['server-1']).toEqual(['server-1', 'server-2', 'server-3']);
    expect(staged.placements[0]!.position).toBe(3);
  });

  it('rejects unsupported physical forms instead of inventing clone semantics', () => {
    const nested = fixtureOptions();
    ((nested.rackArea[0]!['rackItems'] as Obj[])[0]!)['nodes'] = [{ id: 'node-1' }];
    expect(() => stageRackedCloneMultiple(nested)).toThrow(/nested physical cloning/);

    const ruled = fixtureOptions();
    ((ruled.rackArea[0]!['rackItems'] as Obj[])[0]!)['rule'] = { mtMinMaxRule: { min: 2 } };
    expect(() => stageRackedCloneMultiple(ruled)).toThrow(/authoritative placement/);

    const nonRack = fixtureOptions();
    const [source] = nonRack.rackArea[0]!['rackItems'] as Obj[];
    nonRack.rackArea[0]!['rackItems'] = [];
    nonRack.nonRackArea.push(source!);
    expect(() => stageRackedCloneMultiple(nonRack)).toThrow(/not racked/);
  });

  it('rejects identity collisions, malformed occupancy, and exhausted placement', () => {
    const collision = fixtureOptions();
    collision.cloneIds = ['rack-1'];
    expect(() => stageRackedCloneMultiple(collision)).toThrow(/already exists/);

    const malformed = fixtureOptions();
    (malformed.rackArea[0]!['rackItems'] as Obj[]).push({ id: 'bad', position: 0, size: 1 });
    expect(() => stageRackedCloneMultiple(malformed)).toThrow(/invalid placement metadata/);

    const full = fixtureOptions();
    full.rackArea[0]!['size'] = 1;
    ((full.rackArea[0]!['rackItems'] as Obj[])[0]!)['highestPosition'] = 1;
    expect(() => stageRackedCloneMultiple(full)).toThrow(/authoritative placement is required/);
  });
});
