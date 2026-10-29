import type { Locale, SolutionContext } from '../config/schema.js';
export type QueryValue = string | number | boolean | undefined;
/**
 * Builds the locale half of the mandatory query preamble.
 *
 * Note the rename: the API expects `country_or_region`, not `country`. The SPA
 * does the same substitution in its own URL builder.
 */
export declare function localeParams(locale: Locale): Record<string, string>;
/**
 * Builds the solution half.
 *
 * `solutionMode` must be the human-readable string ("General Purpose"), not an
 * enum — passing an enum returns HTTP 200 with an empty array rather than an
 * error, which is a particularly nasty failure mode.
 */
export declare function solutionParams(solution: SolutionContext): Record<string, string>;
export interface ComposeInput {
    locale: Locale;
    solution?: SolutionContext | undefined;
    /** Call-site params. May override preamble values, but only explicitly. */
    query?: Record<string, QueryValue> | undefined;
    /**
     * Endpoints that legitimately need no solution context (bootstrap calls such
     * as /locales, /currencies, /system_date).
     */
    requiresSolution?: boolean;
}
export declare function composeQuery(input: ComposeInput): URLSearchParams;
/**
 * Fails locally, before a request is sent, when any mandatory param is absent.
 *
 * This converts what would be an HTTP 500 with a leaked JDBC statement into an
 * actionable local error, and costs zero requests.
 */
export declare function assertPreamble(params: URLSearchParams, opts: {
    endpoint: string;
    corrId: string;
    requiresSolution: boolean;
}): void;
/** The frozen header set, plus a locale-derived Accept-Language. */
export declare function composeHeaders(locale: Locale): Record<string, string>;
