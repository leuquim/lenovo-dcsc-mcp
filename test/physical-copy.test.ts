import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { stageRackedCopy } from '../src/domain/physicalCopy.js';
import type { RackObject } from '../src/domain/rack.js';

type Obj = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/parity/racked-copy.json', import.meta.url), 'utf8',
)) as Obj;

function fixtureOptions() {
  return {
    rackArea: structuredClone(fixture['rackArea'] as RackObject[]),
    nonRackArea: structuredClone(fixture['nonRackArea'] as RackObject[]),
    sourceId: 'server-1',
    copyId: String(fixture['copyId']),
    cloneDependency: structuredClone(fixture['cloneDependency']),
  };
}

describe('browser-authoritative direct racked Copy staging', () => {
  it('creates the captured independent Copy identity, name, placement and dependency', () => {
    const options = fixtureOptions();
    const before = structuredClone(options);
    const staged = stageRackedCopy(options);
    const items = staged.rackArea[0]!['rackItems'] as Obj[];

    expect(staged.copyName).toBe('Copy_Server');
    expect(staged.placement).toEqual({ configurationId: 'server-2', rackId: 'rack-1', position: 2 });
    expect(staged.cloneDependency).toEqual((fixture['expected'] as Obj)['cloneDependency']);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual((before.rackArea[0]!['rackItems'] as Obj[])[0]);
    expect(items[1]).toEqual({
      ...(items[0] as Obj), id: 'server-2', name: 'Copy_Server', position: 2,
      lock: false, newHardware: true,
    });
    expect(items[1]).not.toHaveProperty('originalId');
    expect(items[1]!['opaqueItemMetadata']).toEqual({ retained: true });
    expect(options).toEqual(before);
  });

  it('preserves unrelated dependency groups and locked-space placement', () => {
    const options = fixtureOptions();
    options.rackArea[0]!['lockedSpace'] = [2];
    options.cloneDependency = {
      ...options.cloneDependency as Obj,
      unrelated: ['unrelated', 'unrelated-clone'],
    };
    const staged = stageRackedCopy(options);
    expect(staged.placement.position).toBe(3);
    expect(staged.cloneDependency['unrelated']).toEqual(['unrelated', 'unrelated-clone']);
    expect(staged.cloneDependency['server-1']).toEqual(['server-1']);
    expect(staged.cloneDependency['server-2']).toEqual(['server-2']);
  });

  it('rejects linked sources because browser Copy behavior for a Clone Multiple member is unverified', () => {
    const options = fixtureOptions();
    options.cloneDependency = { 'server-1': ['server-1', 'server-linked'], 'rack-1': ['rack-1'] };
    expect(() => stageRackedCopy(options)).toThrow(/linked Copy semantics are not captured/);
  });

  it('rejects an unnamed source instead of inventing browser fallback naming', () => {
    const options = fixtureOptions();
    delete ((options.rackArea[0]!['rackItems'] as Obj[])[0]!)['name'];
    expect(() => stageRackedCopy(options)).toThrow(/fallback hardware-label naming is not captured/);
  });

  it('uses the configuration name when the physical rack item is unnamed', () => {
    const options = fixtureOptions();
    delete ((options.rackArea[0]!['rackItems'] as Obj[])[0]!)['name'];
    const staged = stageRackedCopy({ ...options, sourceName: 'Server' });

    expect(staged.copyName).toBe('Copy_Server');
    expect((staged.rackArea[0]!['rackItems'] as Obj[])[1]).toMatchObject({
      id: 'server-2', name: 'Copy_Server', position: 2,
    });
  });

  it('inherits strict identity, nesting, and placement validation', () => {
    const collision = fixtureOptions();
    collision.copyId = 'rack-1';
    expect(() => stageRackedCopy(collision)).toThrow(/already exists/);

    const nested = fixtureOptions();
    ((nested.rackArea[0]!['rackItems'] as Obj[])[0]!)['children'] = [{ id: 'child' }];
    expect(() => stageRackedCopy(nested)).toThrow(/nested physical cloning/);

    const full = fixtureOptions();
    full.rackArea[0]!['size'] = 1;
    ((full.rackArea[0]!['rackItems'] as Obj[])[0]!)['highestPosition'] = 1;
    expect(() => stageRackedCopy(full)).toThrow(/authoritative placement is required/);
  });
});
