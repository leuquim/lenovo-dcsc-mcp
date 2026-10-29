import { DcscError, DcscThrottledError, DcscValidationError } from '../errors.js';
/** Transport-level error codes worth retrying. */
const RETRYABLE_CODES = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'EPIPE',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
]);
export function isRetryableTransportError(err) {
    if (err === null || typeof err !== 'object')
        return false;
    const code = err.code;
    if (code !== undefined && RETRYABLE_CODES.has(code))
        return true;
    const cause = err.cause;
    return cause !== undefined && cause !== err ? isRetryableTransportError(cause) : false;
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
export function shouldRetry(input) {
    const { err, method, connectPhase, attempt, maxAttempts } = input;
    if (attempt >= maxAttempts)
        return false;
    // 499 is an access-control verdict, not a transient fault.
    if (err instanceof DcscThrottledError)
        return false;
    if (err instanceof DcscValidationError)
        return false;
    const idempotent = method === 'GET' || method === 'HEAD';
    if (isRetryableTransportError(err)) {
        return idempotent || connectPhase;
    }
    if (err instanceof DcscError) {
        if (!err.retryable)
            return false;
        const status = err.status ?? 0;
        const retryableStatus = status === 502 || status === 503 || status === 504 || status === 500;
        if (!retryableStatus)
            return false;
        return idempotent || connectPhase;
    }
    return false;
}
/** Full jitter: random(0, min(base * factor^(n-1), max)). */
export function backoffDelay(attempt, opts) {
    const ceiling = Math.min(opts.baseDelayMs * Math.pow(opts.factor, Math.max(0, attempt - 1)), opts.maxDelayMs);
    return Math.floor(Math.random() * ceiling);
}
//# sourceMappingURL=retry.js.map