import { type Obj } from '../util/coerce.js';
export interface ConfigIdFeature {
    featureCode: string;
    quantity: 1;
    description: string;
}
export interface ConfigIdAssignmentInput {
    rackData: readonly Obj[];
    nonRackData: readonly Obj[];
    configurations: readonly Obj[];
    /** Raw response from GET /rmp/mip. The SPA's config-ID family is key 5374. */
    mipCatalog: unknown;
    /** Optional physical item id -> root configuration id mapping for clones. */
    cloneRoots?: Readonly<Record<string, string>>;
}
export interface ConfigIdAssignmentResult {
    rackData: Obj[];
    nonRackData: Obj[];
    assignedPhysicalItems: number;
    consumedCatalogFeatures: number;
}
/**
 * Applies DCSC's client-held configuration-ID metadata to physical workspace
 * items. The server only supplies the ordered feature catalog through
 * `/rmp/mip`; placement and autoDerive responses do not add these features.
 *
 * A physical item qualifies only when its associated configuration contains a
 * 5374-family HIPO product with a feature list. Distinct 5374 products consume
 * the catalog in physical layout order. Clone items reuse their root's mapping.
 */
export declare function assignConfigIdFeatures(input: ConfigIdAssignmentInput): ConfigIdAssignmentResult;
/** Extracts the exact 5374 family consumed by the current DCSC SPA. */
export declare function configIdCatalog(value: unknown): ConfigIdFeature[];
export declare function configIdTargetCodes(configuration: Obj | undefined): string[];
