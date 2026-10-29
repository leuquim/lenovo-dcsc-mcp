export interface RetryOptions {
    maxAttempts: number;
    baseDelayMs: number;
    factor: number;
    maxDelayMs: number;
}
export declare function isRetryableTransportError(err: unknown): boolean;
export interface RetryDecisionInput {
    err: unknown;
    method: string;
    /** True when undici failed before the request body was fully written. */
    connectPhase: boolean;
    attempt: number;
    maxAttempts: number;
}
/**
 * Retry policy.
 *
 * Retried: transport errors, and 502/503/504. A 500 is retried only when it is
 * NOT problem+json — a problem+json 500 is deterministic, so retrying it just
 * burns a request and adds WAF exposure.
 *
 * Never retried: 4xx, 499, and any non-idempotent request that actually
 * reached the server. A POST is retried only on connect-phase failures, where
 * we know the body never landed. A silent duplicate mutation is worse than a
 * visible failure.
 */
export declare function shouldRetry(input: RetryDecisionInput): boolean;
/** Full jitter: random(0, min(base * factor^(n-1), max)). */
export declare function backoffDelay(attempt: number, opts: RetryOptions): number;
