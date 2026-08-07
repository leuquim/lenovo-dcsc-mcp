/**
 * Request pacing.
 *
 * 35 sequential requests were observed clean and DCSC documents no rate limit,
 * so the policy is deliberately conservative and stays that way: a token
 * bucket for spacing, a semaphore for in-flight concurrency, and a hard
 * per-tool-call budget that stops a runaway agent loop.
 */

export class Semaphore {
  #available: number;
  readonly #queue: Array<() => void> = [];

  constructor(permits: number) {
    this.#available = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return this.#release;
    }
    await new Promise<void>((resolve) => this.#queue.push(resolve));
    return this.#release;
  }

  readonly #release = (): void => {
    const next = this.#queue.shift();
    if (next) next();
    else this.#available += 1;
  };

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class TokenBucket {
  #tokens: number;
  #lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.#tokens = capacity;
  }

  #refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.#lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.#tokens = Math.min(this.capacity, this.#tokens + elapsedSec * this.refillPerSec);
    this.#lastRefill = now;
  }

  /** Waits until a token is available, then consumes it. */
  async take(): Promise<void> {
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
  #used = 0;
  constructor(readonly limit: number) {}

  get used(): number {
    return this.#used;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.#used);
  }

  /** Returns false when the budget is exhausted. */
  tryConsume(): boolean {
    if (this.#used >= this.limit) return false;
    this.#used += 1;
    return true;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
