import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigSchema, type Config } from '../src/config/schema.js';
import { cloneConfigurationRaw } from '../src/domain/configurationIdentity.js';
import { canonicalWorkspaceHash } from '../src/domain/reconciliation.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { removeWorkspaceReferences } from '../src/domain/workspaceReferences.js';
import type { RawConfiguration } from '../src/model/types.js';
import {
  loadSessions,
  readSessionRecoveryArchive,
  serializeWorkspaces,
  WORKSPACE_DOC_VERSION,
  workspaceFile,
} from '../src/session/persist.js';
import { SessionPersistenceError } from '../src/http/persistenceError.js';
import { CLONE_OWNERSHIP_RECOVERY_STATE_KEY, SessionStore } from '../src/session/SessionStore.js';
import type { WorkspaceSession } from '../src/model/session.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      const workspaces = join(root, 'state', 'workspaces');
      chmodSync(workspaces, 0o700);
      for (const name of readdirSync(workspaces)) chmodSync(join(workspaces, name), 0o700);
    } catch {
      // The test may fail before creating its state directory.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function setup(): { root: string; path: string; config: Config } {
  const root = mkdtempSync(join(tmpdir(), 'dcsc-clone-migration-'));
  roots.push(root);
  const path = join(root, 'state', 'sessions.json');
  return {
    root,
    path,
    config: ConfigSchema.parse({ files: { persistSessions: true, sessionFile: path } }),
  };
}

function raw(identity: string): RawConfiguration {
  return {
    id: identity,
    workspaceId: identity,
    sliceCtoCode: '7D73CTO1WW',
    description: 'ThinkSystem SR630 V3',
    type: 'server',
    quantity: 1,
    totalPrice: 125,
    shippingStatus: ['30'],
    tabs: [{ subTabs: [{ title: 'System', sections: [{
      name: 'Memory',
      results: [{ code: 'MEM-32G', quantity: 2, price: 25, type: 'hardware' }],
    }] }] }],
    hipoDerivedItems: [],
    hipoServiceCtoServices: [],
  };
}

function oldSingletonStore(diverge = false): SessionStore {
  const ids = ['root', 'clone'];
  const store = new SessionStore();
  const rootRaw = raw(ids[0]!);
  const first = store.create({
    locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
    solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
    mode: 'cto',
    raw: rootRaw,
    configurationId: ids[0]!,
    reduced: reduceConfiguration(rootRaw, ids[0]!),
    primed: true,
  });
  const cloneRaw = cloneConfigurationRaw(rootRaw, ids[0]!, ids[1]!);
  // Captured layout roundtrips hydrate these catalog-only fields differently
  // without changing selected sections, commercial lines, pricing or controls.
  cloneRaw.shippingStatus = [];
  cloneRaw.audience = 0;
  cloneRaw.customized = false;
  cloneRaw.powerReportResponse = { presentationOnly: true };
  if (diverge) cloneRaw.tabs![0]!.subTabs![0]!.sections![0]!.results![0]!.quantity = 3;
  store.create({
    locale: first.locale,
    solution: first.solution,
    mode: 'cto',
    raw: cloneRaw,
    configurationId: ids[1]!,
    reduced: reduceConfiguration(cloneRaw, ids[1]!),
    primed: true,
    workspaceId: first.workspaceId,
  });
  const workspace = store.getWorkspace(first.workspaceId)!;
  const color = (root: string, dependBy: string[]) => ({
    color: '#123456', darkColor: '#012345', dependBy, root,
  });
  workspace.nonRackArea = ids.map(id => ({ id, code: '7D73CTO1WW', type: 'server', quantity: 1 }));
  workspace.serverState = {
    cloneDependency: { root: ['root'], clone: ['clone'] },
    cloneDependencyColor: { root: color('root', ids), clone: color('clone', ['clone']) },
    importCloneExpansion: [{
      sourceId: 'root',
      original: { id: 'root', quantity: 2, originalIds: ids },
      ids,
    }],
    historyInformation: [{ command: 'IMPORT', description: 'Import : source.xml', timestamp: 'fixed' }],
    messageHistory: { history: [{ command: 'ADD', timestamp: 'fixed' }], sessionStart: 'fixed' },
  };
  workspace.revision = 17;
  workspace.createdAt = 101;
  workspace.lastAccessAt = 102;
  workspace.pricedAt = 103;
  return store;
}

function persistedState(workspace: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'label', 'locale', 'solution', 'validationMode', 'configurations', 'rackArea',
    'nonRackArea', 'serverState', 'rackSummaries', 'cables', 'floorItems', 'powerSelections',
    'integrity', 'integrityWarnings', 'recoveryData', 'createdAt', 'lastAccessAt', 'pricedAt',
  ];
  return Object.fromEntries(keys.map(key => [key, structuredClone(workspace[key])]));
}

