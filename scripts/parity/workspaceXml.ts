/** Readers for the blobs a CFXML export carries beside the product lines: workspace, floor information and logical groups. */
import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const array = (value: unknown): unknown[] => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

/** The base64+gzip text of a top-level export element, decoded. */
export function xmlBlob(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!match) throw new Error(`Export XML has no <${tag}> element.`);
  const bytes = Buffer.from(match[1]!.trim(), 'base64');
  return (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8');
}

/** Rack models with the product codes inside them, and the loose product codes, from the Workspace element. */
export function workspaceContents(xml: string): { racks: Array<{ code: string; items: string[] }>; loose: string[] } {
  const json = JSON.parse(String(parser.parse(xmlBlob(xml, 'Workspace'))['string'])) as Obj;
  return {
    racks: array(json['rackArea']).map(object).map(rack => ({
      code: String(rack['code']), items: array(rack['rackItems']).map(item => String(object(item)['code'])).sort(),
    })).sort((left, right) => left.code.localeCompare(right.code)),
    loose: array(json['nonRackArea']).map(item => String(object(item)['code'])).sort(),
  };
}

/** Grid size and the Floor Preference values of the FloorInformation element. */
export function floorInformation(xml: string) {
  const info = object(parser.parse(xmlBlob(xml, 'FloorInformation'))['FloorInformation']);
  const settings = object(info['floorGridSettings']);
  const preference = object(info['floorPreference']);
  const cells = array(object(info['FloorGrid'])['GridElement']).map(object);
  return {
    rowCount: Number(settings['RowCount']), colCount: Number(settings['ColCount']),
    gridElements: cells.length,
    preference: Object.fromEntries(Object.entries(preference).map(([key, value]) => [key, String(value)])),
  };
}

/** Logical groups of the GroupData element: name, parent, index and the product codes in each. */
export function logicalGroups(xml: string) {
  const data = object(parser.parse(xmlBlob(xml, 'GroupData'))['com.lenovo.awakens.io.cfxml.model.section.GroupData']);
  return array(object(data['groupList'])['com.lenovo.awakens.api.request.Group']).map(object).map(group => ({
    name: String(group['name']), parent: group['parent'] === undefined ? null : String(group['parent']),
    index: Number(group['index']),
    products: array(object(group['products'])['com.lenovo.awakens.api.request.Group_-Product']).map(product => String(object(product)['code'])).sort(),
  }));
}
