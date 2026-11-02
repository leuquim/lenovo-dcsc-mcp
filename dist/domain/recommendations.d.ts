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
        features?: Array<{
            code: string;
            quantity?: number | undefined;
        }> | undefined;
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
export declare function fetchSubTabRecommendations(http: DcscHttpClient, ctx: RequestCtx, mode: string, productCode: string): Promise<SubTabRecommendation[]>;
/**
 * Fetches cross-sell, bundle and summary recommendations for a solution.
 * Endpoint: POST /recommendations/summary?type={mode}&mode={mode}
 */
export declare function fetchSummaryRecommendations(http: DcscHttpClient, ctx: RequestCtx, payload: SummaryRecommendationPayload, mode?: string): Promise<unknown>;
/**
 * Fetches smart top-choice preconfigured LFO recommendations for a CTO model.
 * Endpoint: POST /smart/recommend/lfo/{country}/{ctoCode}
 */
export declare function fetchSmartLfoRecommendation(http: DcscHttpClient, ctx: RequestCtx, country: string, ctoCode: string, payload?: SmartLfoPayload, isMultiCto?: boolean): Promise<SmartLfoResponse>;
