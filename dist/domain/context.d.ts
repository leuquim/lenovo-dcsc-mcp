import type { SolutionContext } from '../config/schema.js';
import type { DcscHttpClient, RequestCtx } from '../http/request.js';
export interface SolutionModeInfo {
    mode: string;
    masterSlices: string[];
    description?: string | undefined;
    /** Website feature switches for this mode, not a guarantee about API endpoint availability. */
    websiteFunctions?: Record<string, boolean> | undefined;
}
/**
 * Resolves the solution context.
 *
 * `masterSlices` cannot be guessed: omitting it returns HTTP 500 and passing
 * the wrong set silently returns an empty catalog. The authoritative values
 * come from /solution_modes, which is why this is a required bootstrap step
 * rather than a constant.
 */
export declare function fetchSolutionModes(http: DcscHttpClient, ctx: RequestCtx): Promise<SolutionModeInfo[]>;
/** Picks the requested mode, or the first available, and builds the context. */
export declare function toSolutionContext(modes: SolutionModeInfo[], preferred?: string): SolutionContext;
