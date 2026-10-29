/**
 * Floor-grid placement for racks.
 *
 * There is no floor API on DCSC. The SPA keeps the grid entirely client-side
 * (`storeFloorGrid` is a Redux action; `constructFloorGrid` runs in the
 * browser). The 359 mined endpoints contain no `/floor*` path, and probing
 * confirms 404s. Floor coordinates therefore cannot be validated by the
 * server — they are planning state only, the same way the web UI treats them.
 *
 * We still refuse placements that reference a rack DCSC has never seen in
 * this workspace, and we surface an explicit warning so callers do not
 * confuse a local tile with a server-accepted layout.
 */
import type { FloorItem } from '../session/SessionStore.js';
import type { RackObject } from './rack.js';
export interface FloorPlacementResult {
    item: FloorItem;
    /** Always true: DCSC has no floor endpoint. */
    clientSide: true;
    warning: string;
}
/** SPA defaults used when building floorPreference for export / auto_connect. */
export declare const DEFAULT_FLOOR_PREFERENCE: {
    readonly growthRatioHorizontal: 1;
    readonly growthRatioVertical: 1;
    readonly rackDist: 0.01;
    readonly vertDist: 0.5;
    readonly coldDist: 3;
    readonly hotDist: 2;
    readonly slackDist: 0;
    readonly useTrayCabling: false;
};
/**
 * Records a floor placement after checking the rack is in the workspace.
 *
 * Does not invent stability, clearance or aisle rules — the SPA does not
 * ask the server for those either.
 */
export declare function placeRackOnFloor(opts: {
    rackArea: RackObject[];
    rackId: string;
    x: number;
    y: number;
    existing: FloorItem[];
    newId: string;
}): FloorPlacementResult;
