import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { MAGIC_BYTES } from '../config/constants.js';
const OWNED_ARTIFACT = 'lenovo-dcsc-export';
const OWNED_ARTIFACT_VERSION = 1;
const PREVIEW_BYTES = 200;
const MAX_MANIFEST_BYTES = 64 * 1024;
const DAY_DIRECTORY = /^\d{4}-\d{2}-\d{2}$/;
/** Final artifact directories currently being published in this process. */
const activeArtifacts = new Set();
export function artifactDir(config) {
    if (config.files.artifactDir)
        return config.files.artifactDir;
    const base = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
    return join(base, 'lenovo-dcsc', 'artifacts');
}
/**
 * Filenames from `Content-Disposition` are a display label, never a path.
 * Strip separators and traversal, cap the length, and keep it to a safe charset.
 */
export function sanitiseFileName(name) {
    const cleaned = name
        .replace(/[\\/]/g, '-')
        .replace(/\.\./g, '-')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/[^A-Za-z0-9._-]/g, '-')
        .replace(/^[-.]+/, '')
        .slice(0, 120);
    return cleaned.length > 0 ? cleaned : 'export';
}
/**
 * Removes only completed export bundles that this module marked as owned.
 *
 * Unmarked directories, user imports, symlinks and in-progress publications
 * are deliberately ignored. A caller may run this concurrently with an export:
 * staging directories are hidden and a final directory remains in activeArtifacts
 * until writeExportBundle has returned.
 */
export function cleanupExpiredArtifacts(config, nowMs = Date.now()) {
    const root = resolve(artifactDir(config));
    const cutoff = nowMs - config.files.artifactTtlDays * 24 * 60 * 60 * 1_000;
    const removed = [];
    const warnings = [];
    let days;
    try {
        days = readdirSync(root, { withFileTypes: true });
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return { removed, warnings };
        return {
            removed,
            warnings: [`Could not inspect artifact retention directory: ${errorMessage(err)}`],
        };
    }
    for (const day of days) {
        if (!day.isDirectory() || !DAY_DIRECTORY.test(day.name))
            continue;
        const dayPath = resolve(root, day.name);
        if (!isInside(root, dayPath))
            continue;
        let candidates;
        try {
            candidates = readdirSync(dayPath, { withFileTypes: true });
        }
        catch (err) {
            warnings.push(`Could not inspect artifact directory ${dayPath}: ${errorMessage(err)}`);
            continue;
        }
        for (const candidate of candidates) {
            if (!candidate.isDirectory() || candidate.name.startsWith('.'))
                continue;
            const candidatePath = resolve(dayPath, candidate.name);
            if (!isInside(root, candidatePath) || activeArtifacts.has(candidatePath))
                continue;
            try {
                const stat = lstatSync(candidatePath);
                if (!stat.isDirectory() || stat.isSymbolicLink())
                    continue;
                const manifestPath = join(candidatePath, 'manifest.json');
                const manifestStat = lstatSync(manifestPath);
                if (!manifestStat.isFile() ||
                    manifestStat.isSymbolicLink() ||
                    manifestStat.size > MAX_MANIFEST_BYTES) {
                    continue;
                }
                const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
                if (manifest.owner !== OWNED_ARTIFACT ||
                    manifest.version !== OWNED_ARTIFACT_VERSION ||
                    manifest.status !== 'complete' ||
                    typeof manifest.createdAt !== 'string') {
                    continue;
                }
                const createdAt = Date.parse(manifest.createdAt);
                if (!Number.isFinite(createdAt) || createdAt >= cutoff)
                    continue;
                rmSync(candidatePath, { recursive: true, force: true });
                removed.push(candidatePath);
            }
            catch (err) {
                const code = err.code;
                // A directory without our manifest is not ours to manage.
                if (code !== 'ENOENT') {
                    warnings.push(`Could not inspect or expire artifact ${candidatePath}: ${errorMessage(err)}`);
                }
            }
        }
        // Remove the date container only when it became empty. Never recurse here.
        try {
            if (readdirSync(dayPath).length === 0)
                rmSync(dayPath);
        }
        catch {
            // Another export may have created an entry between the read and removal.
        }
    }
    return { removed, warnings };
}
/**
 * Streams the export into a private staging directory, verifies and extracts it,
 * then publishes the whole bundle with one directory rename.
 *
 * The download limit is enforced before each chunk reaches disk. Hashing and the
 * error preview are gathered during that same pass, so the completed ZIP is never
 * read back into memory.
 */
