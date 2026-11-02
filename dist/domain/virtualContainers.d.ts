import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import type { WorkspaceSession } from '../model/session.js';
export interface VirtualCompatibleProduct {
    code: string;
    description?: string;
    type?: string;
    [key: string]: unknown;
}
export interface VirtualContainerCompatibleCategory {
    id: string;
    compatibleProducts: VirtualCompatibleProduct[];
    [key: string]: unknown;
}
/**
 * Fetches compatible inner products and categories for virtual containers
 * in the current workspace.
 */
export declare function fetchVirtualContainerCompatibleProducts(http: DcscHttpClient, workspace: WorkspaceSession, ctx: RequestCtx): Promise<VirtualContainerCompatibleCategory[]>;
/**
 * Evaluates multi-product rules across virtual container hierarchies
 * in the current workspace.
 */
export declare function checkVirtualContainerRules(http: DcscHttpClient, workspace: WorkspaceSession, ctx: RequestCtx): Promise<unknown[]>;
