import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { projectChassisManufacturing } from '../src/domain/chassisManufacturing.js';
import { serializeSections } from '../src/domain/dcscWire.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import type { RawConfiguration } from '../src/model/types.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/nested-manufacturing.json', import.meta.url), 'utf8')) as {
  configurations: RawConfiguration[]; expected: Record<string, unknown[]>;
};
const chassis = { id: 'chassis', type: 'chassis', chassisModel: 'dense', position: 1,
  nodes: [{ id: 'copy', type: 'node' }] };

it('matches native D3/SD535 export manufacturing sections without mutating canonical BOMs', () => {
  const before = structuredClone(fixture.configurations);
  const projected = projectChassisManufacturing({
    rackArea: [{ id: 'rack', rackItems: [chassis] }], nonRackArea: [{ id: 'source', type: 'node' }],
    configurations: fixture.configurations,
  });
  for (const raw of projected) {
    expect(serializeSections(raw).filter(section => section.name === 'MI_P')).toEqual(fixture.expected[raw.id!]);
  }
  expect(fixture.configurations).toEqual(before);
});

it('numbers independent chassis by position and restarts in each rack and loose area', () => {
  const configurations = ['a', 'b', 'c', 'd'].map(id => ({ ...structuredClone(fixture.configurations[0]!), id }));
  const make = (id: string, position: number) => ({ ...chassis, id, position });
  const result = projectChassisManufacturing({
    rackArea: [{ rackItems: [make('b', 8), make('a', 1)] }, { rackItems: [make('c', 5)] }],
    nonRackArea: [make('d', 1)], configurations,
  });
  expect(result.map(raw => serializeSections(raw).find(section => section.name === 'MI_P')?.results))
    .toEqual(['7501', '7502', '7501', '7501'].map(code => [{ code, quantity: 1 }]));
});

it('uses one group for equivalent linked chassis and counts physical children on each chassis', () => {
  const configurations = ['a', 'b', 'c'].map(id => ({ ...structuredClone(fixture.configurations[0]!), id }));
  const node = (id: string) => ({ id, type: 'node' });
  const result = projectChassisManufacturing({
    rackArea: [{ rackItems: [
      { ...chassis, id: 'a', position: 1, nodes: [node('n1'), node('n2')] },
      { ...chassis, id: 'b', position: 3, nodes: [node('n3'), node('n4')] },
      { ...chassis, id: 'c', position: 5, nodes: [node('n5')] },
    ] }], nonRackArea: [], configurations,
    cloneDependencyColor: { a: { dependBy: ['a', 'b', 'c'] }, n1: { dependBy: ['n1', 'n3'] }, n2: { dependBy: ['n2', 'n4'] } },
  });
  expect(result.map(raw => serializeSections(raw).find(section => section.name === 'MI_P')?.results))
    .toEqual([[{ code: '7501', quantity: 2 }], [{ code: '7501', quantity: 2 }], [{ code: '7502', quantity: 1 }]]);
});

it('removes stale group membership when a node is loose and never invents unavailable catalog codes', () => {
  const raw = structuredClone(fixture.configurations[1]!);
  const section = (raw.unSelectableCharacters as Array<Record<string, unknown>>)[0]!;
  section.results = [{ code: '7502', quantity: 1 }, { code: 'other', quantity: 2 }];
  section.features = [];
  const result = projectChassisManufacturing({ rackArea: [], nonRackArea: [{ id: 'source', type: 'node' }], configurations: [raw] });
  expect(serializeSections(result[0]!)[0]!.results).toEqual([{ code: 'other', quantity: 2 }]);
  const placed = projectChassisManufacturing({ rackArea: [{ rackItems: [{ ...chassis, nodes: [{ id: 'source', type: 'node' }] }] }],
    nonRackArea: [], configurations: [raw] });
  expect(serializeSections(placed[0]!)[0]!.results).toEqual([{ code: 'other', quantity: 2 }]);
});

it('uses the website hardware label for unnamed configurations and preserves chosen names', () => {
  for (const [type, label] of [['chassis', 'Chassis'], ['node', 'Node'], ['switch', 'Switch'], ['rack', 'Rack']] as const) {
    expect(reduceConfiguration({ type }, 'id').name).toBe(label);
    expect(reduceConfiguration({ type, name: 'User label' }, 'id').name).toBe('User label');
  }
});
