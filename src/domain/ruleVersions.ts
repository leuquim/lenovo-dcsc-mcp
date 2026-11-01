import type { DcscHttpClient, RequestCtx } from '../http/request.js';

export interface FetchRuleVersionsInput {
  ctoCode: string;
  tableCode?: string | undefined;
}

export interface RuleVersionsResult {
  ctoCode: string;
  versions: string[];
  tableCode: string;
  ruleVersions: unknown;
}

/**
 * Fetches version history codes for a CTO product.
 *
 * Upstream route: GET /api/ctos/${encodeURIComponent(ctoCode)}/versions
 */
export async function fetchCtoVersions(
  http: DcscHttpClient,
  ctx: RequestCtx,
  ctoCode: string,
): Promise<string[]> {
  const code = ctoCode.trim();
  if (!code) {
    throw new Error('A CTO product code is required to fetch CTO versions.');
  }

  const response = await http.send({
    endpoint: 'ctos.versions',
    method: 'GET',
    path: `/ctos/${encodeURIComponent(code)}/versions`,
    responseKind: 'json',
    timeoutClass: 'interactive',
    requiresSolution: true,
    ctx,
  });

  const raw = response.raw;
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item));
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const direct = record[code] ?? record[code.toUpperCase()];
    if (typeof direct === 'string') {
      return direct.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (direct !== undefined && direct !== null) {
      return [String(direct)];
    }
    return Object.keys(record);
  }
  return [];
}

/**
 * Fetches table rule versions for a specific CTO and table code.
 *
 * Upstream route: GET /api/ctos/${encodeURIComponent(ctoCode)}/${encodeURIComponent(tableCode)}/rule_versions
 */
export async function fetchRuleVersions(
  http: DcscHttpClient,
  ctx: RequestCtx,
  input: FetchRuleVersionsInput,
): Promise<unknown> {
  const code = input.ctoCode.trim();
  if (!code) {
    throw new Error('A CTO product code is required to fetch rule versions.');
  }
  const table = (input.tableCode ?? '203').trim();

  const response = await http.send({
    endpoint: 'ctos.ruleVersions',
    method: 'GET',
    path: `/ctos/${encodeURIComponent(code)}/${encodeURIComponent(table)}/rule_versions`,
    responseKind: 'json',
    timeoutClass: 'interactive',
    requiresSolution: true,
    ctx,
  });

  return response.raw;
}

/**
 * Combined helper for inspecting CTO version history and rule table versions.
 */
export async function fetchRuleVersionsInfo(
  http: DcscHttpClient,
  ctx: RequestCtx,
  input: FetchRuleVersionsInput,
): Promise<RuleVersionsResult> {
  const ctoCode = input.ctoCode.trim();
  const tableCode = input.tableCode ?? '203';
  const [versions, ruleVersions] = await Promise.all([
    fetchCtoVersions(http, ctx, ctoCode),
    fetchRuleVersions(http, ctx, { ctoCode, tableCode }),
  ]);

  return {
    ctoCode,
    versions,
    tableCode,
    ruleVersions,
  };
}
