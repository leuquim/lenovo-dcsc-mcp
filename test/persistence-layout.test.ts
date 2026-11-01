import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigSchema, type Config } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import type { RawConfiguration } from '../src/model/types.js';
import {
  createPersistenceWriter,
  loadSessions,
  workspaceBlobsDirectory,
  workspaceFile,
  workspacesDirectory,
} from '../src/session/persist.js';
import { SessionStore, type CreateSessionInput } from '../src/session/SessionStore.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function persistenceConfig(): Config {
  const root = mkdtempSync(join(tmpdir(), 'dcsc-persistence-layout-'));
  roots.push(root);
  return ConfigSchema.parse({
    files: { persistSessions: true, sessionFile: join(root, 'state', 'sessions.json') },
  });
}

const LARGE_VALUE_CHARACTERS = 6000;

function input(configurationId: string, padding = 0): CreateSessionInput {
  const raw: RawConfiguration = {
    id: configurationId,
    sliceCtoCode: '7D73CTO1WW',
    description: configurationId + configurationId.repeat(padding),
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

async function persistedStore(
  config: Config,
  workspaceIds: string[],
  padding = 0,
): Promise<SessionStore> {
  const store = new SessionStore();
  store.setPersistenceWriter(createPersistenceWriter(config));
  for (const id of workspaceIds) {
    await store.createManyAtomic([input(`US__${id}`, padding)], { newWorkspaceId: id });
  }
  return store;
}

const LARGE_RAW_PADDING = Math.ceil(LARGE_VALUE_CHARACTERS / 'US__ws_blob'.length);

function setLabel(store: SessionStore, workspaceId: string, label: string): Promise<void> {
  return store.transact(workspaceId, {}, (draft) => {
    draft.label = label;
  });
}

function blobFiles(config: Config, id: string): string[] {
  return readdirSync(workspaceBlobsDirectory(config, id)).sort();
}

function setQuantity(store: SessionStore, workspaceId: string, quantity: number): Promise<void> {
  return store.transact(workspaceId, {}, (draft) => {
    [...draft.configurations.values()][0]!.raw.quantity = quantity;
  });
}

function persistedWorkspace(config: Config, id: string): {
  configurations: Array<{ raw: { quantity: number } }>;
  history: { undo: Array<{ state: { configurations: Array<Record<string, unknown>> } }> };
} {
  const document = JSON.parse(readFileSync(workspaceFile(config, id), 'utf8')) as {
    workspace: ReturnType<typeof persistedWorkspace>;
  };
  return document.workspace;
}

describe('per-workspace persistence layout', () => {
  it('rewrites only the changed workspace document, atomically, with 0600 permissions', async () => {
    const config = persistenceConfig();
    const store = await persistedStore(config, ['ws_a', 'ws_b']);
    const fileA = workspaceFile(config, 'ws_a');
    const fileB = workspaceFile(config, 'ws_b');
    const inodeA = statSync(fileA).ino;
    const inodeB = statSync(fileB).ino;
    const bytesB = readFileSync(fileB);

    await setQuantity(store, 'ws_a', 5);

    expect(statSync(fileA).ino).not.toBe(inodeA);
    expect(persistedWorkspace(config, 'ws_a').configurations[0]!.raw.quantity).toBe(5);
    expect(statSync(fileB).ino).toBe(inodeB);
    expect(readFileSync(fileB)).toEqual(bytesB);
    expect(statSync(fileA).mode & 0o777).toBe(0o600);
    expect(readdirSync(workspacesDirectory(config)).sort()).toEqual(['ws_a', 'ws_b']);
    expect(existsSync(`${fileA}.rollback`)).toBe(false);
  });

  it('removes only the deleted workspace directory', async () => {
    const config = persistenceConfig();
    const store = await persistedStore(config, ['ws_a', 'ws_b']);

    expect(await store.deleteWorkspace('ws_a')).toBe(true);

    expect(readdirSync(workspacesDirectory(config))).toEqual(['ws_b']);
    const restarted = new SessionStore();
    expect(loadSessions(restarted, config)).toBe(1);
    expect(restarted.getWorkspace('ws_a')).toBeUndefined();
    expect(restarted.getWorkspace('ws_b')).toBeDefined();
  });

  it('reads a workspace file only on first access after restart', async () => {
    const config = persistenceConfig();
    await persistedStore(config, ['ws_a', 'ws_b']);
    writeFileSync(workspaceFile(config, 'ws_b'), '{not json');

    const restarted = new SessionStore();
    restarted.setPersistenceWriter(createPersistenceWriter(config));
    expect(loadSessions(restarted, config)).toBe(2);
    expect(restarted.lastRestoreReport.restored).toBe(0);
    expect(restarted.lastRestoreReport.warnings).toEqual([]);

    expect(restarted.getWorkspace('ws_a')?.configurations.size).toBe(1);
    expect(restarted.lastRestoreReport.restored).toBe(1);
    expect(restarted.lastRestoreReport.warnings).toEqual([]);

    expect(restarted.getWorkspace('ws_b')).toBeUndefined();
    expect(restarted.lastRestoreReport.warnings.join('\n')).toMatch(/ws_b.*unreadable/i);
  });

  it('resolves a configuration handle by loading only its workspace', async () => {
    const config = persistenceConfig();
    const source = await persistedStore(config, ['ws_a', 'ws_b']);
    const configurationOfB = [...source.getWorkspace('ws_b')!.configurations.keys()][0]!;

    const restarted = new SessionStore();
    loadSessions(restarted, config);
    expect(restarted.get(configurationOfB)?.workspaceId).toBe('ws_b');
    expect(restarted.lastRestoreReport.restored).toBe(1);
  });

  it('renames the legacy single file to .bak once and ignores it', () => {
    const config = persistenceConfig();
    const legacy = config.files.sessionFile!;
    const bytes = Buffer.from(JSON.stringify({ version: 2, savedAt: 1, workspaces: [] }), 'utf8');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, bytes);

    const first = new SessionStore();
    expect(loadSessions(first, config)).toBe(0);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(`${legacy}.bak`)).toEqual(bytes);
    expect(first.lastRestoreReport.warnings).toEqual([]);

    const second = new SessionStore();
    expect(loadSessions(second, config)).toBe(0);
    expect(readFileSync(`${legacy}.bak`)).toEqual(bytes);
  });

  it('renames per-workspace files of the earlier layout to .bak and ignores them', () => {
    const config = persistenceConfig();
    mkdirSync(workspacesDirectory(config), { recursive: true });
    const earlier = join(workspacesDirectory(config), 'ws_old.json');
    writeFileSync(earlier, '{"version":2}');

    expect(loadSessions(new SessionStore(), config)).toBe(0);

    expect(existsSync(earlier)).toBe(false);
    expect(readFileSync(`${earlier}.bak`, 'utf8')).toBe('{"version":2}');
  });

  it('trusts an index entry newer than its workspace document and rescans a newer document', async () => {
    const garbledWorkspace = async (modifiedAt: Date) => {
      const config = persistenceConfig();
      const source = await persistedStore(config, ['ws_a']);
      const configurationId = [...source.getWorkspace('ws_a')!.configurations.keys()][0]!;
      writeFileSync(workspaceFile(config, 'ws_a'), '{not json');
      utimesSync(workspaceFile(config, 'ws_a'), modifiedAt, modifiedAt);
      const restarted = new SessionStore();
      loadSessions(restarted, config);
      restarted.get(configurationId);
      return restarted.lastRestoreReport.warnings;
    };

    expect((await garbledWorkspace(new Date(Date.now() - 60_000))).join('\n'))
      .toMatch(/ws_a.*unreadable/i);
    expect(await garbledWorkspace(new Date(Date.now() + 60_000))).toEqual([]);
  });
});

