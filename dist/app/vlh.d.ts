import { type VlhConnectorRecord, type VlhItem, type VlhType } from '../domain/vlh.js';
import type { Runtime } from './runtime.js';
export declare const VLH_SECTIONS: readonly ['topologies', 'connectors', 'functions', 'rpq'];
export type VlhSection = typeof VLH_SECTIONS[number];
export declare const VIRTUAL_CONTAINER_CHECKS: readonly ['compatibleProducts', 'rules'];
export type VirtualContainerCheck = typeof VIRTUAL_CONTAINER_CHECKS[number];
/** VLH wizard info (whole or one section), or the physical attributes of a product or VLH item code. */
export declare function inspectVlh(rt: Runtime, opts: {
    section?: VlhSection | undefined;
    code?: string | undefined;
}): Promise<import("../domain/vlh.js").VlhAttributes | import("../domain/vlh.js").VlhWizardInfo | {
    networkTopologies: string[];
    networkTopologyConnectorsMap?: never;
    connectorFunctions?: never;
    rpqPlaceholders?: never;
} | {
    networkTopologies?: never;
    networkTopologyConnectorsMap: Record<string, import("../domain/vlh.js").VlhConnectorOption[]>;
    connectorFunctions?: never;
    rpqPlaceholders?: never;
} | {
    networkTopologies?: never;
    networkTopologyConnectorsMap?: never;
    connectorFunctions: import("../domain/vlh.js").VlhConnectorFunction[];
    rpqPlaceholders?: never;
} | {
    networkTopologies?: never;
    networkTopologyConnectorsMap?: never;
    connectorFunctions?: never;
    rpqPlaceholders: string[];
}>;
/** Virtual-container compatible products or multi-product rule results for a workspace. */
export declare function inspectVirtualContainers(rt: Runtime, handle: string, opts: {
    check: VirtualContainerCheck;
    expectedRevision?: number | undefined;
}): Promise<{
    rules: unknown[];
    categories?: never;
    session: string;
    revision: number;
} | {
    rules?: never;
    categories: import("../domain/virtualContainers.js").VirtualContainerCompatibleCategory[];
    session: string;
    revision: number;
}>;
export interface VlhItemInput {
    vlhType: VlhType;
    description: string;
    listPrice?: number | undefined;
    vlhId?: string | undefined;
    commonInfo?: Record<string, unknown> | undefined;
    connectors?: VlhConnectorRecord[] | undefined;
    attributes?: Array<Record<string, unknown>> | undefined;
    bundledParts?: Array<Record<string, unknown>> | undefined;
}
/** Builds the item the VLH Item Editor creates, with the defaults its wizard fills in. */
export declare function buildVlhItem(input: VlhItemInput): VlhItem;
/** Export Items: builds the VLH items and writes the downloaded .vlh file to the artifact store. */
export declare function exportVlh(rt: Runtime, opts: {
    items: VlhItemInput[];
    fileName?: string | undefined;
}): Promise<import("../files/artifactStore.js").SpreadsheetArtifact>;
/** Import Items: uploads a .vlh file to the VLH Item Editor. */
export declare function importVlh(rt: Runtime, opts: {
    filePath: string;
}): Promise<{
    imported: unknown;
}>;
