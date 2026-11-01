import type { DcscHttpClient, RequestCtx } from '../http/request.js';

export interface FetchSupplyStatusInput {
  code: string;
  type?: 'Option' | 'CTO' | 'LFO' | string | undefined;
  country?: string | undefined;
}

export interface SupplyStatusResult {
  code: string;
  type: string;
  country: string;
  shippingStatus: string[];
  raw: unknown;
}

export interface FetchEsdInfoInput {
  action: 'info' | 'alternative';
  payload: Record<string, unknown>;
}

export interface EsdInfoResult {
  action: 'info' | 'alternative';
  data: unknown;
  raw: unknown;
}

/**
 * Fetches supply status and shipping lead-times.
 * Endpoint: GET /supply/status?country=...&type=...&code=...
 */
export async function fetchSupplyStatus(
  http: DcscHttpClient,
  ctx: RequestCtx,
  input: FetchSupplyStatusInput,
): Promise<SupplyStatusResult> {
  const country = input.country ?? ctx.locale.country;
  const type = input.type ?? 'Option';
  const code = input.code;

  const res = await http.send({
    endpoint: 'supply_status',
    method: 'GET',
    path: '/supply/status',
    query: {
      country,
      type,
      code,
    },
    responseKind: 'json',
    timeoutClass: 'interactive',
    requiresSolution: false,
    ctx,
  });

  const raw = res.raw;
  let shippingStatus: string[] = [];

  const items = Array.isArray(raw) ? raw : [raw];
  for (const item of items) {
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      if (Array.isArray(rec.shippingStatus)) {
        shippingStatus = rec.shippingStatus.map((v) => String(v));
        break;
      }
    }
  }

  return {
    code,
    type,
    country,
    shippingStatus,
    raw,
  };
}

/**
 * Fetches ESD (Electronic Software Delivery) info or alternatives.
 * Endpoints:
 * - POST /sst/esd/info
 * - POST /sst/esd/alternative
 */
export async function fetchEsdInfo(
  http: DcscHttpClient,
  ctx: RequestCtx,
  input: FetchEsdInfoInput,
): Promise<EsdInfoResult> {
  const path = input.action === 'info' ? '/sst/esd/info' : '/sst/esd/alternative';
  const endpoint = input.action === 'info' ? 'sst_esd_info' : 'sst_esd_alternative';

  const res = await http.send({
    endpoint,
    method: 'POST',
    path,
    body: { kind: 'json', value: input.payload },
    responseKind: 'json',
    timeoutClass: 'interactive',
    requiresSolution: false,
    ctx,
  });

  return {
    action: input.action,
    data: res.raw,
    raw: res.raw,
  };
}
