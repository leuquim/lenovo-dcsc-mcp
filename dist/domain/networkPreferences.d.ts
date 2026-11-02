import type { FabricOptions, NetworkType } from './fabric.js';
import { type Obj } from '../util/coerce.js';
export interface ConnectorChoice {
    /** Stable key accepted by `connectorIds`. */
    id: string;
    port: string;
    portNumber: string;
    description: string;
    raw: Obj;
}
export interface TopologySelectionInput {
    /** A topology stable ID or short name. */
    topology: string;
    /** A network-type stable ID or name. Required when several networks are eligible. */
    networkName?: string | undefined;
    /** Stable IDs returned by `listTopologyConnectors`. */
    connectorIds?: readonly string[] | undefined;
    /** Port number, port name, or `port:portNumber`. Each value must identify one connector. */
    ports?: readonly string[] | undefined;
}
export interface WorkspaceNetworkSelection {
    /** Stable network-type ID. */
    networkTypeId: string;
    /** Optional topology stable ID or short name; otherwise the network's current default is used. */
    topology?: string | undefined;
    mainDeviceId?: string | undefined;
    leafDeviceId?: string | undefined;
    cableId?: string | undefined;
    leafCableId?: string | undefined;
    /** Empty string clears the color preference, matching the website's unselected color. */
    cableColor?: string | undefined;
    leafCableColor?: string | undefined;
    /** Website layout choice. Changing it clears existing VLAN joins. */
    layout?: 'Centralized' | 'Distributed' | undefined;
    mainTrunks?: number | undefined;
    leafTrunks?: number | undefined;
    /** Exact description returned by the leaf-node-cabling catalog. */
    leafCabling?: string | undefined;
    /** Stable IDs of other network records joined to this centralized main switch. */
    vlanNetworkTypeIds?: readonly string[] | undefined;
    /** Stable custom-cable ID, or `manual-cable` to clear it. Valid only without a main switch. */
    customCableId?: string | undefined;
}
export interface ResolvedWorkspaceNetworkSelection {
    networkTypeId: string;
    topologyId: string;
    mainDeviceId?: string | undefined;
    leafDeviceId?: string | undefined;
    cableId?: string | undefined;
    leafCableId?: string | undefined;
    /** Empty string clears the color preference, matching the website's unselected color. */
    cableColor?: string | undefined;
    leafCableColor?: string | undefined;
    layout: 'Centralized' | 'Distributed';
    mainTrunks: number;
    leafTrunks: number;
    leafCabling?: string | undefined;
    vlanNetworkTypeIds: string[];
    customCableId?: string | undefined;
}
export interface WorkspaceNetworkPreferences {
    /** Validated network records consumed by the SPA cluster-preference adapter. */
    networkTypes: NetworkType[];
    clusterPreference: Obj[];
    selections: ResolvedWorkspaceNetworkSelection[];
}
/** Lists the exact connector DTOs that may be selected for a configuration/topology. */
export declare function listTopologyConnectors(rawConfiguration: Obj, fabric: FabricOptions, topology: string): ConnectorChoice[];
/**
 * Builds one configuration's SPA `selectedTopologies` map. Existing network entries and every
 * field of selected connector DTOs are preserved.
 */
export declare function buildSelectedTopologies(rawConfiguration: Obj, fabric: FabricOptions, input: TopologySelectionInput, storageNetworkNames?: readonly string[]): Obj;
export declare const EXISTING_CUSTOMER_SWITCH_ID = "existing-customer-switch";
export declare const MANUAL_CABLE_ID = "manual-cable";
export interface NetworkLeafCablingChoice extends Record<string, unknown> {
    id: string;
    description: string;
}
/** Effective website radio choices, including the SPA fallback when the API omits/empties the list. */
export declare function listNetworkLeafCablingChoices(fabric: FabricOptions): NetworkLeafCablingChoice[];
/**
 * Validates active network selections and produces the exact cluster-preference DTOs consumed by
 * auto-connect. Defaults are accepted only when they still identify one available catalog option.
 */
export declare function buildWorkspaceNetworkPreferences(fabric: FabricOptions, requested: readonly WorkspaceNetworkSelection[]): WorkspaceNetworkPreferences;
