import type { DcscHttpClient, RequestCtx } from '../http/request.js';
type Obj = Record<string, unknown>;
/** Every option retains the fields DCSC returned; `id` is a stable client key. */
export interface FabricOption extends Obj {
    id: string;
}
export interface NetworkTopology extends FabricOption {
    shortName: string;
    description: string;
}
export interface NetworkDevice extends FabricOption {
    option: string;
    feature: string;
    description: string;
    topologies: string[];
    topologyConnectors: Record<string, number>;
}
export interface NetworkType extends FabricOption {
    name: string;
    defaultNetworkTechnology: string;
    defaultLayout: string;
}
export interface CableOption extends FabricOption {
    featureCode: string;
    description: string;
    topologies: string[];
    compatibility: string[];
}
export interface SelectedService extends FabricOption {
    featureCode: string;
    description: string;
}
export interface NodeRole extends FabricOption {
    role: string;
    description: string;
}
export interface LeafNodeCabling extends FabricOption {
    description: string;
}
export interface StorageSwitch extends FabricOption {
    option: string;
    featureCode?: string | undefined;
    description: string;
    price?: number | undefined;
}
export interface StorageController extends FabricOption {
    option: string;
    featureCode?: string | undefined;
    description: string;
    expansions: unknown[];
    price?: number | undefined;
}
export interface FabricOptions {
    topologies: NetworkTopology[];
    networkDevices: NetworkDevice[];
    networkTypes: NetworkType[];
    cables: CableOption[];
    selectedServices: SelectedService[];
    nodeRoles: NodeRole[];
    /** Browser radio choices returned by getTopologies. Older fixtures may omit them. */
    leafNodeCabling?: LeafNodeCabling[] | undefined;
    storageSwitches: StorageSwitch[];
    storageControllers: StorageController[];
}
export interface FabricPage<T> {
    items: T[];
    total: number;
    offset: number;
    limit: number;
    nextOffset?: number | undefined;
}
export declare function paginateFabric<T>(items: readonly T[], opts?: {
    offset?: number | undefined;
    limit?: number | undefined;
}): FabricPage<T>;
export declare function fetchFabricOptions(http: DcscHttpClient, ctx: RequestCtx): Promise<FabricOptions>;
export {};
