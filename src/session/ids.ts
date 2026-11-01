import { ulid } from 'ulid';

const SUFFIX_LENGTH = { sess: 6, ws: 8, rack: 6, cable: 6, floor: 6 } as const;

function suffix(length: number): string {
  return ulid().slice(-length).toLowerCase();
}

/** Configuration sessions embed the product code: `sess_<code>_<suffix>`. */
export function newId(kind: 'sess', productCode: string): string;
export function newId(kind: 'ws' | 'rack' | 'cable' | 'floor'): string;
export function newId(kind: keyof typeof SUFFIX_LENGTH, productCode?: string): string {
  const body = suffix(SUFFIX_LENGTH[kind]);
  return kind === 'sess' ? `sess_${productCode}_${body}` : `${kind}_${body}`;
}
