export interface RackCapacityProbeRequest {
    requestedCount: number;
    physicalSizeU: number;
    /** Deterministic seed positions; DCSC remains authoritative when auto-arranging. */
    positionForOrdinal: (ordinal: number) => number;
}
export type RackCapacityProbeResult<TLayout> = {
    kind: 'layout';
    /** Number of requested nodes DCSC retained in the returned rack. */
    acceptedCount: number;
    /** Complete authoritative layout, including weight and placement metadata. */
    layout: TLayout;
} | {
    /** Use only for an explicit capacity rejection, never a generic request error. */
    kind: 'capacity-rejected';
    reason?: string | undefined;
};
export interface RackCapacityResult<TLayout> {
    capacity: number;
    calls: number;
    physicalSizeU: number;
    acceptedLayout?: TLayout | undefined;
    evidence: 'partial-layout' | 'capacity-rejection-bound';
}
export interface FindRackCapacityOptions<TLayout> {
    physicalSizeU: number;
    requestBudget: number;
    /** Safety ceiling for one probe payload. Reaching it is not capacity evidence. */
    maxProbeCount?: number | undefined;
    probe: (request: RackCapacityProbeRequest) => Promise<RackCapacityProbeResult<TLayout>>;
}
export declare class RackCapacityIncompleteError extends Error {
    readonly calls: number;
    readonly requestBudget: number;
    readonly acceptedLowerBound: number;
    readonly rejectedUpperBound?: number | undefined;
    readonly maxProbeCount?: number | undefined;
    constructor(calls: number, requestBudget: number, acceptedLowerBound: number, rejectedUpperBound?: number | undefined, maxProbeCount?: number | undefined);
}
/**
 * Finds the exact DCSC-accepted node count using exponential probes followed by
 * binary search when DCSC rejects an oversized request without returning a
 * partial layout. A successful partial layout is already exact evidence: DCSC
 * saw every requested node and returned the subset it could place.
 */
export declare function findRackCapacity<TLayout>(options: FindRackCapacityOptions<TLayout>): Promise<RackCapacityResult<TLayout>>;