export async function writeExportBundle(stream, fileName, config) {
    const cleanup = cleanupExpiredArtifacts(config);
    const root = resolve(artifactDir(config));
    const day = new Date().toISOString().slice(0, 10);
    const dayDir = join(root, day);
    const safeName = sanitiseFileName(fileName);
    const artifactName = `${safeName}-${randomUUID()}`;
    const finalDir = resolve(dayDir, artifactName);
    const stagingDir = resolve(dayDir, `.${artifactName}.tmp`);
    if (!isInside(root, finalDir) || !isInside(root, stagingDir)) {
        throw new Error('Refusing to write an export outside the configured artifact directory.');
    }
    mkdirSync(dayDir, { recursive: true });
    mkdirSync(stagingDir);
    activeArtifacts.add(finalDir);
    try {
        const stagedZipPath = join(stagingDir, `${safeName}.zip`);
        const inspection = new DownloadInspector(config.files.maxDownloadBytes);
        await pipeline(stream, inspection, createWriteStream(stagedZipPath, { flags: 'wx' }));
        const head = inspection.preview.subarray(0, 4);
        if (!head.equals(MAGIC_BYTES.zip) && !head.equals(MAGIC_BYTES.zipEmpty)) {
            const preview = inspection.preview.toString('utf8');
            throw new Error(`DCSC returned HTTP 200 but the body is not a ZIP archive (starts with ${JSON.stringify(preview.slice(0, 80))}). This is an error response disguised as a download.`);
        }
        const warnings = [...cleanup.warnings];
        if (head.equals(MAGIC_BYTES.zipEmpty)) {
            warnings.push('DCSC returned an empty archive. This usually means no export formats were accepted.');
        }
        const stagedMembers = await unzip(stagedZipPath, stagingDir, config);
        const finalZipPath = join(finalDir, `${safeName}.zip`);
        const members = stagedMembers.map((member) => ({
            ...member,
            path: join(finalDir, 'extracted', sanitiseFileName(member.name)),
        }));
        const xml = members.find((member) => member.name.toLowerCase().endsWith('.xml'));
        const workbooks = members
            .filter((member) => /\.xlsx?$/i.test(member.name))
            .map((member) => member.path);
        if (!xml && !head.equals(MAGIC_BYTES.zipEmpty)) {
            warnings.push('No XML member found — this archive cannot be imported into Lenovo Bid Portal.');
        }
        const bundle = {
            zipPath: finalZipPath,
            bytes: inspection.bytes,
            sha256: inspection.digest(),
            members,
            ...(xml ? { xml: xml.path } : {}),
            workbooks,
            warnings,
        };
        writeFileSync(join(stagingDir, 'manifest.json'), JSON.stringify({
            owner: OWNED_ARTIFACT,
            version: OWNED_ARTIFACT_VERSION,
            status: 'complete',
            ...bundle,
            createdAt: new Date().toISOString(),
        }, null, 2), { encoding: 'utf8', flush: true });
        renameSync(stagingDir, finalDir);
        return bundle;
    }
    catch (err) {
        rmSync(stagingDir, { recursive: true, force: true });
        throw err;
    }
    finally {
        activeArtifacts.delete(finalDir);
    }
}
/**
 * Publishes a bounded JSON recovery snapshot through the same owned-artifact
 * lifecycle as downloaded exports. The supplied JSON is preserved byte for
 * byte; callers remain responsible for choosing the recovery envelope.
 */
