import type { RawConfiguration } from '../model/types.js';
import type { RackObject } from './rack.js';
/**
 * The SPA's deriveGroupIdToConfiguration adds catalog-backed MI_P selections
 * locally before export. Group ordinals restart per rack (and loose area),
 * per chassis model, in physical position order. Linked chassis with the same
 * node configuration membership share an ordinal.
 */
export declare function projectChassisManufacturing(input: {
    rackArea: readonly RackObject[];
    nonRackArea: readonly RackObject[];
    configurations: readonly RawConfiguration[];
    cloneDependencyColor?: unknown;
}): RawConfiguration[];
