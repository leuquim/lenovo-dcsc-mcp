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
export declare class WafGate {
    #private;
    private readonly ladderMs;
    private readonly decayAfterSuccesses;
    private readonly resetAfterMs;
    constructor(ladderMs: readonly number[], decayAfterSuccesses: number, resetAfterMs: number);
    get strikes(): number;
    /** Milliseconds remaining in the current cooldown, 0 when clear. */
    remainingMs(now?: number): number;
    get isCoolingDown(): boolean;
    /** Records a 499 and opens (or extends) the global cooldown. */
    recordStrike(now?: number): number;
    /** Records a clean response; decays one rung after enough of them. */
    recordSuccess(): void;
}