describe('content-addressed workspace values', () => {
  it('a mutation writes doc.json and only new values, leaving existing ones untouched', async () => {
    const config = persistenceConfig();
    const store = await persistedStore(config, ['ws_blob'], LARGE_RAW_PADDING);
    const blobsBefore = blobFiles(config, 'ws_blob');
    expect(blobsBefore).toHaveLength(1);
    const blobPath = join(workspaceBlobsDirectory(config, 'ws_blob'), blobsBefore[0]!);
    const blobStat = statSync(blobPath);
    const documentInode = statSync(workspaceFile(config, 'ws_blob')).ino;
    expect(statSync(blobPath).mode & 0o777).toBe(0o600);
    const documentText = readFileSync(workspaceFile(config, 'ws_blob'), 'utf8');
    expect(documentText).toContain('$blob');
    expect(documentText).not.toContain('"totalPrice"');

    await setQuantity(store, 'ws_blob', 5);

    const blobsAfter = blobFiles(config, 'ws_blob');
    expect(blobsAfter).toHaveLength(2);
    expect(blobsAfter).toContain(blobsBefore[0]);
    expect(statSync(blobPath).ino).toBe(blobStat.ino);
    expect(statSync(blobPath).mtimeMs).toBe(blobStat.mtimeMs);
    expect(statSync(workspaceFile(config, 'ws_blob')).ino).not.toBe(documentInode);

    await setLabel(store, 'ws_blob', 'renamed');

    expect(blobFiles(config, 'ws_blob')).toEqual(blobsAfter);
    expect(statSync(blobPath).ino).toBe(blobStat.ino);
    expect(persistedWorkspace(config, 'ws_blob')).toMatchObject({ label: 'renamed' });
  });

  it('restores identical configuration raw and snapshots through undo and redo across restarts', async () => {
    const config = persistenceConfig();
    const store = await persistedStore(config, ['ws_blob'], LARGE_RAW_PADDING);
    for (const quantity of [2, 3, 4]) await setQuantity(store, 'ws_blob', quantity);
    const configurationOf = (target: SessionStore) =>
      [...target.getWorkspace('ws_blob')!.configurations.values()][0]!;
    const observed = (target: SessionStore) => {
      const session = configurationOf(target);
      return {
        raw: structuredClone(session.raw),
        snapshots: session.snapshots.map(({ revision, raw }) => ({ revision, raw: structuredClone(raw) })),
      };
    };
    const beforeUndo = observed(store);
    expect(beforeUndo.raw.quantity).toBe(4);

    expect(await store.undoWorkspace('ws_blob')).toBe(true);
    const undone = observed(store);
    expect(undone.raw.quantity).toBe(3);

    const afterUndoRestart = new SessionStore();
    afterUndoRestart.setPersistenceWriter(createPersistenceWriter(config));
    loadSessions(afterUndoRestart, config);
    expect(observed(afterUndoRestart)).toEqual(undone);

    expect(await afterUndoRestart.redoWorkspace('ws_blob')).toBe(true);
    const redone = observed(afterUndoRestart);
    expect(redone.raw).toEqual(beforeUndo.raw);
    const afterRedoRestart = new SessionStore();
    loadSessions(afterRedoRestart, config);
    expect(observed(afterRedoRestart)).toEqual(redone);
  });

  it('removes values no document references once history is trimmed', async () => {
    const config = persistenceConfig();
    const store = await persistedStore(config, ['ws_blob'], LARGE_RAW_PADDING);
    const [initial] = blobFiles(config, 'ws_blob');

    for (let quantity = 2; quantity <= 13; quantity += 1) {
      await setQuantity(store, 'ws_blob', quantity);
    }

    const blobs = blobFiles(config, 'ws_blob');
    expect(store.getWorkspace('ws_blob')!.history!.undo).toHaveLength(10);
    expect(blobs).toHaveLength(11);
    expect(blobs).not.toContain(initial);
    const restarted = new SessionStore();
    loadSessions(restarted, config);
    expect([...restarted.getWorkspace('ws_blob')!.configurations.values()][0]!.raw.quantity).toBe(13);
  });

  it('shares unchanged immutable values between a history entry and the live workspace', async () => {
    const config = persistenceConfig();
    const store = await persistedStore(config, ['ws_blob'], LARGE_RAW_PADDING);
    await setQuantity(store, 'ws_blob', 2);

    await setLabel(store, 'ws_blob', 'renamed');

    const workspace = store.getWorkspace('ws_blob')!;
    const entry = workspace.history!.undo.at(-1)!;
    const [recorded] = entry.state['configurations'] as Array<{ raw: unknown }>;
    expect(recorded!.raw).toBe([...workspace.configurations.values()][0]!.raw);
    expect(entry.state['serverState']).toBe(workspace.serverState);
    expect(entry.state['rackArea']).toBe(workspace.rackArea);
  });
});

