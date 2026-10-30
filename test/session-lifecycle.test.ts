import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema, type Config } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import type { RawConfiguration } from '../src/model/types.js';
import { createPersistenceWriter, loadSessions } from '../src/session/persist.js';
import {
  SessionConflictError,
  SessionStore,
  type CreateSessionInput,
} from '../src/session/SessionStore.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function persistenceConfig(): Config {
  const root = mkdtempSync(join(tmpdir(), 'dcsc-session-lifecycle-'));
  roots.push(root);
  return ConfigSchema.parse({
    files: {
      persistSessions: true,
      sessionFile: join(root, 'state', 'sessions.json'),
    },
  });
}

function input(configurationId: string): CreateSessionInput {
  const raw: RawConfiguration = {
    id: configurationId,
    sliceCtoCode: '7D73CTO1WW',
    description: configurationId,
    type: 'SERVER',
    quantity: 1,
    totalPrice: 100,
    tabs: [],
  };
  return {
    locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
    solution: { solutionMode: 'General Purpose', masterSlices: ['ISG'] },
    mode: 'cto',
    raw,
    configurationId,
    reduced: reduceConfiguration(raw, configurationId),
    primed: true,
  };
}

describe('durable session lifecycle', () => {
  it('deletes a standalone-only workspace durably and does not resurrect it on restart', async () => {
    const config = persistenceConfig();
    const store = new SessionStore();
    store.setPersistenceWriter(createPersistenceWriter(config));
    const created = await store.createManyAtomic([], {
      newWorkspaceId: 'ws_standalone_delete',
      workspaceContext: {
        locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
        solution: { solutionMode: 'General Purpose', masterSlices: ['ISG'] },
      },
      workspaceState: { serverState: { standaloneData: [{ code: 'SW-1', quantity: 2 }] } },
    });

    expect(await store.deleteWorkspace(created.workspace.id, created.workspace.revision)).toBe(true);
    expect(store.getWorkspace(created.workspace.id)).toBeUndefined();

    const restarted = new SessionStore();
    expect(loadSessions(restarted, config)).toBe(0);
    expect(restarted.listWorkspaces()).toEqual([]);
  });

  it('keeps live and persisted state when deletion fails or has a stale revision', async () => {
    const config = persistenceConfig();
    const store = new SessionStore();
    store.setPersistenceWriter(createPersistenceWriter(config));
    const session = await store.createAtomic(input('US__delete_failure'));
    const workspace = store.getWorkspace(session.id)!;

    await expect(
      store.deleteWorkspace(workspace.id, workspace.revision + 1),
    ).rejects.toBeInstanceOf(SessionConflictError);
    store.setPersistenceWriter(() => {
      throw new Error('disk full');
    });
    await expect(store.deleteWorkspace(workspace.id, workspace.revision)).rejects.toMatchObject({
      name: 'SessionPersistenceError',
      cause: expect.objectContaining({ message: 'disk full' }),
    });
    expect(store.getWorkspace(workspace.id)).toBe(workspace);

    const restarted = new SessionStore();
    expect(loadSessions(restarted, config)).toBe(1);
    expect(restarted.getWorkspace(workspace.id)).toBeDefined();
  });

  it('persists capacity eviction in the same snapshot as the replacement workspace', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const config = persistenceConfig();
    const store = new SessionStore(1);
    store.setPersistenceWriter(createPersistenceWriter(config));
    const first = await store.createManyAtomic([input('US__capacity_old')], {
      newWorkspaceId: 'ws_capacity_old',
    });
    clock.mockReturnValue(1_800_000_001_000);
    const second = await store.createManyAtomic([input('US__capacity_new')], {
      newWorkspaceId: 'ws_capacity_new',
    });

    expect(store.getWorkspace(first.workspace.id)).toBeUndefined();
    expect(store.getWorkspace(second.workspace.id)).toBe(second.workspace);
    const restarted = new SessionStore(1);
    expect(loadSessions(restarted, config)).toBe(1);
    expect(restarted.getWorkspace('ws_capacity_old')).toBeUndefined();
    expect(restarted.getWorkspace('ws_capacity_new')).toBeDefined();
  });

  it('rewrites an over-capacity persisted snapshot after restore', async () => {
    // Establish actual recency; equal timestamps use the workspace-ID tie-breaker.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const config = persistenceConfig();
    const source = new SessionStore(2);
    source.setPersistenceWriter(createPersistenceWriter(config));
    await source.createManyAtomic([input('US__restore_old')], {
      newWorkspaceId: 'ws_restore_old',
    });
    clock.mockReturnValue(1_800_000_001_000);
    await source.createManyAtomic([input('US__restore_new')], {
      newWorkspaceId: 'ws_restore_new',
    });

    const bounded = new SessionStore(1);
    expect(loadSessions(bounded, config)).toBe(1);
    expect(bounded.lastRestoreReport.evictedWorkspaceIds).toEqual(['ws_restore_old']);
    const restarted = new SessionStore(1);
    expect(loadSessions(restarted, config)).toBe(1);
    expect(restarted.lastRestoreReport.evictedWorkspaceIds).toEqual([]);
    expect(restarted.getWorkspace('ws_restore_new')).toBeDefined();
  });

  it('drain waits for an asynchronous persistence writer', async () => {
    const store = new SessionStore();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      writerStarted = resolve;
    });
    store.setPersistenceWriter(async () => {
      writerStarted();
      await blocked;
    });

    const creation = store.createAtomic(input('US__delayed_writer'));
    await started;
    let drained = false;
    const draining = store.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await Promise.all([creation, draining]);
    expect(drained).toBe(true);
    expect(store.listWorkspaces()).toHaveLength(1);
  });
});
