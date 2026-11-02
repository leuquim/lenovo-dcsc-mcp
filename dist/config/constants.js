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
export const KNOWN_HOSTS = [
    'dcsc.lenovo.com',
    'us-dcsc.lenovo.com',
    'emea-dcsc.lenovo.com',
    'cn-dcsc.lenovo.com',
    'dcsc-api.lenovo.com',
    'us-dcsc-api.lenovo.com',
];
export const DEFAULT_HOST = 'dcsc.lenovo.com';
/**
 * The API is same-origin under /api. The SPA builds this from the bundle
 * constant `prefix: e => "./api" + e`. The *-dcsc-api hosts are NOT a separate
 * API — they serve the identical application.
 *
 * verified 2026-08-07
 */
export const API_PREFIX = '/api';
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
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
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
export const REQUIRED_HEADERS = Object.freeze({
    'user-agent': USER_AGENT,
    accept: 'application/json, text/plain, */*',
    origin: 'https://dcsc.lenovo.com',
    referer: 'https://dcsc.lenovo.com/',
    integrationParams: '{}',
    'X-ENABLE-IAD': 'true',
});
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
export const REQUIRED_QUERY_PARAMS = [
    'country_or_region',
    'geo',
    'language',
    'currency',
    'solutionMode',
    'masterSlices',
    '_request',
];
/** The SPA appends this to every request; some endpoints behave differently without it. */
export const REQUEST_SOURCE = 'web';
/**
 * Configuration mode types, from the bundle constant
 * `CONFIGURATION_MODE_TYPE = {CTO, LFO, LFO_AS_CTO, LFO_ADD_OPTIONS}`.
 *
 * verified 2026-08-07
 */
export const CONFIG_MODES = ['cto', 'lfo', 'lfo-as-cto', 'lfo-add-options'];
export const HPC_SOLUTION_MODE = 'HPC and AI - Systems';
/**
 * Fallback masterSlices for General Purpose. The authoritative values come
 * from /api/solution_modes at runtime; this exists only so the very first
 * bootstrap call has something valid to send.
 *
 * verified 2026-08-07
 */
export const DEFAULT_MASTER_SLICES = ['GP', 'HPCGPALL', 'HPCGPRYO'];
/** Magic bytes used to detect an error masquerading as a successful download. */
export const MAGIC_BYTES = {
    zip: Buffer.from([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04
    zipEmpty: Buffer.from([0x50, 0x4b, 0x05, 0x06]), // empty archive
    ole2: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), // legacy .xls
    xml: Buffer.from('<?xml', 'utf8'),
};
/** Largest tool response, in bytes of compact JSON. */
export const RESPONSE_BYTE_BUDGET = 8000;
/** Room kept for the fields a handler adds around a paged or trimmed payload. */
export const RESPONSE_ENVELOPE_RESERVE_BYTES = 1000;
/** Budget for the payload that pagers and projections trim to fit. */
export const PAGE_BYTE_BUDGET = RESPONSE_BYTE_BUDGET - RESPONSE_ENVELOPE_RESERVE_BYTES;
//# sourceMappingURL=constants.js.map