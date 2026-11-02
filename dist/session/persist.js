import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadValidationJobs, VALIDATION_JOBS_STATE_KEY } from '../domain/validationJobs.js';
import { logger } from '../http/trace.js';
import { asSessionPersistenceError } from '../http/persistenceError.js';
import { errorMessage } from '../util/coerce.js';
import { canonicalJson, digestOf, sha256Hex } from './valueDigest.js';
/** Self-contained envelope of recovery exports and archives. Derived reduced/index data is deliberately absent. */
export const SNAPSHOT_VERSION = 2;
/** Envelope of a workspace's doc.json, whose large values are references into blobs/. */
export const WORKSPACE_DOC_VERSION = 3;
const INDEX_VERSION = 1;
const DOC_FILE = 'doc.json';
const BLOBS_DIRECTORY = 'blobs';
const BLOB_SUFFIX = '.json';
const BLOB_REF_KEY = '$blob';
const BLOB_HASH_PATTERN = /^[0-9a-f]{64}$/;
/** Values smaller than this stay in doc.json instead of getting a file of their own. */
const INLINE_VALUE_BYTES = 4096;
const LEGACY_WORKSPACE_SUFFIX = '.json';
const LEGACY_BACKUP_SUFFIX = '.bak';
const MAX_SNAPSHOTS_PERSISTED = 3;
const RECOVERY_ID_PATTERN = /^recovery_([0-9a-f]{64})$/;
const RECOVERY_REASON_LIMIT = 500;
class RecoveryArchiveReadError extends Error {
}
export function stateFile(config) {
    if (config.files.sessionFile)
        return config.files.sessionFile;
    const base = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
    return join(base, 'lenovo-dcsc', 'sessions.json');
}
/**
 * Lists immutable source snapshots retained when persisted state could not be
 * restored losslessly. Paths remain private; callers use the opaque id with
 * readSessionRecoveryArchive.
 */
export function listSessionRecoveryArchives(config) {
    const path = stateFile(config);
    const directory = dirname(path);
    const prefix = `${basename(path)}.recovery-`;
    let entries;
    try {
        entries = readdirSync(directory, { withFileTypes: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw asSessionPersistenceError(error, { operation: 'list session recovery archives' });
    }
    const archives = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.bak'))
            continue;
        const hash = entry.name.slice(prefix.length, -'.bak'.length);
        if (!/^[0-9a-f]{64}$/.test(hash))
            continue;
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
        }
        catch (error) {
            logger().warn({ archiveId: `recovery_${hash}`, err: errorMessage(error) }, 'Could not inspect a session recovery archive');
        }
    }
    return archives.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
}
/** Reads one confined recovery archive and verifies it against its opaque id. */
export function readSessionRecoveryArchive(config, id) {
    const match = RECOVERY_ID_PATTERN.exec(id);
    if (!match)
        throw new Error('Invalid session recovery archive id.');
    const expectedHash = match[1];
    const path = recoveryArchivePath(config, expectedHash);
    let fd;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stats = fstatSync(fd);
        if (!stats.isFile())
            throw new RecoveryArchiveReadError('Session recovery archive is not a regular file.');
        if (stats.size > config.files.maxDownloadBytes) {
            throw new RecoveryArchiveReadError(`Session recovery archive exceeds the configured download limit of ${config.files.maxDownloadBytes} bytes.`);
        }
        const bytes = readFileSync(fd);
        closeSync(fd);
        fd = undefined;
        if (sha256Hex(bytes) !== expectedHash) {
            throw new RecoveryArchiveReadError('Session recovery archive failed its integrity check.');
        }
        return bytes;
    }
    catch (error) {
        if (fd !== undefined)
            closeSync(fd);
        if (error instanceof RecoveryArchiveReadError)
            throw error;
        if (error.code === 'ENOENT') {
            throw new RecoveryArchiveReadError(`Session recovery archive ${id} was not found.`);
        }
        throw new RecoveryArchiveReadError(`Session recovery archive ${id} could not be read safely.`);
    }
}
/** Writer suitable for SessionStore.setPersistenceWriter. */
export function createPersistenceWriter(config) {
    if (!config.files.persistSessions)
        return undefined;
    return (changed, removedIds, index) => commitChange(config, changed, removedIds, index);
}
/** Writes every loaded workspace through the same path the store's writer uses. */
export function saveSessions(store, config) {
    if (!config.files.persistSessions)
        return;
    try {
        commitChange(config, store.listWorkspaces(), [], store.workspaceIndex());
    }
    catch (error) {
        throw asSessionPersistenceError(error, { operation: 'saveSessions' });
    }
}
/** Self-contained JSON of workspaces with every value inline, for recovery export and archives. */
export function serializeWorkspaces(workspaces) {
    return JSON.stringify({
        version: SNAPSHOT_VERSION,
        savedAt: Date.now(),
        workspaces: workspaces.map((workspace) => serializeWorkspace(workspace, keepInline)),
    });
}
/** Writes the changed workspaces, drops the removed ones, then refreshes the index that locates them. */
function commitChange(config, changed, removedIds, index) {
    mkdirSync(workspacesDirectory(config), { recursive: true });
    for (const workspace of changed)
        writeWorkspace(config, workspace);
    for (const id of removedIds)
        removeWorkspaceDirectory(config, id);
    if (removedIds.length > 0)
        syncDirectory(workspacesDirectory(config));
    writeFileAtomic(indexFile(config), JSON.stringify({ version: INDEX_VERSION, workspaces: index }), { durable: false });
}
/**
 * Writes a workspace as doc.json plus the large values it references, each stored
 * once under blobs/ by content hash. The document is renamed into place last, so
 * every reference a readable document holds resolves.
 */
