import type { DcscHttpClient, RequestCtx } from '../http/request.js';

export interface SubTabRecommendation {
  subTab: string;
  title: string;
  content: string;
  linkIcon?: string | undefined;
  linkText?: string | undefined;
  link?: string | undefined;
  [key: string]: unknown;
}

export interface SummaryRecommendationPayload {
  selectedProductDataLists: Array<Array<{
    code: string;
    id?: string | undefined;
    quantity?: number | undefined;
    features?: Array<{ code: string; quantity?: number | undefined }> | undefined;
    [key: string]: unknown;
  }>>;
  customizeSelectedOptionCodes?: string[] | undefined;
  customizeSelectedServiceCodes?: string[] | undefined;
  selectedStandaloneCodes?: string[] | undefined;
  [key: string]: unknown;
}

export interface SmartLfoPayload {
  sections?: unknown[] | undefined;
  lfoProducts?: unknown[] | undefined;
  [key: string]: unknown;
}

export interface SmartLfoResponse {
  lfoResponses?: unknown | undefined;
  [key: string]: unknown;
}

/**
 * Fetches context-aware sub-tab recommendations and rule advisories.
 * Endpoint: GET /recommendations/sub_tabs?mode={mode}&selectedProducts={productCode}
 */
export async function fetchSubTabRecommendations(
  http: DcscHttpClient,
  ctx: RequestCtx,
  mode: string,
  productCode: string,
): Promise<SubTabRecommendation[]> {
  if (!productCode || typeof productCode !== 'string' || productCode.trim().length === 0) {
    throw new Error('A non-empty productCode is required for sub-tab recommendations.');
  }

  const query: Record<string, string> = {
    mode: mode || 'CTO',
    selectedProducts: productCode.trim(),
  };

  const res = await http.send({
    endpoint: 'recommendations_sub_tabs',
    method: 'GET',
    path: '/recommendations/sub_tabs',
    query,
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });

  if (!Array.isArray(res.raw)) {
    return [];
  }

  return res.raw as SubTabRecommendation[];
}

/**
 * Fetches cross-sell, bundle and summary recommendations for a solution.
 * Endpoint: POST /recommendations/summary?type={mode}&mode={mode}
 */
export async function fetchSummaryRecommendations(
  http: DcscHttpClient,
  ctx: RequestCtx,
  payload: SummaryRecommendationPayload,
  mode = 'CTO',
): Promise<unknown> {
  const query: Record<string, string> = {
    type: mode,
    mode,
  };

  const res = await http.send({
    endpoint: 'recommendations_summary',
    method: 'POST',
    path: '/recommendations/summary',
    query,
    body: { kind: 'json', value: payload },
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });

  return res.raw;
}

/**
 * Fetches smart top-choice preconfigured LFO recommendations for a CTO model.
 * Endpoint: POST /smart/recommend/lfo/{country}/{ctoCode}
 */
export async function fetchSmartLfoRecommendation(
  http: DcscHttpClient,
  ctx: RequestCtx,
  country: string,
  ctoCode: string,
  payload?: SmartLfoPayload,
  isMultiCto?: boolean,
): Promise<SmartLfoResponse> {
  if (!country || !/^[A-Za-z]{2}$/.test(country)) {
    throw new Error('A valid 2-letter ISO country code is required for smart LFO recommendations.');
  }
  if (!ctoCode || typeof ctoCode !== 'string' || ctoCode.trim().length === 0) {
    throw new Error('A non-empty ctoCode is required for smart LFO recommendations.');
  }

  const query: Record<string, string> = {};
  if (isMultiCto !== undefined) {
    query['isMultiCto'] = String(isMultiCto);
  }

  const bodyValue = payload ?? { sections: [], lfoProducts: [] };

  const res = await http.send({
    endpoint: 'smart_recommend_lfo',
    method: 'POST',
    path: `/smart/recommend/lfo/${encodeURIComponent(country.toUpperCase())}/${encodeURIComponent(ctoCode)}`,
    query,
    body: { kind: 'json', value: bodyValue },
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });

  return (res.raw ?? {}) as SmartLfoResponse;
}
