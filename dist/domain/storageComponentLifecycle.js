import { resolveStoragePhysicalAliases, } from './storagePlacement.js';
import { objectOrUndefined } from '../util/coerce.js';
export const NATIVE_DETACHED_STORAGE_COMMERCIAL_DIFFERENCE = 'website-counts-detached-template';
function requiredString(value, label) {
    if (typeof value !== 'string' || value.trim() === '')
        throw new Error(`${label} is required.`);
    return value;
}
function uniqueStrings(value, label) {
    if (!Array.isArray(value))
        throw new Error(`${label} must be an identity array.`);
    const values = value.map((entry) => requiredString(entry, `${label} member`));
    if (new Set(values).size !== values.length)
        throw new Error(`${label} contains duplicate identities.`);
    return values;
}
export function detachedStorageComponentSource(state) {
    return state['detachedStorageComponents'] ?? [];
}
/** Strict reader used by mutations and identity-sensitive projections. */
export function readDetachedStorageComponents(state) {
    const source = detachedStorageComponentSource(state);
    if (!Array.isArray(source)) {
        throw new Error('Saved detached storage components are malformed. Inspect the recovery snapshot before editing them.');
    }
    const seen = new Set();
    return source.map((raw, index) => {
        const value = objectOrUndefined(raw);
        if (!value)
            throw new Error(`Detached storage component ${index} must be an object.`);
        const templateId = requiredString(value['templateId'], `Detached storage component ${index} templateId`);
        if (seen.has(templateId))
            throw new Error(`Detached storage template ${templateId} occurs more than once.`);
        seen.add(templateId);
        const code = requiredString(value['code'], `Detached storage component ${templateId} code`);
        const type = value['type'];
        if (type !== 'storage' && type !== 'switch') {
            throw new Error(`Detached storage component ${templateId} has invalid type.`);
        }
        const roles = uniqueStrings(value['roles'], `Detached storage component ${templateId} roles`);
        if (roles.length !== 1 || (roles[0] !== 'controller' && roles[0] !== 'mainSwitch')) {
            throw new Error(`Detached storage component ${templateId} must have exactly one captured component role.`);
        }
        const role = roles[0];
        if ((role === 'controller' ? 'storage' : 'switch') !== type) {
            throw new Error(`Detached storage component ${templateId} has conflicting type and role.`);
        }
        const physicalIds = uniqueStrings(value['physicalIds'], `Detached storage component ${templateId} physicalIds`);
        if (physicalIds.includes(templateId)) {
            throw new Error(`Detached storage component ${templateId} lists its template as a physical identity.`);
        }
        if (value['reason'] !== 'definition-replaced' ||
            value['nativeCommercialDifference'] !== NATIVE_DETACHED_STORAGE_COMMERCIAL_DIFFERENCE) {
            throw new Error(`Detached storage component ${templateId} has unsupported lifecycle metadata.`);
        }
        return {
            templateId,
            code,
            type,
            roles: [role],
            physicalIds,
            sourceNetworkName: requiredString(value['sourceNetworkName'], `Detached storage component ${templateId} sourceNetworkName`),
            reason: 'definition-replaced',
            nativeCommercialDifference: NATIVE_DETACHED_STORAGE_COMMERCIAL_DIFFERENCE,
        };
    });
}
/** Tolerant identity projection used while exposing a recovery snapshot. */
export function detachedStorageTemplateIds(state) {
    const source = detachedStorageComponentSource(state);
    if (!Array.isArray(source))
        return new Set();
    return new Set(source.flatMap((raw) => {
        const id = objectOrUndefined(raw)?.['templateId'];
        return typeof id === 'string' && id.trim() ? [id] : [];
    }));
}
function selectedId(network, role) {
    const id = objectOrUndefined(network[role])?.['id'];
    return typeof id === 'string' ? id.trim() : '';
}
function activeTemplateIds(networks) {
    return new Set(networks.flatMap(network => ['controller', 'mainSwitch']
        .map(role => selectedId(network, role)).filter(Boolean)));
}
/**
 * Retains a configured component when a storage definition replaces or clears it.
 *
 * Browser r48 keeps the template configuration, dependency/color root and rack
 * aliases. The native exporter then accidentally charges for the loose template
 * as well as its alias. We record the lifecycle explicitly so MCP projections
 * retain editability but count physical aliases only.
 */
export function retainReplacedStorageComponents(options) {
    const previousMatches = options.previousNetworks.filter(network => network.name === options.definitionName);
    const nextMatches = options.nextNetworks.filter(network => network.name === options.definitionName);
    if (previousMatches.length !== 1 || nextMatches.length !== 1) {
        throw new Error(`Storage network "${options.definitionName}" must exist exactly once before and after replacement.`);
    }
    const state = options.workspace.serverState ?? {};
    const activeAfter = activeTemplateIds(options.nextNetworks);
    const existing = readDetachedStorageComponents(state).filter(record => !activeAfter.has(record.templateId));
    const aliases = resolveStoragePhysicalAliases({
        rackArea: options.workspace.rackArea ?? [],
        nonRackArea: options.workspace.nonRackArea ?? [],
        storageConnectionNetworks: options.previousNetworks,
        cloneDependency: state['cloneDependency'],
    });
    const retained = [];
    for (const role of ['controller', 'mainSwitch']) {
        const before = objectOrUndefined(previousMatches[0][role]);
        const oldId = selectedId(previousMatches[0], role);
        const newId = selectedId(nextMatches[0], role);
        if (!oldId || oldId === newId || activeAfter.has(oldId))
            continue;
        const expectedType = role === 'controller' ? 'storage' : 'switch';
        if (before?.['hardwareType'] !== expectedType) {
            throw new Error(`Storage template ${oldId} has invalid ${role} hardwareType.`);
        }
        const code = requiredString(before['option'], `Storage template ${oldId} code`);
        const physicalIds = aliases.filter(alias => alias.templateId === oldId).map(alias => alias.physicalId);
        const record = {
            templateId: oldId,
            code,
            type: expectedType,
            roles: [role],
            physicalIds,
            sourceNetworkName: options.definitionName,
            reason: 'definition-replaced',
            nativeCommercialDifference: NATIVE_DETACHED_STORAGE_COMMERCIAL_DIFFERENCE,
        };
        const conflict = existing.find(item => item.templateId === oldId);
        if (conflict && JSON.stringify(conflict) !== JSON.stringify(record)) {
            throw new Error(`Detached storage template ${oldId} conflicts with its retained lifecycle record.`);
        }
        if (!conflict)
            existing.push(record);
        retained.push(record);
    }
    return { detachedStorageComponents: structuredClone(existing), retained: structuredClone(retained) };
}
//# sourceMappingURL=storageComponentLifecycle.js.map