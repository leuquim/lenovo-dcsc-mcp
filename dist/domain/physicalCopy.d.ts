import { type RackedClonePlacement, type StageRackedCloneMultipleOptions } from './physicalClone.js';
export interface StageRackedCopyOptions extends Omit<StageRackedCloneMultipleOptions, 'cloneIds'> {
    copyId: string;
    /** Configuration name used by Copy when the physical rack item is intentionally unnamed. */
    sourceName?: string | undefined;
}
export interface StagedRackedCopy {
    rackArea: StageRackedCloneMultipleOptions['rackArea'];
    nonRackArea: StageRackedCloneMultipleOptions['nonRackArea'];
    cloneDependency: Record<string, string[]>;
    placement: RackedClonePlacement;
    copyName: string;
}
/**
 * Stage the browser's distinct rack `Copy` action for one direct rack item.
 * A Copy gets an independent identity/name/dependency group; unlike Clone
 * Multiple it does not remain commercially linked to its source.
 */
export declare function stageRackedCopy(options: StageRackedCopyOptions): StagedRackedCopy;
