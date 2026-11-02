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
export declare function querySids(http: DcscHttpClient, opts: SidQueryOptions, ctx: RequestCtx): Promise<SidQueryResult>;
/**
 * Fetches the customizable reference solution payload for a preconfigured SID number.
 *
 * Upstream route: GET /api/reference_solution/CRNs/${sidNumber}/customize
 */
export declare function customizeSid(http: DcscHttpClient, sidNumber: string, ctx: RequestCtx): Promise<unknown>;
