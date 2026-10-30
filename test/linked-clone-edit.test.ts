import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  projectLinkedCloneResponse,
  projectHpcLinkedResponses,
  resolveLinkedCloneGroup,
} from '../src/domain/linkedCloneEdit.js';
import type { RawConfiguration } from '../src/model/types.js';

const response = JSON.parse(readFileSync(new URL(
  './fixtures/parity/linked-clone-cpu-response.json', import.meta.url,
), 'utf8')) as RawConfiguration;

describe('linked clone edits', () => {
  it('resolves either member to the root while preserving accepted member order', () => {
    const dependency = {
      US__source: ['US__clone', 'US__source'],
      US__rack: ['US__rack'],
    };
    const ids = ['US__source', 'US__rack', 'US__clone'];

    expect(resolveLinkedCloneGroup(dependency, ids, 'US__source')).toEqual({
      rootId: 'US__source', memberIds: ['US__clone', 'US__source'], linked: true,
    });
    expect(resolveLinkedCloneGroup(dependency, ids, 'US__clone')).toEqual({
      rootId: 'US__source', memberIds: ['US__clone', 'US__source'], linked: true,
    });
    expect(resolveLinkedCloneGroup(dependency, ids, 'US__rack')).toEqual({
      rootId: 'US__rack', memberIds: ['US__rack'], linked: false,
    });
  });

  it('treats an unlisted configuration as an independent singleton', () => {
    expect(resolveLinkedCloneGroup(undefined, ['US__source'], 'US__source')).toEqual({
      rootId: 'US__source', memberIds: ['US__source'], linked: false,
    });
  });

  it('rejects ambiguous, incomplete and stale dependency maps', () => {
    const ids = ['US__source', 'US__clone'];
    expect(() => resolveLinkedCloneGroup({ US__source: ['US__clone'] }, ids, 'US__clone'))
      .toThrow(/does not include its root/);
    expect(() => resolveLinkedCloneGroup({ US__source: ['US__source', 'US__clone', 'US__clone'] }, ids, 'US__clone'))
      .toThrow(/duplicate configuration/);
    expect(() => resolveLinkedCloneGroup({
      US__source: ['US__source', 'US__clone'], US__clone: ['US__clone'],
    }, ids, 'US__clone')).toThrow(/multiple clone groups/);
    expect(() => resolveLinkedCloneGroup({ US__source: ['US__source', 'US__missing'] }, ids, 'US__source'))
      .toThrow(/unknown configuration/);
  });

  it('projects the single authoritative response to every explicit target in dependency order', () => {
    const group = {
      rootId: 'US__source', memberIds: ['US__clone', 'US__source'], linked: true,
    };

    const projected = projectLinkedCloneResponse(response, group);

    expect(projected.map(configuration => configuration.id)).toEqual(['US__clone', 'US__source']);
    expect(projected.map(configuration => configuration.workspaceId)).toEqual(['US__clone', 'US__source']);
    expect(projected.map(configuration => configuration.totalPrice)).toEqual([26415.51, 26415.51]);
    expect(projected.map(configuration => configuration.tabs?.[0]?.subTabs?.[0]?.sections?.[0]?.results?.[0]))
      .toEqual([
        expect.objectContaining({ code: 'BYW3', quantity: 2 }),
        expect.objectContaining({ code: 'BYW3', quantity: 2 }),
      ]);
    expect(response.id).toBe('US__source');
  });

  it('requires the response fan-out to exactly match the resolved group', () => {
    const group = {
      rootId: 'US__source', memberIds: ['US__clone', 'US__source'], linked: true,
    };
    expect(() => projectLinkedCloneResponse({ ...response, updateConfigurationIds: undefined }, group))
      .toThrow(/omitted updateConfigurationIds/);
    expect(() => projectLinkedCloneResponse({ ...response, updateConfigurationIds: ['US__source'] }, group))
      .toThrow(/do not match/);
    expect(() => projectLinkedCloneResponse({
      ...response, updateConfigurationIds: ['US__source', 'US__clone', 'US__extra'],
    }, group)).toThrow(/do not match/);
    expect(() => projectLinkedCloneResponse({
      ...response, updateConfigurationIds: ['US__source', 'US__source'],
    }, group)).toThrow(/duplicate/);
    expect(() => projectLinkedCloneResponse({ ...response, id: 'US__other' }, group))
      .toThrow(/outside clone group/);
  });
});