function fixtureBytes(options: { divergeCurrent?: boolean; divergentHistory?: boolean } = {}): Buffer {
  const source = oldSingletonStore(options.divergeCurrent === true);
  const envelope = JSON.parse(serializeWorkspaces(source.listWorkspaces())) as {
    workspaces: Array<Record<string, unknown>>;
  };
  const workspace = envelope.workspaces[0]!;
  const state = persistedState(workspace);
  if (options.divergentHistory) {
    const configurations = state.configurations as Array<Record<string, unknown>>;
    const clone = configurations[1]!;
    const cloneRaw = clone.raw as RawConfiguration;
    cloneRaw.tabs![0]!.subTabs![0]!.sections![0]!.results![0]!.quantity = 4;
  }
  workspace.history = {
    undo: [{ revision: 16, state }],
    redo: [{ revision: 18, state: persistedState(workspace) }],
  };
  return asDocument(JSON.stringify(envelope));
}

function asDocument(envelopeJson: string): Buffer {
  const envelope = JSON.parse(envelopeJson) as { workspaces: unknown[] };
  return Buffer.from(
    JSON.stringify({ version: WORKSPACE_DOC_VERSION, workspace: envelope.workspaces[0] }),
    'utf8',
  );
}

function installWorkspaceFile(config: Config, bytes: Buffer): string {
  const document = JSON.parse(bytes.toString('utf8')) as { workspace: { id: string } };
  const file = workspaceFile(config, document.workspace.id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

function archiveId(bytes: Buffer): string {
  return `recovery_${createHash('sha256').update(bytes).digest('hex')}`;
}

function expectCanonicalOwnership(workspace: WorkspaceSession): void {
  expect(workspace.serverState.cloneDependency).toEqual({ root: ['root', 'clone'] });
  expect(workspace.serverState.cloneDependencyColor).toEqual({
    root: expect.objectContaining({ dependBy: ['root', 'clone'] }),
  });
}

describe('persisted clone ownership canonical migration', () => {
  it('archives and durably rewrites the proven singleton defect, including undo and redo', async () => {
    const { config } = setup();
    const original = fixtureBytes();
    const file = installWorkspaceFile(config, original);

    const restored = new SessionStore();
    expect(loadSessions(restored, config)).toBe(1);
    const workspace = restored.listWorkspaces()[0]!;
    expectCanonicalOwnership(workspace);
    expect(workspace).toMatchObject({ revision: 17, createdAt: 101, lastAccessAt: 102, pricedAt: 103 });
    expect(workspace.serverState).toMatchObject({
      historyInformation: [{ command: 'IMPORT', description: 'Import : source.xml', timestamp: 'fixed' }],
      messageHistory: { history: [{ command: 'ADD', timestamp: 'fixed' }], sessionStart: 'fixed' },
    });
    expect(restored.lastRestoreReport.normalizationRequired).toBe(false);
    expect(restored.lastRestoreReport.canonicalRewriteReasons.join('\n')).toMatch(/clone ownership/i);
    const archive = restored.lastRestoreReport.recoveryArchives.find(item => item.id === archiveId(original));
    expect(archive).toBeDefined();
    expect(readSessionRecoveryArchive(config, archive!.id)).toEqual(original);
    expect(readFileSync(file)).not.toEqual(original);

    expect(await restored.undoWorkspace(workspace.id, workspace.revision)).toBe(true);
    expectCanonicalOwnership(workspace);
    expect(workspace.serverState).toMatchObject({
      historyInformation: [{ command: 'IMPORT', description: 'Import : source.xml', timestamp: 'fixed' }],
      messageHistory: { history: [{ command: 'ADD', timestamp: 'fixed' }], sessionStart: 'fixed' },
    });
    expect(await restored.redoWorkspace(workspace.id, workspace.revision)).toBe(true);
    expectCanonicalOwnership(workspace);
    expect(workspace.serverState).toMatchObject({
      historyInformation: [{ command: 'IMPORT', description: 'Import : source.xml', timestamp: 'fixed' }],
      messageHistory: { history: [{ command: 'ADD', timestamp: 'fixed' }], sessionStart: 'fixed' },
    });

    const deletionProbe = structuredClone(workspace) as WorkspaceSession;
    deletionProbe.configurations = new Map(workspace.configurations);
    expect(() => removeWorkspaceReferences(deletionProbe, new Set(['root']))).not.toThrow();
    expect(deletionProbe.serverState.cloneDependencyColor).toEqual({
      clone: expect.objectContaining({ dependBy: ['clone'] }),
    });

    const restarted = new SessionStore();
    expect(loadSessions(restarted, config)).toBe(1);
    expectCanonicalOwnership(restarted.listWorkspaces()[0]!);
    expect(restarted.lastRestoreReport.canonicalRewriteReasons).toEqual([]);
  });

  it('keeps divergent current ownership readable but blocks every mutation with reimport guidance', async () => {
    const { config } = setup();
    const original = fixtureBytes({ divergeCurrent: true });
    const file = installWorkspaceFile(config, original);

    const restored = new SessionStore();
    expect(loadSessions(restored, config)).toBe(1);
    const workspace = restored.listWorkspaces()[0]!;
    expect(workspace.integrity).toBe('damaged');
    expect(workspace.serverState[CLONE_OWNERSHIP_RECOVERY_STATE_KEY]).toBe(true);
    expect(workspace.serverState.cloneDependency).toEqual({ root: ['root'], clone: ['clone'] });
    await expect(restored.transact(workspace.id, {}, draft => {
      draft.label = 'must not commit';
    })).rejects.toThrow(/clone ownership.*re-import.*CFXML/i);
    expect(workspace.label).not.toBe('must not commit');
    expect(readFileSync(file)).toEqual(original);
    const archive = restored.lastRestoreReport.recoveryArchives.find(item => item.id === archiveId(original));
    expect(archive).toBeDefined();
    expect(readSessionRecoveryArchive(config, archive!.id)).toEqual(original);
  });

  it('discards a divergent history snapshot instead of letting undo resurrect singleton ownership', () => {
    const { config } = setup();
    const original = fixtureBytes({ divergentHistory: true });
    const file = installWorkspaceFile(config, original);

    const restored = new SessionStore();
    expect(loadSessions(restored, config)).toBe(1);
    const workspace = restored.listWorkspaces()[0]!;
    expectCanonicalOwnership(workspace);
    expect(workspace.history?.undo).toEqual([]);
    expect(workspace.history?.redo).toHaveLength(1);
    expect(workspace.recoveryData).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'discarded-history', warning: expect.stringMatching(/diverged/i) }),
    ]));
    expect(restored.lastRestoreReport.normalizationRequired).toBe(true);
    expect(readFileSync(file)).toEqual(original);
  });

  it('keeps a stored reconciliation hash stale after canonical ownership changes', () => {
    const { config } = setup();
    const source = oldSingletonStore();
    const workspace = source.listWorkspaces()[0]!;
    const oldHash = canonicalWorkspaceHash(workspace);
    workspace.serverState.reconciliationProposals = [{
      version: 1,
      id: 'old-proposal',
      workspaceId: workspace.id,
      sourceRevision: workspace.revision,
      sourceHash: oldHash,
      targetHash: 'old-target',
      createdAt: 100,
      status: 'changes-proposed',
      diffs: [], warnings: [], target: {},
    }];
    installWorkspaceFile(config, asDocument(serializeWorkspaces(source.listWorkspaces())));

    const restored = new SessionStore();
    expect(loadSessions(restored, config)).toBe(1);
    const migrated = restored.listWorkspaces()[0]!;
    const proposals = migrated.serverState.reconciliationProposals as Array<Record<string, unknown>>;
    expect(proposals[0]?.sourceHash).toBe(oldHash);
    expect(canonicalWorkspaceHash(migrated)).not.toBe(oldHash);
  });

  it('does not rewrite when the source archive cannot be created', () => {
    const { path, config } = setup();
    const original = fixtureBytes();
    const file = installWorkspaceFile(config, original);
    const hash = createHash('sha256').update(original).digest('hex');
    mkdirSync(`${path}.recovery-${hash}.bak`);

    const store = new SessionStore();
    expect(loadSessions(store, config)).toBe(1);
    expect(() => store.listWorkspaces()).toThrow(SessionPersistenceError);
    expect(readFileSync(file)).toEqual(original);
  });

  it('archives first and leaves the source intact when the canonical rewrite fails', () => {
    const { config } = setup();
    const original = fixtureBytes();
    const file = installWorkspaceFile(config, original);

    const priming = new SessionStore();
    expect(loadSessions(priming, config)).toBe(1);
    priming.listWorkspaces();
    const id = archiveId(original);
    expect(readSessionRecoveryArchive(config, id)).toEqual(original);

    writeFileSync(file, original);
    chmodSync(dirname(file), 0o500);
    const blocked = new SessionStore();
    expect(loadSessions(blocked, config)).toBe(1);
    expect(() => blocked.listWorkspaces()).toThrow(SessionPersistenceError);
    expect(readFileSync(file)).toEqual(original);
    expect(readSessionRecoveryArchive(config, id)).toEqual(original);
  });
});
