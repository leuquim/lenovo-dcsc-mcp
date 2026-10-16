import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config/load.js';
import { ConfigSchema, type Config } from '../src/config/schema.js';
import {
  artifactDir,
  cleanupExpiredArtifacts,
  writeExportBundle,
  writeRecoveryArtifact,
} from '../src/files/artifactStore.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dcsc-artifacts-'));
  temporaryRoots.push(root);
  return root;
}

function testConfig(root: string, files: Partial<Config['files']> = {}): Config {
  return ConfigSchema.parse({
    logLevel: 'error',
    files: {
      artifactDir: root,
      artifactTtlDays: 30,
      maxDownloadBytes: 1024 * 1024,
      maxUnzipBytes: 1024 * 1024,
      maxUnzipEntries: 20,
      maxCompressionRatio: 100,
      persistSessions: false,
      ...files,
    },
  });
}

describe('writeExportBundle', () => {
  it('enforces cumulative expanded bytes and entry counts at their exact boundaries', async () => {
    const root = temporaryRoot();
    const zip = fileZip([{ name: 'one.xml', content: '12345' }, { name: 'two.xml', content: '67890' }]);
    const accepted = await writeExportBundle(Readable.from([zip]), 'boundary',
      testConfig(join(root, 'accepted'), { maxUnzipBytes: 10, maxUnzipEntries: 2 }));
    expect(accepted.members).toHaveLength(2);
    for (const [name, bounds, error] of [
      ['bytes', { maxUnzipBytes: 9 }, /expands beyond/],
      ['entries', { maxUnzipEntries: 1 }, /too many entries/],
    ] as const) {
      const rejectedRoot = join(root, name);
      await expect(writeExportBundle(Readable.from([zip]), name, testConfig(rejectedRoot, bounds))).rejects.toThrow(error);
      expect(findFiles(rejectedRoot)).toEqual([]);
    }
  });

  it('rejects excessive expansion ratios and colliding extracted names without partial publication', async () => {
    const root = temporaryRoot();
    const content = 'x'.repeat(4000);
    const compressed = fileZip([{ name: 'large.xml', content, compressed: true }]);
    await expect(writeExportBundle(Readable.from([compressed]), 'ratio',
      testConfig(join(root, 'ratio'), { maxCompressionRatio: 2 }))).rejects.toThrow(/compression ratio/);
    expect(findFiles(join(root, 'ratio'))).toEqual([]);
    const allowed = await writeExportBundle(Readable.from([compressed]), 'ratio-allowed',
      testConfig(join(root, 'allowed'), { maxCompressionRatio: 4000 }));
    expect(readFileSync(allowed.members[0]!.path, 'utf8')).toBe(content);
    const collision = fileZip([{ name: 'one/two.xml', content: 'first' }, { name: 'one-two.xml', content: 'second' }]);
    await expect(writeExportBundle(Readable.from([collision]), 'collision',
      testConfig(join(root, 'collision')))).rejects.toThrow(/duplicate output name/);
    expect(findFiles(join(root, 'collision'))).toEqual([]);
  });

  it('cleans up truncated archives and interrupted downloads', async () => {
    const root = temporaryRoot();
    const zip = singleFileZip('configuration.xml', '<CFXML />');
    await expect(writeExportBundle(Readable.from([zip.subarray(0, zip.length - 5)]), 'truncated',
      testConfig(join(root, 'truncated')))).rejects.toThrow();
    expect(findFiles(join(root, 'truncated'))).toEqual([]);
    const stream = Readable.from((async function* () {
      yield zip.subarray(0, 12);
      throw new Error('download interrupted');
    })());
    await expect(writeExportBundle(stream, 'interrupted', testConfig(join(root, 'interrupted'))))
      .rejects.toThrow(/download interrupted/);
    expect(findFiles(join(root, 'interrupted'))).toEqual([]);
  });
  it('streams, hashes, extracts and atomically publishes a uniquely named bundle', async () => {
    const root = temporaryRoot();
    const zip = singleFileZip('configuration.xml', '<CFXML />');
    // The exact configured boundary is accepted; only byte N+1 is rejected.
    const config = testConfig(root, { maxDownloadBytes: zip.length });

    const first = await writeExportBundle(Readable.from([zip]), 'quote', config);
    const second = await writeExportBundle(Readable.from([zip]), 'quote', config);

    expect(first.bytes).toBe(zip.length);
    expect(first.sha256).toBe(createHash('sha256').update(zip).digest('hex'));
    expect(first.sha256).toHaveLength(64);
    expect(first.zipPath).not.toBe(second.zipPath);
    expect(first.xml).toBeDefined();
    expect(readFileSync(first.xml!, 'utf8')).toBe('<CFXML />');
    expect(readdirSync(dirname(first.zipPath))).not.toContain(
      expect.stringMatching(/^\..*\.tmp$/),
    );

    const manifest = JSON.parse(
      readFileSync(join(dirname(first.zipPath), 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      owner: 'lenovo-dcsc-export',
      version: 1,
      status: 'complete',
      sha256: first.sha256,
    });
  });

  it('keeps an in-progress bundle private and outside retention cleanup', async () => {
    const root = temporaryRoot();
    const zip = singleFileZip('configuration.xml', '<CFXML />');
    const config = testConfig(root, { artifactTtlDays: 0 });
    const source = new PassThrough();

    const pending = writeExportBundle(source, 'in-progress', config);
    source.write(zip.subarray(0, 16));
    const dayDir = join(root, new Date().toISOString().slice(0, 10));
    const duringWrite = readdirSync(dayDir);
    expect(duringWrite).toHaveLength(1);
    expect(duringWrite[0]).toMatch(/^\..*\.tmp$/);

    cleanupExpiredArtifacts(config, Date.now() + 24 * 60 * 60 * 1_000);
    expect(readdirSync(dayDir)).toEqual(duringWrite);

    source.end(zip.subarray(16));
    const bundle = await pending;
    expect(existsSync(bundle.zipPath)).toBe(true);
    expect(readdirSync(dayDir).some((entry) => entry.startsWith('.'))).toBe(false);
  });

  it('rejects an oversized stream before publishing and removes partial output', async () => {
    const root = temporaryRoot();
    const zip = singleFileZip('configuration.xml', '<CFXML />');
    const config = testConfig(root, { maxDownloadBytes: zip.length - 1 });

    await expect(
      writeExportBundle(
        Readable.from([zip.subarray(0, 16), zip.subarray(16)]),
        'too-large',
        config,
      ),
    ).rejects.toThrow(`configured download limit of ${zip.length - 1} bytes`);

    expect(findFiles(root)).toEqual([]);
  });

  it('does not publish an HTTP-200 error body and removes its staging directory', async () => {
    const root = temporaryRoot();
    const config = testConfig(root);

    await expect(
      writeExportBundle(Readable.from(['not a zip']), 'bad-response', config),
    ).rejects.toThrow('body is not a ZIP archive');

    expect(findFiles(root)).toEqual([]);
  });
});

describe('writeRecoveryArtifact', () => {
  it('publishes exact JSON inside the owned artifact root with hash and manifest', async () => {
    const root = temporaryRoot();
    const config = testConfig(root);
    const json = JSON.stringify({ version: 2, workspaces: [{ recoveryData: [{ opaque: true }] }] });

    const artifact = await writeRecoveryArtifact(json, '../../private/recovery.json', config);

    expect(resolve(artifact.path).startsWith(resolve(root) + sep)).toBe(true);
    expect(artifact.path).not.toContain('..');
    expect(readFileSync(artifact.path, 'utf8')).toBe(json);
    expect(artifact.bytes).toBe(Buffer.byteLength(json));
    expect(artifact.sha256).toBe(createHash('sha256').update(json).digest('hex'));
    expect(artifact.format).toBe('lenovo-dcsc-session-snapshot-v2');
    expect(JSON.parse(readFileSync(join(dirname(artifact.path), 'manifest.json'), 'utf8')))
      .toMatchObject({
        owner: 'lenovo-dcsc-export',
        version: 1,
        status: 'complete',
        kind: 'recovery-json',
        path: artifact.path,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      });
  });

  it('enforces the download byte bound and removes unpublished partial output', async () => {
    const root = temporaryRoot();
    const config = testConfig(root, { maxDownloadBytes: 8 });
    await expect(
      writeRecoveryArtifact(JSON.stringify({ content: 'too large' }), 'recovery', config),
    ).rejects.toThrow('Recovery artifact exceeded the configured download limit of 8 bytes');
    expect(findFiles(root)).toEqual([]);
  });
});

describe('cleanupExpiredArtifacts', () => {
  it('does not follow date, artifact or manifest symlinks into another directory', () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const target = makeArtifact(outside, 'foreign', { owner: 'lenovo-dcsc-mcp', version: 1,
      status: 'complete', createdAt: '2000-01-01T00:00:00Z' });
    symlinkSync(dirname(target), join(root, '2000-01-01'), 'dir');
    const day = join(root, '2000-01-02');
    mkdirSync(day);
    symlinkSync(target, join(day, 'linked-artifact'), 'dir');
    const linkedManifest = join(day, 'linked-manifest');
    mkdirSync(linkedManifest);
    symlinkSync(join(target, 'manifest.json'), join(linkedManifest, 'manifest.json'));
    writeFileSync(join(linkedManifest, 'payload.bin'), 'retain');
    expect(cleanupExpiredArtifacts(testConfig(root)).removed).toEqual([]);
    expect(readFileSync(join(target, 'payload.bin'), 'utf8')).toBe('owned only when the marker says so');
    expect(readFileSync(join(linkedManifest, 'payload.bin'), 'utf8')).toBe('retain');
  });
  it('expires only old, completed, MCP-owned exports', () => {
    const root = temporaryRoot();
    const config = testConfig(root, { artifactTtlDays: 7 });
    const now = Date.parse('2026-10-15T12:00:00.000Z');

    const expired = makeArtifact(root, 'expired', {
      owner: 'lenovo-dcsc-export',
      version: 1,
      status: 'complete',
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    const recent = makeArtifact(root, 'recent', {
      owner: 'lenovo-dcsc-export',
      version: 1,
      status: 'complete',
      createdAt: '2026-10-14T00:00:00.000Z',
    });
    const userImport = makeArtifact(root, 'user-import', {
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    const incomplete = makeArtifact(root, 'incomplete', {
      owner: 'lenovo-dcsc-export',
      version: 1,
      status: 'writing',
      createdAt: '2020-01-01T00:00:00.000Z',
    });

    const result = cleanupExpiredArtifacts(config, now);

    expect(result.removed).toEqual([expired]);
    expect(result.warnings).toEqual([]);
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(userImport)).toBe(true);
    expect(existsSync(incomplete)).toBe(true);
  });
});

describe('artifact environment settings', () => {
  it('maps every download and extraction bound from DCSC_* variables', () => {
    const root = temporaryRoot();
    const configFile = join(root, 'config.json');
    writeFileSync(configFile, '{}');
    vi.stubEnv('DCSC_CONFIG', configFile);
    vi.stubEnv('DCSC_ARTIFACT_DIR', join(root, 'exports'));
    vi.stubEnv('DCSC_ARTIFACT_TTL_DAYS', '9');
    vi.stubEnv('DCSC_MAX_DOWNLOAD_BYTES', '1234');
    vi.stubEnv('DCSC_MAX_UNZIP_BYTES', '5678');
    vi.stubEnv('DCSC_MAX_UNZIP_ENTRIES', '12');
    vi.stubEnv('DCSC_MAX_COMPRESSION_RATIO', '42.5');

    const config = loadConfig();

    expect(config.files).toMatchObject({
      artifactDir: join(root, 'exports'),
      artifactTtlDays: 9,
      maxDownloadBytes: 1234,
      maxUnzipBytes: 5678,
      maxUnzipEntries: 12,
      maxCompressionRatio: 42.5,
    });
  });

  it('applies artifact defaults, file, environment and explicit overrides in order', () => {
    const root = temporaryRoot();
    const configFile = join(root, 'config.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        files: {
          artifactDir: join(root, 'from-file'),
          artifactTtlDays: 2,
          maxDownloadBytes: 2_000,
          maxUnzipBytes: 3_000,
          maxUnzipEntries: 20,
          maxCompressionRatio: 10,
        },
      }),
    );
    vi.stubEnv('DCSC_CONFIG', configFile);
    vi.stubEnv('DCSC_ARTIFACT_DIR', join(root, 'from-env'));
    vi.stubEnv('DCSC_ARTIFACT_TTL_DAYS', '3');
    vi.stubEnv('DCSC_MAX_DOWNLOAD_BYTES', '4000');
    vi.stubEnv('DCSC_MAX_UNZIP_BYTES', '5000');
    vi.stubEnv('DCSC_MAX_UNZIP_ENTRIES', '30');
    vi.stubEnv('DCSC_MAX_COMPRESSION_RATIO', '20');

    const config = loadConfig({
      files: {
        artifactDir: join(root, 'from-override'),
        maxDownloadBytes: 6_000,
      },
    });

    expect(config.files).toMatchObject({
      artifactDir: join(root, 'from-override'),
      artifactTtlDays: 3,
      maxDownloadBytes: 6_000,
      maxUnzipBytes: 5_000,
      maxUnzipEntries: 30,
      maxCompressionRatio: 20,
    });
  });

  it('uses XDG_DATA_HOME only when no artifact directory is configured', () => {
    const root = temporaryRoot();
    vi.stubEnv('XDG_DATA_HOME', join(root, 'xdg-data'));
    const config = ConfigSchema.parse({ files: { persistSessions: false } });

    expect(artifactDir(config)).toBe(join(root, 'xdg-data', 'lenovo-dcsc', 'artifacts'));
    expect(
      artifactDir(ConfigSchema.parse({ files: { artifactDir: join(root, 'explicit') } })),
    ).toBe(join(root, 'explicit'));
  });
});

function makeArtifact(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
): string {
  const dir = join(root, '2026-10-01', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'payload.bin'), 'owned only when the marker says so');
  return dir;
}

function findFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else out.push(path);
    }
  };
  visit(root);
  return out;
}

function singleFileZip(name: string, content: string): Buffer {
  return fileZip([{ name, content }]);
}

function fileZip(files: Array<{ name: string; content: string; compressed?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let centralOffset = 0;
  for (const file of files) {
    const fileName = Buffer.from(file.name);
    const data = Buffer.from(file.content);
    const stored = file.compressed ? deflateRawSync(data) : data;
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(file.compressed ? 8 : 0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(file.compressed ? 8 : 0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(centralOffset, 42);
    locals.push(local, fileName, stored);
    centrals.push(central, fileName);
    centralOffset += local.length + fileName.length + stored.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centrals.reduce((sum, chunk) => sum + chunk.length, 0), 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([...locals, ...centrals, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
