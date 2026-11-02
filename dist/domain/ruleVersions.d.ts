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
export declare function fetchCtoVersions(http: DcscHttpClient, ctx: RequestCtx, ctoCode: string): Promise<string[]>;
/**
 * Fetches table rule versions for a specific CTO and table code.
 *
 * Upstream route: GET /api/ctos/${encodeURIComponent(ctoCode)}/${encodeURIComponent(tableCode)}/rule_versions
 */
export declare function fetchRuleVersions(http: DcscHttpClient, ctx: RequestCtx, input: FetchRuleVersionsInput): Promise<unknown>;
/**
 * Combined helper for inspecting CTO version history and rule table versions.
 */
export declare function fetchRuleVersionsInfo(http: DcscHttpClient, ctx: RequestCtx, input: FetchRuleVersionsInput): Promise<RuleVersionsResult>;
