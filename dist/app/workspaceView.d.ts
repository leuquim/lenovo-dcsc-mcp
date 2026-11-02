import type { ConfigSession, WorkspaceSession } from '../model/session.js';
import { type Basket } from './standalone.js';
import type { Runtime } from './runtime.js';
export declare function requireConfigSession(rt: Runtime, id: string): ConfigSession;
/** The workspace owning a configuration or workspace handle. */
export declare function requireWorkspaceOf(rt: Runtime, handle: string): WorkspaceSession;
export interface WorkspacePageRequest {
    session: string;
    view: 'summary' | 'layout';
    path?: string[] | undefined;
    offset: number;
    limit: number;
    expectedRevision?: number | undefined;
}
/** A configuration's or workspace's compact summary, or the physical layout, with revision-bound detail pages. */
export declare function inspectWorkspace(rt: Runtime, request: WorkspacePageRequest): Record<string, unknown>;
/** Undo and redo depth of the workspace, so callers know whether dcsc_undo can act. */
export declare function inspectHistory(rt: Runtime, handle: string): Record<string, unknown>;
/** The standalone baskets of a workspace: the single present basket in full, or a pointer to each of several. */
export declare function inspectBaskets(rt: Runtime, request: {
    session: string;
    basket?: Basket | undefined;
    offset: number;
    limit: number;
}): Record<string, unknown>;
export declare function assertCurrentWorkspaceRevision(rt: Runtime, handle: string, expected: number | undefined): WorkspaceSession;
