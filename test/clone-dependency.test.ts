import { expect, it } from 'vitest';
import { projectCloneDependency } from '../src/domain/cloneDependency.js';

it('preserves grouped identities and adds uncovered configurations without double ownership', () => {
  const accepted = { source: ['source', 'clone', 'removed'], rack: ['rack'], removedRoot: ['removedRoot'] };
  const before = structuredClone(accepted);
  expect(projectCloneDependency(accepted, ['source', 'clone', 'rack', 'switch']))
    .toEqual({ source: ['source', 'clone'], rack: ['rack'], switch: ['switch'] });
  expect(accepted).toEqual(before);
  expect(projectCloneDependency(undefined, ['source', 'rack'])).toEqual({ source: ['source'], rack: ['rack'] });
});

it('rejects malformed and overlapping clone identity groups', () => {
  expect(() => projectCloneDependency({ source: ['source', 'clone'], clone: ['clone'] }, ['source', 'clone']))
    .toThrow(/multiple clone groups/);
  expect(() => projectCloneDependency({ source: 'clone' }, ['source', 'clone'])).toThrow(/invalid members/);
  expect(() => projectCloneDependency([], ['source'])).toThrow(/object/);
});
