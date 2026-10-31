import { describe, expect, it } from 'vitest';

import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { SessionStore, type WorkspaceSession } from '../src/session/SessionStore.js';
import { cloneConfigurationRaw } from '../src/domain/configurationIdentity.js';

const locale = { country: 'US', geo: 'NA', language: 'en', currency: 'USD' };
const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };

function workspaceWith(ids: string[]): WorkspaceSession {
  const sessions = new SessionStore();
  let workspaceId: string | undefined;
  const sourceId = ids[0]!;
  const sourceRaw = {
    id: sourceId, workspaceId: sourceId, sliceCtoCode: '7D73CTO1WW', code: '7D73CTO1WW',
    type: 'server', name: 'Server', quantity: 1,
    tabs: [{ subTabs: [{ info: ['Current diagnostic'], sections: [{
      name: 'Memory',
      results: [{ code: 'MEMORY-OPTION', quantity: 1, price: 25 }],
    }] }] }],
  };
  for (const id of ids) {
    const raw = id === sourceId ? structuredClone(sourceRaw) : cloneConfigurationRaw(sourceRaw, sourceId, id);
    const session = sessions.create({ locale, solution, mode: 'cto', raw, configurationId: id,
      reduced: reduceConfiguration(raw, id), primed: true, ...(workspaceId ? { workspaceId } : {}) });
    workspaceId = session.workspaceId;
  }
  const workspace = sessions.getWorkspace(workspaceId!)!;
  workspace.nonRackArea = ids.map(id => ({ id, code: '7D73CTO1WW', type: 'server', size: 1, quantity: 1 }));
  return workspace;
}

function exportWorkspace(workspace: WorkspaceSession): Record<string, unknown> {
  return buildExportData({ workspace, solution, fileTypes: ['XML', 'MESSAGE_HISTORY'], validationMode: 'guided' });
}

function color(root: string, dependBy: string[]): Record<string, unknown> {
  return { color: '#123456', darkColor: '#012345', dependBy,
    colorRGB: { r: 18, g: 52, b: 86 }, darkColorRGB: { r: 1, g: 35, b: 69 }, root };
}

