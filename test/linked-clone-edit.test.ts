import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  projectLinkedCloneResponse,
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
