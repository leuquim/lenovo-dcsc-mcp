import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { cloneConfigurationRaw } from '../src/domain/configurationIdentity.js';
import { reconcileImportedCloneDependency } from '../src/domain/importCloneOwnership.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { removeWorkspaceReferences } from '../src/domain/workspaceReferences.js';
import { DcscService } from '../src/mcp/service.js';

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/linked-clone-root-delete.json', import.meta.url), 'utf8')) as {
  before: { cloneDependency: Record<string, string[]> };
  after: { cloneDependency: Record<string, string[]>; cloneDependencyColor: Record<string, unknown> };
};

function setup(dependency: Record<string, unknown>) {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
  const raw = { id: 'rack', code: 'RACK', type: 'rack', quantity: 1, tabs: [] };
  const rack = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw,
    configurationId: raw.id, reduced: reduceConfiguration(raw, raw.id), primed: true });
  const workspace = service.sessions.getWorkspace(rack.id)!;
  const sourceRaw = { id: 'server-root', code: 'SERVER', sliceCtoCode: 'SERVER', type: 'server',
    quantity: 1, tabs: [] };
  for (const configurationId of ['server-root', 'server-2', 'server-3']) {
    const serverRaw = configurationId === 'server-root'
      ? structuredClone(sourceRaw)
      : cloneConfigurationRaw(sourceRaw, 'server-root', configurationId);
    service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: serverRaw,
      configurationId, reduced: reduceConfiguration(serverRaw, configurationId), primed: true,
      workspaceId: workspace.id });
  }
  workspace.rackArea = [{ id: 'rack', code: 'RACK', type: 'rack', rackItems: [
    { id: 'server-root', code: 'SERVER', type: 'server', position: 1 },
    { id: 'server-2', code: 'SERVER', type: 'server', position: 2 },
    { id: 'server-3', code: 'SERVER', type: 'server', position: 3 },
  ] }];
  workspace.serverState.cloneDependency = structuredClone(dependency);
  workspace.serverState.cloneDependencyColor = {
    rack: { color: '#rack', dependBy: ['rack'], retained: 'rack-metadata' },
    'server-root': { color: '#33ebbb', darkColor: '#112233', dependBy: ['server-root', 'server-2', 'server-3'],
      retained: { future: true } },
  };
  workspace.serverState.linkedConfigurationEdits = {
    'server-root': [{ at: 1, members: ['server-root', 'server-2', 'server-3'] }],
    rack: [{ at: 2, members: ['rack'] }],
  };
  workspace.serverState.importCloneExpansion = [{
    sourceId: 'server-root',
    original: { id: 'server-root', quantity: 3, originalIds: ['server-root', 'server-2', 'server-3'] },
    ids: ['server-root', 'server-2', 'server-3'],
  }];
  return { workspace };
}

function removeConfiguration(workspace: ReturnType<typeof setup>['workspace'], configurationId: string): void {
  for (const [sessionId, session] of workspace.configurations) {
    if (session.configurationId === configurationId) workspace.configurations.delete(sessionId);
  }
}

function assertHistoricalExpansionRemainsUsable(workspace: ReturnType<typeof setup>['workspace']): void {
  const activeIds = new Set([...workspace.configurations.values()].map(session => session.configurationId));
  const dependency = workspace.serverState.cloneDependency as Record<string, string[]>;
  expect(reconcileImportedCloneDependency({
    dependency,
    colors: workspace.serverState.cloneDependencyColor as Record<string, unknown>,
    provenance: workspace.serverState.importCloneExpansion,
    activeConfigurationIds: activeIds,
    storageRoots: new Set(),
    configurations: [...workspace.configurations.values()],
  })).toEqual(dependency);
  expect(() => buildExportData({ workspace, solution: workspace.solution,
    fileTypes: ['XML'], validationMode: 'guided' })).not.toThrow();
}

