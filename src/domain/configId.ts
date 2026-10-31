import type { DcscHttpClient, RequestCtx } from '../http/request.js';

export interface GenerateConfigIdResult {
  configId: string;
}

export interface ValidateConfigIdResult {
  valid: boolean;
  url?: string | undefined;
  message?: string | undefined;
}

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
 * Requests an online 10-character alphanumeric Configuration ID from DCSC.
 *
 * Upstream route: POST /api/generateConfigId?country_or_region=${country}&controlExpressModal=false&_request=web
 * Critical header: integrationParams: '{}' (applied by composeHeaders via REQUIRED_HEADERS).
 */
export async function generateConfigId(
  http: DcscHttpClient,
  ctx: RequestCtx,
): Promise<GenerateConfigIdResult> {
  const response = await http.send({
    endpoint: 'generate_config_id',
    method: 'POST',
    path: '/generateConfigId',
    query: {
      controlExpressModal: 'false',
    },
    requiresSolution: false,
    responseKind: 'json',
    timeoutClass: 'interactive',
    ctx,
  });

  const raw = response.raw;
  let configId = '';
  if (typeof raw === 'string') {
    configId = raw.trim().replace(/^"|"$/g, '');
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    configId = String(obj['configId'] ?? obj['configuration_id'] ?? obj['id'] ?? '').trim();
  }

  if (!configId) {
    throw new Error('DCSC returned an empty or invalid Configuration ID.');
  }

  return { configId };
}

/**
 * Validates whether a Configuration ID exists and is available in DCSC's database.
 *
 * Upstream route: POST /api/restore?country_or_region=${country}&language=${language}&currency=${currency}&configuration_id=${configId}
 */
export async function validateConfigId(
  http: DcscHttpClient,
  configId: string,
  ctx: RequestCtx,
): Promise<ValidateConfigIdResult> {
  const trimmed = configId.trim();
  if (!trimmed) {
    throw new Error('A non-empty configuration ID is required for validation.');
  }

  const response = await http.send({
    endpoint: 'validate_config_id',
    method: 'POST',
    path: '/restore',
    query: {
      configuration_id: trimmed,
    },
    requiresSolution: false,
    responseKind: 'json',
    timeoutClass: 'interactive',
    ctx,
  });

  const raw = (typeof response.raw === 'string'
    ? JSON.parse(response.raw)
    : response.raw) as Record<string, unknown> | null;

  if (!raw || typeof raw !== 'object') {
    return { valid: false, message: 'Unrecognised validation response from DCSC.' };
  }

  const success = raw['success'] === true;
  const url = typeof raw['url'] === 'string' ? raw['url'] : undefined;
  const message = typeof raw['message'] === 'string' ? raw['message'] : undefined;

  return {
    valid: success,
    ...(url !== undefined ? { url } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

/**
 * Retrieves an online configuration by ID from DCSC.
 *
 * Upstream route: POST /api/retrieve/configId?country_or_region=${country}&language=${language}&currency=${currency}&configuration_id=${configId}&currentFileType=CTO
 * Request body: multipart/form-data with existing `configurationIds` keys.
 * Returns the raw import payload array or object to be ingested by #acceptImportPayload.
 */
export async function retrieveConfigId(
  http: DcscHttpClient,
  configId: string,
  existingIds: string[],
  ctx: RequestCtx,
  currentFileType = 'CTO',
): Promise<unknown> {
  const trimmed = configId.trim();
  if (!trimmed) {
    throw new Error('A non-empty configuration ID is required for retrieval.');
  }

  const normalizedFileType = currentFileType.toUpperCase() === 'LFO' ? 'LFO' : 'CTO';

  const response = await http.send({
    endpoint: 'retrieve_config_id',
    method: 'POST',
    path: '/retrieve/configId',
    query: {
      configuration_id: trimmed,
      currentFileType: normalizedFileType,
    },
    body: {
      kind: 'multipart',
      parts: existingIds.map((id) => ({ name: 'configurationIds', value: id })),
    },
    requiresSolution: false,
    responseKind: 'json',
    timeoutClass: 'heavy',
    ctx,
  });

  const raw = typeof response.raw === 'string' ? JSON.parse(response.raw) : response.raw;

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj['errorMessage'] === 'string' && obj['errorMessage']) {
      throw new Error(`DCSC failed to retrieve Config ID ${trimmed}: ${obj['errorMessage']}`);
    }
  }

  if (!raw || (Array.isArray(raw) && raw.length === 0)) {
    throw new Error(`DCSC returned no configuration data for Config ID ${trimmed}.`);
  }

  return raw;
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

  const raw = (typeof response.raw === 'string'
    ? JSON.parse(response.raw)
    : response.raw) as Record<string, unknown> | null;

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

  const raw = typeof response.raw === 'string' ? JSON.parse(response.raw) : response.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`DCSC returned no customizable reference solution for SID ${trimmed}.`);
  }

  return raw;
}
