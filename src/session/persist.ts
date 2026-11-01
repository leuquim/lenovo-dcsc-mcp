import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { Config } from '../config/schema.js';
import { loadValidationJobs, VALIDATION_JOBS_STATE_KEY } from '../domain/validationJobs.js';
import { logger } from '../http/trace.js';
import type {
  PersistenceWriter,
  RestoreRecoveryArchive,
  RestoreReport,
  SessionStore,
  WorkspaceIndexEntry,
} from './SessionStore.js';
import type { ConfigSession, WorkspaceSession } from '../model/session.js';
import { asSessionPersistenceError } from '../http/persistenceError.js';
import { errorMessage } from '../util/coerce.js';

/** Envelope of every workspace file. Derived reduced/index data is deliberately absent. */
export const SNAPSHOT_VERSION = 2;
const INDEX_VERSION = 1;
const WORKSPACE_FILE_SUFFIX = '.json';
const LEGACY_BACKUP_SUFFIX = '.bak';
const MAX_SNAPSHOTS_PERSISTED = 3;
const RECOVERY_ID_PATTERN = /^recovery_([0-9a-f]{64})$/;
const RECOVERY_REASON_LIMIT = 500;

class RecoveryArchiveReadError extends Error {}

export function stateFile(config: Config): string {
  if (config.files.sessionFile) return config.files.sessionFile;
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(base, 'lenovo-dcsc', 'sessions.json');
}

/**
 * Lists immutable source snapshots retained when persisted state could not be
 * restored losslessly. Paths remain private; callers use the opaque id with
 * readSessionRecoveryArchive.
 */
export function listSessionRecoveryArchives(config: Config): RestoreRecoveryArchive[] {
  const path = stateFile(config);
  const directory = dirname(path);
  const prefix = `${basename(path)}.recovery-`;
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw asSessionPersistenceError(error, { operation: 'list session recovery archives' });
  }

  const archives: RestoreRecoveryArchive[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.bak')) continue;
    const hash = entry.name.slice(prefix.length, -'.bak'.length);
    if (!/^[0-9a-f]{64}$/.test(hash)) continue;
    const archivePath = join(directory, entry.name);
    try {
      const stats = statSync(archivePath);
      const metadata = readRecoveryMetadata(`${archivePath}.meta.json`, hash);
      archives.push({
        id: `recovery_${hash}`,
        sha256: hash,
        bytes: stats.size,
        createdAt: metadata?.createdAt ?? safeCreatedAt(stats.birthtimeMs, stats.mtimeMs),
        reason: metadata?.reason ?? 'Preserved session state with recovery diagnostics.',
      });
    } catch (error) {
      logger().warn(
        { archiveId: `recovery_${hash}`, err: errorMessage(error) },
        'Could not inspect a session recovery archive',
      );
    }
  }
  return archives.sort(
    (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );
}

/** Reads one confined recovery archive and verifies it against its opaque id. */
export function readSessionRecoveryArchive(config: Config, id: string): Buffer {
  const match = RECOVERY_ID_PATTERN.exec(id);
  if (!match) throw new Error('Invalid session recovery archive id.');
  const expectedHash = match[1]!;
  const path = recoveryArchivePath(config, expectedHash);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new RecoveryArchiveReadError('Session recovery archive is not a regular file.');
    if (stats.size > config.files.maxDownloadBytes) {
      throw new RecoveryArchiveReadError(
        `Session recovery archive exceeds the configured download limit of ${config.files.maxDownloadBytes} bytes.`,
      );
    }
    const bytes = readFileSync(fd);
    closeSync(fd);
    fd = undefined;
    if (sha256(bytes) !== expectedHash) {
      throw new RecoveryArchiveReadError('Session recovery archive failed its integrity check.');
    }
    return bytes;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error instanceof RecoveryArchiveReadError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RecoveryArchiveReadError(`Session recovery archive ${id} was not found.`);
    }
    throw new RecoveryArchiveReadError(`Session recovery archive ${id} could not be read safely.`);
  }
}

/** Writer suitable for SessionStore.setPersistenceWriter. */
export function createPersistenceWriter(config: Config): PersistenceWriter | undefined {
  if (!config.files.persistSessions) return undefined;
  return (changed, removedIds, index) => commitChange(config, changed, removedIds, index);
}

/** Writes every loaded workspace through the same path the store's writer uses. */
export function saveSessions(store: SessionStore, config: Config): void {
  if (!config.files.persistSessions) return;
  try {
    commitChange(config, store.listWorkspaces(), [], store.workspaceIndex());
  } catch (error) {
    throw asSessionPersistenceError(error, { operation: 'saveSessions' });
  }
}

