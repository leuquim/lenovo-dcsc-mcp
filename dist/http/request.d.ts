import type { Readable } from 'node:stream';
import type { Config, Locale, SolutionContext } from '../config/schema.js';
import { type QueryValue } from './preamble.js';
import { RequestBudget } from './resilience/pacer.js';
import { logger } from './trace.js';
export type TimeoutClass = 'fast' | 'interactive' | 'heavy' | 'export';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
/** One part of a multipart/form-data body: either a plain field or a file. */
export type MultipartPart = {
    name: string;
    value: string;
} | {
    name: string;
    filename: string;
    contentType: string;
    content: string;
};
export type ReqBody = {
    kind: 'json';
    value: unknown;
}
/** Reproduces the SPA's hidden-iframe form POST used for exports. */
 | {
    kind: 'form';
    fields: Record<string, string>;
}
/** Reproduces the SPA's file upload used for CFXML import. */
 | {
    kind: 'multipart';
    parts: MultipartPart[];
};
export interface RequestCtx {
    corrId: string;
    locale: Locale;
    solution?: SolutionContext | undefined;
    signal?: AbortSignal | undefined;
    budget?: RequestBudget | undefined;
}
export interface SendInput {
    /** Stable logical id, used for logging, fixtures and fingerprints. */
    endpoint: string;
    method: HttpMethod;
    /** Path below /api, e.g. "/category_hierarchies". */
    path: string;
    query?: Record<string, QueryValue> | undefined;
    body?: ReqBody | undefined;
    responseKind: 'json' | 'stream';
    timeoutClass?: TimeoutClass | undefined;
    /** Bootstrap endpoints (/locales, /currencies) do not need solution context. */
    requiresSolution?: boolean | undefined;
    ctx: RequestCtx;
}
interface BaseResponse {
    status: number;
    headers: Record<string, string>;
    requestId: string | undefined;
    traceId: string | undefined;
    durationMs: number;
}
export interface JsonResponse extends BaseResponse {
    raw: unknown;
}
export interface StreamResponse extends BaseResponse {
    stream: Readable;
    contentType: string | undefined;
    contentDisposition: string | undefined;
}
/**
 * The single chokepoint for all DCSC traffic.
 *
 * This module is the only place in the codebase permitted to import undici
 * (enforced by the no-restricted-imports rule in eslint.config.js). Everything
 * else must call send(), which is what guarantees the mandatory header and
 * query preamble is applied — omitting any part of it produces an HTTP 500
 * from DCSC, sometimes with a leaked SQL statement.
 *
 * Fixed pipeline: budget -> pace -> breaker/WAF -> send -> parse.
 */
export declare class DcscHttpClient {
    #private;
    private readonly config;
    constructor(config: Config);
    get health(): {
        breaker: string;
        wafStrikes: number;
        wafCooldownMs: number;
        enabled: boolean;
    };
    close(): Promise<void>;
    send(input: SendInput & {
        responseKind: 'json';
    }): Promise<JsonResponse>;
    send(input: SendInput & {
        responseKind: 'stream';
    }): Promise<StreamResponse>;
}
export { RequestBudget, logger };
