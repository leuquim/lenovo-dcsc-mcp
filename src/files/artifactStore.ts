import { createWriteStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import yauzl from 'yauzl';

import { MAGIC_BYTES } from '../config/constants.js';
import type { Config } from '../config/schema.js';

export interface ExportMember {
  name: string;
  bytes: number;
  path: string;
}

export interface ExportBundle {
  zipPath: string;
  bytes: number;
  sha256: string;
  members: ExportMember[];
  xml?: string;
  workbooks: string[];
  warnings: string[];
}

export function artifactDir(config: Config): string {
  if (config.files.artifactDir) return config.files.artifactDir;
  const base =
    process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(base, 'lenovo-dcsc', 'artifacts');
}

/**
 * Filenames from `Content-Disposition` are a display label, never a path.
 * Strip separators and traversal, cap the length, and keep it to a safe charset.
 */
export function sanitiseFileName(name: string): string {
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
 * Streams the export to disk, verifies it is genuinely a ZIP, then unpacks it.
 *
 * The magic-byte check is not optional: DCSC's form-POST endpoints return
 * errors with HTTP 200 and a Content-Disposition header, so trusting the status
 * code alone silently produces corrupt output.
 */
export async function writeExportBundle(
  stream: NodeJS.ReadableStream,
  fileName: string,
  config: Config,
): Promise<ExportBundle> {
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(artifactDir(config), day, sanitiseFileName(fileName));
  mkdirSync(dir, { recursive: true });

  const zipPath = join(dir, `${sanitiseFileName(fileName)}.zip`);
  await pipeline(stream, createWriteStream(zipPath));

  const bytes = statSync(zipPath).size;
  const buf = readFileSync(zipPath);
  const head = buf.subarray(0, 4);

  if (!head.equals(MAGIC_BYTES.zip) && !head.equals(MAGIC_BYTES.zipEmpty)) {
    const preview = buf.subarray(0, 200).toString('utf8');
    throw new Error(
      `DCSC returned HTTP 200 but the body is not a ZIP archive (starts with ${JSON.stringify(
        preview.slice(0, 80),
      )}). This is an error response disguised as a download.`,
    );
  }

  const warnings: string[] = [];
  if (head.equals(MAGIC_BYTES.zipEmpty)) {
    warnings.push(
      'DCSC returned an empty archive. This usually means no export formats were accepted.',
    );
  }

  const members = await unzip(zipPath, dir, config);
  const xml = members.find((m) => m.name.toLowerCase().endsWith('.xml'));
  const workbooks = members
    .filter((m) => /\.xlsx?$/i.test(m.name))
    .map((m) => m.path);

  if (!xml && !head.equals(MAGIC_BYTES.zipEmpty)) {
    warnings.push('No XML member found — this archive cannot be imported into Lenovo Bid Portal.');
  }

  const bundle: ExportBundle = {
    zipPath,
    bytes,
    sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16),
    members,
    ...(xml ? { xml: xml.path } : {}),
    workbooks,
    warnings,
  };

  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ ...bundle, createdAt: new Date().toISOString() }, null, 2),
  );

  return bundle;
}

async function unzip(zipPath: string, dir: string, config: Config): Promise<ExportMember[]> {
  const outDir = join(dir, 'extracted');
  mkdirSync(outDir, { recursive: true });
  const root = resolve(outDir);

  return new Promise<ExportMember[]>((resolveP, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('Could not open export archive'));

      const members: ExportMember[] = [];
      let totalBytes = 0;

      zip.on('entry', (entry: yauzl.Entry) => {
        if (members.length >= config.files.maxUnzipEntries) {
          zip.close();
          return reject(new Error('Export archive has too many entries.'));
        }
        // Directories, absolute paths and traversal are all rejected.
        if (entry.fileName.endsWith('/')) return zip.readEntry();

        const safeName = sanitiseFileName(entry.fileName);
        const target = resolve(join(outDir, safeName));
        if (!target.startsWith(root + sep)) {
          zip.close();
          return reject(new Error(`Refusing to extract outside the target directory: ${entry.fileName}`));
        }

        totalBytes += entry.uncompressedSize;
        if (totalBytes > config.files.maxUnzipBytes) {
          zip.close();
          return reject(new Error('Export archive expands beyond the configured size limit.'));
        }
        if (
          entry.compressedSize > 0 &&
          entry.uncompressedSize / entry.compressedSize > config.files.maxCompressionRatio
        ) {
          zip.close();
          return reject(new Error(`Entry ${entry.fileName} has a suspicious compression ratio.`));
        }

        zip.openReadStream(entry, (rsErr, readStream) => {
          if (rsErr || !readStream) {
            zip.close();
            return reject(rsErr ?? new Error('Could not read archive entry'));
          }
          pipeline(readStream, createWriteStream(target))
            .then(() => {
              members.push({
                name: entry.fileName,
                bytes: entry.uncompressedSize,
                path: target,
              });
              zip.readEntry();
            })
            .catch(reject);
        });
      });

      zip.on('end', () => resolveP(members));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}
