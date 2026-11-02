import type { RawConfiguration } from '../model/types.js';
import type { WorkspaceSession } from '../model/session.js';
import { type AutoDerivePath } from './endpoints.js';
export interface StorageAssignmentRequest {
    endpoint: 'storage_assignment';
    method: 'POST';
    path: AutoDerivePath;
    query: {
        configurationId: string;
        guideMode: boolean;
    };
    body: Record<string, unknown>;
}
export interface StorageAssignmentResult {
    configuration: RawConfiguration;
    responseState: Record<string, unknown>;
}
/**
 * Builds the exact derive used by Configuration > Network > Manage storage networks.
 *
 * Every workspace configuration remains rule context, but only the target raw
 * configuration receives the selected name and only its ID is customized. The
 * live request does not carry a workspace selected-storage map.
 */
export declare function buildStorageAssignmentRequest(workspace: WorkspaceSession, targetConfigurationId: string, networkName: string | null): StorageAssignmentRequest;
/** Validates one full assignment target while retaining workspace-wide derived patches. */
export declare function parseStorageAssignmentResponse(raw: unknown, targetConfigurationId: string, networkName: string | null): StorageAssignmentResult;