export function serializeWorkspaces(workspaces: readonly WorkspaceSession[]): string {
  return JSON.stringify({
    version: SNAPSHOT_VERSION,
    savedAt: Date.now(),
    workspaces: workspaces.map(serializeWorkspace),
  });
}

/** Rewrites only the changed workspace files, then the index that locates them. */
function commitChange(
  config: Config,
  changed: readonly WorkspaceSession[],
  removedIds: readonly string[],
  index: readonly WorkspaceIndexEntry[],
): void {
  const directory = workspacesDirectory(config);
  mkdirSync(directory, { recursive: true });
  for (const workspace of changed) {
    writeFileAtomic(workspaceFile(config, workspace.id), serializeWorkspaces([workspace]));
  }
  for (const id of removedIds) removeFileIfPresent(workspaceFile(config, id));
  syncDirectory(directory);
  writeFileAtomic(
    indexFile(config),
    JSON.stringify({ version: INDEX_VERSION, savedAt: Date.now(), workspaces: index }),
  );
  syncDirectory(stateDirectory(config));
}

/**
 * Registers the persisted workspaces with the store without reading them; each
 * is parsed and restored when first accessed. The legacy single-file state is
 * set aside once and ignored.
 */
export function loadSessions(store: SessionStore, config: Config): number {
  if (!config.files.persistSessions) return 0;
  retireLegacySessionFile(config);
  const retained = evictBeyondCapacity(store, config, readWorkspaceIndex(config));
  recordAvailableRecoveryArchives(store, config);
  store.registerUnloaded(retained, (id) => hydrateWorkspace(store, config, id));
  return retained.length;
}

function retireLegacySessionFile(config: Config): void {
  const legacy = stateFile(config);
  if (!existsSync(legacy)) return;
  try {
    renameSync(legacy, `${legacy}${LEGACY_BACKUP_SUFFIX}`);
    syncDirectory(dirname(legacy));
  } catch (error) {
    throw asSessionPersistenceError(error, { operation: 'retire legacy session file' });
  }
  logger().info(
    { path: legacy },
    'Legacy single-file session state renamed to .bak and ignored; starting without it',
  );
}

function readWorkspaceIndex(config: Config): WorkspaceIndexEntry[] {
  const directory = workspacesDirectory(config);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw asSessionPersistenceError(error, { operation: 'list persisted workspaces' });
  }
  const index = readIndexFile(config);
  const entries: WorkspaceIndexEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(WORKSPACE_FILE_SUFFIX)) continue;
    const id = workspaceIdOfFile(name);
    if (id === undefined) continue;
    const path = join(directory, name);
    const indexed = index?.byId.get(id);
    // A file newer than the index means a crash between the file and index writes.
    entries.push(
      indexed && statSync(path).mtimeMs <= index!.savedAt ? indexed : scanWorkspaceFile(path, id),
    );
  }
  return entries;
}

function readIndexFile(
  config: Config,
): { savedAt: number; byId: Map<string, WorkspaceIndexEntry> } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(indexFile(config), 'utf8')) as {
      version?: unknown;
      savedAt?: unknown;
      workspaces?: unknown;
    };
    if (
      parsed.version !== INDEX_VERSION || typeof parsed.savedAt !== 'number' ||
      !Array.isArray(parsed.workspaces)
    ) return undefined;
    const byId = new Map<string, WorkspaceIndexEntry>();
    for (const value of parsed.workspaces as Array<Partial<WorkspaceIndexEntry>>) {
      if (
        typeof value.id !== 'string' || typeof value.lastAccessAt !== 'number' ||
        !Array.isArray(value.configurationIds) ||
        !value.configurationIds.every((id) => typeof id === 'string')
      ) return undefined;
      byId.set(value.id, {
        id: value.id,
        lastAccessAt: value.lastAccessAt,
        configurationIds: value.configurationIds,
      });
    }
    return { savedAt: parsed.savedAt, byId };
  } catch {
    return undefined;
  }
}

/** Rebuilds one index entry from a workspace file the index does not cover. */
function scanWorkspaceFile(path: string, id: string): WorkspaceIndexEntry {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { workspaces?: unknown[] };
    const workspace = parsed.workspaces?.[0] as
      { lastAccessAt?: unknown; configurations?: Array<{ id?: unknown }> } | undefined;
    return {
      id,
      lastAccessAt: typeof workspace?.lastAccessAt === 'number' ? workspace.lastAccessAt : 0,
      configurationIds: (workspace?.configurations ?? [])
        .map((configuration) => configuration.id)
        .filter((configId): configId is string => typeof configId === 'string'),
    };
  } catch {
    return { id, lastAccessAt: 0, configurationIds: [] };
  }
}

