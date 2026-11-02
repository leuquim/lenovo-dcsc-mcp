import type { DcscHttpClient, RequestCtx } from '../http/request.js';
export declare const VLH_TYPES: readonly ['basic', 'switch', 'networking-adapter', 'networking-cable', 'server', 'rack', 'chassis'];
export type VlhType = typeof VLH_TYPES[number];
export interface VlhConnectorOption {
    shortName: string;
    description: string;
    type: string;
    comment?: string;
}
export interface VlhConnectorFunction {
    shortName: string;
    description: string;
}
export interface VlhWizardInfo {
    networkTopologyConnectorsMap: Record<string, VlhConnectorOption[]>;
    connectorFunctions: VlhConnectorFunction[];
    networkTopologies: string[];
    rpqPlaceholders: string[];
}
export interface VlhConnectorRecord {
    networkTopology?: string;
    connector?: string;
    connectorFunction?: string;
    quantity?: number;
    id?: string;
    [key: string]: unknown;
}
export interface VlhAttributes {
    type: VlhType | string;
    attributes: {
        PRODUCT_TYPE?: string;
        HEIGHT_EIA?: number | string;
        EIA_U_CAPACITY?: number | string;
        CONNECTORPORT?: number | string;
        LENGTH?: number | string;
        CABLE_COLOR?: string;
        [key: string]: unknown;
    };
    connectors: VlhConnectorRecord[];
}
/**
 * Queries available network topologies, connector functions, and RPQ placeholders
 * for Neptune water-cooling and VLH items.
 */
export declare function fetchVlhWizardInfo(http: DcscHttpClient, ctx: RequestCtx): Promise<VlhWizardInfo>;
/**
 * Queries physical dimensions, EIA U-height/capacity, and connector definitions
 * for a product or VLH item.
 */
export declare function fetchVlhAttributes(http: DcscHttpClient, code: string, ctx: RequestCtx): Promise<VlhAttributes>;
export declare const VLH_PRODUCT_TYPE = "VLH";
/** One VLH Item Editor entry as the SPA posts it to the export. */
export interface VlhItem {
    vlhId: string;
    vlhType: VlhType;
    commonInfo: {
        description: string;
        listPrice: number;
        productType: string;
        [key: string]: unknown;
    };
    connectors: VlhConnectorRecord[];
    attributes: Array<Record<string, unknown>>;
    bundledParts: Array<Record<string, unknown>>;
}
/** The 14-field export form of the captured POST /vlh/export/xml; only `data` carries content. */
export declare function buildVlhExportForm(items: readonly VlhItem[]): Record<string, string>;
/** Export Items: the VLH item definitions as a .vlh (VLHData XML) download stream. */
export declare function exportVlhItems(http: DcscHttpClient, items: readonly VlhItem[], ctx: RequestCtx): Promise<import("../http/request.js").StreamResponse>;
/** Import Items: uploads a .vlh file as the multipart part `vlhXmlFile`. */
export declare function importVlhItems(http: DcscHttpClient, file: {
    fileName: string;
    content: Uint8Array;
}, ctx: RequestCtx): Promise<unknown>;