export async function writeRecoveryArtifact(json, fileName, config) {
    try {
        JSON.parse(json);
    }
    catch {
        throw new Error('Recovery artifact content must be valid JSON.');
    }
    return writeRecoveryContent(Buffer.from(json, 'utf8'), fileName, config, 'lenovo-dcsc-session-snapshot-v2', 'json');
}
/** Corrupt source files must remain recoverable without decoding or JSON normalization. */
export async function writeRecoverySourceArtifact(bytes, fileName, config) {
    return writeRecoveryContent(bytes, fileName, config, 'lenovo-dcsc-session-source-bytes', 'bin');
}
async function writeRecoveryContent(bytes, fileName, config, format, extension) {
    if (bytes.length > config.files.maxDownloadBytes) {
        throw new Error(`Recovery artifact exceeded the configured download limit of ${config.files.maxDownloadBytes} bytes.`);
    }
    const cleanup = cleanupExpiredArtifacts(config);
    const root = resolve(artifactDir(config));
    const day = new Date().toISOString().slice(0, 10);
    const dayDir = join(root, day);
    const safeName = sanitiseFileName(fileName.replace(/\.json$/i, ''));
    const artifactName = `${safeName}-${randomUUID()}`;
    const finalDir = resolve(dayDir, artifactName);
    const stagingDir = resolve(dayDir, `.${artifactName}.tmp`);
    if (!isInside(root, finalDir) || !isInside(root, stagingDir)) {
        throw new Error('Refusing to write a recovery artifact outside the configured artifact directory.');
    }
    mkdirSync(dayDir, { recursive: true });
    mkdirSync(stagingDir);
    activeArtifacts.add(finalDir);
    try {
        const outputName = `${safeName}.${extension}`;
        const stagedPath = join(stagingDir, outputName);
        const finalPath = join(finalDir, outputName);
        const inspection = new DownloadInspector(config.files.maxDownloadBytes, 'Recovery artifact');
        await pipeline(Readable.from([bytes]), inspection, createWriteStream(stagedPath, { flags: 'wx' }));
        const artifact = {
            path: finalPath,
            bytes: inspection.bytes,
            sha256: inspection.digest(),
            format,
            warnings: [...cleanup.warnings],
        };
        writeFileSync(join(stagingDir, 'manifest.json'), JSON.stringify({
            owner: OWNED_ARTIFACT,
            version: OWNED_ARTIFACT_VERSION,
            status: 'complete',
            kind: extension === 'json' ? 'recovery-json' : 'recovery-source',
            ...artifact,
            createdAt: new Date().toISOString(),
        }, null, 2), { encoding: 'utf8', flush: true });
        renameSync(stagingDir, finalDir);
        return artifact;
    }
    catch (err) {
        rmSync(stagingDir, { recursive: true, force: true });
        throw err;
    }
    finally {
        activeArtifacts.delete(finalDir);
    }
}
class DownloadInspector extends Transform {
    maxBytes;
    subject;
    bytes = 0;
    #hash = createHash('sha256');
    #preview = Buffer.alloc(0);
    #digested = false;
    constructor(maxBytes, subject = 'DCSC export') {
        super();
        this.maxBytes = maxBytes;
        this.subject = subject;
    }
    get preview() {
        return this.#preview;
    }
    digest() {
        if (this.#digested)
            throw new Error('Export hash was already finalized.');
        this.#digested = true;
        return this.#hash.digest('hex');
    }
    _transform(chunk, encoding, callback) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        const nextBytes = this.bytes + data.length;
        if (nextBytes > this.maxBytes) {
            callback(new Error(`${this.subject} exceeded the configured download limit of ${this.maxBytes} bytes.`));
            return;
        }
        this.bytes = nextBytes;
        this.#hash.update(data);
        if (this.#preview.length < PREVIEW_BYTES) {
            const remaining = PREVIEW_BYTES - this.#preview.length;
            this.#preview = Buffer.concat([this.#preview, data.subarray(0, remaining)]);
        }
        callback(null, data);
    }
}
async function unzip(zipPath, dir, config) {
    const outDir = join(dir, 'extracted');
    mkdirSync(outDir, { recursive: true });
    const root = resolve(outDir);
    return new Promise((resolveP, reject) => {
        yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
            if (err || !zip)
                return reject(err ?? new Error('Could not open export archive'));
            const members = [];
            const outputNames = new Set();
            let totalBytes = 0;
            let entryCount = 0;
            zip.on('entry', (entry) => {
                entryCount += 1;
                if (entryCount > config.files.maxUnzipEntries) {
                    zip.close();
                    return reject(new Error('Export archive has too many entries.'));
                }
                // Directories, absolute paths and traversal are all rejected.
                if (entry.fileName.endsWith('/'))
                    return zip.readEntry();
                const safeName = sanitiseFileName(entry.fileName);
                if (outputNames.has(safeName)) {
                    zip.close();
                    return reject(new Error(`Export archive contains duplicate output name: ${safeName}`));
                }
                outputNames.add(safeName);
                const target = resolve(join(outDir, safeName));
                if (!isInside(root, target)) {
                    zip.close();
                    return reject(new Error(`Refusing to extract outside the target directory: ${entry.fileName}`));
                }
                totalBytes += entry.uncompressedSize;
                if (totalBytes > config.files.maxUnzipBytes) {
                    zip.close();
                    return reject(new Error('Export archive expands beyond the configured size limit.'));
                }
                if (entry.compressedSize > 0 &&
                    entry.uncompressedSize / entry.compressedSize > config.files.maxCompressionRatio) {
                    zip.close();
                    return reject(new Error(`Entry ${entry.fileName} has a suspicious compression ratio.`));
                }
                zip.openReadStream(entry, (rsErr, readStream) => {
                    if (rsErr || !readStream) {
                        zip.close();
                        return reject(rsErr ?? new Error('Could not read archive entry'));
                    }
                    pipeline(readStream, createWriteStream(target, { flags: 'wx' }))
                        .then(() => {
                        members.push({
                            name: entry.fileName,
                            bytes: entry.uncompressedSize,
                            path: target,
                        });
                        zip.readEntry();
                    })
                        .catch((streamErr) => {
                        zip.close();
                        reject(streamErr);
                    });
                });
            });
            zip.on('end', () => resolveP(members));
            zip.on('error', reject);
            zip.readEntry();
        });
    });
}
function isInside(root, candidate) {
    return candidate.startsWith(root + sep);
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=artifactStore.js.map