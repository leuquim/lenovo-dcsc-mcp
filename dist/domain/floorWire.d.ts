import type { WorkspaceSession } from '../session/SessionStore.js';
type Obj = Record<string, unknown>;
/** The website exports both grid cells and their flattened report representation. */
export declare function buildFloorState(workspace: WorkspaceSession): {
    information: Obj;
    items: Obj[];
};
export {};
