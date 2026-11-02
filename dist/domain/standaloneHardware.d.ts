import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import { type PartLookupMode } from './standalone.js';
import { type Obj } from '../util/coerce.js';
/**
 * Hardware option part numbers (transceivers, cables, kits) added from the
 * website's Part Search as "Standalone Items". The website keeps the complete
 * /findpart row and adds an id and quantity; exports carry that row in
 * `standaloneData` and as a `type: "standalone"` group product.
 */
export interface StandaloneHardwareSelection {
    id: string;
    kind: 'hardware';
    code: string;
    quantity: number;
    description: string;
    featureCode?: string | undefined;
    unitPrice?: number | undefined;
    priceNotAvailable: boolean;
    /** Complete /findpart row, as the website keeps it. */
    part: Obj;
}
export interface StandaloneHardwareState {
    kind: 'standalone-hardware';
    selections: StandaloneHardwareSelection[];
}
export declare function emptyStandaloneHardware(): StandaloneHardwareState;
/** Resolves an exact hardware part number through the website's Part Search endpoint. */
export declare function lookupStandaloneHardwarePart(http: DcscHttpClient, ctx: RequestCtx, code: string, mode?: PartLookupMode): Promise<Obj>;
export declare function standaloneHardwareSelection(part: Obj, quantity: number, id?: string): StandaloneHardwareSelection;
/** Adds a part, or replaces the quantity of one already selected (the website keeps one line per part). */
export declare function selectStandaloneHardware(state: StandaloneHardwareState, part: Obj, quantity: number): StandaloneHardwareState;
export declare function setStandaloneHardwareQuantity(state: StandaloneHardwareState, code: string, quantity: number): StandaloneHardwareState;
export declare function removeStandaloneHardware(state: StandaloneHardwareState, code: string): StandaloneHardwareState;
/** One `standaloneData` row, matching the captured website export form. */
export declare function standaloneHardwareExportItem(selection: StandaloneHardwareSelection): Obj;
/** One `groups[].products` row: the same row typed `standalone` with unit and extended price. */
export declare function standaloneHardwareGroupProduct(selection: StandaloneHardwareSelection, groupName?: string): Obj;
/**
 * Restores standalone hardware rows from a /multiple/cfxml_import response.
 * Rows are recognised by `type: "HARDWARE"`; everything else is left to the
 * software parser.
 */
export declare function parseStandaloneHardwareRows(rows: Obj[], groupProducts: Obj[]): StandaloneHardwareState | undefined;
export declare function isStandaloneHardwareRow(row: Obj): boolean;
export declare function standaloneHardwareTotal(state: StandaloneHardwareState): number | undefined;
