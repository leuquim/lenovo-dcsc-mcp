import { type NativeManualConnectionRequest } from '../domain/nativeManualCabling.js';
import { type ManualConnectionEdit } from '../domain/manualCabling.js';
import { type AutoConnectResult, type AutoConnectSettingsPatch } from '../domain/cabling.js';
import { type RequestCtx } from '../http/request.js';
import type { Runtime } from './runtime.js';
/**
 * Runs DCSC auto-connect and replaces the workspace cable list with the
 * server's connections. Manual port maps are not invented here.
 */
export declare function runAutoConnect(rt: Runtime, sessionHandle: string, ctx: RequestCtx, expectedRevision?: number, settings?: AutoConnectSettingsPatch): Promise<AutoConnectResult>;
export declare function inspectManualCabling(rt: Runtime, handle: string, expectedWorkspaceRevision?: number): {
    workspace: string;
    revision: number;
    report: import("../domain/manualCabling.js").ManualCablingCatalog;
};
export declare function inspectManualCableChoices(rt: Runtime, handle: string, connectionId: string, expectedWorkspaceRevision: number | undefined, ctx: RequestCtx): Promise<{
    workspace: string;
    revision: number;
    report: import("../domain/manualCabling.js").ManualCablingCatalog;
}>;
export declare function createNativeManualCabling(rt: Runtime, handle: string, request: NativeManualConnectionRequest & {
    expectedRevision: number;
    ctx: RequestCtx;
}): Promise<{
    workspace: string;
    revision: number;
    connection: import("../domain/manualCabling.js").ManualConnectionView;
    pinnedConnectionCount: number;
    sourceConfigurationIds: string[];
    destinationConfigurationIds: string[];
    additionalConnectionCount: number;
}>;
export declare function inspectNativeManualCabling(rt: Runtime, handle: string, request: Omit<NativeManualConnectionRequest, 'cablePart'> & {
    expectedRevision: number;
    ctx: RequestCtx;
}): Promise<{
    workspace: string;
    revision: number;
    report: {
        totalDistance: unknown;
        choices: {
            part: string;
            description: {} | null;
            option: {} | null;
            price: {} | null;
            length: {} | null;
            selection: {
                configurationId: string;
                physicalDestinationIds: any[];
                section: string;
                code: string;
                previousQuantity: number;
                requiredQuantity: number;
                quantity: number;
                configurationIds?: string[];
            };
        }[];
        destinationConfigurationIds: string[];
        sourceConfigurationIds: string[];
        pinnableConnectionCount: number;
        routePreservation: string;
    };
}>;
export declare function editManualCabling(rt: Runtime, handle: string, edit: ManualConnectionEdit & {
    expectedRevision: number;
    ctx: RequestCtx;
}): Promise<{
    connection: import("../domain/manualCabling.js").ManualConnectionView;
    updatedConnections?: import("../domain/manualCabling.js").ManualConnectionView[];
    swappedConnections?: import("../domain/manualCabling.js").ManualConnectionView[];
    workspace: string;
    revision: number;
    configurationChange?: {
        session: string;
        configurationId: string;
        previousTotalPrice: number | null;
        totalPrice: number | null;
        priceDelta: number | null;
        currency: string;
        priceScope: 'editable-configuration';
    };
}>;
export interface CablingCandidate extends Omit<NativeManualConnectionRequest, 'cablePart' | 'pinExistingRoutes'> {
    expectedRevision: number;
}
export interface CableDistanceQuery {
    from: string;
    to: string;
    topology: string;
}
/** Reads the cable configuration panel: the connection list, one connection's refreshed cable choices, the cable choices for a new connection, or the distance between two endpoints. */
export declare function inspectCabling(rt: Runtime, handle: string, opts: {
    expectedRevision?: number | undefined;
    refreshConnectionId?: string | undefined;
    candidate?: Omit<CablingCandidate, 'expectedRevision'> | undefined;
    distance?: CableDistanceQuery | undefined;
    ctx: RequestCtx;
}): Promise<{
    workspace: string;
    revision: number;
    report: import("../domain/manualCabling.js").ManualCablingCatalog;
} | {
    workspace: string;
    revision: number;
    report: {
        totalDistance: unknown;
        choices: {
            part: string;
            description: {} | null;
            option: {} | null;
            price: {} | null;
            length: {} | null;
            selection: {
                configurationId: string;
                physicalDestinationIds: any[];
                section: string;
                code: string;
                previousQuantity: number;
                requiredQuantity: number;
                quantity: number;
                configurationIds?: string[];
            };
        }[];
        destinationConfigurationIds: string[];
        sourceConfigurationIds: string[];
        pinnableConnectionCount: number;
        routePreservation: string;
    };
} | {
    workspace: string;
    revision: number;
    report: {
        from: string;
        to: string;
        topology: string;
        totalDistance: {} | null;
        compatibleCables: {
            part: unknown;
            option: unknown;
            length: unknown;
            price: unknown;
        }[];
    };
}>;
export type CablingChange = ({
    action: 'create';
} & NativeManualConnectionRequest) | ({
    action: 'edit';
} & ManualConnectionEdit);
/** Applies connection changes in order, each against the revision the previous one produced. */
export declare function applyCablingChanges(rt: Runtime, handle: string, changes: readonly CablingChange[], expectedRevision: number, ctx: RequestCtx): Promise<{
    workspace: string;
    revision: number;
    results: {
        action: CablingChange['action'];
        result: Awaited<ReturnType<typeof createNativeManualCabling>> | Awaited<ReturnType<typeof editManualCabling>>;
    }[];
}>;
/**
 * Applies a network topology shortName to a configuration and optionally
 * re-runs auto-connect so DCSC can recompute cabling for the fabric choice.
 */
export declare function applyTopology(rt: Runtime, opts: {
    sessionHandle: string;
    topology: string;
    networkName?: string | undefined;
    connectorIds?: string[] | undefined;
    ports?: string[] | undefined;
    expectedRevision?: number | undefined;
    autoConnect?: boolean | undefined;
    ctx: RequestCtx;
}): Promise<{
    session: string;
    topology: string;
    selectedTopologies: Record<string, unknown>;
    autoConnect?: AutoConnectResult | undefined;
}>;
