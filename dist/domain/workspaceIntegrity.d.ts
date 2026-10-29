import type { WorkspaceSession } from '../session/SessionStore.js';
/** Older recovery records have no scope. They cannot establish that only history was lost. */
export declare function hasUnrepairedRecoveryData(workspace: WorkspaceSession): boolean;
export declare function assertConfigurationReconciliationAllowed(workspace: WorkspaceSession): void;
/** Configuration derive does not verify placements, floor plans, cords or connections. */
export declare function hasPhysicalState(workspace: WorkspaceSession): boolean;
