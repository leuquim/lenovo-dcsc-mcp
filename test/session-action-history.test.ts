import { describe, expect, it, vi } from 'vitest';
import type { ActionHistoryFactory } from '../src/domain/actionHistory.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { serializeWorkspaces } from '../src/session/persist.js';
import { SessionStore, type CreateSessionInput } from '../src/session/SessionStore.js';
import type { WorkspaceSession } from '../src/model/session.js';

function input(id = 'US__history'): CreateSessionInput {
  const raw = { id, sliceCtoCode: '7D73CTO1WW', description: 'Server', type: 'SERVER', quantity: 1, tabs: [] };
  return {
    locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
    solution: { solutionMode: 'HPC and AI - Systems', masterSlices: ['HPC'] },
    mode: 'cto', raw, configurationId: id, reduced: reduceConfiguration(raw, id), primed: true,
  };
}

const action: ActionHistoryFactory = () => ({ command: 'UPDATE', quantity: 1, type: 'SERVER',
  code: '7D73CTO1WW', description: 'Server', location: 'Non Rack Area' });
const rows = (workspace: WorkspaceSession) => workspace.serverState.historyInformation as unknown[] | undefined;

describe('durable native action history', () => {
  it('commits records with the accepted candidate and survives persisted restoration and branching', async () => {
    const store = new SessionStore();
    const session = store.create(input());
    const workspace = store.getWorkspace(session.id)!;
    let persisted = '';
    store.setPersistenceWriter(candidate => {
      expect(rows(workspace)).toBeUndefined();
      expect(rows(candidate[0]!)).toHaveLength(1);
      persisted = serializeWorkspaces(candidate);
    });
    await store.transact(session.id, { actionHistory: action }, (_workspace, target) => { target!.raw.quantity = 2; });
    const first = structuredClone(rows(workspace));
    expect(first).toHaveLength(1);

    const restored = new SessionStore();
    expect(restored.restore((JSON.parse(persisted) as { workspaces: unknown[] }).workspaces)).toBe(1);
    const restoredWorkspace = restored.getWorkspace(workspace.id)!;
    expect(rows(restoredWorkspace)).toEqual(first);
    expect(await restored.undoWorkspace(workspace.id)).toBe(true);
    expect(rows(restoredWorkspace)).toBeUndefined();
    expect(await restored.redoWorkspace(workspace.id)).toBe(true);
    expect(rows(restoredWorkspace)).toEqual(first);
    await restored.undoWorkspace(workspace.id);
    await restored.transact(session.id, { actionHistory: action }, (_workspace, target) => { target!.raw.quantity = 3; });
    expect(rows(restoredWorkspace)).toHaveLength(1);
    expect(rows(restoredWorkspace)).not.toEqual(first);
    expect(await restored.redoWorkspace(workspace.id)).toBe(false);
  });

  it.each(['stale', 'rejected', 'invalid', 'disk', 'noop'] as const)(
    'preserves complete published state for a %s operation', async failure => {
      const store = new SessionStore();
      const session = store.create(input());
      const workspace = store.getWorkspace(session.id)!;
      const before: unknown = JSON.parse(serializeWorkspaces([workspace])).workspaces;
      const factory = vi.fn(action);
      if (failure === 'disk') store.setPersistenceWriter(() => { throw new Error('disk full'); });
      const operation = store.transact(session.id, {
        actionHistory: factory, ...(failure === 'stale' ? { expectedRevision: 99 } : {}),
      }, (_workspace, target) => {
        if (failure === 'noop') return;
        target!.raw.quantity = 2;
        if (failure === 'rejected') throw new Error('accepted layout differs from requested layout');
        if (failure === 'invalid') target!.configurationId = '';
      });
      if (failure === 'noop') await operation;
      else await expect(operation).rejects.toThrow();
      expect(JSON.parse(serializeWorkspaces([workspace])).workspaces).toEqual(before);
      if (['stale', 'rejected', 'noop'].includes(failure)) expect(factory).not.toHaveBeenCalled();
    },
  );

  it('includes creation events in the first durable candidate and existing-workspace additions', async () => {
    const store = new SessionStore();
    const add: ActionHistoryFactory = () => ({ command: 'ADD', quantity: 1, type: 'SERVER',
      code: '7D73CTO1WW', description: 'Server', location: 'Non Rack Area' });
    const writes: string[] = [];
    store.setPersistenceWriter(candidate => { writes.push(serializeWorkspaces(candidate)); });
    const created = await store.createManyAtomic([input()], { actionHistory: add });
    expect(rows(created.workspace)).toHaveLength(1);
    expect(JSON.parse(writes[0]!).workspaces[0].serverState.historyInformation).toEqual(rows(created.workspace));
    await store.createManyAtomic([input('US__second')], { workspaceHandle: created.workspace.id, actionHistory: add });
    expect(rows(created.workspace)).toHaveLength(2);
    expect(writes).toHaveLength(2);
  });

  it('never publishes creation records when persistence fails', async () => {
    const store = new SessionStore();
    store.setPersistenceWriter(() => { throw new Error('disk full'); });
    await expect(store.createManyAtomic([input()], { newWorkspaceId: 'ws_history_failure', actionHistory: action })).rejects.toThrow();
    expect(store.getWorkspace('ws_history_failure')).toBeUndefined();
  });

  it('rejects a history writer during restoration before invoking the callback', async () => {
    const store = new SessionStore();
    const session = store.create(input());
    const callback = vi.fn();
    await expect(store.transact(session.id, { history: 'restore', actionHistory: action }, callback))
      .rejects.toThrow('History restoration cannot append action history');
    expect(callback).not.toHaveBeenCalled();
  });
});