/** Removes the least recently used workspace files over capacity, keeping their bytes archived. */
function evictBeyondCapacity(
  store: SessionStore,
  config: Config,
  entries: WorkspaceIndexEntry[],
): WorkspaceIndexEntry[] {
  const excess = entries.length - store.maxSessions;
  if (excess <= 0) return entries;
  const ordered = [...entries].sort(
    (a, b) => a.lastAccessAt - b.lastAccessAt || a.id.localeCompare(b.id),
  );
  const evicted = ordered.slice(0, excess);
  try {
    for (const entry of evicted) {
      const path = workspaceFile(config, entry.id);
      preserveRecoveryArchive(
        config,
        readFileSync(path),
        `Workspace ${entry.id} retained after eviction to enforce session capacity.`,
      );
      unlinkSync(path);
    }
    syncDirectory(workspacesDirectory(config));
  } catch (error) {
    throw asSessionPersistenceError(error, { operation: 'restore capacity normalization' });
  }
  const evictedIds = evicted.map((entry) => entry.id);
  store.recordRestoreDiagnostics({
    warnings: [`Evicted ${evictedIds.length} workspace(s) to enforce session capacity`],
    evictedWorkspaceIds: evictedIds,
  });
  const evictedSet = new Set(evictedIds);
  return entries.filter((entry) => !evictedSet.has(entry.id));
}

type WorkspaceFileProblem = {
  warning: string;
  kind: string;
  version?: unknown;
};

/** Restores one persisted workspace on first access; unusable files are archived and removed. */
function hydrateWorkspace(store: SessionStore, config: Config, id: string): void {
  const path = workspaceFile(config, id);
  let sourceBytes: Buffer;
  try {
    sourceBytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      store.recordRestoreDiagnostics({
        warnings: [`Persisted workspace ${id} is missing; it was not restored.`],
      });
      return;
    }
    throw asSessionPersistenceError(error, { operation: 'read persisted workspace' });
  }

  const parsed = parseWorkspaceFile(sourceBytes, id);
  if ('warning' in parsed) {
    const archive = preserveRecoveryArchive(config, sourceBytes, parsed.warning);
    store.recordRestoreDiagnostics({
      warnings: [parsed.warning],
      quarantined: [{
        kind: parsed.kind,
        ...(parsed.version !== undefined ? { version: parsed.version } : {}),
        recoveryArchiveId: archive.id,
      }],
      recoveryArchives: mergeRecoveryArchives(config, archive),
    });
    discardWorkspaceFile(config, path);
    logger().warn(
      { path, archiveId: archive.id },
      'Could not load a persisted workspace; an exact recovery archive was retained',
    );
    return;
  }

  const report = store.restoreLazily(normalizeValidationJobs(parsed.workspaces));
  if (report.normalizationRequired) {
    const reasons = report.quarantined.length > 0
      ? [`${report.quarantined.length} record(s) could not be restored losslessly`]
      : [];
    const sourceArchive = preserveRecoveryArchive(
      config,
      sourceBytes,
      `Original workspace file retained${reasons.length > 0 ? `: ${reasons.join('; ')}` : ''}.`,
    );
    store.recordRestoreDiagnostics({ recoveryArchives: mergeRecoveryArchives(config, sourceArchive) });
  } else if (report.canonicalRewriteReasons.length > 0) {
    const sourceArchive = preserveRecoveryArchive(
      config,
      sourceBytes,
      `Original workspace file retained before safe canonical rewrite: ${report.canonicalRewriteReasons.join(' ')}`,
    );
    store.recordRestoreDiagnostics({ recoveryArchives: mergeRecoveryArchives(config, sourceArchive) });
  }

  if (report.restored === 0) {
    discardWorkspaceFile(config, path);
  } else if (!report.normalizationRequired && report.canonicalRewriteReasons.length > 0) {
    const workspace = store.peekWorkspace(id);
    try {
      if (workspace) {
        writeFileAtomic(path, serializeWorkspaces([workspace]));
        syncDirectory(workspacesDirectory(config));
      }
    } catch (error) {
      throw asSessionPersistenceError(error, { operation: 'v2 clone ownership canonical migration' });
    }
  }
  logRestoreWarnings(report, path);
}

