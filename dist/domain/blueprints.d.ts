/**
 * Curated starting points for AI factory work.
 *
 * Architects do not start from a blank configurator; they start from a
 * reference architecture and adjust. Each entry here is a product code that has
 * historical launch, price, export and re-import evidence dated per entry.
 * The MCP checks current catalog availability before presenting or launching
 * them; these historical modes are preferred defaults, not exclusivity claims.
 */
export interface Blueprint {
    id: string;
    name: string;
    productCode: string;
    /** Historically verified preferred mode; recheck current catalog membership. */
    solutionMode: string;
    accelerator: string;
    cooling: 'air' | 'direct water';
    summary: string;
    /** Approximate list price in USD as verified on the date below. */
    verifiedListPriceUsd: number;
    verifiedOn: string;
    /**
     * What the launched configuration does NOT include.
     *
     * The launch price looks like a working node and is not one — these models
     * come up with the GPU baseboard, CPUs and memory populated but no boot
     * device, no local storage and no fabric adapters. Reading the price without
     * reading this is how a node gets under-configured.
     */
    shipsWithout: string[];
    /** Rough per-node max draw, for density sizing before a session exists. */
    approxMaxKWPerNode?: number | undefined;
}
export declare const BLUEPRINTS: Blueprint[];
export declare function findBlueprint(idOrCode: string): Blueprint | undefined;