function writeWorkspace(config, workspace) {
    const directory = workspaceDirectory(config, workspace.id);
    const blobsDirectory = join(directory, BLOBS_DIRECTORY);
    const createdDirectory = mkdirSync(blobsDirectory, { recursive: true });
    const blobs = new Map();
    const document = JSON.stringify({
        version: WORKSPACE_DOC_VERSION,
        workspace: serializeWorkspace(workspace, (value) => externalize(value, blobs)),
    });
    let wroteBlob = false;
    for (const [hash, value] of blobs) {
        const path = blobFile(blobsDirectory, hash);
        if (existsSync(path))
            continue;
        const json = canonicalJson(value);
        if (sha256Hex(json) !== hash) {
            throw new Error('A persisted workspace value changed after it was hashed.');
        }
        writeFileAtomic(path, json);
        wroteBlob = true;
    }
    if (wroteBlob)
        syncDirectory(blobsDirectory);
    writeFileAtomic(docFile(directory), document);
    syncDirectory(directory);
    if (createdDirectory !== undefined)
        syncDirectory(workspacesDirectory(config));
    removeUnreferencedBlobs(blobsDirectory, blobs);
}
function externalize(value, blobs) {
    if (typeof value !== 'object' || value === null)
        return value;
    const { hash, bytes } = digestOf(value);
    if (bytes < INLINE_VALUE_BYTES)
        return value;
    blobs.set(hash, value);
    return { [BLOB_REF_KEY]: hash };
}
function removeUnreferencedBlobs(blobsDirectory, referenced) {
    try {
        for (const name of readdirSync(blobsDirectory)) {
            const hash = name.endsWith(BLOB_SUFFIX) ? name.slice(0, -BLOB_SUFFIX.length) : undefined;
            if (hash === undefined || !referenced.has(hash))
                removeFileIfPresent(join(blobsDirectory, name));
        }
    }
    catch (error) {
        logger().warn({ err: errorMessage(error) }, 'Could not remove unreferenced workspace values; they are ignored');
    }
}
/**
 * Registers the persisted workspaces with the store without reading them; each
 * is parsed and restored when first accessed. The legacy single-file state is
 * set aside once and ignored.
 */
