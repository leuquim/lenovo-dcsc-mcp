import type { FabricOptions, StorageController } from './fabric.js';
type Obj = Record<string, unknown>;
export declare const STORAGE_TYPES: readonly ["Balance Warehouse", "General Storage"];
export declare const STORAGE_LAYOUTS: readonly ["Fully Redundant", "Minimal Cabling"];
export declare const DIRECT_ATTACHED: "direct-attached";
export type StorageType = typeof STORAGE_TYPES[number];
export type StorageLayout = typeof STORAGE_LAYOUTS[number];
export interface StorageExpansionChoice {
    id: string;
    controllerId: string;
    option: string;
    featureCode: string;
    description: string;
    maximum: number;
    raw: Obj;
}
export interface StorageNetworkInput {
    name: string;
    controllerId: string;
    /** Defaults to the controller's first expansion, matching the DCSC Add Storage action. */
    expansionId?: string | undefined;
    /** Zero explicitly disables an available expansion. Otherwise the UI default is one. */
    expansionQuantity?: number | undefined;
    /** Omit or use `direct-attached` for DCSC's Direct Attached Connection option. */
    switchId?: string | typeof DIRECT_ATTACHED | undefined;
    type?: StorageType | undefined;
    layout?: StorageLayout | undefined;
}
export type StorageNetworkChanges = {
    [K in keyof Omit<StorageNetworkInput, 'name'>]?: StorageNetworkInput[K] | undefined;
};
export interface StorageConnectionNetwork extends Obj {
    name: string;
    maximumExpansions: number;
    type: StorageType;
    layout: StorageLayout;
    controller: Obj;
    expansion: Obj;
    mainSwitch: Obj;
}
export interface StorageAssignment {
    configurationId: string;
    /** Empty or null selects the website's No Storage option. */
    networkName: string | null;
}
export interface SelectedStorageNetworks {
    configurations: Obj[];
    /** The Redux/workspace map; each raw configuration also receives the same string value. */
    selectedStorageNetwork: Record<string, string>;
}
/** Raw inspection must remain possible even for an unsupported imported value. */
export declare function storageConnectionNetworkSource(state: Obj): unknown;
/** Resolve current and imported storage envelopes without discarding retained fields. */
export declare function readStorageConnectionNetworks(state: Obj): StorageConnectionNetwork[];
/** Controllers and SAN switches referenced by storage definitions are managed configurations,
 * not implicitly loose physical servers. Keep explicitly returned placements. */
export declare function managedStorageComponentIds(state: Obj): Set<string>;
/** Physical storage instances have separate IDs from their editable templates. */
export declare function storagePhysicalTemplateIds(workspace: {
    serverState?: Obj;
    rackArea?: Obj[];
    nonRackArea?: Obj[];
}): Map<string, string>;
/** Storage physical aliases share a template; they are not editable clone sessions. */
export declare function configurationCloneDependency(workspace: {
    serverState?: Obj;
    rackArea?: Obj[];
    nonRackArea?: Obj[];
}): unknown;
/** The browser retains managed component templates at raw quantity one but exports
 * zero commercial units until the managed product has a physical instance. */
export declare function unplacedManagedStorageComponentIds(workspace: {
    serverState?: Obj;
    rackArea?: Obj[];
    nonRackArea?: Obj[];
}): Set<string>;
/** Templates stay at raw quantity one; commercial and power totals count their physical IDs. */
export declare function storageComponentQuantities(workspace: {
    serverState?: Obj;
    rackArea?: Obj[];
    nonRackArea?: Obj[];
}): Map<string, number>;
/** The SPA's export color map also carries the template-to-physical identity links. */
export declare function storageDependencyColors(workspace: {
    serverState?: Obj;
    rackArea?: Obj[];
    nonRackArea?: Obj[];
}): Obj;
/** Adds stable client keys to the expansion records nested under one controller. */
export declare function listStorageExpansions(controller: StorageController): StorageExpansionChoice[];
/**
 * Builds the compact workspace storage record produced by DCSC's Add Storage editor. Catalog
 * descriptions/prices are lookup data; the saved controller, expansion and switch carry only
 * hardware type, option and feature code.
 */
export declare function buildStorageConnectionNetwork(fabric: FabricOptions, input: StorageNetworkInput): StorageConnectionNetwork;
/** Appends a new, uniquely named storage network while retaining all existing raw fields. */
export declare function addStorageConnectionNetwork(existing: readonly StorageConnectionNetwork[], fabric: FabricOptions, input: StorageNetworkInput): StorageConnectionNetwork[];
/** Definition names are references used by configurations, so edits target one exact name. */
export declare function editStorageConnectionNetwork(existing: readonly StorageConnectionNetwork[], edit: {
    name: string;
    action: 'rename' | 'remove';
    newName?: string | undefined;
}): StorageConnectionNetwork[];
/** Website preference controls update only the selected fields, preserving managed identities. */
export declare function reconfigureStorageConnectionNetwork(existing: readonly StorageConnectionNetwork[], fabric: FabricOptions, name: string, changes: StorageNetworkChanges, rackedTemplateIds?: ReadonlySet<string>): StorageConnectionNetwork[];
/**
 * Applies the configuration-side storage dropdown. DCSC stores only the selected network name on
 * each configuration and mirrors those strings in a workspace map keyed by configuration ID.
 */
export declare function applySelectedStorageNetworks(configurations: readonly Obj[], storageConnectionNetworks: readonly StorageConnectionNetwork[], assignments: readonly StorageAssignment[]): SelectedStorageNetworks;
export {};
