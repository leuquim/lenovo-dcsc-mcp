import { logger } from '../trace.js';

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

interface Sample {
  at: number;
  ok: boolean;
}

/**
 * One circuit breaker per host.
 *
 * The half-open probe is deliberately NOT the caller's real request: it is a
 * cheap known-good GET issued by the caller of `shouldProbe()`. Probing with a
 * user's expensive mutation would be both slow and risky.
 */
export class CircuitBreaker {
  #state: BreakerState = 'closed';
  #samples: Sample[] = [];
  #consecutive5xx = 0;
  #openUntil = 0;
  #halfOpenSuccesses = 0;
  #probeInFlight = false;

  constructor(private readonly opts: BreakerOptions) {}

  get state(): BreakerState {
    this.#refresh();
    return this.#state;
  }

  #refresh(now = Date.now()): void {
    if (this.#state === 'open' && now >= this.#openUntil) {
      this.#state = 'half-open';
      this.#halfOpenSuccesses = 0;
      this.#probeInFlight = false;
      logger().warn('Circuit breaker half-open');
    }
    const cutoff = now - this.opts.windowMs;
    if (this.#samples.length > 0) {
      this.#samples = this.#samples.filter((s) => s.at >= cutoff);
      if (this.#samples.length > this.opts.windowSize) {
        this.#samples = this.#samples.slice(-this.opts.windowSize);
      }
    }
  }

  /** Whether a request may proceed right now. */
  canPass(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open') return false;
    // half-open: exactly one probe at a time
    if (this.#probeInFlight) return false;
    this.#probeInFlight = true;
    return true;
  }

  msUntilClose(now = Date.now()): number {
    return Math.max(0, this.#openUntil - now);
  }

  recordSuccess(now = Date.now()): void {
    this.#consecutive5xx = 0;
    this.#samples.push({ at: now, ok: true });
    if (this.#state === 'half-open') {
      this.#probeInFlight = false;
      this.#halfOpenSuccesses += 1;
      if (this.#halfOpenSuccesses >= this.opts.halfOpenSuccesses) {
        this.#state = 'closed';
        this.#samples = [];
        logger().info('Circuit breaker closed');
      }
    }
    this.#refresh(now);
  }

  recordFailure(opts: { serverError: boolean; now?: number }): void {
    const now = opts.now ?? Date.now();
    this.#samples.push({ at: now, ok: false });
    if (opts.serverError) this.#consecutive5xx += 1;

    if (this.#state === 'half-open') {
      this.#probeInFlight = false;
      this.#trip(now, this.opts.openMs, 'probe failed');
      return;
    }

    if (this.#consecutive5xx >= this.opts.consecutive5xxTrip) {
      this.#trip(now, this.opts.openMs, `${this.#consecutive5xx} consecutive 5xx`);
      return;
    }

    this.#refresh(now);
    if (this.#samples.length >= this.opts.minSamples) {
      const failures = this.#samples.filter((s) => !s.ok).length;
      const ratio = failures / this.#samples.length;
      if (ratio > this.opts.failureRatio) {
        this.#trip(now, this.opts.openMs, `failure ratio ${(ratio * 100).toFixed(0)}%`);
      }
    }
  }

  /** Forces the breaker open, e.g. for the WAF cooldown. Longest wins. */
  forceOpen(durationMs: number, reason: string, now = Date.now()): void {
    this.#trip(now, durationMs, reason);
  }

  #trip(now: number, durationMs: number, reason: string): void {
    this.#state = 'open';
    this.#openUntil = Math.max(this.#openUntil, now + durationMs);
    this.#consecutive5xx = 0;
    this.#samples = [];
    logger().warn({ reason, openMs: durationMs }, 'Circuit breaker opened');
  }
}
