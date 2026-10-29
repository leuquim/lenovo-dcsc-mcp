import { DEFAULT_MASTER_SLICES } from '../config/constants.js';
import { SolutionModesSchema } from '../schemas/catalog.js';
import { parseResponse } from '../schemas/parse.js';
/**
 * Resolves the solution context.
 *
 * `masterSlices` cannot be guessed: omitting it returns HTTP 500 and passing
 * the wrong set silently returns an empty catalog. The authoritative values
 * come from /solution_modes, which is why this is a required bootstrap step
 * rather than a constant.
 */
export async function fetchSolutionModes(http, ctx) {
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
        ...(m.modeDescription != null || m.description != null ? { description: m.modeDescription ?? m.description } : {}),
        ...(m.systemFunctionList != null ? { websiteFunctions: m.systemFunctionList } : {}),
    }));
}
/** Picks the requested mode, or the first available, and builds the context. */
export function toSolutionContext(modes, preferred) {
    let chosen;
    if (preferred !== undefined) {
        const requested = preferred.trim();
        chosen = modes.find((m) => m.mode.toLocaleLowerCase() === requested.toLocaleLowerCase());
        if (!chosen) {
            const available = modes.map((m) => `"${m.mode}"`).join(', ');
            throw new Error(`Unknown solution mode "${preferred}". ` +
                (available ? `Valid modes: ${available}.` : 'DCSC returned no available solution modes.'));
        }
    }
    else {
        chosen = modes.find((m) => m.mode === 'General Purpose') ?? modes[0];
    }
    if (!chosen) {
        return {
            solutionMode: 'General Purpose',
            masterSlices: [...DEFAULT_MASTER_SLICES],
        };
    }
    return { solutionMode: chosen.mode, masterSlices: chosen.masterSlices };
}
export function baseCtx(corrId, locale) {
    return { corrId, locale };
}
//# sourceMappingURL=context.js.map