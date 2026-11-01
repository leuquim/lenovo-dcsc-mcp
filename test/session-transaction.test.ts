import { describe, expect, it } from 'vitest';

import { reduceConfiguration } from '../src/domain/reduce.js';
import { loadValidationJobs, type ValidationJob } from '../src/domain/validationJobs.js';
import type { RawConfiguration } from '../src/model/types.js';
import { SessionConflictError, SessionStore, type CreateSessionInput } from '../src/session/SessionStore.js';
import type { ConfigSession } from '../src/model/session.js';

const locale = { country: 'US', geo: 'NA', language: 'en', currency: 'USD' } as const;
const solution = { solutionMode: 'General Purpose', masterSlices: ['ISG'] };

function addSession(store: SessionStore, workspaceId?: string): ConfigSession {
  const configurationId = `US__${Math.random().toString(16).slice(2)}`;
  const raw: RawConfiguration = {
    id: configurationId,
    sliceCtoCode: '7D73CTO1WW',
    description: 'ThinkSystem SR630 V3',
    type: 'SERVER',
    quantity: 1,
    tabs: [],
  };
  return store.create({
    locale,
    solution,
    mode: 'cto',
    raw,
    configurationId,
    reduced: reduceConfiguration(raw, configurationId),
    primed: true,
    ...(workspaceId ? { workspaceId } : {}),
  });
}