describe('workspace export clone dependency/color consistency', () => {
  it('repairs the proven legacy compressed-import singleton graph without double-owning clone members', () => {
    const ids = ['root', 'clone-a', 'clone-b', 'clone-c'];
    const workspace = workspaceWith(ids);
    workspace.serverState = {
      cloneDependency: Object.fromEntries(ids.map(id => [id, [id]])),
      cloneDependencyColor: Object.fromEntries([
        ['root', color('root', ids)],
        ...ids.slice(1).map(id => [id, color(id, [id])] as const),
      ]),
      importCloneExpansion: [{ sourceId: 'root', original: { id: 'root', quantity: 4, originalIds: ids }, ids }],
    };
    const before = structuredClone({
      serverState: workspace.serverState,
      configurations: [...workspace.configurations.values()].map(session => session.raw),
    });

    const exported = exportWorkspace(workspace);

    expect((exported.workspaceInformation as Record<string, unknown>).cloneDependency).toEqual({ root: ids });
    expect((exported.workspace as Record<string, unknown>).nonRackArea).toEqual([
      expect.objectContaining({ id: 'root', quantity: 4, originalIds: ids }),
    ]);
    expect(((exported.workspaceInformation as Record<string, unknown>).nonRackData as unknown[])).toHaveLength(4);
    expect(Object.keys(exported.cloneDependencyColor as Record<string, unknown>)).toEqual(['root']);
    expect((exported.cloneDependencyColor as Record<string, Record<string, unknown>>).root?.dependBy).toEqual(ids);
    const report = (exported.messageHistory as Record<string, Record<string, unknown>>).validationReport;
    expect(Object.keys(report?.info as Record<string, unknown>)).toEqual(['root']);
    expect({
      serverState: workspace.serverState,
      configurations: [...workspace.configurations.values()].map(session => session.raw),
    }).toEqual(before);
  });

  it('refuses an unracked multi-unit configuration the website cannot reopen', () => {
    const workspace = workspaceWith(['only']);
    for (const session of workspace.configurations.values()) session.raw.quantity = 3;
    expect(() => exportWorkspace(workspace)).toThrow(/quantity 3 but is not in a rack/);
  });

  it('keeps genuinely independent singleton configurations independent', () => {
    const ids = ['first', 'second'];
    const workspace = workspaceWith(ids);
    workspace.serverState = {
      cloneDependency: { first: ['first'], second: ['second'] },
      cloneDependencyColor: { first: color('first', ['first']), second: color('second', ['second']) },
    };

    const exported = exportWorkspace(workspace);

    expect((exported.workspaceInformation as Record<string, unknown>).cloneDependency)
      .toEqual({ first: ['first'], second: ['second'] });
    expect(Object.keys(exported.cloneDependencyColor as Record<string, unknown>)).toEqual(['first', 'second']);
    expect(((exported.workspace as Record<string, unknown>).nonRackArea as unknown[])).toHaveLength(2);
  });

  it('keeps ship-uninstalled linked copies in a separate slim hierarchy group', () => {
    const ids = ['root', 'clone'];
    const workspace = workspaceWith(ids);
    workspace.nonRackArea[1]!.shipUninstalled = true;
    workspace.serverState = {
      cloneDependency: { root: ids },
      cloneDependencyColor: { root: color('root', ids) },
    };

    const exported = exportWorkspace(workspace);
    const slim = (exported.workspace as Record<string, unknown>).nonRackArea as Array<Record<string, unknown>>;

    expect(slim).toEqual([
      expect.objectContaining({ id: 'root', quantity: 1, originalIds: ['root'] }),
      expect.objectContaining({ id: 'clone', quantity: 1, originalIds: ['clone'] }),
    ]);
  });

  it('groups cloned chassis when their sorted child-root multiplicities match', () => {
    const chassisIds = ['chassis-root', 'chassis-clone'];
    const nodeIds = ['node-root', 'node-a', 'node-b', 'node-c'];
    const workspace = workspaceWith([...chassisIds, ...nodeIds]);
    workspace.nonRackArea = [
      { id: 'chassis-root', code: 'CHASSIS', type: 'chassis', size: 2, nodes: [
        { id: 'node-root', code: 'NODE', type: 'node', occupiedBay: 1 },
        { id: 'node-a', code: 'NODE', type: 'node', occupiedBay: 1 },
      ] },
      { id: 'chassis-clone', code: 'CHASSIS', type: 'chassis', size: 2, nodes: [
        { id: 'node-b', code: 'NODE', type: 'node', occupiedBay: 1 },
        { id: 'node-c', code: 'NODE', type: 'node', occupiedBay: 1 },
      ] },
    ];
    workspace.serverState = {
      cloneDependency: {
        'chassis-root': chassisIds,
        'node-root': nodeIds,
      },
      cloneDependencyColor: {
        'chassis-root': color('chassis-root', chassisIds),
        'node-root': color('node-root', nodeIds),
      },
    };

    const exported = exportWorkspace(workspace);
    const slim = (exported.workspace as Record<string, unknown>).nonRackArea as Array<Record<string, unknown>>;

    expect(slim).toEqual([
      expect.objectContaining({
        id: 'chassis-root', quantity: 2, originalIds: chassisIds,
        children: [expect.objectContaining({ id: 'node-root', quantity: 2, originalIds: nodeIds })],
      }),
    ]);
  });

  it('projects an accepted linked dependency and removes stale singleton member colors', () => {
    const ids = ['root', 'clone-a', 'clone-b'];
    const workspace = workspaceWith(ids);
    workspace.serverState = {
      cloneDependency: { root: ids },
      cloneDependencyColor: {
        root: color('root', ['root']),
        'clone-a': color('clone-a', ['clone-a']),
        'clone-b': color('clone-b', ['clone-b']),
      },
    };

    const exported = exportWorkspace(workspace);

    expect((exported.workspaceInformation as Record<string, unknown>).cloneDependency).toEqual({ root: ids });
    expect(exported.cloneDependencyColor).toEqual({ root: { ...color('root', ['root']), dependBy: ids } });
  });

  it('fails closed for an unproven multi-member color over independent dependency roots', () => {
    const workspace = workspaceWith(['root', 'other']);
    workspace.serverState = {
      cloneDependency: { root: ['root'], other: ['other'] },
      cloneDependencyColor: { root: color('root', ['root', 'other']) },
    };

    expect(() => exportWorkspace(workspace)).toThrow(/color root conflicts with the active dependency group/i);
  });

  it('does not relink legacy imported singletons after a member configuration diverges', () => {
    const ids = ['root', 'clone'];
    const workspace = workspaceWith(ids);
    const clone = [...workspace.configurations.values()].find(session => session.configurationId === 'clone')!;
    clone.raw.tabs![0]!.subTabs![0]!.sections![0]!.results![0]!.quantity = 2;
    clone.raw.totalPrice = 1;
    workspace.serverState = {
      cloneDependency: { root: ['root'], clone: ['clone'] },
      cloneDependencyColor: { root: color('root', ids), clone: color('clone', ['clone']) },
      importCloneExpansion: [{ sourceId: 'root', original: { id: 'root', quantity: 2, originalIds: ids }, ids }],
    };
    const before = structuredClone(workspace.serverState);

    expect(() => exportWorkspace(workspace)).toThrow(/diverged configuration state and cannot be relinked safely/i);
    expect(workspace.serverState).toEqual(before);
  });

  it('rejects malformed legacy expansion provenance without changing workspace state', () => {
    const ids = ['root', 'clone'];
    const workspace = workspaceWith(ids);
    workspace.serverState = {
      cloneDependency: { root: ['root'], clone: ['clone'] },
      cloneDependencyColor: { root: color('root', ids), clone: color('clone', ['clone']) },
      importCloneExpansion: [{
        sourceId: 'root',
        original: { id: 'another-root', quantity: 2, originalIds: ids },
        ids,
      }],
    };
    const before = structuredClone(workspace.serverState);

    expect(() => exportWorkspace(workspace)).toThrow(/provenance is malformed/i);
    expect(workspace.serverState).toEqual(before);
  });

  it('rejects an invalid present dependBy list rather than treating it as absent', () => {
    const workspace = workspaceWith(['root']);
    workspace.serverState = {
      cloneDependency: { root: ['root'] },
      cloneDependencyColor: { root: color('root', ['root', 'root']) },
    };
    const before = structuredClone(workspace.serverState);

    expect(() => exportWorkspace(workspace)).toThrow(/invalid dependBy ownership/i);
    expect(workspace.serverState).toEqual(before);
  });

  it('fails closed instead of discarding a second overlapping multi-member color', () => {
    const workspace = workspaceWith(['root', 'clone']);
    workspace.serverState = {
      cloneDependency: { root: ['root', 'clone'] },
      cloneDependencyColor: {
        root: color('root', ['root', 'clone']),
        clone: color('clone', ['clone', 'root']),
      },
    };

    expect(() => exportWorkspace(workspace)).toThrow(/overlaps active dependency group root/i);
  });
});
