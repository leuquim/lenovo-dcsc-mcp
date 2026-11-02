import { planNativeManualCableSelection } from '../domain/nativeManualCabling.js';
import { type CustomizeOptions, type LayoutResult, type RackObject } from '../domain/rack.js';
import { type AutoConnectResult } from '../domain/cabling.js';
import { type RequestCtx } from '../http/request.js';
import type { RawConfiguration } from '../model/types.js';
import type { WorkspaceSession } from '../model/session.js';
import { type Runtime } from './runtime.js';
/**
 * Re-validates the workspace's layout and stores DCSC's corrected version.
 *
 * Every rack mutation funnels through here: DCSC may move items, reject
 * placements or push them out of the rack entirely, and its answer replaces
 * ours rather than merging with it.
 */
export declare function syncLayout(rt: Runtime, ws: WorkspaceSession, rackArea: RackObject[], ctx: RequestCtx, opts?: CustomizeOptions & {
    cloneMultiple?: boolean;
    cloneHpcSwitch?: string;
    clonePopulatedChassis?: boolean;
    copyPopulatedChassisDependency?: unknown;
    copyConfigurationId?: string;
    lockMutation?: boolean;
    preserveImportedManualCables?: boolean;
    deletedLinkedRootConfigurations?: RawConfiguration[];
    forceArrange?: boolean;
    nestedPhysicalEdit?: {
        configurations: RawConfiguration[];
        cloneDependency: unknown;
    };
}): Promise<LayoutResult>;
export declare function workspaceNetworkState(ws: WorkspaceSession): Record<string, unknown>;
export declare function workspaceCablingPayload(ws: WorkspaceSession): import("../domain/rack.js").RackCustomizePayload & {
    configurations: import("../domain/rack.js").RackConfigurationWire[];
};
export declare function refreshStorageLayoutDraft(rt: Runtime, ws: WorkspaceSession, ctx: RequestCtx): Promise<void>;
export declare function provisionSwitchesDraft(rt: Runtime, ws: WorkspaceSession, ctx: RequestCtx, opts?: {
    deferLayout?: boolean;
}): Promise<void>;
export declare function autoConnectDraft(rt: Runtime, ws: WorkspaceSession, ctx: RequestCtx, seedConnections?: readonly unknown[], manualCableSelection?: ReturnType<typeof planNativeManualCableSelection> | Array<ReturnType<typeof planNativeManualCableSelection>>): Promise<AutoConnectResult>;
/** Adds the SPA-owned CONFIG_ID metadata; only detached drafts may be passed. */
export declare function prepareConfigIdsDraft(rt: Runtime, ws: WorkspaceSession, ctx: RequestCtx): Promise<void>;
export declare function refreshRackMetadata(ws: WorkspaceSession, refreshFeatures?: boolean): void;
export declare function acceptDerivedWorkspaceConfigurations(ws: WorkspaceSession, response: unknown): void;
export declare function acceptWorkspaceConfigurations(ws: WorkspaceSession, values: unknown[]): void;
/** Current physical endpoints and floor geometry for the website's existing-row editor. */
export declare function manualCablingInput(workspace: WorkspaceSession): {
    connections: unknown[];
    cloneDependency: unknown;
    configurations: RawConfiguration[];
    rackArea: RackObject[];
    nonRackArea: RackObject[];
    floorItems: import("../util/coerce.js").Obj[];
    floorPreference: Record<string, unknown>;
    physicalTemplateIds: Map<string, string>;
    mode: "cto" | "lfo";
    solutionMode: string;
};
