import {
  closeSync,
  constants,
  copyFileSync,
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
import type { PersistenceWriter, RestoreRecoveryArchive, SessionStore } from './SessionStore.js';
import type { ConfigSession, WorkspaceSession } from '../model/session.js';
import { asSessionPersistenceError } from '../http/persistenceError.js';
import { errorMessage } from '../util/coerce.js';

/** Current on-disk envelope. Derived reduced/index data is deliberately absent. */
export const SNAPSHOT_VERSION = 2;
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
  return (workspaces) => saveWorkspaceSnapshot(workspaces, config);
}

/** Compatibility entry point for callers that persist outside a transaction. */
export function saveSessions(store: SessionStore, config: Config): void {
  if (!config.files.persistSessions) return;
  try {
    saveWorkspaceSnapshot(store.listWorkspaces(), config);
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

/** Writes and synchronizes a complete candidate before replacing the live file. */
export function saveWorkspaceSnapshot(
  workspaces: readonly WorkspaceSession[],
  config: Config,
): void {
  if (!config.files.persistSessions) return;
  const path = stateFile(config);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const rollback = `${tmp}.rollback`;
  let fd: number | undefined;
  let replaced = false;
  const hadPrevious = existsSync(path);
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, serializeWorkspaces(workspaces), 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (hadPrevious) {
      copyFileSync(path, rollback);
      syncFile(rollback);
    }
    renameSync(tmp, path);
    replaced = true;
    syncDirectory(dirname(path));
    if (hadPrevious) {
      try {
        unlinkSync(rollback);
      } catch {
        // The committed file is durable; stale rollback cleanup is best-effort.
      }
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    let rollbackError: unknown;
    if (replaced) {
      try {
        if (hadPrevious) renameSync(rollback, path);
        else unlinkSync(path);
        syncDirectory(dirname(path));
      } catch (candidate) {
        rollbackError = candidate;
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // The rename may already have consumed the temporary path.
    }
    if (existsSync(rollback)) unlinkSync(rollback);
    if (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Session persistence failed and the previous file could not be restored',
      );
    }
    throw error;
  }
}

export function loadSessions(store: SessionStore, config: Config): number {
  if (!config.files.persistSessions) return 0;
  const path = stateFile(config);
  let sourceBytes: Buffer;
  try {
    sourceBytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      recordAvailableRecoveryArchives(store, config);
      return 0;
    }
    throw asSessionPersistenceError(error, { operation: 'read persisted sessions' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceBytes.toString('utf8')) as unknown;
  } catch {
    const warning = 'Persisted session JSON is unreadable; the server started without those sessions.';
    const archive = preserveRecoveryArchive(config, sourceBytes, warning);
    store.recordRestoreDiagnostics({
      warnings: [warning],
      quarantined: [{ kind: 'unreadable-session-snapshot', recoveryArchiveId: archive.id }],
      recoveryArchives: mergeRecoveryArchives(config, archive),
    });
    logger().warn(
      { path, archiveId: archive.id },
      'Could not load persisted sessions; an exact recovery archive was retained',
    );
    return 0;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const warning = 'Persisted session snapshot root is not an object; no sessions were restored.';
    const archive = preserveRecoveryArchive(config, sourceBytes, warning);
    store.recordRestoreDiagnostics({
      warnings: [warning],
      quarantined: [{ kind: 'invalid-session-envelope', recoveryArchiveId: archive.id }],
      recoveryArchives: mergeRecoveryArchives(config, archive),
    });
    logger().warn({ path, archiveId: archive.id }, 'Session snapshot root is invalid; recovery archive retained');
    return 0;
  }
  const payload = parsed as { version?: number; workspaces?: unknown[] };

  if (!Array.isArray(payload.workspaces)) {
    const warning = 'Persisted session snapshot has no workspace array; no sessions were restored.';
    const archive = preserveRecoveryArchive(config, sourceBytes, warning);
    store.recordRestoreDiagnostics({
      warnings: [warning],
      quarantined: [{ kind: 'invalid-session-envelope', recoveryArchiveId: archive.id }],
      recoveryArchives: mergeRecoveryArchives(config, archive),
    });
    logger().warn({ path, archiveId: archive.id }, 'Session snapshot has no workspace array; recovery archive retained');
    return 0;
  }

  if (payload.version === SNAPSHOT_VERSION) {
    const restored = store.restore(normalizeValidationJobs(payload.workspaces));
    const report = store.lastRestoreReport;
    if (report.normalizationRequired) {
      const reasons = [
        ...(report.quarantined.length > 0
          ? [`${report.quarantined.length} record(s) could not be restored losslessly`]
          : []),
        ...(report.evictedWorkspaceIds.length > 0
          ? [`${report.evictedWorkspaceIds.length} workspace(s) exceeded restore capacity`]
          : []),
      ];
      const sourceArchive = preserveRecoveryArchive(
        config,
        sourceBytes,
        `Original v2 session snapshot retained: ${reasons.join('; ')}.`,
      );
      store.recordRestoreDiagnostics({ recoveryArchives: mergeRecoveryArchives(config, sourceArchive) });
    } else if (report.canonicalRewriteReasons.length > 0) {
      const sourceArchive = preserveRecoveryArchive(
        config,
        sourceBytes,
        `Original v2 session snapshot retained before safe canonical rewrite: ${report.canonicalRewriteReasons.join(' ')}`,
      );
      store.recordRestoreDiagnostics({ recoveryArchives: mergeRecoveryArchives(config, sourceArchive) });
    } else {
      recordAvailableRecoveryArchives(store, config);
    }
    // Restore enforces the configured capacity in memory. Commit the same
    // bounded set so an evicted workspace cannot reappear after another restart.
    const finalReport = store.lastRestoreReport;
    const safeCanonicalRewrite = !finalReport.normalizationRequired &&
      finalReport.canonicalRewriteReasons.length > 0;
    const safeCapacityRewrite = finalReport.evictedWorkspaceIds.length > 0;
    if (safeCanonicalRewrite || safeCapacityRewrite) {
      try {
        saveWorkspaceSnapshot(store.listWorkspaces(), config);
      } catch (error) {
        throw asSessionPersistenceError(error, {
          operation: safeCanonicalRewrite
            ? 'v2 clone ownership canonical migration'
            : 'restore capacity normalization',
        });
      }
    }
    logRestoreWarnings(store, path);
    return restored;
  }

  if (payload.version === 1) {
    const backup = `${path}.v1.bak`;
    if (!existsSync(backup)) {
      copyFileSync(path, backup);
      syncFile(backup);
      syncDirectory(dirname(path));
    }
    const sourceArchive = preserveRecoveryArchive(
      config,
      sourceBytes,
      'Original v1 session snapshot retained before migration.',
    );
    const restored = store.restore(normalizeValidationJobs(payload.workspaces), {
      provenance: 'legacy-unverified',
    });
    store.recordRestoreDiagnostics({ recoveryArchives: mergeRecoveryArchives(config, sourceArchive) });
    logRestoreWarnings(store, path);
    if (restored === 0 && payload.workspaces.length > 0) {
      logger().warn(
        { path, backup },
        'No v1 workspace could be migrated; original and backup were preserved',
      );
      return 0;
    }
    try {
      saveWorkspaceSnapshot(store.listWorkspaces(), config);
    } catch (error) {
      throw asSessionPersistenceError(error, { operation: 'v1 session migration' });
    }
    return restored;
  }

  const warning = `Unsupported session snapshot version ${String(payload.version)}; no sessions were restored.`;
  const archive = preserveRecoveryArchive(config, sourceBytes, warning);
  store.recordRestoreDiagnostics({
    warnings: [warning],
    quarantined: [{
      kind: 'unsupported-session-snapshot',
      version: payload.version,
      recoveryArchiveId: archive.id,
    }],
    recoveryArchives: mergeRecoveryArchives(config, archive),
  });
  logger().warn(
    { path, version: payload.version, archiveId: archive.id },
    'Unsupported session snapshot version; recovery archive retained',
  );
  return 0;
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
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, path);
      syncDirectory(dirname(path));
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(tmp);
      } catch {
        // The temporary path may not have been created or may have been renamed.
      }
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
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ version: 1, ...metadata }), 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    syncDirectory(dirname(path));
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // A missing metadata sidecar is safe; the immutable archive remains discoverable.
    }
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
    const copy = structuredClone(workspace) as Record<string, unknown>;
    const serverState = copy['serverState'];
    if (
      typeof serverState !== 'object' || serverState === null || Array.isArray(serverState) ||
      !Object.hasOwn(serverState, VALIDATION_JOBS_STATE_KEY)
    ) {
      return copy;
    }
    copy['serverState'] = {
      ...serverState,
      [VALIDATION_JOBS_STATE_KEY]: loadValidationJobs(
        serverState as Record<string, unknown>,
        now,
      ),
    };
    return copy;
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

function logRestoreWarnings(store: SessionStore, path: string): void {
  const report = store.lastRestoreReport;
  if (report.warnings.length === 0 && report.quarantined.length === 0) return;
  logger().warn(
    { path, warnings: report.warnings, quarantinedRecords: report.quarantined.length },
    'Loaded session snapshot with recovery diagnostics',
  );
}

function syncFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