describe('workspace history size', () => {
  it('keeps no nested configuration snapshot copies in undo and redo entries', async () => {
    const config = persistenceConfig();
    const store = await persistedStore(config, ['ws_h']);
    for (const quantity of [2, 3, 4]) await setQuantity(store, 'ws_h', quantity);

    const workspace = store.getWorkspace('ws_h')!;
    const live = [...workspace.configurations.values()][0]!;
    expect(live.snapshots).toHaveLength(3);
    expect(workspace.history!.undo).toHaveLength(3);
    for (const entry of workspace.history!.undo) {
      for (const configuration of entry.state['configurations'] as Array<Record<string, unknown>>) {
        expect(configuration).not.toHaveProperty('snapshots');
      }
    }
    for (const entry of persistedWorkspace(config, 'ws_h').history.undo) {
      for (const configuration of entry.state.configurations) {
        expect(configuration).not.toHaveProperty('snapshots');
      }
    }

    expect(await store.undoWorkspace('ws_h')).toBe(true);
    const undone = [...store.getWorkspace('ws_h')!.configurations.values()][0]!;
    expect(undone.raw.quantity).toBe(3);
    expect(undone.snapshots.map((snapshot) => snapshot.revision)).toEqual([1, 2]);
    for (const entry of store.getWorkspace('ws_h')!.history!.redo) {
      for (const configuration of entry.state['configurations'] as Array<Record<string, unknown>>) {
        expect(configuration).not.toHaveProperty('snapshots');
      }
    }
  });

  it('shares recorded entries instead of copying them on each change', async () => {
    const config = persistenceConfig();
    const store = await persistedStore(config, ['ws_h']);
    await setQuantity(store, 'ws_h', 2);
    const firstEntry = store.getWorkspace('ws_h')!.history!.undo[0]!;

    await setQuantity(store, 'ws_h', 3);

    expect(store.getWorkspace('ws_h')!.history!.undo[0]).toBe(firstEntry);
  });
});
