import type { DcscHttpClient, RequestCtx } from '../http/request.js';

export interface SidQueryOptions {
  categoryId: string;
  pageIndex?: number | undefined;
  pageSize?: number | undefined;
  sidNumber?: string | undefined;
  tceFlag?: boolean | undefined;
}

export interface SidItem {
  sidShortDesc: string;
  sidNumber: string;
  cpu: string[];
  ram: string[];
  storage: string[];
  gpu: string[];
  network: string[];
  ctoCount: number;
  sidPrice: number;
}

export interface SidQueryResult {
  content: SidItem[];
  totalElements: number;
  number: number;
}

/**
 * Queries preconfigured Solution ID (SID) templates by product category.
 *
 * Upstream route: GET /api/sids/query/${categoryId}?country_or_region=${country}&language=${language}&currency=${currency}&pageIndex=${pageIndex}&pageSize=${pageSize}...
 * Note: pageIndex is a mandatory parameter.
 */
export async function querySids(
  http: DcscHttpClient,
  opts: SidQueryOptions,
  ctx: RequestCtx,
): Promise<SidQueryResult> {
  const categoryId = opts.categoryId.trim();
  if (!categoryId) {
    throw new Error('A category ID is required to query SIDs.');
  }

  const pageIndex = opts.pageIndex ?? 1;
  const pageSize = opts.pageSize ?? 10;

  const response = await http.send({
    endpoint: 'query_sids',
    method: 'GET',
    path: `/sids/query/${encodeURIComponent(categoryId)}`,
    query: {
      pageIndex,
      pageSize,
      ...(opts.sidNumber ? { sidNumber: opts.sidNumber.trim() } : {}),
      ...(opts.tceFlag !== undefined ? { tceFlag: opts.tceFlag } : {}),
    },
    requiresSolution: false,
    responseKind: 'json',
    timeoutClass: 'interactive',
    ctx,
  });

  const raw = response.raw as Record<string, unknown> | null;

  if (!raw || typeof raw !== 'object') {
    return { content: [], totalElements: 0, number: pageIndex };
  }

  const rawContent = Array.isArray(raw['content']) ? raw['content'] : [];
  const content: SidItem[] = rawContent.map((item) => {
    const obj = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const asStringArray = (val: unknown): string[] =>
      Array.isArray(val) ? val.filter((x): x is string => typeof x === 'string') : [];

    return {
      sidShortDesc: typeof obj['sidShortDesc'] === 'string' ? obj['sidShortDesc'] : '',
      sidNumber: typeof obj['sidNumber'] === 'string' ? obj['sidNumber'] : '',
      cpu: asStringArray(obj['cpu']),
      ram: asStringArray(obj['ram']),
      storage: asStringArray(obj['storage']),
      gpu: asStringArray(obj['gpu']),
      network: asStringArray(obj['network']),
      ctoCount: typeof obj['ctoCount'] === 'number' ? obj['ctoCount'] : 1,
      sidPrice: typeof obj['sidPrice'] === 'number' ? obj['sidPrice'] : 0,
    };
  });

  const totalElements = typeof raw['totalElements'] === 'number' ? raw['totalElements'] : content.length;
  const number = typeof raw['number'] === 'number' ? raw['number'] : pageIndex;

  return {
    content,
    totalElements,
    number,
  };
}

/**
 * Fetches the customizable reference solution payload for a preconfigured SID number.
 *
 * Upstream route: GET /api/reference_solution/CRNs/${sidNumber}/customize
 */
export async function customizeSid(
  http: DcscHttpClient,
  sidNumber: string,
  ctx: RequestCtx,
): Promise<unknown> {
  const trimmed = sidNumber.trim();
  if (!trimmed) {
    throw new Error('A non-empty SID number is required to customize.');
  }

  const response = await http.send({
    endpoint: 'customize_sid',
    method: 'GET',
    path: `/reference_solution/CRNs/${encodeURIComponent(trimmed)}/customize`,
    responseKind: 'json',
    timeoutClass: 'heavy',
    ctx,
  });

  const raw = response.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`DCSC returned no customizable reference solution for SID ${trimmed}.`);
  }

  return raw;
}
