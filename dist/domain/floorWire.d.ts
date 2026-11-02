import type { WorkspaceSession } from '../model/session.js';
import type { Obj } from '../util/coerce.js';
/** The website exports both grid cells and their flattened report representation. */
export declare function buildFloorState(workspace: WorkspaceSession): {
    information: Obj;
    items: Obj[];
};
