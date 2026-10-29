import { usesCtoWire } from './modeFamily.js';
import { buildAutoDeriveRequest } from './reduce.js';
/**
 * Builds the derive the SPA sends when the user chooses Rack > Customize.
 *
 * This is distinct from a summary/workspace derive: every configuration is
 * context for rack rules, while `customizingIds` contains only the rack being
 * opened. DCSC returns a newly hydrated full configuration for that rack.
 */
export function buildRackRecustomizePlan(workspace, rackConfigurationId) {
    const session = [...workspace.configurations.values()]
        .find((candidate) => candidate.configurationId === rackConfigurationId);
    if (!session)
        throw new Error(`Rack ${rackConfigurationId} has no configuration session.`);
    if (!workspace.rackArea.some((rack) => String(rack['id']) === rackConfigurationId)) {
        throw new Error(`Configuration ${rackConfigurationId} is not an active physical rack.`);
    }
    if (!usesCtoWire(session.mode) || [...workspace.configurations.values()].some((candidate) => !usesCtoWire(candidate.mode))) {
        throw new Error('The captured rack recustomization contract currently supports CTO-only workspaces.');
    }
    const autoCorrect = [...workspace.configurations.values()].every((candidate) => candidate.autoCorrect);
    const body = buildAutoDeriveRequest(workspace, {
        validationMode: workspace.validationMode,
        autoCorrect,
    });
    body['customizingIds'] = [rackConfigurationId];
    return {
        endpoint: 'rack_recustomize',
        method: 'POST',
        path: '/ctos/autoDerive',
        query: {
            configurationId: rackConfigurationId,
            entranceFlag: 'customize',
            guideMode: workspace.validationMode === 'guided',
        },
        body,
    };
}
/**
 * Validates the partial autoDerive response before its target configuration is
 * atomically published. The SPA receives exactly one configuration here and
 * replaces that configuration by identity; unrelated workspace members stay
 * intact.
 */
export function parseRackRecustomizeResult(raw, rackConfigurationId) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('DCSC rack recustomization returned a non-object response. No local state was changed.');
    }
    const response = raw;
    if (!Array.isArray(response['configurations']) || response['configurations'].length !== 1) {
        throw new Error('DCSC rack recustomization did not return exactly one configuration. No local state was changed.');
    }
    const candidate = response['configurations'][0];
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('DCSC rack recustomization returned an invalid configuration. No local state was changed.');
    }
    const configuration = candidate;
    if (configuration.id !== rackConfigurationId) {
        throw new Error(`DCSC rack recustomization returned configuration ${String(configuration.id)} instead of ${rackConfigurationId}. No local state was changed.`);
    }
    if (!Array.isArray(configuration.tabs)) {
        throw new Error('DCSC rack recustomization returned an incomplete configuration without tabs. No local state was changed.');
    }
    const responseState = structuredClone(response);
    delete responseState['configurations'];
    return { configuration: structuredClone(configuration), responseState };
}
//# sourceMappingURL=rackRecustomize.js.map