export type BreakerState = 'closed' | 'open' | 'half-open';
export interface BreakerOptions {
    windowSize: number;
    windowMs: number;
    minSamples: number;
    failureRatio: number;
    consecutive5xxTrip: number;
    openMs: number;
    halfOpenSuccesses: number;
}
/**
 * One circuit breaker per host.
 *
 * The half-open probe is deliberately NOT the caller's real request: it is a
 * cheap known-good GET issued by the caller of `shouldProbe()`. Probing with a
 * user's expensive mutation would be both slow and risky.
 */
export declare class CircuitBreaker {
    #private;
    private readonly opts;
    constructor(opts: BreakerOptions);
    get state(): BreakerState;
    /** Whether a request may proceed right now. */
    canPass(): boolean;
    msUntilClose(now?: number): number;
    recordSuccess(now?: number): void;
    recordFailure(opts: {
        serverError: boolean;
        now?: number;
    }): void;
    /** Forces the breaker open, e.g. for the WAF cooldown. Longest wins. */
    forceOpen(durationMs: number, reason: string, now?: number): void;
}
