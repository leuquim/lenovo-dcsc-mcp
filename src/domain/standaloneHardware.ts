import { randomUUID } from 'node:crypto';

import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import { findParts, type PartLookupMode } from './standalone.js';

type Obj = Record<string, unknown>;

/**
 * Hardware option part numbers (transceivers, cables, kits) added from the
 * website's Part Search as "Standalone Items". The website keeps the complete
 * /findpart row and adds an id and quantity; exports carry that row in
 * `standaloneData` and as a `type: "standalone"` group product.
 */
export interface StandaloneHardwareSelection {
  id: string;
  kind: 'hardware';
  code: string;
  quantity: number;
  description: string;
  featureCode?: string | undefined;
  unitPrice?: number | undefined;
  priceNotAvailable: boolean;
  /** Complete /findpart row, as the website keeps it. */
  part: Obj;
}

export interface StandaloneHardwareState {
  kind: 'standalone-hardware';
  selections: StandaloneHardwareSelection[];
}

export function emptyStandaloneHardware(): StandaloneHardwareState {
  return { kind: 'standalone-hardware', selections: [] };
}

/** Resolves an exact hardware part number through the website's Part Search endpoint. */
export async function lookupStandaloneHardwarePart(
  http: DcscHttpClient,
  ctx: RequestCtx,
  code: string,
  mode: PartLookupMode = 'LFO',
): Promise<Obj> {
  const wanted = code.trim().toUpperCase();
  if (wanted === '') throw new Error('Part number must not be empty.');
  const result = await findParts(http, ctx, { keyword: wanted, types: ['HARDWARE'], mode });
  const matches = result.items.filter((item) => item.type === 'HARDWARE' && item.code.toUpperCase() === wanted);
  if (matches.length === 0) {
    const near = result.items.slice(0, 5).map((item) => `${item.code} (${item.type})`).join(', ');
    throw new Error(`No standalone hardware part ${wanted} in DCSC Part Search.${near ? ` Closest results: ${near}.` : ''}`);
  }
  return structuredClone(matches[0]!.raw);
}

export function standaloneHardwareSelection(part: Obj, quantity: number, id: string = randomUUID()): StandaloneHardwareSelection {
  const code = string(part['code']);
  if (!code) throw new Error('Part Search row has no part number.');
  const unitPrice = number(part['price']) ?? number(objects(part['prices'])[0]?.['price']);
  return {
    id,
    kind: 'hardware',
    code,
    quantity: positiveInteger(quantity, 'quantity'),
    description: string(part['description']) ?? '',
    ...(string(part['featureCode']) ? { featureCode: string(part['featureCode']) } : {}),
    ...(unitPrice !== undefined ? { unitPrice } : {}),
    priceNotAvailable: part['priceNotAvailable'] === true,
    part: structuredClone(part),
  };
}

/** Adds a part, or replaces the quantity of one already selected (the website keeps one line per part). */
export function selectStandaloneHardware(
  state: StandaloneHardwareState,
  part: Obj,
  quantity: number,
): StandaloneHardwareState {
  const code = string(part['code']);
  const existing = state.selections.find((selection) => selection.code === code);
  const selection = standaloneHardwareSelection(part, quantity, existing?.id);
  return {
    ...state,
    selections: existing
      ? state.selections.map((candidate) => (candidate.code === code ? selection : candidate))
      : [...state.selections, selection],
  };
}

export function setStandaloneHardwareQuantity(
  state: StandaloneHardwareState,
  code: string,
  quantity: number,
): StandaloneHardwareState {
  const existing = requireSelection(state, code);
  return selectStandaloneHardware(state, existing.part, quantity);
}

export function removeStandaloneHardware(state: StandaloneHardwareState, code: string): StandaloneHardwareState {
  requireSelection(state, code);
  return { ...state, selections: state.selections.filter((selection) => selection.code !== code) };
}

/** One `standaloneData` row, matching the captured website export form. */
export function standaloneHardwareExportItem(selection: StandaloneHardwareSelection): Obj {
  return {
    keyWord: null,
    isLFO: false,
    ...structuredClone(selection.part),
    id: selection.id,
    quantity: selection.quantity,
  };
}

/** One `groups[].products` row: the same row typed `standalone` with unit and extended price. */
export function standaloneHardwareGroupProduct(selection: StandaloneHardwareSelection, groupName = 'Config 1'): Obj {
  return {
    ...standaloneHardwareExportItem(selection),
    type: 'standalone',
    price: selection.unitPrice !== undefined ? round2(selection.unitPrice * selection.quantity) : null,
    unitPrice: selection.unitPrice ?? null,
    groupId: groupName,
  };
}

/**
 * Restores standalone hardware rows from a /multiple/cfxml_import response.
 * Rows are recognised by `type: "HARDWARE"`; everything else is left to the
 * software parser.
 */
export function parseStandaloneHardwareRows(rows: Obj[], groupProducts: Obj[]): StandaloneHardwareState | undefined {
  const hardware = rows.filter((row) => String(row['type'] ?? '').toUpperCase() === 'HARDWARE');
  if (hardware.length === 0) return undefined;
  return {
    kind: 'standalone-hardware',
    selections: hardware.map((row) => {
      const code = string(row['code']);
      if (!code) throw new Error('Imported standalone hardware row has no part number.');
      const id = string(row['id']) ?? randomUUID();
      const group = groupProducts.find((candidate) => string(candidate['id']) === id);
      const unitPrice = number(group?.['unitPrice']);
      const part: Obj = structuredClone(row);
      delete part['id'];
      delete part['quantity'];
      if (unitPrice !== undefined && number(part['price']) === undefined) part['price'] = unitPrice;
      return standaloneHardwareSelection(part, positiveInteger(number(row['quantity']) ?? 0, `standalone ${code} quantity`), id);
    }),
  };
}

export function isStandaloneHardwareRow(row: Obj): boolean {
  return String(row['type'] ?? '').toUpperCase() === 'HARDWARE';
}

export function standaloneHardwareTotal(state: StandaloneHardwareState): number | undefined {
  let total = 0;
  for (const selection of state.selections) {
    if (selection.unitPrice === undefined) return undefined;
    total += selection.unitPrice * selection.quantity;
  }
  return round2(total);
}

function requireSelection(state: StandaloneHardwareState, code: string): StandaloneHardwareSelection {
  const selection = state.selections.find((candidate) => candidate.code === code);
  if (!selection) throw new Error(`Standalone hardware ${code} is not selected.`);
  return selection;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function objects(value: unknown): Obj[] {
  return Array.isArray(value)
    ? value.filter((item): item is Obj => typeof item === 'object' && item !== null && !Array.isArray(item))
    : [];
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}
