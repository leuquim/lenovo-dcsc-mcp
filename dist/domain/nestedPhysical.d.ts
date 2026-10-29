import type { RackObject } from './rack.js';
type Obj = Record<string, unknown>;
/** Explicit native Delete Node intent, distinct from a freshly launched loose product. */
export declare function detachedNestedNodeIds(workspace: {
    serverState: Obj;
    rackArea: RackObject[];
    nonRackArea: RackObject[];
}): Set<string>;
/** A successful backend response must still perform the requested nested edit. */
export declare function assertAcceptedNestedEdit(expected: {
    rackArea: RackObject[];
    nonRackArea: RackObject[];
}, accepted: {
    rackArea: RackObject[];
    nonRackArea: RackObject[];
}): void;
export interface StageConfiguredNodeCopyOptions {
    rackArea: RackObject[];
    nonRackArea: RackObject[];
    chassisId: string;
    sourceNodeId: string;
    copyId: string;
}
export interface NestedNodePlacement {
    rackId: string;
    chassisId: string;
    nodeId: string;
    occupiedBay: number;
}
export interface StagedConfiguredNodeCopy {
    rackArea: RackObject[];
    nonRackArea: RackObject[];
    placement: NestedNodePlacement;
    /** SPA applies this local product-copy mapping only after customize succeeds. */
    configurationIdMapping: Record<string, string>;
}
/**
 * Stage the captured DCSC `Add Node -> Already Configured Nodes -> As Copy`
 * action. The existing configured node remains in the non-rack area and the
 * new physical identity is nested beneath the selected chassis. DCSC remains
 * authoritative for the accepted bay/size representation returned by rack
 * customization.
 */
export declare function stageConfiguredNodeCopy(options: StageConfiguredNodeCopyOptions): StagedConfiguredNodeCopy;
export {};
