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

  it('preserves the original group root when copying either its root or member', () => {
    const options = fixtureOptions();
    options.cloneDependency = { 'server-1': ['server-1', 'server-linked'], 'rack-1': ['rack-1'] };
    const result = stageRackedCopy(options);
    expect(result.cloneDependency['server-1']).toEqual(['server-1', 'server-linked']);
    expect(result.cloneDependency['server-2']).toEqual(['server-2']);
    options.cloneDependency = { root: ['root', 'server-1'], 'rack-1': ['rack-1'] };
    const member = stageRackedCopy(options);
    expect(member.cloneDependency['root']).toEqual(['root', 'server-1']);
    expect(member.cloneDependency['server-1']).toBeUndefined();
    expect(member.cloneDependency['server-2']).toEqual(['server-2']);
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


describe('captured populated chassis Copy staging', () => {
  it('copies parent and child names and breaks both temporary clone links', () => {
    const native = JSON.parse(readFileSync(new URL('./fixtures/parity/chassis-copy-native.json', import.meta.url), 'utf8'));
    const clone = JSON.parse(readFileSync(new URL('./fixtures/parity/chassis-clone-multiple.json', import.meta.url), 'utf8'));
    const original = native.before[0].rackItems[0];
    const copied = native.request[0].rackItems[1];
    const nodeId = original.nodes[0].id;
    const childId = copied.nodes[0].id;
    const options = {
      rackArea: clone.rackArea as RackObject[], nonRackArea: [], sourceId: original.id,
      copyId: copied.id, cloneDependency: native.requestCloneDependency,
      childCloneIds: { [copied.id]: { [nodeId]: childId } },
    };
    const before = structuredClone(options);
    const result = stageRackedCopy(options);
    const items = result.rackArea[0]!['rackItems'] as Obj[];
    expect(items[1]).toMatchObject(copied);
    expect(result.cloneDependency[original.id]).toEqual([original.id]);
    expect(result.cloneDependency[copied.id]).toEqual([copied.id]);
    expect(result.cloneDependency[nodeId]).toEqual([nodeId]);
    expect(result.cloneDependency[childId]).toEqual([childId]);
    expect(options).toEqual(before);
    expect(() => stageRackedCopy({ ...options, childCloneIds: {} })).toThrow();
    const linked = stageRackedCopy({ ...options, cloneDependency: {
      ...options.cloneDependency, [nodeId]: [nodeId, 'linked-node'],
    } });
    expect(linked.cloneDependency[nodeId]).toEqual([nodeId, 'linked-node']);
    expect(linked.cloneDependency[childId]).toEqual([childId]);
  });
});

it.each([{ file: 'chassis-linked-copy-native.json', sourceIndex: 0 },
  { file: 'chassis-member-copy-native.json', sourceIndex: 1 }])('matches native $file without splitting either original group', ({ file, sourceIndex }) => {
  const fixture = JSON.parse(readFileSync(new URL(`./fixtures/parity/${file}`, import.meta.url), 'utf8'));
  const source = fixture.before[0].rackItems[sourceIndex];
  const copy = fixture.request[0].rackItems[2];
  const options = { rackArea: fixture.before as RackObject[], nonRackArea: [], sourceId: source.id,
    copyId: copy.id, cloneDependency: fixture.requestCloneDependency,
    childCloneIds: { [copy.id]: { [source.nodes[0].id]: copy.nodes[0].id } } };
  const before = structuredClone(options);
  const result = stageRackedCopy(options);
  expect((result.rackArea[0]!['rackItems'] as Obj[])[2]).toMatchObject(copy);
  for (const [root, members] of Object.entries(fixture.requestCloneDependency)) expect(result.cloneDependency[root]).toEqual(members);
  expect(result.cloneDependency[copy.id]).toEqual([copy.id]);
  expect(result.cloneDependency[copy.nodes[0].id]).toEqual([copy.nodes[0].id]);
  expect(options).toEqual(before);
});
