import type { DcscHttpClient, RequestCtx } from '../http/request.js';

/**
 * The rack layer, backed by DCSC rather than modelled locally.
 *
 * Rack fit is not something a client can compute. DCSC applies per-product
 * placement rules ("this server cannot be placed lower than U3 or higher than
 * U35 in this rack"), accumulates weight, and runs a centre-of-gravity
 * stability check that returns PASSED / WARNING / FAILED. Items that cannot be
 * placed are moved out of the rack and returned in nonRackArea. None of that is
 * derivable from U-heights alone, so every mutation is round-tripped through
 * /ctos/racks/customize and the server's answer is taken as the truth.
 */

export type RackObject = Record<string, unknown>;

export interface RackCabinet {
  code: string;
  description: string;
  machineType?: string | undefined;
  price?: number | undefined;
}

/** Physical envelope DCSC reports for a product: U height, weight, dimensions. */
export interface PhysicalEnvelope {
  code: string;
  type: string;
  /** Height in rack units. */
  sizeU: number;
  weightKg: number;
  widthMm?: number | undefined;
  depthMm?: number | undefined;
  raw: RackObject;
}

export interface RackItemSummary {
  id: string;
  code: string;
  description?: string | undefined;
  /** Bottom-most U occupied, 1-based. */
  position: number;
  endPosition: number;
  sizeU: number;
}

export interface RackSummary {
  id: string;
  code: string;
  description?: string | undefined;
  sizeU: number;
  usedU: number;
  freeU: number;
  emptyWeightKg?: number | undefined;
  totalWeightKg?: number | undefined;
  /** DCSC's centre-of-gravity verdict: PASSED, WARNING or FAILED. */
  stableStatus?: string | undefined;
  items: RackItemSummary[];
  errors: Array<{ code?: string | undefined; message: string }>;
}

export interface LayoutResult {
  racks: RackSummary[];
  /** Items DCSC refused to place, or that were never placed. */
  unplaced: Array<{ id?: string | undefined; code: string; description?: string | undefined }>;
  errors: Array<{ code?: string | undefined; message: string }>;
  /** Raw rackArea, kept so the next mutation can be posted back verbatim. */
  rawRackArea: RackObject[];
  rawNonRackArea: RackObject[];
  connections: unknown[];
}

interface CategoryNode {
  products?: Array<Record<string, unknown>> | null;
  children?: CategoryNode[] | null;
}

/** Rack cabinets available in the current solution mode. */
export async function fetchRackCabinets(
  http: DcscHttpClient,
  ctx: RequestCtx,
): Promise<RackCabinet[]> {
  const res = await http.send({
    endpoint: 'racks_categories',
    method: 'GET',
    path: '/ctos/racks/categories',
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });

  const out: RackCabinet[] = [];
  const walk = (nodes: CategoryNode[]): void => {
    for (const node of nodes) {
      for (const p of node.products ?? []) {
        const code = p['code'];
        if (typeof code !== 'string') continue;
        // The rack category also carries accessories (console managers, rear
        // door heat exchangers, UPSes). Only actual cabinets can hold items.
        if (p['hardwareType'] !== 'rack') continue;
        const description = p['description'];
        const machineType = p['machineType'];
        const price = p['price'];
        out.push({
          code,
          description: typeof description === 'string' ? description : '',
          ...(typeof machineType === 'string' ? { machineType } : {}),
          ...(typeof price === 'number' ? { price } : {}),
        });
      }
      if (node.children?.length) walk(node.children);
    }
  };
  walk((res.raw as CategoryNode[]) ?? []);
  return out;
}

/**
 * Physical envelope for each product code.
 *
 * This is the only way to learn a product's U height and weight — the
 * configuration tree does not carry them.
 */
export async function fetchEnvelopes(
  http: DcscHttpClient,
  ctx: RequestCtx,
  items: Array<{ code: string; type: string }>,
): Promise<Map<string, PhysicalEnvelope>> {
  const out = new Map<string, PhysicalEnvelope>();
  if (items.length === 0) return out;

  const res = await http.send({
    endpoint: 'racks_customize_non_rack',
    method: 'POST',
    path: '/ctos/racks/customize/non_rack',
    body: {
      kind: 'json',
      value: items.map((i) => ({ type: i.type, asVLH: false, code: i.code })),
    },
    responseKind: 'json',
    timeoutClass: 'interactive',
    ctx,
  });

  for (const entry of (res.raw as RackObject[]) ?? []) {
    const code = entry['code'];
    if (typeof code !== 'string') continue;
    out.set(code.toUpperCase(), {
      code,
      type: String(entry['type'] ?? 'server'),
      sizeU: num(entry['size']) ?? 1,
      weightKg: num(entry['weight']) ?? 0,
      widthMm: num(entry['width']),
      depthMm: num(entry['depth']),
      raw: entry,
    });
  }
  return out;
}

