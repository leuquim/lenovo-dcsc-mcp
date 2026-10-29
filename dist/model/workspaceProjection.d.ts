import type { WorkspaceSession } from '../session/SessionStore.js';
export interface WorkspaceProjectionOptions {
    tool: string;
    arguments: Record<string, unknown>;
    previewLimit?: number | undefined;
    pageLimit?: number | undefined;
}
export interface WorkspacePageOptions extends WorkspaceProjectionOptions {
    path: string[];
    offset: number;
    limit: number;
}
export interface WorkspaceProjectionTotals {
    configurations: number;
    racks: number;
    rackItems: number;
    rackErrors: number;
    unracked: number;
    cables: number;
    floorItems: number;
    powerSelections: number;
    storageNetworks: number;
    cloneDependency: number;
    cloneDependencyColor: number;
    rawRackArea: number;
    rawNonRackArea: number;
    layoutErrors: number;
    rawConnections: number;
    autoConnectMessageGroups: number;
    autoConnectMessages: number;
    standaloneSoftware: number;
    integrityWarnings: number;
}
/**
 * Lossless JSON-safe source behind the compact workspace projections.
 *
 * Keep this source free of previews and truncation. projectJsonPage turns large
 * values into child continuations, so even an individual oversized rack or
 * cable remains inspectable without exceeding an MCP response budget.
 */
export declare function workspaceDetailSource(workspace: WorkspaceSession): Record<string, unknown>;
export declare function workspaceProjectionTotals(source: ReturnType<typeof workspaceDetailSource>): WorkspaceProjectionTotals;
/** Bounded integrity fragment reusable by single-configuration and standalone summaries. */
export declare function projectWorkspaceIntegrity(workspace: WorkspaceSession, options: WorkspaceProjectionOptions): Record<string, unknown>;
/** Compact replacement for the multi-configuration dcsc_session_info body. */
export declare function projectWorkspaceSummary(workspace: WorkspaceSession, options: WorkspaceProjectionOptions): Record<string, unknown>;
/** Compact replacement for the default dcsc_workspace_layout response. */
export declare function projectWorkspaceLayout(workspace: WorkspaceSession, options: WorkspaceProjectionOptions): Record<string, unknown>;
/** Lossless bounded detail page used when a projection tool receives path. */
export declare function projectWorkspacePage(workspace: WorkspaceSession, options: WorkspacePageOptions): Record<string, unknown>;
