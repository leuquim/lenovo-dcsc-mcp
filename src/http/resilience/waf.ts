import { logger } from '../trace.js';

/**
 * HTTP 499 handling.
 *
 * 499 is DCSC's upstream bot-mitigation verdict: it means this client is
 * flagged, not that a request failed transiently. The real SPA reacts by hard
 * redirecting to www.lenovo.com. It is client-scoped rather than route-scoped,
 * so the response here is global rather than per-endpoint.
 *
 * Policy, deliberately narrow:
 *   - 499 is never retried, at any level.
 *   - Any 499 opens a global cooldown and increments a strike counter.
 *   - Cooldown climbs a ladder: 60s -> 300s -> 900s -> 3600s.
 *   - A rung decays after a run of clean requests; strikes reset after a
 *     sustained clean period.
 *
 * What this deliberately does NOT do: rotate User-Agents, spread load across
 * the regional hosts, or route through proxies. Backing off is ordinary
 * politeness; evading an access control is a different kind of act, and the
 * design forecloses it structurally (fixed host allowlist, pinned UA, no proxy
 * support anywhere in the codebase).
 */
export class WafGate {
  #strikes = 0;
  #cooldownUntil = 0;
  #consecutiveSuccesses = 0;
  #lastStrikeAt = 0;

  constructor(
    private readonly ladderMs: readonly number[],
    private readonly decayAfterSuccesses: number,
    private readonly resetAfterMs: number,
  ) {}

  get strikes(): number {
    return this.#strikes;
  }

  /** Milliseconds remaining in the current cooldown, 0 when clear. */
  remainingMs(now = Date.now()): number {
    this.#maybeReset(now);
    return Math.max(0, this.#cooldownUntil - now);
  }

  get isCoolingDown(): boolean {
    return this.remainingMs() > 0;
  }

  #maybeReset(now: number): void {
    if (
      this.#strikes > 0 &&
      this.#lastStrikeAt > 0 &&
      now - this.#lastStrikeAt >= this.resetAfterMs &&
      now >= this.#cooldownUntil
    ) {
      logger().info(
        { strikes: this.#strikes },
        'WAF strikes reset after sustained clean period',
      );
      this.#strikes = 0;
      this.#consecutiveSuccesses = 0;
    }
  }

  #ladderValue(strike: number): number {
    const idx = Math.min(strike - 1, this.ladderMs.length - 1);
    return this.ladderMs[Math.max(0, idx)] ?? 60_000;
  }

  /** Records a 499 and opens (or extends) the global cooldown. */
  recordStrike(now = Date.now()): number {
    this.#strikes += 1;
    this.#consecutiveSuccesses = 0;
    this.#lastStrikeAt = now;
    const cooldown = this.#ladderValue(this.#strikes);
    this.#cooldownUntil = Math.max(this.#cooldownUntil, now + cooldown);
    logger().warn(
      { strikes: this.#strikes, cooldownMs: cooldown },
      'HTTP 499 from DCSC — client flagged; opening global cooldown',
    );
    return cooldown;
  }

  /** Records a clean response; decays one rung after enough of them. */
  recordSuccess(): void {
    if (this.#strikes === 0) return;
    this.#consecutiveSuccesses += 1;
    if (this.#consecutiveSuccesses >= this.decayAfterSuccesses) {
      this.#strikes -= 1;
      this.#consecutiveSuccesses = 0;
      logger().info({ strikes: this.#strikes }, 'WAF strike decayed');
    }
  }
}
