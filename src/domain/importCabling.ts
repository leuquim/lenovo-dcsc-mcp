import { XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'node:zlib';
import { type Obj, objectOrEmpty } from '../util/coerce.js';

const fields = ['network', 'topology', 'cablePart', 'sourceId', 'sourcePortName', 'sourcePortNumber',
  'destinationId', 'destinationPortName', 'destinationPortNumber', 'type', 'subType'];
const identity = (row: Obj) => JSON.stringify(fields.map(key => String(row[key] ?? '')));

/** Lenovo's importer drops the saved breakout divider; retain its exact source identity. */
export function readSavedBreakoutConnections(xml: string): Obj[] {
  const parser = new XMLParser({ parseTagValue: false });
  const document = objectOrEmpty(parser.parse(xml));
  const encoded = objectOrEmpty(objectOrEmpty(document['CFXML'])['SectionData'])['NetworkingInformation'];
  if (typeof encoded !== 'string' || !encoded.trim()) return [];
  const decoded = unzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 20 * 1024 * 1024 }).toString('utf8');
  const network = objectOrEmpty(objectOrEmpty(parser.parse(decoded))['NetworkingInformation']);
  const items = objectOrEmpty(network['AutoConnectResults'])['AutoConnectItem'];
  const rows = (Array.isArray(items) ? items : items === undefined ? [] : [items]).map(objectOrEmpty);
  return rows.filter(row => row['Divider'] === '4').map(row => {
    if (row['Topology'] !== '100GbE_Copper' || row['SourcePortName'] !== 'SFP28' || row['DestinationPortName'] !== 'QSFP28' ||
        !/100G QSFP28 to 4x25G SFP28/i.test(String(row['CableType']))) {
      throw new Error('Saved breakout shape is not supported for verified import recovery.');
    }
    const saved: Obj = {};
    for (const key of fields) {
      const tag = key === 'sourceId' ? 'Sourced' : key[0]!.toUpperCase() + key.slice(1);
      const value = row[tag];
      if (typeof value !== 'string' || !value.trim()) throw new Error(`Saved breakout is missing ${tag}.`);
      saved[key] = value;
    }
    return { ...saved, category: 'BREAKOUT', divider: 4 };
  });
}

/** Restore shape only on a unique, otherwise unchanged backend-imported row. */
export function restoreSavedBreakoutConnections(payload: Obj, saved: readonly Obj[]): number {
  if (!saved.length) return 0;
  const networking = objectOrEmpty(payload['networkingInformation']);
  const rows = Array.isArray(networking['autoConnectResults']) ? networking['autoConnectResults'].map(objectOrEmpty) : [];
  const replacements = new Map<Obj, Obj>();
  for (const source of saved) {
    const matches = rows.filter(row => identity(row) === identity(source));
    if (matches.length !== 1 || replacements.has(matches[0]!)) throw new Error('Saved breakout identity is missing or ambiguous after import.');
    replacements.set(matches[0]!, source);
  }
  // Validate all identities before changing the imported payload.
  for (const [row, source] of replacements) {
    row['category'] = source['category']; row['divider'] = source['divider'];
  }
  return replacements.size;
}
