import type { RawConfiguration } from '../model/types.js';
import type { ReducedConfiguration } from './reduce.js';
/** Filters are scoped by their parent and group; upstream names recur across products. */
export declare function softwareFilterName(parent: string, group: string, filter: string): string;
/** Browser-captured group toggles and nested maintenance/filter edits. */
export declare function applySoftwareSelection(config: ReducedConfiguration, raw: RawConfiguration, change: {
    sectionName: string;
    code: string;
    quantity: number;
}): ReducedConfiguration | undefined;
