/**
 * Request pacing.
 *
 * 35 sequential requests were observed clean and DCSC documents no rate limit,
 * so the policy is deliberately conservative and stays that way: a token
 * bucket for spacing, a semaphore for in-flight concurrency, and a hard
 * per-tool-call budget that stops a runaway agent loop.
 */
export declare class Semaphore {
    #private;
    constructor(permits: number);
    acquire(): Promise<() => void>;
    run<T>(fn: () => Promise<T>): Promise<T>;
}
export declare class TokenBucket {
    #private;
    private readonly capacity;
    private readonly refillPerSec;
    constructor(capacity: number, refillPerSec: number);
    /** Waits until a token is available, then consumes it. */
    take(): Promise<void>;
}
/**
 * Per-tool-call request budget. This is the guard against a runaway agent
 * loop hammering DCSC, and matters more than every other resilience control.
 */
export declare class RequestBudget {
    #private;
    readonly limit: number;
    constructor(limit: number);
    get used(): number;
    get remaining(): number;
    /** Returns false when the budget is exhausted. */
    tryConsume(): boolean;
}
export declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;
