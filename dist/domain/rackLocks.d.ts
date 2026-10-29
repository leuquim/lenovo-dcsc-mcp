import type { RackObject } from './rack.js';
export interface RackLockChange {
    rackArea: RackObject[];
    rackId: string;
    position: number;
    locked: boolean;
}
/** Convert canonical/customize one-based lock positions to the SPA derive/export projection. */
export declare function projectLockedSpaceToSpa(value: unknown, size: number): number[];
/** Hydrate the SPA derive/export zero-based lock projection into canonical one-based positions. */
export declare function hydrateLockedSpaceFromSpa(value: unknown, size: number): number[];
/** Stage the website's direct rack-item Lock/Unlock mutation in canonical physical state. */
export declare function stageRackItemLock(rackArea: RackObject[], itemId: string, locked: boolean): RackLockChange;
/** Stage the website's empty-U Lock/Unlock mutation in canonical physical state. */
export declare function stageRackSpaceLock(rackArea: RackObject[], rackId: string, position: number, locked: boolean): RackLockChange;
