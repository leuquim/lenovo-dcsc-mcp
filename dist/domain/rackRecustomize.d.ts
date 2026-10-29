import type { RawConfiguration } from '../model/types.js';
import type { WorkspaceSession } from '../session/SessionStore.js';
export interface RackRecustomizePlan {
    endpoint: 'rack_recustomize';
    method: 'POST';
    path: '/ctos/autoDerive';
    query: {
        configurationId: string;
        entranceFlag: 'customize';
        guideMode: boolean;
    };
    body: Record<string, unknown>;
}
export interface RackRecustomizeResult {
    configuration: RawConfiguration;
    /**
     * Lossless response metadata for the workspace server-state envelope. The
     * caller decides when to publish it with the configuration transaction.
     */
    responseState: Record<string, unknown>;
}
/**
 * Builds the derive the SPA sends when the user chooses Rack > Customize.
 *
 * This is distinct from a summary/workspace derive: every configuration is
 * context for rack rules, while `customizingIds` contains only the rack being
 * opened. DCSC returns a newly hydrated full configuration for that rack.
 */
export declare function buildRackRecustomizePlan(workspace: WorkspaceSession, rackConfigurationId: string): RackRecustomizePlan;
/**
 * Validates the partial autoDerive response before its target configuration is
 * atomically published. The SPA receives exactly one configuration here and
 * replaces that configuration by identity; unrelated workspace members stay
 * intact.
 */
export declare function parseRackRecustomizeResult(raw: unknown, rackConfigurationId: string): RackRecustomizeResult;
