import type { RawConfiguration } from '../model/types.js';
import { type RackObject } from './rack.js';
export interface RackFiller {
    /** SPA filler coordinate. This is zero-based even when rack-item positions are one-based. */
    position: number;
    size: 1 | 3 | 5;
}
export interface RackFillerProjection {
    rack: RackObject;
    configuration: RawConfiguration;
    filler: RackFiller[];
    selections: Array<{
        code: string;
        quantity: number;
        derived: true;
    }>;
}
export declare class RackFillerCatalogError extends Error {
    readonly missingCodes: string[];
    constructor(missingCodes: string[]);
}
/**
 * Reproduces the SPA `buildFiller` packing used before rack derives.
 *
 * Workspace rack items and locked U values are DCSC's one-based coordinates;
 * filler positions remain the SPA's zero-based local coordinate, as captured.
 */
export declare function buildRackFiller(rack: RackObject, force?: boolean): RackFiller[];
/**
 * Projects the browser-owned rack filler state into both halves of the next
 * workspace derive: physical `rackData` and the compact rack configuration.
 */
export declare function projectRackFiller(sourceRack: RackObject, sourceConfiguration: RawConfiguration): RackFillerProjection;
