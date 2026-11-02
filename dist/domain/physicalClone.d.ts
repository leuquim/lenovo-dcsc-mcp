import type { RackObject } from './rack.js';
export interface RackedClonePlacement {
    configurationId: string;
    rackId: string;
    position: number;
}
export interface StageRackedCloneMultipleOptions {
    rackArea: RackObject[];
    nonRackArea: RackObject[];
    sourceId: string;
    cloneIds: string[];
    /** Each cloned chassis maps every source node ID to its new identity. */
    childCloneIds?: Record<string, Record<string, string>>;
    /**
     * The complete workspace mapping that will be sent in
     * `workspaceInformation.cloneDependency` on auto-derive.
     */
    cloneDependency?: unknown;
}
export interface StagedRackedCloneMultiple {
    rackArea: RackObject[];
    nonRackArea: RackObject[];
    cloneDependency: Record<string, string[]>;
    placements: RackedClonePlacement[];
}
/**
 * Stages the browser's captured `Clone Multiple` physical operation for a
 * direct rack item with supported capacity bounds. The returned clone has a new identity,
 * `newHardware: true`, and the first free contiguous rack position. DCSC must
 * still accept the staged layout through rack customize/auto-derive.
 *
 * Populated chassis require explicit per-parent child identity mappings.
 * Copy, non-rack items, VLH, and complex placement rules are
 * deliberately rejected because their current browser contracts are not yet
 * verified.
 */
export declare function stageRackedCloneMultiple(options: StageRackedCloneMultipleOptions): StagedRackedCloneMultiple;
