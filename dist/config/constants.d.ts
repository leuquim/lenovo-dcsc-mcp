/**
 * Verified constants for the DCSC HTTP surface.
 *
 * Everything in this file was confirmed empirically against
 * https://dcsc.lenovo.com on 2026-08-07. Each block carries the date it was
 * last verified so staleness is visible during review.
 *
 * DCSC is undocumented and unversioned, and ships releases weekly to
 * fortnightly. Treat every value here as a fact with an expiry date.
 */
/** Hosts known to serve the DCSC application. */
export declare const KNOWN_HOSTS: readonly ["dcsc.lenovo.com", "us-dcsc.lenovo.com", "emea-dcsc.lenovo.com", "cn-dcsc.lenovo.com", "dcsc-api.lenovo.com", "us-dcsc-api.lenovo.com"];
export type KnownHost = (typeof KNOWN_HOSTS)[number];
export declare const DEFAULT_HOST: KnownHost;
/**
 * The API is same-origin under /api. The SPA builds this from the bundle
 * constant `prefix: e => "./api" + e`. The *-dcsc-api hosts are NOT a separate
 * API — they serve the identical application.
 *
 * verified 2026-08-07
 */
export declare const API_PREFIX = "/api";
/** The AI configurator ("nightingale") lives under a different prefix. */
export declare const AI_PREFIX = "/ai-acceler";
/**
 * Pinned browser User-Agent.
 *
 * This is constant by design. Rotating it would be an attempt to evade the
 * WAF signal described in resilience/waf.ts, which changes the character of
 * this activity from "using a public endpoint" to "circumventing a technical
 * protection measure". We back off; we never evade.
 *
 * verified 2026-08-07
 */
export declare const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/**
 * Headers DCSC requires on every /api request.
 *
 * `integrationParams` and `X-ENABLE-IAD` are not optional: omitting
 * `integrationParams` makes several endpoints throw a Java NullPointerException
 * and return HTTP 500 (observed on /api/findpart:
 * `Cannot invoke "...IntegrationParams.isIntegratedBPP()" because
 * "integrationParams" is null`).
 *
 * Deliberately NOT sent: Cookie (there is no session to carry) and the
 * Sec-Fetch-* / sec-ch-ua client hints. Server-to-server calls work without
 * them, and fabricating browser fingerprint headers is unnecessary.
 *
 * verified 2026-08-07
 */
export declare const REQUIRED_HEADERS: Readonly<Record<string, string>>;
/**
 * Query parameters DCSC requires on essentially every call, including POSTs
 * (they are rejected when supplied in the body).
 *
 * Two traps encoded here:
 *  - `solutionMode` must be the human-readable string from /api/solution_modes
 *    (e.g. "General Purpose"), NOT an enum like "GENERAL_PURPOSE". Passing the
 *    enum returns HTTP 200 with an empty array, which is worse than an error.
 *  - Omitting `masterSlices` returns HTTP 500 with a raw JDBC statement.
 *
 * verified 2026-08-07
 */
export declare const REQUIRED_QUERY_PARAMS: readonly ["country_or_region", "geo", "language", "currency", "solutionMode", "masterSlices", "_request"];
export type RequiredQueryParam = (typeof REQUIRED_QUERY_PARAMS)[number];
/** The SPA appends this to every request; some endpoints behave differently without it. */
export declare const REQUEST_SOURCE = "web";
/**
 * Configuration mode types, from the bundle constant
 * `CONFIGURATION_MODE_TYPE = {CTO, LFO, LFO_AS_CTO, LFO_ADD_OPTIONS}`.
 *
 * verified 2026-08-07
 */
export declare const CONFIG_MODES: readonly ["cto", "lfo", "lfo-as-cto", "lfo-add-options"];
export type ConfigMode = (typeof CONFIG_MODES)[number];
/**
 * Solution modes, from the bundle constant `SOLUTION_MODE`. These are the
 * human-readable strings the API expects for the `solutionMode` query param.
 *
 * verified 2026-08-07
 */
export declare const SOLUTION_MODES: readonly ["General Purpose", "Cluster", "HPC and AI - LESI Solution", "HPC and AI - Systems"];
export type SolutionModeName = (typeof SOLUTION_MODES)[number];
/**
 * Fallback masterSlices for General Purpose. The authoritative values come
 * from /api/solution_modes at runtime; this exists only so the very first
 * bootstrap call has something valid to send.
 *
 * verified 2026-08-07
 */
export declare const DEFAULT_MASTER_SLICES: readonly ["GP", "HPCGPALL", "HPCGPRYO"];
/**
 * HTTP 499 is the upstream bot-mitigation verdict. The real SPA hard-redirects
 * to www.lenovo.com when it sees this on /solution_modes, /launch or
 * /autoDerive. It is client-scoped, not route-scoped.
 *
 * verified 2026-08-07 (handler present in app bundle)
 */
export declare const WAF_STATUS = 499;
/** Magic bytes used to detect an error masquerading as a successful download. */
export declare const MAGIC_BYTES: {
    readonly zip: Buffer<ArrayBuffer>;
    readonly zipEmpty: Buffer<ArrayBuffer>;
    readonly ole2: Buffer<ArrayBuffer>;
    readonly xml: Buffer<ArrayBuffer>;
};