export interface CustomizeOptions {
  autoArrange?: boolean;
  autoConnect?: boolean;
  cogValidation?: boolean;
}

/**
 * Posts a layout for validation and returns DCSC's corrected version.
 *
 * The response is authoritative: items may have moved, been rejected, or been
 * pushed out to nonRackArea, and weights and stability are recomputed.
 */
export async function customizeLayout(
  http: DcscHttpClient,
  ctx: RequestCtx,
  payload: { rackArea: RackObject[]; nonRackArea: RackObject[] },
  opts: CustomizeOptions = {},
): Promise<LayoutResult> {
  const res = await http.send({
    endpoint: 'racks_customize',
    method: 'POST',
    path: '/ctos/racks/customize',
    query: {
      autoArrange: opts.autoArrange ?? false,
      autoConnect: opts.autoConnect ?? false,
      cogValidation: opts.cogValidation ?? true,
    },
    body: { kind: 'json', value: payload },
    responseKind: 'json',
    timeoutClass: 'heavy',
    ctx,
  });

  const raw = res.raw as {
    rackArea?: RackObject[] | null;
    nonRackArea?: RackObject[] | null;
    connections?: unknown[] | null;
  };

  const rackArea = raw.rackArea ?? [];
  const nonRackArea = raw.nonRackArea ?? [];
  const allErrors: LayoutResult['errors'] = [];

  const racks: RackSummary[] = rackArea.map((r) => {
    const items = ((r['rackItems'] as RackObject[] | undefined) ?? []).map((it) => {
      const sizeU = num(it['size']) ?? 1;
      const position = num(it['position']) ?? 0;
      return {
        id: String(it['id'] ?? ''),
        code: String(it['code'] ?? ''),
        description: str(it['description']),
        position,
        endPosition: num(it['endPosition']) ?? position + sizeU - 1,
        sizeU,
      };
    });
    const errors = toErrors(r['errors']);
    allErrors.push(...errors);

    const sizeU = num(r['size']) ?? 0;
    const usedU = items.reduce((acc, i) => acc + i.sizeU, 0);
    return {
      id: String(r['id'] ?? ''),
      code: String(r['code'] ?? ''),
      description: str(r['description']),
      sizeU,
      usedU,
      freeU: Math.max(0, sizeU - usedU),
      emptyWeightKg: num(r['emptyRackWeight']),
      totalWeightKg: num(r['totalWeight']),
      stableStatus: str(r['stableStatus']),
      items,
      errors,
    };
  });

  return {
    racks,
    unplaced: nonRackArea.map((n) => ({
      id: str(n['id']),
      code: String(n['code'] ?? ''),
      description: str(n['description']),
    })),
    errors: allErrors,
    rawRackArea: rackArea,
    rawNonRackArea: nonRackArea,
    connections: raw.connections ?? [],
  };
}

/** Builds a rackItem entry for a product placed at a given U position. */
export function buildRackItem(
  envelope: PhysicalEnvelope,
  configurationId: string,
  position: number,
  quantity = 1,
): RackObject {
  return {
    ...envelope.raw,
    id: configurationId,
    code: envelope.code,
    sliceCtoCode: envelope.code,
    type: envelope.type,
    quantity,
    position,
    endPosition: position + envelope.sizeU - 1,
  };
}

/** Builds a rackArea entry for an empty rack cabinet. */
export function buildRackObject(
  envelope: PhysicalEnvelope,
  rackId: string,
  items: RackObject[] = [],
): RackObject {
  return {
    ...envelope.raw,
    id: rackId,
    code: envelope.code,
    sliceCtoCode: envelope.code,
    type: 'rack',
    quantity: 1,
    rackItems: items,
  };
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function toErrors(v: unknown): Array<{ code?: string | undefined; message: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ code?: string | undefined; message: string }> = [];
  for (const e of v) {
    if (typeof e === 'string') {
      out.push({ message: e });
      continue;
    }
    if (typeof e !== 'object' || e === null) continue;
    const o = e as Record<string, unknown>;
    const message = o['message'];
    if (typeof message !== 'string') continue;
    out.push({ code: str(o['code']), message });
  }
  return out;
}
