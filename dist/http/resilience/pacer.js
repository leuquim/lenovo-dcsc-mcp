/**
 * Request pacing.
 *
 * 35 sequential requests were observed clean and DCSC documents no rate limit,
 * so the policy is deliberately conservative and stays that way: a token
 * bucket for spacing, a semaphore for in-flight concurrency, and a hard
 * per-tool-call budget that stops a runaway agent loop.
 */
export class Semaphore {
    #available;
    #queue = [];
    constructor(permits) {
        this.#available = permits;
    }
    async acquire() {
        if (this.#available > 0) {
            this.#available -= 1;
            return this.#release;
        }
        await new Promise((resolve) => this.#queue.push(resolve));
        return this.#release;
    }
    #release = () => {
        const next = this.#queue.shift();
        if (next)
            next();
        else
            this.#available += 1;
    };
    async run(fn) {
        const release = await this.acquire();
        try {
            return await fn();
        }
        finally {
            release();
        }
    }
}
export class TokenBucket {
    capacity;
    refillPerSec;
    #tokens;
    #lastRefill = Date.now();
    constructor(capacity, refillPerSec) {
        this.capacity = capacity;
        this.refillPerSec = refillPerSec;
        this.#tokens = capacity;
    }
    #refill() {
        const now = Date.now();
        const elapsedSec = (now - this.#lastRefill) / 1000;
        if (elapsedSec <= 0)
            return;
        this.#tokens = Math.min(this.capacity, this.#tokens + elapsedSec * this.refillPerSec);
        this.#lastRefill = now;
    }
    /** Waits until a token is available, then consumes it. */
    async take() {
        for (;;) {
            this.#refill();
            if (this.#tokens >= 1) {
                this.#tokens -= 1;
                return;
            }
            const deficit = 1 - this.#tokens;
            const waitMs = (deficit / this.refillPerSec) * 1000;
            // ±20% jitter, purely to avoid lockstep with any server-side window.
            const jittered = waitMs * (0.8 + Math.random() * 0.4);
            await sleep(Math.max(5, Math.ceil(jittered)));
        }
    }
}
/**
 * Per-tool-call request budget. This is the guard against a runaway agent
 * loop hammering DCSC, and matters more than every other resilience control.
 */
export class RequestBudget {
    limit;
    #used = 0;
    constructor(limit) {
        this.limit = limit;
    }
    get used() {
        return this.#used;
    }
    get remaining() {
        return Math.max(0, this.limit - this.#used);
    }
    /** Returns false when the budget is exhausted. */
    tryConsume() {
        if (this.#used >= this.limit)
            return false;
        this.#used += 1;
        return true;
    }
}
export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
//# sourceMappingURL=pacer.js.map