export function loadSessions(store, config) {
    if (!config.files.persistSessions)
        return 0;
    retireLegacySessionFile(config);
    const retained = evictBeyondCapacity(store, config, readWorkspaceIndex(config));
    recordAvailableRecoveryArchives(store, config);
    store.registerUnloaded(retained, (id) => hydrateWorkspace(store, config, id));
    return retained.length;
}
function retireLegacySessionFile(config) {
    const legacy = stateFile(config);
    if (!existsSync(legacy))
        return;
    try {
        renameSync(legacy, `${legacy}${LEGACY_BACKUP_SUFFIX}`);
        syncDirectory(dirname(legacy));
    }
    catch (error) {
        throw asSessionPersistenceError(error, { operation: 'retire legacy session file' });
    }
    logger().info({ path: legacy }, 'Legacy single-file session state renamed to .bak and ignored; starting without it');
}
/** Sets aside per-workspace `<id>.json` files from the earlier layout; they are ignored. */
function retireLegacyWorkspaceFiles(directory, names) {
    if (names.length === 0)
        return;
    try {
        for (const name of names) {
            const path = join(directory, name);
            renameSync(path, `${path}${LEGACY_BACKUP_SUFFIX}`);
        }
        syncDirectory(directory);
    }
    catch (error) {
        throw asSessionPersistenceError(error, { operation: 'retire legacy workspace files' });
    }
    logger().info({ files: names.length }, 'Legacy per-workspace files renamed to .bak and ignored; starting without them');
}
function readWorkspaceIndex(config) {
    const directory = workspacesDirectory(config);
    let children;
    try {
        children = readdirSync(directory, { withFileTypes: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw asSessionPersistenceError(error, { operation: 'list persisted workspaces' });
    }
    retireLegacyWorkspaceFiles(directory, children.filter((child) => child.isFile() && child.name.endsWith(LEGACY_WORKSPACE_SUFFIX))
        .map((child) => child.name));
    const index = readIndexFile(config);
    const entries = [];
    for (const child of children) {
        if (!child.isDirectory())
            continue;
        const id = workspaceIdOfDirectory(child.name);
        if (id === undefined)
            continue;
        const path = docFile(join(directory, child.name));
        let modifiedAt;
        try {
            modifiedAt = statSync(path).mtimeMs;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                continue;
            throw asSessionPersistenceError(error, { operation: 'list persisted workspaces' });
        }
        const indexed = index?.byId.get(id);
        // A document newer than the index means a crash between the document and index writes.
        entries.push(indexed && modifiedAt <= index.modifiedAt ? indexed : scanWorkspaceFile(path, id));
    }
    return entries;
}
function readIndexFile(config) {
    try {
        const path = indexFile(config);
        const modifiedAt = statSync(path).mtimeMs;
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.workspaces))
            return undefined;
        const byId = new Map();
        for (const value of parsed.workspaces) {
            if (typeof value.id !== 'string' || typeof value.lastAccessAt !== 'number' ||
                !Array.isArray(value.configurationIds) ||
                !value.configurationIds.every((id) => typeof id === 'string'))
                return undefined;
            byId.set(value.id, {
                id: value.id,
                lastAccessAt: value.lastAccessAt,
                configurationIds: value.configurationIds,
            });
        }
        return { modifiedAt, byId };
    }
    catch {
        return undefined;
    }
}
/** Rebuilds one index entry from a workspace document the index does not cover. */
function scanWorkspaceFile(path, id) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const workspace = parsed.workspace;
        return {
            id,
            lastAccessAt: typeof workspace?.lastAccessAt === 'number' ? workspace.lastAccessAt : 0,
            configurationIds: (workspace?.configurations ?? [])
                .map((configuration) => configuration.id)
                .filter((configId) => typeof configId === 'string'),
        };
    }
    catch {
        return { id, lastAccessAt: 0, configurationIds: [] };
    }
}
/** Removes the least recently used workspaces over capacity, keeping their content archived. */
function evictBeyondCapacity(store, config, entries) {
    const excess = entries.length - store.maxSessions;
    if (excess <= 0)
        return entries;
    const ordered = [...entries].sort((a, b) => a.lastAccessAt - b.lastAccessAt || a.id.localeCompare(b.id));
    const evicted = ordered.slice(0, excess);
    try {
        for (const entry of evicted) {
            preserveRecoveryArchive(config, recoverySourceBytes(config, entry.id, readFileSync(docFile(workspaceDirectory(config, entry.id)))), `Workspace ${entry.id} retained after eviction to enforce session capacity.`);
            removeWorkspaceDirectory(config, entry.id);
        }
        syncDirectory(workspacesDirectory(config));
    }
    catch (error) {
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
/** Restores one persisted workspace on first access; unusable ones are archived and removed. */
function hydrateWorkspace(store, config, id) {
    const path = docFile(workspaceDirectory(config, id));
    let sourceBytes;
    try {
        sourceBytes = readFileSync(path);
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            store.recordRestoreDiagnostics({
                warnings: [`Persisted workspace ${id} is missing; it was not restored.`],
            });
            return;
        }
        throw asSessionPersistenceError(error, { operation: 'read persisted workspace' });
    }
    const parsed = parseWorkspaceDoc(config, sourceBytes, id);
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
        discardWorkspace(config, id);
        logger().warn({ path, archiveId: archive.id }, 'Could not load a persisted workspace; an exact recovery archive was retained');
        return;
    }
    const report = store.restoreLazily(normalizeValidationJobs(parsed.workspaces));
    if (report.normalizationRequired) {
        const reasons = report.quarantined.length > 0
            ? [`${report.quarantined.length} record(s) could not be restored losslessly`]
            : [];
        const sourceArchive = preserveRecoveryArchive(config, recoverySourceBytes(config, id, sourceBytes), `Original workspace file retained${reasons.length > 0 ? `: ${reasons.join('; ')}` : ''}.`);
        store.recordRestoreDiagnostics({ recoveryArchives: mergeRecoveryArchives(config, sourceArchive) });
    }
    else if (report.canonicalRewriteReasons.length > 0) {
        const sourceArchive = preserveRecoveryArchive(config, recoverySourceBytes(config, id, sourceBytes), `Original workspace file retained before safe canonical rewrite: ${report.canonicalRewriteReasons.join(' ')}`);
        store.recordRestoreDiagnostics({ recoveryArchives: mergeRecoveryArchives(config, sourceArchive) });
    }
    if (report.restored === 0) {
        discardWorkspace(config, id);
    }
    else if (!report.normalizationRequired && report.canonicalRewriteReasons.length > 0) {
        const workspace = store.peekWorkspace(id);
        try {
            if (workspace)
                writeWorkspace(config, workspace);
        }
        catch (error) {
            throw asSessionPersistenceError(error, { operation: 'v2 clone ownership canonical migration' });
        }
    }
    logRestoreWarnings(report, path);
}
class BlobReadError extends Error {
}
function blobRefHash(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== BLOB_REF_KEY)
        return undefined;
    const hash = value[BLOB_REF_KEY];
    return typeof hash === 'string' && BLOB_HASH_PATTERN.test(hash) ? hash : undefined;
}
function readBlob(blobsDirectory, hash) {
    let bytes;
    try {
        bytes = readFileSync(blobFile(blobsDirectory, hash));
    }
    catch {
        throw new BlobReadError(`value ${hash} is missing`);
    }
    if (sha256Hex(bytes) !== hash)
        throw new BlobReadError(`value ${hash} failed its integrity check`);
    try {
        return JSON.parse(bytes.toString('utf8'));
    }
    catch {
        throw new BlobReadError(`value ${hash} is not valid JSON`);
    }
}
/** Parses a document and replaces each reference by its value; equal references share one object. */
function readDocument(config, id, bytes, loaded = new Map()) {
    const blobsDirectory = join(workspaceDirectory(config, id), BLOBS_DIRECTORY);
    return JSON.parse(bytes.toString('utf8'), (_key, value) => {
        const hash = blobRefHash(value);
        if (hash === undefined)
            return value;
        if (!loaded.has(hash))
            loaded.set(hash, readBlob(blobsDirectory, hash));
        return loaded.get(hash);
    });
}
/** The document with every value inline, so an archive stays complete after its values are collected. */
function recoverySourceBytes(config, id, documentBytes) {
    try {
        const loaded = new Map();
        const parsed = readDocument(config, id, documentBytes, loaded);
        if (loaded.size === 0)
            return documentBytes;
        return Buffer.from(JSON.stringify({ version: SNAPSHOT_VERSION, workspaces: [parsed.workspace] }), 'utf8');
    }
    catch {
        return documentBytes;
    }
}
function parseWorkspaceDoc(config, bytes, id) {
    let parsed;
    try {
        parsed = readDocument(config, id, bytes);
    }
    catch (error) {
        if (error instanceof BlobReadError) {
            return {
                kind: 'unreadable-session-value',
                warning: `Persisted workspace ${id} references a value that cannot be read (${error.message}); it was not restored.`,
            };
        }
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
    const payload = parsed;
    if (payload.version !== WORKSPACE_DOC_VERSION) {
        return {
            kind: 'unsupported-session-snapshot',
            version: payload.version,
            warning: `Unsupported session snapshot version ${String(payload.version)} for workspace ${id}; it was not restored.`,
        };
    }
    const workspace = payload.workspace;
    if (typeof workspace !== 'object' || workspace === null || Array.isArray(workspace) ||
        typeof workspace.id !== 'string' || workspace.id.trim() !== id) {
        return {
            kind: 'invalid-session-envelope',
            warning: `Persisted workspace file for ${id} does not hold exactly that workspace; it was not restored.`,
        };
    }
    return { workspaces: [workspace] };
}
function discardWorkspace(config, id) {
    try {
        removeWorkspaceDirectory(config, id);
        syncDirectory(workspacesDirectory(config));
    }
    catch (error) {
        throw asSessionPersistenceError(error, { operation: 'discard unusable persisted workspace' });
    }
}
function removeWorkspaceDirectory(config, id) {
    rmSync(workspaceDirectory(config, id), { recursive: true, force: true });
}
export function workspacesDirectory(config) {
    return join(stateDirectory(config), 'workspaces');
}
function stateDirectory(config) {
    return dirname(stateFile(config));
}
function indexFile(config) {
    return join(stateDirectory(config), 'workspace-index.json');
}
export function workspaceDirectory(config, id) {
    const name = encodeURIComponent(id).replace(/^\.+$/, (dots) => dots.replaceAll('.', '%2E'));
    return join(workspacesDirectory(config), name);
}
/** The document of one workspace; its large values live next to it under blobs/. */
export function workspaceFile(config, id) {
    return docFile(workspaceDirectory(config, id));
}
export function workspaceBlobsDirectory(config, id) {
    return join(workspaceDirectory(config, id), BLOBS_DIRECTORY);
}
function docFile(directory) {
    return join(directory, DOC_FILE);
}
function blobFile(blobsDirectory, hash) {
    return join(blobsDirectory, `${hash}${BLOB_SUFFIX}`);
}
function workspaceIdOfDirectory(name) {
    try {
        return decodeURIComponent(name);
    }
    catch {
        return undefined;
    }
}
function removeFileIfPresent(path) {
    try {
        unlinkSync(path);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
/** Writes a temporary file and renames it over the target; durable also syncs the file first. */
function writeFileAtomic(path, data, { durable = true } = {}) {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    let fd;
    try {
        fd = openSync(tmp, 'wx', 0o600);
        writeFileSync(fd, data);
        if (durable)
            fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(tmp, path);
    }
    catch (error) {
        if (fd !== undefined)
            closeSync(fd);
        try {
            unlinkSync(tmp);
        }
        catch {
            // The temporary path may not exist or may already have been renamed.
        }
        throw error;
    }
}
function recordAvailableRecoveryArchives(store, config) {
    const recoveryArchives = listSessionRecoveryArchives(config);
    if (recoveryArchives.length > 0)
        store.recordRestoreDiagnostics({ recoveryArchives });
}
function mergeRecoveryArchives(config, current) {
    const byId = new Map(listSessionRecoveryArchives(config).map((archive) => [archive.id, archive]));
    // Prefer the reason from this startup over generic metadata fallback.
    byId.set(current.id, current);
    return [...byId.values()];
}
function preserveRecoveryArchive(config, bytes, reasonValue) {
    const hash = sha256Hex(bytes);
    const id = `recovery_${hash}`;
    const path = recoveryArchivePath(config, hash);
    const reason = reasonValue.trim().slice(0, RECOVERY_REASON_LIMIT) ||
        'Preserved session state with recovery diagnostics.';
    try {
        mkdirSync(dirname(path), { recursive: true });
    }
    catch (error) {
        throw asSessionPersistenceError(error, { operation: 'preserve session recovery archive' });
    }
    if (existsSync(path)) {
        let existing;
        try {
            existing = readRecoveryBytes(path);
        }
        catch (error) {
            throw asSessionPersistenceError(error, { operation: 'preserve session recovery archive' });
        }
        if (sha256Hex(existing) !== hash) {
            throw asSessionPersistenceError(new Error('Existing session recovery archive failed its integrity check.'), { operation: 'preserve session recovery archive' });
        }
    }
    else {
        try {
            writeFileAtomic(path, bytes);
            syncDirectory(dirname(path));
        }
        catch (error) {
            throw asSessionPersistenceError(error, { operation: 'preserve session recovery archive' });
        }
    }
    let stats;
    try {
        stats = statSync(path);
    }
    catch (error) {
        throw asSessionPersistenceError(error, { operation: 'preserve session recovery archive' });
    }
    const existingMetadata = readRecoveryMetadata(`${path}.meta.json`, hash);
    const createdAt = existingMetadata?.createdAt ?? safeCreatedAt(stats.birthtimeMs, stats.mtimeMs);
    writeRecoveryMetadata(path, { id, sha256: hash, bytes: bytes.length, createdAt, reason });
    return { id, sha256: hash, bytes: bytes.length, createdAt, reason };
}
function recoveryArchivePath(config, hash) {
    const path = stateFile(config);
    return join(dirname(path), `${basename(path)}.recovery-${hash}.bak`);
}
function readRecoveryBytes(path) {
    let fd;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const bytes = readFileSync(fd);
        closeSync(fd);
        return bytes;
    }
    catch (error) {
        if (fd !== undefined)
            closeSync(fd);
        throw error;
    }
}
function writeRecoveryMetadata(archivePath, metadata) {
    const path = `${archivePath}.meta.json`;
    if (existsSync(path))
        return;
    try {
        writeFileAtomic(path, JSON.stringify({ version: 1, ...metadata }));
        syncDirectory(dirname(path));
    }
    catch (error) {
        logger().warn({ archiveId: metadata.id, err: errorMessage(error) }, 'Could not write session recovery metadata; archive bytes remain available');
    }
}
function readRecoveryMetadata(path, expectedHash) {
    try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        if (value.id !== `recovery_${expectedHash}` || value.sha256 !== expectedHash ||
            typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0 ||
            typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt < 0 ||
            typeof value.reason !== 'string' || value.reason.trim().length === 0)
            return undefined;
        return {
            id: value.id,
            sha256: value.sha256,
            bytes: value.bytes,
            createdAt: value.createdAt,
            reason: value.reason.slice(0, RECOVERY_REASON_LIMIT),
        };
    }
    catch {
        return undefined;
    }
}
function safeCreatedAt(birthtimeMs, mtimeMs) {
    if (Number.isFinite(birthtimeMs) && birthtimeMs > 0)
        return Math.floor(birthtimeMs);
    if (Number.isFinite(mtimeMs) && mtimeMs > 0)
        return Math.floor(mtimeMs);
    return 0;
}
function normalizeValidationJobs(workspaces) {
    const now = Date.now();
    return workspaces.map((workspace) => {
        if (typeof workspace !== 'object' || workspace === null || Array.isArray(workspace)) {
            return workspace;
        }
        const record = workspace;
        const serverState = record['serverState'];
        if (typeof serverState !== 'object' || serverState === null || Array.isArray(serverState) ||
            !Object.hasOwn(serverState, VALIDATION_JOBS_STATE_KEY)) {
            return workspace;
        }
        return {
            ...record,
            serverState: {
                ...serverState,
                [VALIDATION_JOBS_STATE_KEY]: loadValidationJobs(serverState, now),
            },
        };
    });
}
const keepInline = (value) => value;
function serializeWorkspace(workspace, encode) {
    return {
        id: workspace.id,
        label: workspace.label,
        locale: workspace.locale,
        solution: workspace.solution,
        validationMode: workspace.validationMode,
        configurations: [...workspace.configurations.values()].map((session) => serializeConfiguration(session, encode)),
        rackArea: encode(workspace.rackArea),
        nonRackArea: encode(workspace.nonRackArea),
        serverState: encode(workspace.serverState),
        rackSummaries: encode(workspace.rackSummaries),
        cables: encode(workspace.cables),
        floorItems: encode(workspace.floorItems),
        powerSelections: encode(workspace.powerSelections),
        integrity: workspace.integrity,
        integrityWarnings: workspace.integrityWarnings,
        recoveryData: encode(workspace.recoveryData),
        history: serializeHistory(workspace.history, encode),
        revision: workspace.revision,
        createdAt: workspace.createdAt,
        lastAccessAt: workspace.lastAccessAt,
        pricedAt: workspace.pricedAt,
    };
}
function serializeConfiguration(session, encode) {
    return {
        id: session.id,
        label: session.label,
        product: session.product,
        mode: session.mode,
        validationMode: session.validationMode,
        autoCorrect: session.autoCorrect,
        raw: encode(session.raw),
        configurationId: session.configurationId,
        primed: session.primed,
        configurable: session.configurable,
        revision: session.revision,
        intents: session.intents,
        snapshots: session.snapshots.slice(-MAX_SNAPSHOTS_PERSISTED).map((snapshot) => ({
            revision: snapshot.revision,
            raw: encode(snapshot.raw),
        })),
        createdAt: session.createdAt,
        lastAccessAt: session.lastAccessAt,
        pricedAt: session.pricedAt,
    };
}
function serializeHistory(history, encode) {
    if (!history)
        return history;
    const entries = (list) => list.map((entry) => ({ revision: entry.revision, state: serializeHistoryState(entry.state, encode) }));
    return { undo: entries(history.undo), redo: entries(history.redo) };
}
function serializeHistoryState(state, encode) {
    const encoded = {};
    for (const [key, value] of Object.entries(state)) {
        encoded[key] = key === 'configurations' && Array.isArray(value)
            ? value.map((configuration) => ({
                ...configuration,
                raw: encode(configuration['raw']),
            }))
            : encode(value);
    }
    return encoded;
}
function logRestoreWarnings(report, path) {
    if (report.warnings.length === 0 && report.quarantined.length === 0)
        return;
    logger().warn({ path, warnings: report.warnings, quarantinedRecords: report.quarantined.length }, 'Loaded workspace with recovery diagnostics');
}
function syncDirectory(path) {
    const fd = openSync(path, 'r');
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
//# sourceMappingURL=persist.js.map