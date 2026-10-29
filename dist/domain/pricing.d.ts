import type { RawConfiguration } from '../model/types.js';
/** Missing or explicitly unavailable prices are not a quoted zero. */
export declare function availablePrice(value: unknown, unavailable?: boolean): number | null;
export declare function configurationListPrice(raw: RawConfiguration): number | null;
