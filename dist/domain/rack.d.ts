import type { DcscHttpClient, RequestCtx } from '../http/request.js';
/**
 * The rack layer, backed by DCSC rather than modelled locally.
 *
 * Rack fit is not something a client can compute. DCSC applies per-product
 * placement rules ("this server cannot be placed lower than U3 or higher than
 * U35 in this rack"), accumulates weight, and runs a centre-of-gravity
 * stability check that returns PASSED / WARNING / FAILED. Items that cannot be
 * placed are moved out of the rack and returned in nonRackArea. None of that is
 * derivable from U-heights alone, so every mutation is round-tripped through
 * /ctos/racks/customize and the server's answer is taken as the truth.
 */
export type RackObject = Record<string, unknown>;
export interface RackConfigurationFeature {
    code: string;
    quantity: number;
    installations: unknown[];
    description?: string | undefined;
    type?: string | undefined;
    forAutoConnect?: boolean | undefined;
}
export interface RackConfigurationSection {
    name: string;
    features: RackConfigurationFeature[];
}
export interface RackConfigurationWire extends RackObject {
    id: string;
    code: string;
    sections: RackConfigurationSection[];
    connectors: unknown[];
    selectedTopologies: RackObject;
}
/** Full rack workspace payload. Fields owned by other SPA panels pass through. */
export interface RackCustomizePayload extends RackObject {
    rackArea: RackObject[];
    nonRackArea: RackObject[];
    configurations?: RackConfigurationWire[] | undefined;
}
export interface RackCabinet {
    code: string;
    description: string;
    machineType?: string | undefined;
    price?: number | undefined;
}
/** Physical envelope DCSC reports for a product: U height, weight, dimensions. */
export interface PhysicalEnvelope {
    code: string;
    type: string;
    /** Height in rack units. */
    sizeU: number;
    weightKg: number;
    widthMm?: number | undefined;
    depthMm?: number | undefined;
    raw: RackObject;
}
export interface RackItemSummary {
    id: string;
    code: string;
    description?: string | undefined;
    /** Bottom-most U occupied, 1-based. */
    position: number;
    endPosition: number;
    sizeU: number;
}
export interface RackSummary {
    id: string;
    code: string;
    description?: string | undefined;
    sizeU: number;
    usedU: number;
    freeU: number;
    emptyWeightKg?: number | undefined;
    totalWeightKg?: number | undefined;
    /** DCSC's centre-of-gravity verdict: PASSED, WARNING or FAILED. */
    stableStatus?: string | undefined;
    items: RackItemSummary[];
    errors: Array<{
        code?: string | undefined;
        message: string;
    }>;
}
export interface LayoutResult {
    racks: RackSummary[];
    /** Items DCSC refused to place, or that were never placed. */
    unplaced: Array<{
        id?: string | undefined;
        code: string;
        description?: string | undefined;
    }>;
    errors: Array<{
        code?: string | undefined;
        message: string;
    }>;
    /** Raw rackArea, kept so the next mutation can be posted back verbatim. */
    rawRackArea: RackObject[];
    rawNonRackArea: RackObject[];
    connections: unknown[];
    /** Complete endpoint response, including future server fields. */
    rawState: RackObject;
}
/** Rack hardware available in the current solution mode or compatible-parent catalog. */
export declare function fetchRackCabinets(http: DcscHttpClient, ctx: RequestCtx, masterCode?: string, hardwareType?: 'rack' | 'chassis' | 'node'): Promise<RackCabinet[]>;
/**
 * Physical envelope for each product code.
 *
 * This is the only way to learn a product's U height and weight — the
 * configuration tree does not carry them.
 */
export declare function fetchEnvelopes(http: DcscHttpClient, ctx: RequestCtx, items: Array<{
    code: string;
    type: string;
}>): Promise<Map<string, PhysicalEnvelope>>;
/** Uses DCSC's own product classification when requesting a physical envelope. */
export declare function buildEnvelopeRequest(raw: RackObject): {
    code: string;
    type: string;
    asVLH: boolean;
};
/**
 * Classifies a rackable product from server-authored values only.
 *
 * Live launch evidence returns `server`, `switch`, and `rack` in `type`.
 * `hardwareType` wins when the rack service has already made it more specific.
 */
export declare function classifyRackHardware(...sources: Array<RackObject | undefined>): string;
/** Projects full configuration trees into the compact shape posted by the SPA. */
export declare function buildRackConfigurations(configurations: readonly RackObject[]): RackConfigurationWire[];
/** Adds projected configurations while retaining all caller-owned workspace state. */
export declare function buildRackCustomizePayload(state: RackCustomizePayload, configurations: readonly RackObject[]): RackCustomizePayload & {
    configurations: RackConfigurationWire[];
};
/** The SPA applies derive placement metadata to selected results before preparing rack requests. */
export declare function withDerivedPlacements<T extends RackObject>(configuration: T, response: unknown): T;
/**
 * Applies the configuration patch returned by /ctos/autoDerive.
 *
 * The endpoint wraps a partial list in `configurations`: live responses omit
 * configurations that did not change. Match only by the opaque configuration
 * id and retain every omitted configuration in its original order.
 */
export declare function mergeDerivedConfigurations(current: readonly RackObject[], response: unknown): RackObject[];
export interface CustomizeOptions {
    mode?: 'cto' | 'lfo';
    autoArrange?: boolean;
    autoConnect?: boolean;
    cogValidation?: boolean;
}
/**
 * Posts a layout for validation and returns DCSC's corrected version.
 *
 * The response is authoritative: items may have moved, been rejected, or been
 * pushed out to nonRackArea, and weights and stability are recomputed.
 */
export declare function customizeLayout(http: DcscHttpClient, ctx: RequestCtx, payload: RackCustomizePayload, opts?: CustomizeOptions): Promise<LayoutResult>;
/** Builds a rackItem entry for a product placed at a given U position. */
export declare function buildRackItem(envelope: PhysicalEnvelope, configurationId: string, position: number, quantity?: number): RackObject;
/** Builds a rackArea entry for an empty rack cabinet. */
export declare function buildRackObject(envelope: PhysicalEnvelope, rackId: string, items?: RackObject[]): RackObject;
