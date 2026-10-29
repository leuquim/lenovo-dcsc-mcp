import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import type { WorkspaceSession } from '../session/SessionStore.js';
type Obj = Record<string, unknown>;
/** Retains the complete import envelope without replacing canonical workspace identity/settings. */
export declare function mergeImportedState(workspace: WorkspaceSession, payload: Obj): void;
/** Hydrates the import's slim physical hierarchy from DCSC envelope data. */
export declare function hydrateImportedLayout(http: DcscHttpClient, ctx: RequestCtx, workspace: WorkspaceSession, payload: Obj): Promise<void>;
export {};
