import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigSchema, type Config } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { loadValidationJobs, type ValidationJob } from '../src/domain/validationJobs.js';
import type { RawConfiguration } from '../src/model/types.js';
import {
  createPersistenceWriter,
  listSessionRecoveryArchives,
  loadSessions,
  saveSessions,
  serializeWorkspaces,
  workspaceFile,
} from '../src/session/persist.js';
import { SessionStore } from '../src/session/SessionStore.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempConfig(): { root: string; config: Config; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'dcsc-persist-v2-'));
  roots.push(root);
  const path = join(root, 'state', 'sessions.json');
  return {
    root,
    path,
    config: ConfigSchema.parse({ files: { persistSessions: true, sessionFile: path } }),
  };
}

function populatedStore(): SessionStore {
  const store = new SessionStore();
  const configurationId = 'US__persist0';
  const raw: RawConfiguration = {
    id: configurationId,
    sliceCtoCode: '7D73CTO1WW',
    description: 'ThinkSystem SR630 V3',
    type: 'SERVER',
    quantity: 4,
    totalPrice: 123.45,
    tabs: [],
  };
  const session = store.create({
    locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
    solution: { solutionMode: 'General Purpose', masterSlices: ['ISG'] },
    mode: 'cto',
    validationMode: 'expert',
    autoCorrect: false,
    raw,
    configurationId,
    reduced: reduceConfiguration(raw, configurationId),
    primed: true,
    configurable: false,
  });
  const workspace = store.getWorkspace(session.id);
  if (!workspace) throw new Error('missing workspace');
  workspace.nonRackArea = [{ id: 'loose-1', configurationId }];
  workspace.serverState = {
    floorInformation: { grid: { rows: 8, columns: 12 } },
    networkingInformation: { selectedStorageNetwork: 'ethernet' },
    cloneRackMapping: { rackA: 'rackB' },
  };
  return store;
}

