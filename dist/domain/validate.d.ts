import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import { type Obj } from '../util/coerce.js';
/**
 * DCSC manufacturing validation is a two-request job.
 *
 * POST /lmc_validation returns descriptor objects, not a verdict. The website
 * passes that array unchanged to POST /lmc_validation/result. Only the latter
 * response can establish success or return the manufacturing rule report.
 */
export type ValidationStatus = 'pending' | 'valid' | 'invalid' | 'unavailable' | 'unknown';
export interface ValidationRequestError {
    phase: 'start' | 'result';
    message: string;
    status?: number | undefined;
    retryable?: boolean | undefined;
}
export interface LmcValidationStart {
    buildEntityNumber?: string | undefined;
    uuid?: string | undefined;
    lmcURL?: string | undefined;
    /** Exact response from /lmc_validation. */
    raw: unknown;
    /** Descriptor array posted unchanged to /lmc_validation/result. */
    descriptors: unknown[];
}
export interface LocalMessage {
    severity: 'error' | 'warning' | 'info';
    code?: string | undefined;
    message: string;
    section?: string | undefined;
    configurationId?: string | undefined;
    sourcePath?: string | undefined;
}
export interface LmcValidationResult extends LmcValidationStart {
    status: ValidationStatus;
    terminal: boolean;
    isValid: boolean;
    /** Parsed messages returned by the authoritative result endpoint. */
    messages: LocalMessage[];
    /** Exact response from /lmc_validation/result, when one was obtained. */
    resultRaw?: unknown;
    /** Retained failure detail. A result failure never discards the start descriptors. */
    requestError?: ValidationRequestError;
}
export interface ValidationReport {
    server: LmcValidationResult | undefined;
    /** Authoritative manufacturing messages from /lmc_validation/result. */
    messages: LocalMessage[];
    /** Diagnostics already attached to the DCSC configuration tree. */
    localDiagnostics: LocalMessage[];
    status: ValidationStatus;
    errorCount: number;
    warningCount: number;
    infoCount: number;
    localErrorCount: number;
    localWarningCount: number;
    localInfoCount: number;
    /** True only for a terminal server success with no local error diagnostics. */
    isValid: boolean;
}
/** The website's /lmc_validation body: the export payload narrowed to the keys it posts, plus the mode. */
export declare function lmcValidationBody(exportPayload: Record<string, unknown>, mode: string): Record<string, unknown>;
/** Starts a manufacturing-validation job and retains the exact descriptor array. */
export declare function startLmcValidation(http: DcscHttpClient, ctx: RequestCtx, exportPayload: Record<string, unknown>, mode: string): Promise<LmcValidationStart>;
/** Makes one bounded result request. The caller decides whether a later retry is supported. */
export declare function fetchLmcValidationResult(http: DcscHttpClient, ctx: RequestCtx, start: LmcValidationStart): Promise<LmcValidationResult>;
export declare function parseLmcValidationResult(start: LmcValidationStart, raw: unknown): LmcValidationResult;
/**
 * Collects local diagnostics from the configuration tree. This includes the
 * top-level expansionMessages plus nested section, placement and wizard errors.
 */
export declare function collectLocalDiagnostics(targets: Array<{
    configurationId: string;
    raw: Obj;
}>): LocalMessage[];
export declare function summariseValidation(server: LmcValidationResult | undefined, localDiagnostics: LocalMessage[]): ValidationReport;