function parseWorkspaceFile(
  bytes: Buffer,
  id: string,
): { workspaces: unknown[] } | WorkspaceFileProblem {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return {
      kind: 'unreadable-session-snapshot',
      warning: `Persisted workspace ${id} is unreadable; it was not restored.`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      kind: 'invalid-session-envelope',
      warning: `Persisted workspace ${id} root is not an object; it was not restored.`,
    };
  }
  const payload = parsed as { version?: unknown; workspaces?: unknown };
  if (payload.version !== SNAPSHOT_VERSION) {
    return {
      kind: 'unsupported-session-snapshot',
      version: payload.version,
      warning: `Unsupported session snapshot version ${String(payload.version)} for workspace ${id}; it was not restored.`,
    };
  }
  const workspace = Array.isArray(payload.workspaces) && payload.workspaces.length === 1
    ? payload.workspaces[0] as { id?: unknown } | null
    : undefined;
  if (typeof workspace?.id !== 'string' || workspace.id.trim() !== id) {
    return {
      kind: 'invalid-session-envelope',
      warning: `Persisted workspace file for ${id} does not hold exactly that workspace; it was not restored.`,
    };
  }
  return { workspaces: payload.workspaces as unknown[] };
}

function discardWorkspaceFile(config: Config, path: string): void {
  try {
    removeFileIfPresent(path);
    syncDirectory(workspacesDirectory(config));
  } catch (error) {
    throw asSessionPersistenceError(error, { operation: 'discard unusable persisted workspace' });
  }
}

export function workspacesDirectory(config: Config): string {
  return join(stateDirectory(config), 'workspaces');
}

function stateDirectory(config: Config): string {
  return dirname(stateFile(config));
}

function indexFile(config: Config): string {
  return join(stateDirectory(config), 'workspace-index.json');
}

export function workspaceFile(config: Config, id: string): string {
  return join(workspacesDirectory(config), `${encodeURIComponent(id)}${WORKSPACE_FILE_SUFFIX}`);
}

function workspaceIdOfFile(name: string): string | undefined {
  try {
    return decodeURIComponent(name.slice(0, -WORKSPACE_FILE_SUFFIX.length));
  } catch {
    return undefined;
  }
}

function removeFileIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Writes a fully synced temporary file and renames it over the target. */
function writeFileAtomic(path: string, data: string | Buffer): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // The temporary path may not exist or may already have been renamed.
    }
    throw error;
  }
}

function recordAvailableRecoveryArchives(store: SessionStore, config: Config): void {
  const recoveryArchives = listSessionRecoveryArchives(config);
  if (recoveryArchives.length > 0) store.recordRestoreDiagnostics({ recoveryArchives });
}

function mergeRecoveryArchives(
  config: Config,
  current: RestoreRecoveryArchive,
): RestoreRecoveryArchive[] {
  const byId = new Map(
    listSessionRecoveryArchives(config).map((archive) => [archive.id, archive]),
  );
  // Prefer the reason from this startup over generic metadata fallback.
  byId.set(current.id, current);
  return [...byId.values()];
}

function preserveRecoveryArchive(
  config: Config,
  bytes: Buffer,
  reasonValue: string,
): RestoreRecoveryArchive {
  const hash = sha256(bytes);
  const id = `recovery_${hash}`;
  const path = recoveryArchivePath(config, hash);
  const reason = reasonValue.trim().slice(0, RECOVERY_REASON_LIMIT) ||
    'Preserved session state with recovery diagnostics.';
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    throw asSessionPersistenceError(error, { operation: 'preserve session recovery archive' });
  }

  if (existsSync(path)) {
    let existing: Buffer;
    try {
      existing = readRecoveryBytes(path);
    } catch (error) {
      throw asSessionPersistenceError(error, { operation: 'preserve session recovery archive' });
    }
    if (sha256(existing) !== hash) {
      throw asSessionPersistenceError(
        new Error('Existing session recovery archive failed its integrity check.'),
        { operation: 'preserve session recovery archive' },
      );
    }
  } else {
    try {
      writeFileAtomic(path, bytes);
      syncDirectory(dirname(path));
    } catch (error) {
      throw asSessionPersistenceError(error, { operation: 'preserve session recovery archive' });
    }
  }

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch (error) {
    throw asSessionPersistenceError(error, { operation: 'preserve session recovery archive' });
  }
  const existingMetadata = readRecoveryMetadata(`${path}.meta.json`, hash);
  const createdAt = existingMetadata?.createdAt ?? safeCreatedAt(stats.birthtimeMs, stats.mtimeMs);
  writeRecoveryMetadata(path, { id, sha256: hash, bytes: bytes.length, createdAt, reason });
  return { id, sha256: hash, bytes: bytes.length, createdAt, reason };
}

