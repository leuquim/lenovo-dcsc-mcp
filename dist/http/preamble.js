import { REQUIRED_HEADERS, REQUIRED_QUERY_PARAMS, REQUEST_SOURCE, } from '../config/constants.js';
import { DcscPreambleError } from './errors.js';
/**
 * Builds the locale half of the mandatory query preamble.
 *
 * Note the rename: the API expects `country_or_region`, not `country`. The SPA
 * does the same substitution in its own URL builder.
 */
export function localeParams(locale) {
    return {
        country_or_region: locale.country,
        geo: locale.geo,
        language: locale.language,
        currency: locale.currency,
    };
}
/**
 * Builds the solution half.
 *
 * `solutionMode` must be the human-readable string ("General Purpose"), not an
 * enum — passing an enum returns HTTP 200 with an empty array rather than an
 * error, which is a particularly nasty failure mode.
 */
export function solutionParams(solution) {
    return {
        solutionMode: solution.solutionMode,
        masterSlices: solution.masterSlices.join(','),
    };
}
export function composeQuery(input) {
    const merged = {
        ...localeParams(input.locale),
        ...(input.solution ? solutionParams(input.solution) : {}),
        _request: REQUEST_SOURCE,
        ...(input.query ?? {}),
    };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) {
        if (value === undefined)
            continue;
        params.set(key, String(value));
    }
    return params;
}
/**
 * Fails locally, before a request is sent, when any mandatory param is absent.
 *
 * This converts what would be an HTTP 500 with a leaked JDBC statement into an
 * actionable local error, and costs zero requests.
 */
export function assertPreamble(params, opts) {
    const required = opts.requiresSolution
        ? REQUIRED_QUERY_PARAMS
        : REQUIRED_QUERY_PARAMS.filter((p) => p !== 'solutionMode' && p !== 'masterSlices');
    const missing = required.filter((p) => {
        const v = params.get(p);
        return v === null || v === '';
    });
    if (missing.length > 0) {
        throw new DcscPreambleError({
            endpoint: opts.endpoint,
            corrId: opts.corrId,
            missing,
            userMessage: `Internal error: the DCSC request preamble was incomplete (missing ${missing.join(', ')}). ` +
                'This is a bug in the MCP server, not a DCSC failure.',
        });
    }
}
/** The frozen header set, plus a locale-derived Accept-Language. */
export function composeHeaders(locale) {
    return {
        ...REQUIRED_HEADERS,
        'accept-language': `${locale.language}-${locale.country},${locale.language};q=0.9`,
    };
}
//# sourceMappingURL=preamble.js.map