it('applies native fresh-HPC parent/node responses in order with complete target coverage', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/hpc-fresh-clone-edit.json', import.meta.url), 'utf8'));
  const responses: RawConfiguration[] = (fixture.responses as RawConfiguration[]).map(c => ({ ...c, tabs: [] }));
  const roots = [...new Set(responses.map(c => String(c.id)))];
  const nodeRoot = String(fixture.savedNode.id);
  const current: RawConfiguration[] = roots.flatMap(root => (fixture.cloneDependency[root] as string[]).map(id => ({
    ...responses.find(c => c.id === root)!, id,
  })));
  for (const ids of Object.values(fixture.cloneDependency) as string[][]) for (const id of ids) {
    if (!current.some(c => c.id === id)) current.push({ id, code: 'unrelated', type: 'server', tabs: [] });
  }
  const before = structuredClone(responses);
  const projected = projectHpcLinkedResponses(responses, current, fixture.cloneDependency, nodeRoot, new Set(roots));
  expect(projected).toHaveLength(4);
  for (const id of fixture.cloneDependency[nodeRoot]) {
    expect(projected.find(c => c.id === id)?.powerReportResponse).toEqual(fixture.savedNode.powerReportResponse);
  }
  expect(responses).toEqual(before);
  const subsetOnly = responses.filter(c => c.type !== 'node' || Array.isArray(c.updateConfigurationIds) && c.updateConfigurationIds.length === 1);
  expect(() => projectHpcLinkedResponses(subsetOnly, current, fixture.cloneDependency, nodeRoot, new Set(roots))).toThrow(/target union/);
  const foreign = structuredClone(responses);
  foreign[0]!.updateConfigurationIds = ['foreign'];
  expect(() => projectHpcLinkedResponses(foreign, current, fixture.cloneDependency, nodeRoot, new Set(roots))).toThrow(/foreign/);
  expect(() => projectHpcLinkedResponses(responses, current, fixture.cloneDependency, nodeRoot, new Set([nodeRoot]))).toThrow(/Unexpected/);
});

it('projects native root-only dependent child data only for an explicitly allowed chassis child group', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/hpc-linked-chassis-edit.json', import.meta.url), 'utf8'));
  const responses: RawConfiguration[] = fixture.responses.map((c: RawConfiguration) => ({ ...c, tabs: [] }));
  const parent = responses.find(c => c.type === 'chassis')!.id!;
  const child = responses.find(c => c.type === 'node')!.id!;
  const current = responses.flatMap(c => (fixture.cloneDependency[c.id!] as string[]).map(id => ({ ...c, id })));
  const allowed = new Set([parent, child]);
  expect(() => projectHpcLinkedResponses(responses, current, fixture.cloneDependency, parent, allowed)).toThrow(/target union/);
  const projected = projectHpcLinkedResponses(responses, current, fixture.cloneDependency, parent, allowed, new Set([child]));
  expect(projected).toHaveLength(4);
  for (const id of fixture.cloneDependency[child]) expect(projected.find(c => c.id === id)?.totalPrice).toBe(responses.find(c => c.id === child)!.totalPrice);
  const wrong = structuredClone(responses);
  wrong.find(c => c.id === child)!.updateConfigurationIds = [fixture.cloneDependency[child].find((id: string) => id !== child)];
  expect(() => projectHpcLinkedResponses(wrong, current, fixture.cloneDependency, parent, allowed, new Set([child]))).toThrow(/target union/);
  expect(() => projectHpcLinkedResponses(responses, current, fixture.cloneDependency, child, allowed, new Set([child]))).toThrow(/target union/);
});
