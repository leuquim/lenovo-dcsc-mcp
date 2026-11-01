/** Reading the ZIP archives the DCSC export endpoints return. */
import yauzl from 'yauzl';

export interface ZipMember { name: string; size: number; bytes: Buffer }

/** Every member of a ZIP archive, in stored order. */
export function readZip(zipPath: string): Promise<ZipMember[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error(`Could not open ${zipPath}.`));
      const members: ZipMember[] = [];
      zip.once('error', reject);
      zip.once('end', () => resolve(members));
      zip.on('entry', entry => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error(`Could not read ${entry.fileName}.`));
          const chunks: Buffer[] = [];
          stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
          stream.once('error', reject);
          stream.once('end', () => {
            const bytes = Buffer.concat(chunks);
            members.push({ name: entry.fileName, size: bytes.length, bytes });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

/** The text of the first member whose name ends with the suffix. */
export async function zipText(zipPath: string, suffix: string): Promise<string> {
  const member = (await readZip(zipPath)).find(entry => entry.name.toLowerCase().endsWith(suffix));
  if (!member) throw new Error(`${zipPath} contains no ${suffix} member.`);
  return member.bytes.toString('utf8');
}

const DATE_IN_NAME = /\d{4}-\d{2}-\d{2}|\d{8}_\d{6}/g;

/** Member names and sizes with embedded export dates removed, for comparing two exports of the same content. */
export async function zipListing(zipPath: string): Promise<Array<{ name: string; size: number }>> {
  return (await readZip(zipPath)).map(({ name, size }) => ({ name: name.replace(DATE_IN_NAME, '<date>'), size }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Archive member names with embedded dates removed, for comparing which reports two exports contain. */
export async function zipNames(zipPath: string): Promise<string[]> {
  return (await zipListing(zipPath)).map(member => member.name);
}