function createInput(configurationId: string, workspaceId?: string): CreateSessionInput {
  const raw: RawConfiguration = {
    id: configurationId,
    sliceCtoCode: '7D73CTO1WW',
    description: 'ThinkSystem SR630 V3',
    type: 'SERVER',
    quantity: 1,
    tabs: [],
  };
  return {
    locale,
    solution,
    mode: 'cto',
    raw,
    configurationId,
    reduced: reduceConfiguration(raw, configurationId),
    primed: true,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

function validationJob(id: string, status: ValidationJob['status'] = 'pending'): ValidationJob {
  return {
    version: 1,
    id,
    payloadSha256: id.padEnd(64, 'a').slice(0, 64),
    validatedRevision: 1,
    mode: 'cto',
    status,
    terminal: status === 'valid' || status === 'invalid',
    freshValidationRequired: status === 'unavailable',
    descriptors: status === 'pending' ? [{ uuid: id }] : [],
    startedAt: 100,
  };
}

describe('SessionStore transactions', () => {
  it('durably records validation metadata without revision/history changes', async () => {
    const store = new SessionStore();
    const session = addSession(store);
    const workspace = store.getWorkspace(session.id);
    if (!workspace) throw new Error('missing workspace');
    const workspaceRevision = workspace.revision;
    const sessionRevision = session.revision;
    const history = structuredClone(workspace.history);
    const lastAccessAt = workspace.lastAccessAt;
    let writes = 0;
    store.setPersistenceWriter((candidate) => {
      writes += 1;
      const persisted = candidate.find((entry) => entry.id === workspace.id);
      expect(loadValidationJobs(persisted?.serverState ?? {})).toHaveLength(1);
      expect(loadValidationJobs(workspace.serverState)).toHaveLength(0);
    });

    await store.recordValidationJob(session.id, validationJob('job-one'));

    expect(writes).toBe(1);
    expect(loadValidationJobs(workspace.serverState)).toHaveLength(1);
    expect(workspace.revision).toBe(workspaceRevision);
    expect(session.revision).toBe(sessionRevision);
    expect(workspace.history).toEqual(history);
    expect(workspace.lastAccessAt).toBe(lastAccessAt);
  });

  it('does not publish a validation job when durable persistence fails', async () => {
    const store = new SessionStore();
    const session = addSession(store);
    const workspace = store.getWorkspace(session.id);
    if (!workspace) throw new Error('missing workspace');
    store.setPersistenceWriter(() => { throw new Error('validation disk full'); });

    await expect(store.recordValidationJob(session.id, validationJob('job-failed')))
      .rejects.toMatchObject({
        name: 'SessionPersistenceError',
        cause: expect.objectContaining({ message: 'validation disk full' }),
      });
    expect(loadValidationJobs(workspace.serverState)).toEqual([]);
  });

  it('serializes jobs with content edits and keeps metadata through replace, undo, and redo', async () => {
    const store = new SessionStore();
    const session = addSession(store);
    const workspace = store.getWorkspace(session.id);
    if (!workspace) throw new Error('missing workspace');
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const content = store.transact(session.id, {}, async (draft) => {
      entered?.();
      await blocked;
      draft.serverState = { content: 'new' };
    });
    await started;
    const metadata = store.recordValidationJob(workspace.id, validationJob('job-concurrent'));
    release?.();
    await Promise.all([content, metadata]);

    expect(workspace.serverState['content']).toBe('new');
    expect(loadValidationJobs(workspace.serverState).map((job) => job.id)).toEqual(['job-concurrent']);
    await store.transact(workspace.id, {}, (draft) => { draft.serverState = { content: 'newer' }; });
    expect(loadValidationJobs(workspace.serverState)).toHaveLength(1);
    expect(await store.undoWorkspace(workspace.id)).toBe(true);
    expect(workspace.serverState['content']).toBe('new');
    expect(loadValidationJobs(workspace.serverState)).toHaveLength(1);
    expect(await store.redoWorkspace(workspace.id)).toBe(true);
    expect(workspace.serverState['content']).toBe('newer');
    expect(loadValidationJobs(workspace.serverState)).toHaveLength(1);
  });

  it('discards callback and persistence failures without changing live state', async () => {
    const store = new SessionStore();
    const session = addSession(store);
    const workspace = store.getWorkspace(session.id);
    if (!workspace) throw new Error('missing workspace');
    const before = structuredClone(session.raw);
    const revision = session.revision;

    await expect(
      store.transact(session.id, {}, (draft, target) => {
        if (!target) throw new Error('missing target');
        target.raw.quantity = 4;
        draft.serverState['changed'] = true;
        throw new Error('remote rejected candidate');
      }),
    ).rejects.toThrow('remote rejected candidate');
    expect(session.raw).toEqual(before);
    expect(session.revision).toBe(revision);
    expect(workspace.serverState).toEqual({});

    store.setPersistenceWriter(() => {
      throw new Error('disk full');
    });
    await expect(
      store.transact(session.id, {}, (_draft, target) => {
        if (target) target.raw.quantity = 8;
      }),
    ).rejects.toMatchObject({
      name: 'SessionPersistenceError',
      cause: expect.objectContaining({ message: 'disk full' }),
    });
    expect(session.raw).toEqual(before);
    expect(session.revision).toBe(revision);
  });

  it('publishes one pristine snapshot and rebuilt views while retaining references', async () => {
    const store = new SessionStore();
    const session = addSession(store);
    const workspace = store.getWorkspace(session.id);
    if (!workspace) throw new Error('missing workspace');
    const originalRaw = structuredClone(session.raw);
    const sessionRevision = session.revision;
    const workspaceRevision = workspace.revision;

    await store.transact(session.id, { expectedRevision: sessionRevision }, (_draft, target) => {
      if (!target) throw new Error('missing target');
      target.raw.quantity = 4;
      // Derived edits are ignored; accepted canonical raw is authoritative.
      target.reduced.quantity = 999;
    });

    expect(store.get(session.id)).toBe(session);
    expect(store.getWorkspace(workspace.id)).toBe(workspace);
    expect(session.raw.quantity).toBe(4);
    expect(session.reduced.quantity).toBe(4);
    expect(session.revision).toBe(sessionRevision + 1);
    expect(workspace.revision).toBe(workspaceRevision + 1);
    expect(session.snapshots).toHaveLength(1);
    expect(session.snapshots[0]?.raw).toEqual(originalRaw);
    session.raw.quantity = 9;
    expect(session.snapshots[0]?.raw.quantity).toBe(1);
  });

  it('accepts exactly one concurrent write for one expected configuration revision', async () => {
    const store = new SessionStore();
    const session = addSession(store);
    const expectedRevision = session.revision;
    const mutate = (quantity: number) =>
      store.transact(session.id, { expectedRevision }, async (_draft, target) => {
        await Promise.resolve();
        if (target) target.raw.quantity = quantity;
        return quantity;
      });

    const results = await Promise.allSettled([mutate(2), mutate(3)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(
      SessionConflictError,
    );
    expect(session.revision).toBe(expectedRevision + 1);
  });

  it('preserves an undo callback history edit and treats empty undo as a no-op', async () => {
    const store = new SessionStore();
    const session = addSession(store);
    await store.transact(session.id, {}, (_draft, target) => {
      if (target) target.raw.quantity = 4;
    });
    const revisionAfterChange = session.revision;
    const workspace = store.getWorkspace(session.id);
    if (!workspace) throw new Error('missing workspace');

    const undone = await store.transact(
      session.id,
      { history: 'restore' },
      (_draft, target) => {
        if (!target) return false;
        const snapshot = target.snapshots.pop();
        if (!snapshot) return false;
        target.raw = structuredClone(snapshot.raw);
        return true;
      },
    );
    expect(undone).toBe(true);
    expect(session.raw.quantity).toBe(1);
    expect(session.snapshots).toHaveLength(0);
    expect(session.revision).toBe(revisionAfterChange + 1);

    const workspaceRevision = workspace.revision;
    const noUndo = await store.transact(
      session.id,
      { history: 'restore' },
      (_draft, target) => Boolean(target?.snapshots.pop()),
    );
    expect(noUndo).toBe(false);
    expect(session.revision).toBe(revisionAfterChange + 1);
    expect(workspace.revision).toBe(workspaceRevision);
  });

  it('undoes and redoes complete workspace snapshots with monotonic revisions', async () => {
    const store = new SessionStore();
    const session = addSession(store);
    const workspace = store.getWorkspace(session.id);
    if (!workspace) throw new Error('missing workspace');
    await store.transact(workspace.id, {}, (draft) => {
      draft.serverState = { marker: 'first' };
      const target = draft.configurations.get(session.id);
      if (target) target.raw.quantity = 2;
    });
    await store.transact(workspace.id, {}, (draft) => {
      draft.serverState = { marker: 'second' };
      const target = draft.configurations.get(session.id);
      if (target) target.raw.quantity = 3;
    });
    const beforeUndo = workspace.revision;

    expect(await store.undoWorkspace(workspace.id, beforeUndo)).toBe(true);
    expect(workspace.serverState).toEqual({ marker: 'first' });
    expect(session.raw.quantity).toBe(2);
    expect(workspace.revision).toBe(beforeUndo + 1);

    expect(await store.redoWorkspace(workspace.id, workspace.revision)).toBe(true);
    expect(workspace.serverState).toEqual({ marker: 'second' });
    expect(session.raw.quantity).toBe(3);
    expect(workspace.revision).toBe(beforeUndo + 2);
  });

  it('retains an intentionally empty workspace for undo while ordinary close deletes it', async () => {
    const store = new SessionStore();
    const session = addSession(store);
    const workspace = store.getWorkspace(session.id);
    if (!workspace) throw new Error('missing workspace');
    await store.transact(workspace.id, { keepEmptyWorkspace: true }, (draft) => {
      draft.configurations.clear();
    });
    expect(store.getWorkspace(workspace.id)?.configurations.size).toBe(0);
    expect(await store.undoWorkspace(workspace.id)).toBe(true);
    expect(store.getWorkspace(workspace.id)?.configurations.size).toBe(1);
    expect(await store.redoWorkspace(workspace.id)).toBe(true);
    expect(store.getWorkspace(workspace.id)?.configurations.size).toBe(0);

    expect(await store.undoWorkspace(workspace.id)).toBe(true);
    await store.transact(workspace.id, {}, (draft) => {
      draft.configurations.clear();
    });
    expect(store.getWorkspace(workspace.id)).toBeUndefined();
  });

  it('serializes cross-workspace persistence using the latest committed candidates', async () => {
    const store = new SessionStore();
    const first = addSession(store);
    const second = addSession(store);
    const writes: Array<Record<string, number | null | undefined>> = [];
    let releaseFirst: (() => void) | undefined;
    let enteredFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let invocation = 0;
    store.setPersistenceWriter(async (candidate) => {
      invocation += 1;
      if (invocation === 1) {
        enteredFirst?.();
        await holdFirst;
      }
      writes.push(
        Object.fromEntries(
          candidate.map((workspace) => {
            const config = [...workspace.configurations.values()][0];
            return [workspace.id, config?.raw.quantity];
          }),
        ),
      );
    });

    const firstWrite = store.transact(first.id, {}, (_draft, target) => {
      if (target) target.raw.quantity = 2;
    });
    await firstEntered;
    const secondWrite = store.transact(second.id, {}, (_draft, target) => {
      if (target) target.raw.quantity = 3;
    });
    releaseFirst?.();
    await Promise.all([firstWrite, secondWrite]);

    expect(writes).toHaveLength(2);
    expect(writes[1]?.[first.workspaceId]).toBe(2);
    expect(writes[1]?.[second.workspaceId]).toBe(3);
  });

  it('persists removal before deleting the final live workspace', async () => {
    const store = new SessionStore();
    const session = addSession(store);
    let persistedWorkspaceCount = -1;
    store.setPersistenceWriter((candidate) => {
      persistedWorkspaceCount = candidate.length;
      expect(store.getWorkspace(session.workspaceId)).toBeDefined();
    });

    await store.transact(session.id, {}, (draft, target) => {
      if (target) draft.configurations.delete(target.id);
    });

    expect(persistedWorkspaceCount).toBe(0);
    expect(store.get(session.id)).toBeUndefined();
    expect(store.getWorkspace(session.workspaceId)).toBeUndefined();
  });

  it('rejects unknown explicit workspaces and incompatible joins', () => {
    const store = new SessionStore();
    const session = addSession(store);
    expect(() => addSession(store, 'ws_missing')).toThrow(/not found/);
    expect(addSession(store, session.id).workspaceId).toBe(session.workspaceId);

    const raw = structuredClone(session.raw);
    expect(() =>
      store.create({
        locale: { ...locale, currency: 'EUR' },
        solution,
        mode: 'cto',
        raw,
        configurationId: 'US__foreign',
        reduced: reduceConfiguration(raw, 'US__foreign'),
        primed: true,
        workspaceId: session.workspaceId,
      }),
    ).toThrow(/locale does not match/);
  });
});

describe('atomic staged creation', () => {
  it('persists a prepared new workspace before publishing live references', async () => {
    const store = new SessionStore();
    let writerCalls = 0;
    store.setPersistenceWriter((candidate) => {
      writerCalls += 1;
      expect(store.listWorkspaces()).toHaveLength(0);
      expect(candidate).toHaveLength(1);
      expect(candidate[0]?.serverState).toEqual({ imported: true });
      expect([...candidate[0]!.configurations.values()][0]?.raw.quantity).toBe(4);
    });

    const result = await store.createManyAtomic([createInput('US__atomic0')], {
      newWorkspaceId: 'ws_atomic',
      workspaceState: { serverState: { imported: true } },
      prepare: (draft, created) => {
        expect(draft.configurations.get(created[0]!.id)).toBe(created[0]);
        created[0]!.raw.quantity = 4;
      },
    });

    expect(writerCalls).toBe(1);
    expect(result.workspace).toBe(store.getWorkspace('ws_atomic'));
    expect(result.sessions[0]).toBe(store.get(result.sessions[0]!.id));
    expect(result.sessions[0]?.reduced.quantity).toBe(4);
  });

  it('discards a new batch when preparation or durable persistence fails', async () => {
    const prepareStore = new SessionStore();
    await expect(
      prepareStore.createManyAtomic([createInput('US__prepare_failure')], {
        prepare: () => {
          throw new Error('customize failed');
        },
      }),
    ).rejects.toThrow('customize failed');
    expect(prepareStore.listWorkspaces()).toHaveLength(0);

    const persistStore = new SessionStore();
    persistStore.setPersistenceWriter(() => {
      throw new Error('disk full');
    });
    await expect(persistStore.createAtomic(createInput('US__persist_failure'))).rejects.toMatchObject({
      name: 'SessionPersistenceError',
      cause: expect.objectContaining({ message: 'disk full' }),
    });
    expect(persistStore.listWorkspaces()).toHaveLength(0);
    expect(persistStore.list()).toHaveLength(0);
  });

  it('creates a standalone-only workspace from explicit context', async () => {
    const store = new SessionStore();
    const result = await store.createManyAtomic([], {
      newWorkspaceId: 'ws_standalone',
      workspaceContext: { locale, solution, label: 'Software and services' },
      workspaceState: {
        serverState: { standaloneData: [{ code: 'SVC-1', quantity: 2 }] },
      },
    });
    expect(result.sessions).toEqual([]);
    expect(result.workspace).toBe(store.getWorkspace('ws_standalone'));
    expect(result.workspace.configurations.size).toBe(0);
    expect(result.workspace.serverState).toMatchObject({
      standaloneData: [{ code: 'SVC-1', quantity: 2 }],
    });
  });

  it('joins by configuration handle atomically and applies CAS before prepare', async () => {
    const store = new SessionStore();
    const existing = addSession(store);
    let prepared = 0;

    await expect(
      store.createManyAtomic([createInput('US__stale')], {
        workspaceHandle: existing.id,
        expectedRevision: existing.revision + 1,
        prepare: () => {
          prepared += 1;
        },
      }),
    ).rejects.toBeInstanceOf(SessionConflictError);
    expect(prepared).toBe(0);

    const created = await store.createAtomic(createInput('US__joined', existing.id));
    expect(created).toBe(store.get(created.id));
    expect(created.workspaceId).toBe(existing.workspaceId);
    expect(store.getWorkspace(existing.id)?.configurations.size).toBe(2);
  });

  it('evicts at capacity durably and rejects invalid batches without partial publication', async () => {
    const store = new SessionStore(1);
    const previous = addSession(store);
    let persisted = false;
    store.setPersistenceWriter((candidate) => {
      persisted = true;
      expect(candidate).toHaveLength(1);
      expect(candidate[0]?.id).not.toBe(previous.workspaceId);
    });
    const replacement = await store.createAtomic(createInput('US__over_capacity'));
    expect(persisted).toBe(true);
    expect(store.listWorkspaces()).toHaveLength(1);
    expect(store.getWorkspace(previous.workspaceId)).toBeUndefined();
    expect(store.getWorkspace(replacement.id)?.id).toBe(replacement.workspaceId);

    const empty = new SessionStore();
    await expect(
      empty.createManyAtomic([
        createInput('US__duplicate'),
        createInput('US__duplicate'),
      ]),
    ).rejects.toThrow(/Duplicate canonical configuration id/);
    expect(empty.listWorkspaces()).toHaveLength(0);
  });
});
