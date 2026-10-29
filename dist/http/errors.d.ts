export type DcscErrorKind = 'validation' | 'throttled' | 'server' | 'transport' | 'ambiguous_state' | 'contract_drift' | 'budget_exceeded' | 'unsupported' | 'preamble';
export interface DcscErrorContext {
    endpoint?: string | undefined;
    status?: number | undefined;
    requestId?: string | undefined;
    traceId?: string | undefined;
    corrId?: string | undefined;
    /** Safe to show a user. */
    userMessage: string;
    /** Log-only. Already redacted. */
    internal?: string | undefined;
    bodyHash?: string | undefined;
    retryable?: boolean | undefined;
}
export declare class DcscError extends Error {
    readonly kind: DcscErrorKind;
    readonly endpoint: string | undefined;
    readonly status: number | undefined;
    readonly requestId: string | undefined;
    readonly traceId: string | undefined;
    readonly corrId: string | undefined;
    readonly userMessage: string;
    readonly internal: string | undefined;
    readonly bodyHash: string | undefined;
    readonly retryable: boolean;
    constructor(kind: DcscErrorKind, ctx: DcscErrorContext);
}
/**
 * A 4xx problem+json. `detail` is short and names a parameter, so it is safe
 * to surface verbatim — and it is the engine that makes contract discovery
 * cheap.
 */
export declare class DcscValidationError extends DcscError {
    readonly missingParam: string | undefined;
    readonly problemKind: ProblemKind;
    constructor(ctx: DcscErrorContext & {
        missingParam?: string | undefined;
        problemKind: ProblemKind;
    });
}
/** HTTP 499 — the WAF verdict. Never retried, at any level. */
export declare class DcscThrottledError extends DcscError {
    readonly retryAfterMs: number;
    constructor(ctx: DcscErrorContext & {
        retryAfterMs: number;
    });
}
export declare class DcscServerError extends DcscError {
    constructor(ctx: DcscErrorContext);
}
export declare class DcscTransportError extends DcscError {
    constructor(ctx: DcscErrorContext);
}
/**
 * A 5xx on a POST. The mutation may or may not have applied, so it is never
 * retried — the domain layer must re-read state before continuing. A silent
 * duplicate mutation is worse than a visible failure.
 */
export declare class DcscAmbiguousStateError extends DcscError {
    constructor(ctx: DcscErrorContext);
}
export declare class DcscContractDriftError extends DcscError {
    readonly zodPath: string | undefined;
    constructor(ctx: DcscErrorContext & {
        zodPath?: string;
    });
}
export declare class DcscBudgetExceededError extends DcscError {
    constructor(ctx: DcscErrorContext);
}
export declare class DcscUnsupportedError extends DcscError {
    readonly capability: string;
    constructor(ctx: DcscErrorContext & {
        capability: string;
    });
}
/** Thrown locally, before any request is sent, when the preamble is incomplete. */
export declare class DcscPreambleError extends DcscError {
    readonly missing: readonly string[];
    constructor(ctx: DcscErrorContext & {
        missing: readonly string[];
    });
}
export type ProblemKind = 'missing_param' | 'missing_body' | 'bad_param_type' | 'not_found' | 'method_not_allowed' | 'unknown';
export interface ProblemDetails {
    type?: string;
    title?: string;
    status?: number;
    detail?: string;
    instance?: string;
}
interface ParsedProblem {
    kind: ProblemKind;
    param?: string;
}
export declare function parseProblemDetail(detail: string | undefined): ParsedProblem;
export declare function isProblemJson(contentType: string | undefined): boolean;
/**
 * Builds the user-facing message for a 5xx.
 *
 * This is the absolute sanitisation rule: for status >= 500 the user sees a
 * fixed template plus syntactically safe correlation identifiers. The raw
 * body never escapes.
 */
export declare function serverErrorMessage(status: number, requestId: string | undefined, traceId?: string | undefined, corrId?: string | undefined): string;
export interface BuildErrorInput {
    status: number;
    method: string;
    endpoint: string;
    contentType: string | undefined;
    body: unknown;
    requestId: string | undefined;
    traceId: string | undefined;
    corrId: string;
    retryAfterMs?: number;
    /** When true, bypasses redaction for local reverse-engineering. */
    logRawErrors: boolean;
}
/** Maps an HTTP failure response onto the right DcscError subclass. */
export declare function buildHttpError(input: BuildErrorInput): DcscError;
/**
 * The MCP boundary. A tool result may contain only the user message,
 * syntactically validated request/trace/correlation references, and structured
 * hints. The endpoint, raw body, body hash and redacted internal detail remain
 * log-only.
 *
 * Never construct tool errors anywhere else.
 */
export declare function toToolError(err: unknown): {
    error: string;
    kind: string;
    requestId?: string;
    traceId?: string;
    correlationId?: string;
    missingParam?: string;
    retryAfterMs?: number;
    capability?: string;
    code?: string;
    remoteApplied?: boolean;
    localNotCommitted?: boolean;
    retryable?: boolean;
    operation?: string;
    recoveryHint?: string;
};
export {};
