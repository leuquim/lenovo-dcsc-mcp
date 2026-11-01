import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigSchema, type Config } from '../src/config/schema.js';
import {
  listSessionRecoveryArchives,
  loadSessions,
  readSessionRecoveryArchive,
  saveSessions,
} from '../src/session/persist.js';
import { SessionPersistenceError } from '../src/http/persistenceError.js';
import { SessionStore } from '../src/session/SessionStore.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(): { root: string; path: string; config: Config } {
  const root = mkdtempSync(join(tmpdir(), 'dcsc-persistence-recovery-'));
  roots.push(root);
  const path = join(root, 'state', 'sessions.json');
  return {
    root,
    path,
    config: ConfigSchema.parse({ files: { persistSessions: true, sessionFile: path } }),
  };
}

function historicalV1(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    new URL('./fixtures/persistence/v1-historical.json', import.meta.url),
    'utf8',
  )) as Record<string, unknown>;
}

function recoveryId(bytes: Buffer): string {
  return `recovery_${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('session persistence recovery archives', () => {
  it.each([
    ['non-object root', null, /root is not an object/i],
    ['missing workspace array', { version: 2, sessions: [] }, /no workspace array/i],
    ['unsupported version', { version: 999, workspaces: [] }, /unsupported.*999/i],
  ])('preserves and reports a %s envelope', (_name, value, warning) => {
    const { path, config } = setup();
    mkdirSync(join(path, '..'), { recursive: true });
    const original = Buffer.from(JSON.stringify(value), 'utf8');
    writeFileSync(path, original);

    const store = new SessionStore();
    expect(loadSessions(store, config)).toBe(0);
    expect(store.lastRestoreReport.warnings.join('\n')).toMatch(warning);
    const archive = store.lastRestoreReport.recoveryArchives[0]!;
    expect(archive.id).toBe(recoveryId(original));
    expect(readSessionRecoveryArchive(config, archive.id)).toEqual(original);
    expect(readFileSync(path)).toEqual(original);
  });

  it('preserves unreadable JSON byte-for-byte and exposes it after later valid restarts', () => {
    const { path, config } = setup();
    mkdirSync(join(path, '..'), { recursive: true });
    const original = Buffer.from('{"version":2,"workspaces":[\n  invalid-json\n]}\n', 'utf8');
    writeFileSync(path, original);

    const first = new SessionStore();
    expect(loadSessions(first, config)).toBe(0);
    expect(readFileSync(path)).toEqual(original);
    expect(first.lastRestoreReport.warnings.join('\n')).toMatch(/unreadable/i);
    expect(first.lastRestoreReport.quarantined).toEqual([
      expect.objectContaining({ kind: 'unreadable-session-snapshot' }),
    ]);
    const [archive] = first.lastRestoreReport.recoveryArchives;
    expect(archive).toMatchObject({ id: recoveryId(original), bytes: original.length });
    expect(readSessionRecoveryArchive(config, archive!.id)).toEqual(original);

    writeFileSync(path, JSON.stringify({ version: 2, savedAt: 1, workspaces: [] }));
    const restarted = new SessionStore();
    expect(loadSessions(restarted, config)).toBe(0);
    expect(restarted.lastRestoreReport.recoveryArchives).toEqual([
      expect.objectContaining({ id: archive!.id, sha256: archive!.sha256 }),
    ]);
    expect(readSessionRecoveryArchive(config, archive!.id)).toEqual(original);
  });

  it('archives a mixed v2 source before a later save drops quarantined records', () => {
    const { path, config } = setup();
    mkdirSync(join(path, '..'), { recursive: true });
    const envelope = historicalV1() as { version: number; workspaces: unknown[] };
    envelope.version = 2;
    envelope.workspaces.push({ id: 'broken-top-level-record', configurations: 'invalid' });
    const original = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    writeFileSync(path, original);

    const restored = new SessionStore();
    expect(loadSessions(restored, config)).toBe(1);
    expect(restored.lastRestoreReport.quarantined).toContainEqual(
      expect.objectContaining({ id: 'broken-top-level-record' }),
    );
    const archive = restored.lastRestoreReport.recoveryArchives.find(
      (candidate) => candidate.id === recoveryId(original),
    );
    expect(archive).toBeDefined();

    saveSessions(restored, config);
    expect(readFileSync(path)).not.toEqual(original);
    expect(readSessionRecoveryArchive(config, archive!.id)).toEqual(original);
    expect(listSessionRecoveryArchives(config)).toContainEqual(
      expect.objectContaining({ id: archive!.id, bytes: original.length }),
    );
  });

  it('quarantines malformed nested physical records without aborting valid workspace recovery', () => {
    const { path, config } = setup();
    mkdirSync(join(path, '..'), { recursive: true });
    const envelope = historicalV1() as {
      version: number;
      workspaces: Array<Record<string, unknown>>;
    };
    envelope.version = 2;
    Object.assign(envelope.workspaces[0]!, {
      rackArea: [null],
      floorItems: [null, { id: 'floor-broken', rackId: 'missing-rack', x: 1, y: 2 }],
      cables: [null],
    });
    const original = Buffer.from(JSON.stringify(envelope), 'utf8');
    writeFileSync(path, original);

    const store = new SessionStore();
    expect(loadSessions(store, config)).toBe(1);
    const workspace = store.listWorkspaces()[0]!;
    expect(workspace.integrity).toBe('damaged');
    expect(workspace.rackArea).toEqual([]);
    expect(workspace.floorItems).toEqual([]);
    expect(workspace.cables).toEqual([]);
    expect(workspace.integrityWarnings.join('\n')).toMatch(/rack placement|rackArea|floorItems|cables|missing rack/i);
    expect(store.lastRestoreReport.normalizationRequired).toBe(true);
    const archive = store.lastRestoreReport.recoveryArchives.find(
      (candidate) => candidate.id === recoveryId(original),
    );
    expect(archive).toBeDefined();
    expect(readSessionRecoveryArchive(config, archive!.id)).toEqual(original);
  });

  it('archives the complete v2 source before capacity normalization rewrites it', () => {
    const { path, config } = setup();
    mkdirSync(join(path, '..'), { recursive: true });
    const envelope = historicalV1() as {
      version: number;
      workspaces: Array<Record<string, unknown>>;
    };
    envelope.version = 2;
    const second = structuredClone(envelope.workspaces[0]!);
    second.id = 'ws_historical_v1_second';
    second.lastAccessAt = 2;
    const secondConfigurations = second.configurations as Array<Record<string, unknown>>;
    secondConfigurations[0]!.id = 'sess_historical_v1_second';
    secondConfigurations[0]!.configurationId = 'US__historical_v1_second';
    (secondConfigurations[0]!.raw as Record<string, unknown>).id = 'US__historical_v1_second';
    envelope.workspaces[0]!.lastAccessAt = 1;
    envelope.workspaces.push(second);
    const original = Buffer.from(JSON.stringify(envelope), 'utf8');
    writeFileSync(path, original);

    const bounded = new SessionStore(1);
    expect(loadSessions(bounded, config)).toBe(1);
    expect(bounded.lastRestoreReport.evictedWorkspaceIds).toEqual(['ws_historical_v1']);
    expect(readFileSync(path)).not.toEqual(original);
    const archive = bounded.lastRestoreReport.recoveryArchives.find(
      (candidate) => candidate.id === recoveryId(original),
    );
    expect(archive).toBeDefined();
    expect(readSessionRecoveryArchive(config, archive!.id)).toEqual(original);
  });

  it('migrates a historical-schema v1 fixture and retains both exact backup and archive', () => {
    const { path, config } = setup();
    mkdirSync(join(path, '..'), { recursive: true });
    const original = readFileSync(
      new URL('./fixtures/persistence/v1-historical.json', import.meta.url),
    );
    writeFileSync(path, original);

    const store = new SessionStore();
    expect(loadSessions(store, config)).toBe(1);
    expect(readFileSync(`${path}.v1.bak`)).toEqual(original);
    expect(store.list()[0]).toMatchObject({
      id: 'sess_historical_v1',
      configurationId: 'US__historical_v1',
      raw: { quantity: 2 },
    });
    expect(store.listWorkspaces()[0]).toMatchObject({
      id: 'ws_historical_v1', integrity: 'legacy-unverified', revision: 3,
    });
    const archive = store.lastRestoreReport.recoveryArchives.find(
      (candidate) => candidate.id === recoveryId(original),
    );
    expect(archive).toBeDefined();
    expect(readSessionRecoveryArchive(config, archive!.id)).toEqual(original);
  });

  it('rejects traversal, missing and tampered archive ids', () => {
    const { path, config } = setup();
    mkdirSync(join(path, '..'), { recursive: true });
    const original = Buffer.from('{broken', 'utf8');
    writeFileSync(path, original);
    const store = new SessionStore();
    loadSessions(store, config);
    const archive = store.lastRestoreReport.recoveryArchives[0]!;

    expect(() => readSessionRecoveryArchive(config, '../sessions.json')).toThrow(/invalid/i);
    expect(() => readSessionRecoveryArchive(config, `recovery_${'0'.repeat(64)}`)).toThrow(/not found/i);
    const archivePath = `${path}.recovery-${archive.sha256}.bak`;
    writeFileSync(archivePath, 'tampered');
    expect(() => readSessionRecoveryArchive(config, archive.id)).toThrow(/integrity/i);
  });

  it('checks the configured byte limit before reading an archive', () => {
    const { path, config } = setup();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{broken');
    const store = new SessionStore();
    loadSessions(store, config);
    const archive = store.lastRestoreReport.recoveryArchives[0]!;
    const bounded = ConfigSchema.parse({
      ...config,
      files: { ...config.files, maxDownloadBytes: 4 },
    });

    expect(() => readSessionRecoveryArchive(bounded, archive.id)).toThrow(/download limit of 4 bytes/i);
  });

  it('fails startup safely when the original cannot be archived', () => {
    const { path, config } = setup();
    mkdirSync(join(path, '..'), { recursive: true });
    const original = Buffer.from('{broken', 'utf8');
    writeFileSync(path, original);
    const hash = createHash('sha256').update(original).digest('hex');
    mkdirSync(`${path}.recovery-${hash}.bak`);

    const store = new SessionStore();
    expect(() => loadSessions(store, config)).toThrow(SessionPersistenceError);
    expect(readFileSync(path)).toEqual(original);
    expect(store.lastRestoreReport.warnings).toEqual([]);
  });
});