describe('session persistence v2', () => {
  it('retains the inspectable terminal validation projection across restart without changing revision', async () => {
    const { config } = tempConfig();
    const source = populatedStore();
    source.setPersistenceWriter(createPersistenceWriter(config));
    const workspace = source.listWorkspaces()[0];
    const session = source.list()[0];
    if (!workspace || !session) throw new Error('missing workspace');
    const revision = workspace.revision;
    const terminal: ValidationJob = {
      version: 1, id: 'terminal-job', payloadSha256: 'c'.repeat(64),
      validatedRevision: revision, mode: 'cto', status: 'invalid', terminal: true,
      freshValidationRequired: false, descriptors: [{ uuid: 'terminal' }],
      resultRaw: ['ERROR - Captured manufacturing rule failed'], startedAt: 100, completedAt: 110,
      projection: {
        localDiagnostics: [{ severity: 'error', message: 'processor missing', sourcePath: '$.tabs[0]' }],
        headroom: [{ configuration: session.id, productCode: session.product.code,
          constraints: [{ name: 'Processor', used: 0, capacity: 2, breached: true }],
          breached: ['Processor'] }],
        rackDataOmitted: false,
        validatedScope: { scope: 'configuration', configurations: 1, racksInSolution: 0,
          racksValidated: 0, covers: 'One configuration.' },
      },
    };
    await source.recordValidationJob(session.id, terminal);
    expect(workspace.revision).toBe(revision);

    const restored = new SessionStore();
    expect(loadSessions(restored, config)).toBe(1);
    const jobs = loadValidationJobs(restored.listWorkspaces()[0]?.serverState ?? {});
    expect(jobs).toEqual([terminal]);
    expect(restored.listWorkspaces()[0]?.revision).toBe(revision);
  });

  it('persists validation jobs and marks interrupted retrieval fresh-required on restart', async () => {
    const { config } = tempConfig();
    const source = populatedStore();
    source.setPersistenceWriter(createPersistenceWriter(config));
    const workspace = source.listWorkspaces()[0];
    const session = source.list()[0];
    if (!workspace || !session) throw new Error('missing workspace');
    const revision = workspace.revision;
    const pending: ValidationJob = {
      version: 1, id: 'pending-job', payloadSha256: 'b'.repeat(64),
      validatedRevision: revision, mode: 'cto', status: 'pending', terminal: false,
      freshValidationRequired: false, descriptors: [{ uuid: 'pending' }],
      startedAt: 100, resultRequestedAt: 101,
    };
    await source.recordValidationJob(session.id, pending);
    expect(workspace.revision).toBe(revision);

    const restored = new SessionStore();
    expect(loadSessions(restored, config)).toBe(1);
    const jobs = loadValidationJobs(restored.listWorkspaces()[0]?.serverState ?? {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: 'pending-job', status: 'unavailable', terminal: false,
      freshValidationRequired: true,
      error: { phase: 'result', message: expect.stringMatching(/interrupted/i) },
    });
    expect(restored.listWorkspaces()[0]?.revision).toBe(revision);
  });

  it('round-trips complete canonical/local state and rebuilds derived projections', () => {
    const { config } = tempConfig();
    const source = populatedStore();
    saveSessions(source, config);

    const text = readFileSync(workspaceFile(config, source.listWorkspaces()[0]!.id), 'utf8');
    expect(text).not.toContain('"reduced"');
    expect(text).not.toContain('"index"');

    const target = new SessionStore();
    expect(loadSessions(target, config)).toBe(1);
    const workspace = target.listWorkspaces()[0];
    const session = workspace && [...workspace.configurations.values()][0];
    expect(workspace?.nonRackArea).toEqual([{ id: 'loose-1', configurationId: 'US__persist0' }]);
    expect(workspace?.serverState).toMatchObject({
      floorInformation: { grid: { rows: 8, columns: 12 } },
      cloneRackMapping: { rackA: 'rackB' },
    });
    expect(session?.autoCorrect).toBe(false);
    expect(session?.configurable).toBe(false);
    expect(session?.reduced.quantity).toBe(4);
    expect(session?.index).toBeDefined();
  });

  it('retains hard-loss recovery data and the original bytes when a workspace file holds an unusable record', () => {
    const { config } = tempConfig();
    const source = populatedStore();
    saveSessions(source, config);
    const file = workspaceFile(config, source.listWorkspaces()[0]!.id);
    const current = JSON.parse(serializeWorkspaces(source.listWorkspaces())) as {
      workspaces: Array<{ configurations: unknown[] }>;
    };
    current.workspaces[0]?.configurations.push({ id: '', raw: null });
    writeFileSync(file, JSON.stringify(current));

    const target = new SessionStore();
    expect(loadSessions(target, config)).toBe(1);
    const workspace = target.listWorkspaces()[0];
    expect(workspace?.integrity).toBe('damaged');
    expect(workspace?.integrityWarnings.join(' ')).toMatch(/identity/i);
    expect(workspace?.recoveryData).toHaveLength(1);
    expect(target.lastRestoreReport.quarantined).toHaveLength(1);
    expect(target.lastRestoreReport.recoveryArchives).toHaveLength(1);
    expect(listSessionRecoveryArchives(config)).toHaveLength(1);

    saveSessions(target, config);
    const restarted = new SessionStore();
    expect(loadSessions(restarted, config)).toBe(1);
    expect(restarted.listWorkspaces()[0]?.integrityWarnings).toEqual(workspace?.integrityWarnings);
  });

  it('retains valid history and reports discarded malformed history on restore', async () => {
    const { config } = tempConfig();
    const source = populatedStore();
    source.setPersistenceWriter(createPersistenceWriter(config));
    const workspace = source.listWorkspaces()[0];
    if (!workspace) throw new Error('missing workspace');
    const path = workspaceFile(config, workspace.id);
    await source.transact(workspace.id, {}, (draft) => {
      draft.serverState = { marker: 'changed' };
    });

    const envelope = JSON.parse(readFileSync(path, 'utf8')) as {
      workspaces: Array<{ history?: { undo?: unknown; redo?: unknown } }>;
    };
    const persisted = envelope.workspaces[0];
    if (!persisted?.history || !Array.isArray(persisted.history.undo)) {
      throw new Error('missing persisted history fixture');
    }
    persisted.history.undo.push(null, { revision: 2, state: {} });
    persisted.history.redo = 'not-an-array';
    writeFileSync(path, JSON.stringify(envelope));

    const restored = new SessionStore();
    expect(loadSessions(restored, config)).toBe(1);
    const loaded = restored.listWorkspaces()[0];
    expect(loaded?.history?.undo).toHaveLength(1);
    expect(loaded?.history?.redo).toEqual([]);
    expect(loaded?.integrityWarnings.join('\n')).toMatch(/malformed workspace undo history entry/i);
    expect(loaded?.integrityWarnings.join('\n')).toMatch(/malformed workspace redo history/i);
    expect(loaded?.integrityWarnings.join('\n')).toMatch(/unrestorable workspace undo history entry/i);
    expect(restored.lastRestoreReport.warnings.join('\n')).toMatch(/history/i);
    expect(restored.lastRestoreReport.normalizationRequired).toBe(true);
    expect(loaded?.recoveryData).toHaveLength(3);
    expect(loaded?.recoveryData).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'discarded-history' })]),
    );

    const archiveIds = listSessionRecoveryArchives(config).map((archive) => archive.id);
    saveSessions(restored, config);
    const restarted = new SessionStore();
    expect(loadSessions(restarted, config)).toBe(1);
    expect(restarted.listWorkspaces()[0]?.recoveryData).toEqual(loaded?.recoveryData);
    expect(restarted.lastRestoreReport.normalizationRequired).toBe(false);
    expect(listSessionRecoveryArchives(config).map((archive) => archive.id)).toEqual(archiveIds);
  });

  it('propagates filesystem failures rather than reporting a durable success', () => {
    const { root, config } = tempConfig();
    const blockingFile = join(root, 'not-a-directory');
    writeFileSync(blockingFile, 'x');
    const invalidConfig = ConfigSchema.parse({
      ...config,
      files: { ...config.files, sessionFile: join(blockingFile, 'sessions.json') },
    });
    expect(() => saveSessions(populatedStore(), invalidConfig)).toThrow();
  });

  it('restores durable workspace undo history across restart', async () => {
    const { config } = tempConfig();
    const source = populatedStore();
    source.setPersistenceWriter(createPersistenceWriter(config));
    const workspace = source.listWorkspaces()[0];
    if (!workspace) throw new Error('missing workspace');
    await source.transact(workspace.id, {}, (draft) => {
      draft.serverState = { revisionMarker: 'after' };
      const session = [...draft.configurations.values()][0];
      if (session) session.raw.quantity = 8;
    });

    const restored = new SessionStore();
    expect(loadSessions(restored, config)).toBe(1);
    const restoredWorkspace = restored.listWorkspaces()[0];
    if (!restoredWorkspace) throw new Error('missing restored workspace');
    const restoredSession = [...restoredWorkspace.configurations.values()][0];
    restored.setPersistenceWriter(createPersistenceWriter(config));
    expect(restoredWorkspace.history?.undo).toHaveLength(1);
    expect(await restored.undoWorkspace(restoredWorkspace.id)).toBe(true);
    expect(restoredWorkspace.serverState).toMatchObject({
      floorInformation: { grid: { rows: 8, columns: 12 } },
    });
    expect(restoredSession?.raw.quantity).toBe(4);
    const afterUndoRestart = new SessionStore();
    expect(loadSessions(afterUndoRestart, config)).toBe(1);
    expect(afterUndoRestart.list()[0]?.raw.quantity).toBe(4);
  });

  it('round-trips a standalone-only workspace with no configurations', async () => {
    const { config } = tempConfig();
    const source = new SessionStore();
    source.setPersistenceWriter(createPersistenceWriter(config));
    await source.createManyAtomic([], {
      newWorkspaceId: 'ws_standalone',
      workspaceContext: {
        locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
        solution: { solutionMode: 'General Purpose', masterSlices: ['ISG'] },
      },
      workspaceState: {
        serverState: { standaloneData: [{ code: 'SW-1', quantity: 4 }] },
      },
    });

    const restored = new SessionStore();
    expect(loadSessions(restored, config)).toBe(1);
    const workspace = restored.getWorkspace('ws_standalone');
    expect(workspace?.configurations.size).toBe(0);
    expect(workspace?.serverState).toMatchObject({
      standaloneData: [{ code: 'SW-1', quantity: 4 }],
    });
  });
});
