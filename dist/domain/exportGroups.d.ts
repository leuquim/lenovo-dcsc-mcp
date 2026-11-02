import type { ConfigMode } from '../config/constants.js';
import type { RawConfiguration } from '../model/types.js';
import type { Obj } from '../util/coerce.js';
export interface ExportGroup {
    name: string;
    parent: null;
    index: -1;
    products: ExportGroupProduct[];
}
export interface ExportGroupProduct extends Obj {
    id: string;
    code: string;
    description: string;
    quantity: number;
    price: number | null;
    unitPrice: number | null;
    type: 'hardware' | 'hipo' | 'service' | 'servicectohipo' | 'added-options' | 'unconfigured';
    groupId: string;
    priceNotAvailable?: boolean | undefined;
    showPrice: boolean;
}
/** Minimal structural input so the serializer is independent of session storage. */
export interface ExportGroupWorkspace {
    serverState?: Obj;
    rackArea?: Obj[];
    nonRackArea?: Obj[];
    configurations: ReadonlyMap<string, {
        configurationId: string;
        raw: RawConfiguration;
        product: {
            code: string;
        };
        mode?: ConfigMode | undefined;
    }>;
}
/**
 * Builds the hidden export form's `groups` field for either one configuration
 * or every configuration in a workspace.
 *
 * DCSC's `totalPrice` includes HIPO software and service lines. The website
 * subtracts those child lines from the hardware unit price, then emits each
 * child as its own product. Keeping the inclusive total as the hardware price
 * duplicates thousands of dollars in Quote/Quote Group exports.
 */
export declare function buildExportGroups(source: RawConfiguration | ExportGroupWorkspace, configurationId?: string, mode?: ConfigMode): ExportGroup[];
export interface LogicalGroup {
    name: string;
    parent?: string | undefined;
    products: string[];
}
/**
 * Logical Groups are client state on the website; they reach DCSC only as the export form's `groups` field.
 * Product lines move out of the default group by code; index is the position among siblings, with the
 * default group counted as the first top-level sibling. An imported workspace already holds its groups,
 * and the website counts them in front of the new top-level groups.
 */
export declare function applyLogicalGroups(base: ReadonlyArray<Record<string, unknown>>, logical: readonly LogicalGroup[], importedGroupCount?: number): Array<Record<string, unknown>>;