function recoveryArchivePath(config: Config, hash: string): string {
  const path = stateFile(config);
  return join(dirname(path), `${basename(path)}.recovery-${hash}.bak`);
}

function readRecoveryBytes(path: string): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const bytes = readFileSync(fd);
    closeSync(fd);
    return bytes;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw error;
  }
}

function writeRecoveryMetadata(
  archivePath: string,
  metadata: RestoreRecoveryArchive,
): void {
  const path = `${archivePath}.meta.json`;
  if (existsSync(path)) return;
  try {
    writeFileAtomic(path, JSON.stringify({ version: 1, ...metadata }));
    syncDirectory(dirname(path));
  } catch (error) {
    logger().warn(
      { archiveId: metadata.id, err: errorMessage(error) },
      'Could not write session recovery metadata; archive bytes remain available',
    );
  }
}

function readRecoveryMetadata(
  path: string,
  expectedHash: string,
): RestoreRecoveryArchive | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<RestoreRecoveryArchive>;
    if (
      value.id !== `recovery_${expectedHash}` || value.sha256 !== expectedHash ||
      typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0 ||
      typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt < 0 ||
      typeof value.reason !== 'string' || value.reason.trim().length === 0
    ) return undefined;
    return {
      id: value.id,
      sha256: value.sha256,
      bytes: value.bytes,
      createdAt: value.createdAt,
      reason: value.reason.slice(0, RECOVERY_REASON_LIMIT),
    };
  } catch {
    return undefined;
  }
}

function safeCreatedAt(birthtimeMs: number, mtimeMs: number): number {
  if (Number.isFinite(birthtimeMs) && birthtimeMs > 0) return Math.floor(birthtimeMs);
  if (Number.isFinite(mtimeMs) && mtimeMs > 0) return Math.floor(mtimeMs);
  return 0;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeValidationJobs(workspaces: unknown[]): unknown[] {
  const now = Date.now();
  return workspaces.map((workspace) => {
    if (typeof workspace !== 'object' || workspace === null || Array.isArray(workspace)) {
      return workspace;
    }
    const record = workspace as Record<string, unknown>;
    const serverState = record['serverState'];
    if (
      typeof serverState !== 'object' || serverState === null || Array.isArray(serverState) ||
      !Object.hasOwn(serverState, VALIDATION_JOBS_STATE_KEY)
    ) {
      return workspace;
    }
    return {
      ...record,
      serverState: {
        ...serverState,
        [VALIDATION_JOBS_STATE_KEY]: loadValidationJobs(serverState as Record<string, unknown>, now),
      },
    };
  });
}

function serializeWorkspace(workspace: WorkspaceSession): Record<string, unknown> {
  return {
    id: workspace.id,
    label: workspace.label,
    locale: workspace.locale,
    solution: workspace.solution,
    validationMode: workspace.validationMode,
    configurations: [...workspace.configurations.values()].map(serializeConfiguration),
    rackArea: workspace.rackArea,
    nonRackArea: workspace.nonRackArea,
    serverState: workspace.serverState,
    rackSummaries: workspace.rackSummaries,
    cables: workspace.cables,
    floorItems: workspace.floorItems,
    powerSelections: workspace.powerSelections,
    integrity: workspace.integrity,
    integrityWarnings: workspace.integrityWarnings,
    recoveryData: workspace.recoveryData,
    history: workspace.history,
    revision: workspace.revision,
    createdAt: workspace.createdAt,
    lastAccessAt: workspace.lastAccessAt,
    pricedAt: workspace.pricedAt,
  };
}

function serializeConfiguration(session: ConfigSession): Record<string, unknown> {
  return {
    id: session.id,
    label: session.label,
    product: session.product,
    mode: session.mode,
    validationMode: session.validationMode,
    autoCorrect: session.autoCorrect,
    raw: session.raw,
    configurationId: session.configurationId,
    primed: session.primed,
    configurable: session.configurable,
    revision: session.revision,
    intents: session.intents,
    snapshots: session.snapshots.slice(-MAX_SNAPSHOTS_PERSISTED).map((snapshot) => ({
      revision: snapshot.revision,
      raw: snapshot.raw,
    })),
    createdAt: session.createdAt,
    lastAccessAt: session.lastAccessAt,
    pricedAt: session.pricedAt,
  };
}

function logRestoreWarnings(report: RestoreReport, path: string): void {
  if (report.warnings.length === 0 && report.quarantined.length === 0) return;
  logger().warn(
    { path, warnings: report.warnings, quarantinedRecords: report.quarantined.length },
    'Loaded workspace with recovery diagnostics',
  );
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
