import assert from 'node:assert/strict';
import path from 'node:path';
import yauzl from 'yauzl';

export interface WorkbookRow {
  number: number;
  cells: Record<string, string>;
  values: string[];
}

export interface WorkbookMedia {
  path: string;
  bytes: number;
  width: number | null;
  height: number | null;
}

export interface WorkbookSheet {
  name: string;
  path: string;
  rows: WorkbookRow[];
  media: WorkbookMedia[];
}

export interface WorkbookInspection {
  memberName: string;
  sheetNames: string[];
  sheets: Record<string, WorkbookSheet>;
  media: WorkbookMedia[];
}

function decodeXml(value: string): string {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&');
}

function relationships(xml: string, ownerPath: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*?)\/?>(?:<\/Relationship>)?/g)) {
    const attrs = match[1] ?? '';
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
    if (id && target && !/^[a-z]+:/i.test(target)) {
      result.set(id, path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), decodeXml(target))));
    }
  }
  return result;
}

function relsPath(ownerPath: string): string {
  return path.posix.join(path.posix.dirname(ownerPath), '_rels', `${path.posix.basename(ownerPath)}.rels`);
}

function xmlText(value: string): string {
  return [...value.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1] ?? '')).join('');
}

function parseRows(xml: string, sharedStrings: string[]): WorkbookRow[] {
  const rows: WorkbookRow[] = [];
  for (const match of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(/\br="(\d+)"/.exec(match[1] ?? '')?.[1] ?? 0);
    const cells: Record<string, string> = {};
    for (const cellMatch of (match[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] ?? '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      if (!ref) continue;
      const body = cellMatch[2] ?? '';
      const kind = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
      const value = kind === 's' ? sharedStrings[Number(raw)] ?? ''
        : kind === 'inlineStr' ? xmlText(body) : decodeXml(raw);
      if (value !== '') cells[ref] = value;
    }
    rows.push({ number: rowNumber, cells, values: Object.values(cells) });
  }
  return rows;
}

function pngDimensions(value: Buffer): { width: number | null; height: number | null } {
  if (value.length >= 24 && value.subarray(1, 4).toString('ascii') === 'PNG') {
    return { width: value.readUInt32BE(16), height: value.readUInt32BE(20) };
  }
  return { width: null, height: null };
}

export async function readZipEntries(input: string | Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const opened = (error: Error | null, zip?: yauzl.ZipFile): void => {
      if (error || !zip) return reject(error ?? new Error('Could not open ZIP.'));
      const entries = new Map<string, Buffer>();
      zip.readEntry();
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error(`Could not read ${entry.fileName}.`));
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.on('end', () => resolve(entries));
      zip.on('error', reject);
    };
    if (typeof input === 'string') yauzl.open(input, { lazyEntries: true }, opened);
    else yauzl.fromBuffer(input, { lazyEntries: true }, opened);
  });
}

export async function inspectExportWorkbook(zipPath: string): Promise<WorkbookInspection> {
  const outer = await readZipEntries(zipPath);
  const workbookMembers = [...outer].filter(([name, body]) => name.toLowerCase().endsWith('.xlsx') && body.length > 0);
  assert.equal(workbookMembers.length, 1, `Expected one nonempty XLSX member; found ${workbookMembers.length}.`);
  const [memberName, workbookBody] = workbookMembers[0]!;
  const files = await readZipEntries(workbookBody);
  const workbookPath = 'xl/workbook.xml';
  const workbookXml = files.get(workbookPath)?.toString('utf8');
  assert(workbookXml, 'XLSX has no workbook.xml.');
  const workbookRelsXml = files.get(relsPath(workbookPath))?.toString('utf8');
  assert(workbookRelsXml, 'XLSX has no workbook relationships.');
  const workbookRels = relationships(workbookRelsXml, workbookPath);
  const sharedStringsXml = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const sharedStrings = [...sharedStringsXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match => xmlText(match[1] ?? ''));
  const sheets: Record<string, WorkbookSheet> = {};
  const allMedia = new Map<string, WorkbookMedia>();
  for (const sheetMatch of workbookXml.matchAll(/<sheet\b([^>]*?)\/?>(?:<\/sheet>)?/g)) {
    const attrs = sheetMatch[1] ?? '';
    const name = decodeXml(/\bname="([^"]+)"/.exec(attrs)?.[1] ?? '');
    const relationshipId = /\br:id="([^"]+)"/.exec(attrs)?.[1];
    const sheetPath = relationshipId ? workbookRels.get(relationshipId) : undefined;
    assert(name && sheetPath, `Could not resolve worksheet ${name || relationshipId || '<unknown>'}.`);
    const sheetXml = files.get(sheetPath)?.toString('utf8');
    assert(sheetXml, `Missing worksheet ${sheetPath}.`);
    const sheetRelsXml = files.get(relsPath(sheetPath))?.toString('utf8') ?? '';
    const sheetRels = relationships(sheetRelsXml, sheetPath);
    const media: WorkbookMedia[] = [];
    for (const drawingMatch of sheetXml.matchAll(/<drawing\b[^>]*\br:id="([^"]+)"[^>]*\/?>(?:<\/drawing>)?/g)) {
      const drawingPath = sheetRels.get(drawingMatch[1]!);
      assert(drawingPath && files.has(drawingPath), `Worksheet ${name} has a missing drawing relationship.`);
      const drawingXml = files.get(drawingPath)!.toString('utf8');
      const drawingRelsXml = files.get(relsPath(drawingPath))?.toString('utf8') ?? '';
      const drawingRels = relationships(drawingRelsXml, drawingPath);
      for (const imageMatch of drawingXml.matchAll(/<a:blip\b[^>]*\br:embed="([^"]+)"/g)) {
        const mediaPath = drawingRels.get(imageMatch[1]!);
        const body = mediaPath ? files.get(mediaPath) : undefined;
        assert(mediaPath && body && body.length > 0, `Worksheet ${name} has a missing or empty image relationship.`);
        const dimensions = pngDimensions(body);
        const item = { path: mediaPath, bytes: body.length, ...dimensions };
        media.push(item);
        allMedia.set(mediaPath, item);
      }
    }
    sheets[name] = { name, path: sheetPath, rows: parseRows(sheetXml, sharedStrings), media };
  }
  return { memberName, sheetNames: Object.keys(sheets), sheets, media: [...allMedia.values()] };
}

export function workbookEvidence(workbook: WorkbookInspection): Record<string, unknown> {
  return {
    memberName: workbook.memberName,
    sheetNames: workbook.sheetNames,
    sheets: Object.fromEntries(workbook.sheetNames.map(name => {
      const sheet = workbook.sheets[name]!;
      return [name, { populatedRows: sheet.rows.filter(row => row.values.length > 0).length,
        drawings: sheet.media.length, mediaBytes: sheet.media.reduce((sum, item) => sum + item.bytes, 0) }];
    })),
    media: workbook.media.map(item => ({ path: item.path, bytes: item.bytes, width: item.width, height: item.height })),
  };
}
