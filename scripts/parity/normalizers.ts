import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : value === undefined ? [] : [value];
const text = (value: unknown): string => value === undefined || value === null ? '' : String(value);
const byJson = (left: unknown, right: unknown) => JSON.stringify(left).localeCompare(JSON.stringify(right));
const partNumber = (value: unknown) => text(value).replaceAll('-', '');

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export function price(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const amount = typeof value === 'number' ? value : Number(text(value).replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(amount)) throw new Error(`Expected a finite price, received ${text(value)}.`);
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/** Product lines of a CFXML document: part numbers without dashes, prices to cents, stable order. */
export function cfxml(xml: string) {
  const parsed = object(new XMLParser({ ignoreAttributes: false, parseTagValue: true }).parse(xml));
  const line = (raw: unknown) => {
    const item = object(raw);
    const identity = object(object(item['ProductIdentification'])['PartnerProductIdentification']);
    return {
      code: partNumber(identity['ProprietaryProductIdentifier']),
      type: text(identity['ProductTypeCode']),
      quantity: Number(item['Quantity'] ?? 0),
      unitPrice: price(object(object(item['UnitListPrice'])['FinancialAmount'])['MonetaryAmount'] ?? 0),
    };
  };
  return array(object(object(parsed['CFXML'])['CFData'])['ProductLineItem']).map(raw => ({
    ...line(raw),
    children: array(object(raw)['ProductSubLineItem']).map(line).sort(byJson),
  })).sort(byJson);
}

/** Selected parts and total of raw configurations as returned by the native import or the saved workspace. */
export function configurations(raws: unknown) {
  return array(raws).map(raw => {
    const configuration = object(raw);
    const selections = array(configuration['tabs']).flatMap(tab => array(object(tab)['subTabs']))
      .flatMap(tab => array(object(tab)['sections'])).flatMap(section => {
        const owner = object(section);
        return array(owner['results']).map(object).filter(result => Number(result['quantity']) > 0)
          .map(result => ({ section: owner['name'] ?? owner['characterName'], code: result['code'], quantity: result['quantity'] }));
      }).sort(byJson);
    return { code: configuration['code'], quantity: configuration['quantity'] ?? 1,
      totalPrice: configuration['totalPrice'], selections };
  }).sort(byJson);
}

/** Rack contents by part, position and size. */
export function layout(rackItems: unknown) {
  return array(rackItems).map(raw => {
    const item = object(raw);
    return { code: item['code'], position: item['position'], size: item['size'] };
  }).sort(byJson);
}

/** Export form fields as posted by the SPA, with JSON-encoded fields decoded and products ordered. */
export function wireRequest(fields: Record<string, string>) {
  const decoded = Object.fromEntries(Object.entries(fields).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      try { return [key, JSON.parse(value) as unknown]; } catch { return [key, value]; }
    }));
  const groups = array(decoded['groups']).flatMap(group => array(object(group)['products'])).map(raw => {
    const product = object(raw);
    return { code: partNumber(product['code']), type: text(product['type']).toLowerCase(),
      quantity: Number(product['quantity'] ?? 0), price: price(product['price']), unitPrice: price(product['unitPrice']) };
  }).sort(byJson);
  return { ...decoded, groups };
}

export const normalizers = { cfxml, price, layout, wireRequest, configurations };
