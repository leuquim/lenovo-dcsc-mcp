import { DEFAULT_MASTER_SLICES } from '../config/constants.js';
import type { Locale, SolutionContext } from '../config/schema.js';
import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import { SolutionModesSchema } from '../schemas/catalog.js';
import { parseResponse } from '../schemas/parse.js';

export interface SolutionModeInfo {
  mode: string;
  masterSlices: string[];
  description?: string | undefined;
}

/**
 * Resolves the solution context.
 *
 * `masterSlices` cannot be guessed: omitting it returns HTTP 500 and passing
 * the wrong set silently returns an empty catalog. The authoritative values
 * come from /solution_modes, which is why this is a required bootstrap step
 * rather than a constant.
 */
export async function fetchSolutionModes(
  http: DcscHttpClient,
  ctx: RequestCtx,
): Promise<SolutionModeInfo[]> {
  const res = await http.send({
    endpoint: 'solution_modes',
    method: 'GET',
    path: '/solution_modes',
    responseKind: 'json',
    timeoutClass: 'fast',
    // Chicken-and-egg: this call is how we learn masterSlices, so it cannot
    // require them.
    requiresSolution: false,
    ctx,
  });

  const parsed = parseResponse(SolutionModesSchema, res.raw, {
    endpoint: 'solution_modes',
    corrId: ctx.corrId,
    requestId: res.requestId,
  });

  return parsed.map((m) => ({
    mode: m.mode,
    masterSlices: m.masterSlices ?? [...DEFAULT_MASTER_SLICES],
    ...(m.description != null ? { description: m.description } : {}),
  }));
}

/** Picks the requested mode, or the first available, and builds the context. */
export function toSolutionContext(
  modes: SolutionModeInfo[],
  preferred?: string,
): SolutionContext {
  const chosen =
    (preferred ? modes.find((m) => m.mode === preferred) : undefined) ??
    modes.find((m) => m.mode === 'General Purpose') ??
    modes[0];

  if (!chosen) {
    return {
      solutionMode: 'General Purpose',
      masterSlices: [...DEFAULT_MASTER_SLICES],
    };
  }
  return { solutionMode: chosen.mode, masterSlices: chosen.masterSlices };
}

export function baseCtx(corrId: string, locale: Locale): RequestCtx {
  return { corrId, locale };
}
