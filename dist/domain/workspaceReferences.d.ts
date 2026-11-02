import type { WorkspaceSession } from '../model/session.js';
import type { RackObject } from './rack.js';
/** Removes an existing physical instance without cloning it or changing its metadata. */
export declare function detachPhysicalItem(workspace: WorkspaceSession, id: string): RackObject | undefined;
export declare function physicalIds(item: RackObject): Set<string>;
export declare function removeWorkspaceReferences(workspace: WorkspaceSession, removed: ReadonlySet<string>): void;
