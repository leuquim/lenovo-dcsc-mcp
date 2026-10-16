import type { RawConfiguration } from '../model/types.js';
import { buildRackConfigurations, type RackObject } from './rack.js';

type Obj = Record<string, unknown>;

export interface RackFiller {
  /** SPA filler coordinate. This is zero-based even when rack-item positions are one-based. */
  position: number;
  size: 1 | 3 | 5;
}

export interface RackFillerProjection {
  rack: RackObject;
  configuration: RawConfiguration;
  filler: RackFiller[];
  selections: Array<{ code: string; quantity: number; derived: true }>;
}

export class RackFillerCatalogError extends Error {
  readonly missingCodes: string[];

  constructor(missingCodes: string[]) {
    super(`Rack filler catalog is incomplete; missing feature codes: ${missingCodes.join(', ')}`);
    this.name = 'RackFillerCatalogError';
    this.missingCodes = missingCodes;
  }
}

const FILLER_CODES = new Set(['4275', '4273', '4271', 'B34A', 'B349', 'B348']);
const STANDARD_CODE: Record<RackFiller['size'], string> = { 5: '4275', 3: '4273', 1: '4271' };
const EXTENSION_CODE: Record<RackFiller['size'], string> = { 5: 'B34A', 3: 'B349', 1: 'B348' };

function objects(value: unknown): Obj[] {
  return Array.isArray(value)
    ? value.filter((item): item is Obj => item !== null && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function rackItems(rack: RackObject): Obj[] {
  const items = objects(rack['rackItems']);
  return items.length > 0 ? items : objects(rack['servers']);
}

function occupiedRange(item: Obj): number[] {
  const apiPosition = finiteInteger(item['position']);
  const size = finiteInteger(item['size']);
  if (apiPosition === undefined || apiPosition < 1 || size === undefined || size < 1) return [];
  const localPosition = apiPosition - 1;
  return Array.from({ length: size }, (_, index) => localPosition + index);
}

/**
 * Reproduces the SPA `buildFiller` packing used before rack derives.
 *
 * Workspace rack items and locked U values are DCSC's one-based coordinates;
 * filler positions remain the SPA's zero-based local coordinate, as captured.
 */
export function buildRackFiller(rack: RackObject, force = false): RackFiller[] {
  const items = rackItems(rack);
  const uSpaceItems = objects(rack['featureItems']).filter((item) => item['location'] === 'u_space');
  if (!force && items.length === 0 && uSpaceItems.length === 0) return [];
  const size = finiteInteger(rack['size']);
  if (size === undefined || size < 1) return [];

  const free = new Set(Array.from({ length: size }, (_, index) => index));
  for (const item of [...items, ...uSpaceItems]) {
    for (const position of occupiedRange(item)) free.delete(position);
  }
  for (const locked of Array.isArray(rack['lockedSpace']) ? rack['lockedSpace'] : []) {
    const apiPosition = finiteInteger(locked);
    if (apiPosition !== undefined && apiPosition >= 1) free.delete(apiPosition - 1);
  }

  const filler: RackFiller[] = [];
  const ordered = (): number[] => [...free].sort((left, right) => left - right);
  while (free.size > 0) {
    const position = ordered()[0]!;
    let packed: RackFiller['size'] = 1;
    for (const candidate of [5, 3, 1] as const) {
      if (Array.from({ length: candidate }, (_, index) => position + index)
        .every((value) => free.has(value))) {
        packed = candidate;
        break;
      }
    }
    filler.push({ position, size: packed });
    for (let offset = 0; offset < packed; offset += 1) free.delete(position + offset);
  }
  return filler;
}

function applyFillerSelections(
  source: RawConfiguration,
  filler: RackFiller[],
): { configuration: RawConfiguration; selections: RackFillerProjection['selections'] } {
  const configuration = structuredClone(source);
  const characters = objects(configuration.unSelectableCharacters);
  const mechanical = characters.find((section) => section['name'] === 'MECH_DERIVE_FCS');
  if (!mechanical) return { configuration, selections: [] };
  const available = new Set(objects(mechanical['features']).map((feature) => String(feature['code'] ?? '')));
  const existing = objects(mechanical['results']);
  // The SPA passes an EXTENSION_KIT result separately and falls back to AUEE
  // in MECH_DERIVE_FCS. Both forms occur in server configurations.
  const extension = existing.some((result) => result['code'] === 'AUEE') ||
    characters.some((section) => section['name'] === 'EXTENSION_KIT' &&
      objects(section['results']).some((result) => result['code'] === 'AUEE'));
  const mapping = extension ? EXTENSION_CODE : STANDARD_CODE;
  const retained = existing.filter((result) => !FILLER_CODES.has(String(result['code'] ?? '')));
  const existingFillerCodes = new Set(existing
    .map((result) => String(result['code'] ?? ''))
    .filter((code) => FILLER_CODES.has(code)));
  const requiredCodes = ([5, 3, 1] as const)
    .filter((size) => filler.some((item) => item.size === size))
    .map((size) => mapping[size]);
  const missingCodes = requiredCodes.filter((code) => !available.has(code) && !existingFillerCodes.has(code));
  if (missingCodes.length > 0) throw new RackFillerCatalogError(missingCodes);
  const selections: RackFillerProjection['selections'] = [];
  for (const size of [5, 3, 1] as const) {
    const quantity = filler.filter((item) => item.size === size).length;
    const code = mapping[size];
    if (quantity > 0) selections.push({ code, quantity, derived: true });
  }
  mechanical['results'] = [...retained, ...selections];
  configuration.unSelectableCharacters = characters as RawConfiguration['unSelectableCharacters'];
  return { configuration, selections };
}

function mergeForAutoConnect(previous: Obj[], sections: Obj[]): Obj[] {
  const flags = new Map<string, boolean>();
  for (const section of previous) {
    for (const result of objects(section['results'])) {
      flags.set(`${String(section['name'])}\u0000${String(result['code'])}`, result['forAutoConnect'] === true);
    }
  }
  return sections.map((section) => {
    const { features: compactFeatures, ...metadata } = section;
    const results = objects(section['results']).length > 0
      ? objects(section['results'])
      : objects(compactFeatures);
    return {
      ...metadata,
      results: results.map((result) => ({
      ...result,
      forAutoConnect: result['forAutoConnect'] === true ||
        flags.get(`${String(section['name'])}\u0000${String(result['code'])}`) === true,
      })),
    };
  });
}

/**
 * Projects the browser-owned rack filler state into both halves of the next
 * workspace derive: physical `rackData` and the compact rack configuration.
 */
export function projectRackFiller(
  sourceRack: RackObject,
  sourceConfiguration: RawConfiguration,
): RackFillerProjection {
  const filler = buildRackFiller(sourceRack);
  const { configuration, selections } = applyFillerSelections(sourceConfiguration, filler);
  const compact = buildRackConfigurations([configuration])[0]!;
  const base = compact.sections.find((section) => section.name === 'BASE')?.features[0]?.code;
  const rack: RackObject = {
    ...structuredClone(sourceRack),
    filler,
    features: mergeForAutoConnect(objects(sourceRack['features']), compact.sections as unknown as Obj[]),
    ...(base ? { baseFeatureCode: base } : {}),
  };
  return { rack, configuration, filler, selections };
}