describe('removeWorkspaceReferences Clone Multiple ownership', () => {
  it('promotes the first survivor and matches the three-member browser contract', () => {
    const { workspace } = setup(fixture.before.cloneDependency);
    const provenance = structuredClone(workspace.serverState.importCloneExpansion);
    removeConfiguration(workspace, 'server-root');
    removeWorkspaceReferences(workspace, new Set(['server-root']));

    expect(workspace.serverState.cloneDependency).toEqual(fixture.after.cloneDependency);
    expect(workspace.serverState.cloneDependencyColor).toEqual({
      rack: { color: '#rack', dependBy: ['rack'], retained: 'rack-metadata' },
      'server-2': { color: '#33ebbb', darkColor: '#112233', dependBy: ['server-2', 'server-3'],
        retained: { future: true } },
    });
    expect(workspace.serverState.linkedConfigurationEdits).toEqual({ rack: [{ at: 2, members: ['rack'] }] });
    expect((workspace.rackArea[0]?.rackItems as Array<{ id?: string }>).map(item => item.id))
      .toEqual(['server-2', 'server-3']);
    expect(workspace.serverState.importCloneExpansion).toEqual(provenance);
    assertHistoricalExpansionRemainsUsable(workspace);
  });

  it('retains a singleton when only one member survives', () => {
    const { workspace } = setup(fixture.before.cloneDependency);
    removeWorkspaceReferences(workspace, new Set(['server-root', 'server-3']));
    expect(workspace.serverState.cloneDependency).toEqual({ rack: ['rack'], 'server-2': ['server-2'] });
    expect(workspace.serverState.cloneDependencyColor).toMatchObject({
      'server-2': { dependBy: ['server-2'], retained: { future: true } },
    });
  });

  it('keeps the root when deleting a member and invalidates that group edit history', () => {
    const { workspace } = setup(fixture.before.cloneDependency);
    const provenance = structuredClone(workspace.serverState.importCloneExpansion);
    removeConfiguration(workspace, 'server-2');
    removeWorkspaceReferences(workspace, new Set(['server-2']));
    expect(workspace.serverState.cloneDependency).toEqual({
      rack: ['rack'], 'server-root': ['server-root', 'server-3'],
    });
    expect(workspace.serverState.cloneDependencyColor).toMatchObject({
      'server-root': { dependBy: ['server-root', 'server-3'] },
    });
    expect(workspace.serverState.linkedConfigurationEdits).toEqual({ rack: [{ at: 2, members: ['rack'] }] });
    expect(workspace.serverState.importCloneExpansion).toEqual(provenance);
    assertHistoricalExpansionRemainsUsable(workspace);
  });

  it('drops a dependency, color, and edit history when its whole group is removed', () => {
    const { workspace } = setup(fixture.before.cloneDependency);
    removeWorkspaceReferences(workspace, new Set(['server-root', 'server-2', 'server-3']));
    expect(workspace.serverState.cloneDependency).toEqual({ rack: ['rack'] });
    expect(workspace.serverState.cloneDependencyColor).toEqual({
      rack: { color: '#rack', dependBy: ['rack'], retained: 'rack-metadata' },
    });
    expect(workspace.serverState.linkedConfigurationEdits).toEqual({ rack: [{ at: 2, members: ['rack'] }] });
  });

  it('rejects promotion collisions before detaching any physical item', () => {
    const dependency = {
      'server-root': ['server-root', 'server-2'],
      'server-2': ['server-2', 'server-3'],
      rack: ['rack'],
    };
    const { workspace } = setup(dependency);
    const before = structuredClone({ rackArea: workspace.rackArea, serverState: workspace.serverState });
    expect(() => removeWorkspaceReferences(workspace, new Set(['server-root']))).toThrow(/promoted clone root server-2 conflicts/);
    expect({ rackArea: workspace.rackArea, serverState: workspace.serverState }).toEqual(before);
  });
});
