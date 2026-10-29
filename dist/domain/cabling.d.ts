import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import type { RawConfiguration } from '../model/types.js';
import type { CableLink } from '../session/SessionStore.js';
import type { NetworkDevice, NetworkType } from './fabric.js';
import type { RackObject } from './rack.js';
type Obj = Record<string, unknown>;
export interface ConnectionSummary {
    id: string;
    fromId?: string | undefined;
    toId?: string | undefined;
    fromPort?: string | undefined;
    toPort?: string | undefined;
    sourcePortName?: string | undefined;
    sourcePortNumber?: string | undefined;
    destinationPortName?: string | undefined;
    destinationPortNumber?: string | undefined;
    cableCode?: string | undefined;
    description?: string | undefined;
    network?: string | undefined;
    topology?: string | undefined;
    raw: Obj;
}
export interface AutoConnectSettings extends Obj {
    autoAddPDU?: boolean | undefined;
    autoAddSwitch?: boolean | undefined;
    p2pCabling?: boolean | undefined;
}
export type AutoConnectSettingsPatch = Pick<AutoConnectSettings, 'autoAddPDU' | 'autoAddSwitch' | 'p2pCabling'>;
/** Import/export stores these toggles in customizingFlags; live requests use settings. */
export declare function readAutoConnectSettings(state: Obj): AutoConnectSettings;
/** Canonical live graph takes precedence, including an authoritative empty array. */
export declare function readConnectionGraph(state: Obj): unknown[];
/** Retain the last graph for inspection, but never export it as a current design. */
export declare function invalidateConnectionGraph(state: Obj, reason: string): void;
export declare function assertCurrentConnectionGraph(state: Obj): void;
export declare function readSwitchMap(state: Obj): unknown[];
/** Captured SPA export groups by cablePart; AI/HPC excludes Power connections. */
export declare function buildCableGroups(connections: readonly unknown[], includePower: boolean): Obj[];
/** Website settings are a partial edit; retain imported settings we do not expose. */
export declare function mergeAutoConnectSettings(current: unknown, patch: AutoConnectSettingsPatch): AutoConnectSettings;
/** Full SPA request state. Unknown/new DCSC keys pass through unchanged. */
export interface AutoConnectPayload extends Obj {
    rackArea: RackObject[];
    nonRackArea?: RackObject[] | undefined;
    configurations: RawConfiguration[];
    controllerExpansionMap?: Obj | undefined;
    floorPreference?: Obj | undefined;
    floorItems?: unknown[] | undefined;
    clusterPreference?: unknown[] | undefined;
    powerPreference?: unknown[] | undefined;
    storageConnectionNetworks?: unknown[] | undefined;
    cloneRackMapping?: Obj | undefined;
    connections?: unknown[] | undefined;
    autoConnectSettings?: AutoConnectSettings | undefined;
    switchMap?: unknown[] | undefined;
    virtualContainerIdMapping?: Obj | undefined;
    virtualContainerRule2ConfigMapping?: Obj | undefined;
    virtualContainerInvalidRuleIdMapping?: Obj | undefined;
    vlhItems?: unknown[] | undefined;
    cloneDependency?: Record<string, string[]> | undefined;
}
export interface AutoConnectResult {
    settings: AutoConnectSettings;
    connections: ConnectionSummary[];
    cables: CableLink[];
    rawRackArea: RackObject[];
    rawNonRackArea: RackObject[];
    rawConnections: unknown[];
    errors: unknown[];
    rawState: Obj;
    messages: Array<{
        rackId: string;
        messages: string[];
    }>;
}
/** One projection for graphs returned by either auto-connect or rack customization. */
export declare function projectConnectionGraph(rawConnections: readonly unknown[]): {
    connections: ConnectionSummary[];
    cables: CableLink[];
};
/** Mirrors the SPA's converNetworkTopologies2ClusterPreference adapter. */
export declare function buildClusterPreferences(networkDevices: readonly NetworkDevice[], networkTypes: readonly NetworkType[]): Obj[];
/** Captured automatic-switch map: calculation calls the role usage, export calls it type. */
export declare function buildSwitchMapEntry(id: string, network: string, usage: 'main' | 'leaf', code: string): {
    readonly id: string;
    readonly network: string;
    readonly type: "main" | "leaf";
    readonly code: string;
};
/** Exact /auto_connect request shape: the SPA never seeds regeneration with prior graph rows. */
export declare function buildAutoConnectRequest(payload: AutoConnectPayload): AutoConnectPayload;
export declare function autoConnect(http: DcscHttpClient, ctx: RequestCtx, payload: AutoConnectPayload, query?: {
    autoArrange: boolean;
    autoConnect: boolean;
    cogValidation: boolean;
}): Promise<AutoConnectResult>;
export {};
