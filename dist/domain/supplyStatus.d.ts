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
export declare function fetchSupplyStatus(http: DcscHttpClient, ctx: RequestCtx, input: FetchSupplyStatusInput): Promise<SupplyStatusResult>;
/**
 * Fetches ESD (Electronic Software Delivery) info or alternatives.
 * Endpoints:
 * - POST /sst/esd/info
 * - POST /sst/esd/alternative
 */
export declare function fetchEsdInfo(http: DcscHttpClient, ctx: RequestCtx, input: FetchEsdInfoInput): Promise<EsdInfoResult>;
