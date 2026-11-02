import { type Obj } from '../util/coerce.js';
/** Lenovo's importer drops the saved breakout divider; retain its exact source identity. */
export declare function readSavedBreakoutConnections(xml: string): Obj[];
/** Restore shape only on a unique, otherwise unchanged backend-imported row. */
export declare function restoreSavedBreakoutConnections(payload: Obj, saved: readonly Obj[]): number;
