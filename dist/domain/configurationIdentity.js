/**
 * Clones one canonical DCSC configuration under a fresh configuration id.
 *
 * The configuration DTO uses `id` and `workspaceId` for the same per-product
 * identity. Some imported DTOs also retain an explicit `configurationId`.
 * Modern `selectedTopologies` is keyed by network name; older payloads wrapped
 * that map in one configuration-id key. Only that exact legacy key is renamed.
 * No recursive string replacement is safe because product metadata, connector
 * data, descriptions, and unknown server fields may legitimately contain the
 * old id as ordinary data.
 */
export function cloneConfigurationRaw(raw, oldId, newId) {
    assertIdentity(oldId, 'oldId');
    assertIdentity(newId, 'newId');
    if (oldId === newId)
        throw new Error('A cloned configuration requires a new identity.');
    const clone = structuredClone(raw);
    clone.id = newId;
    clone.workspaceId = newId;
    if (Object.hasOwn(raw, 'configurationId'))
        clone.configurationId = newId;
    const topologies = clone.selectedTopologies;
    if (isObject(topologies) && Object.hasOwn(topologies, oldId)) {
        if (Object.hasOwn(topologies, newId)) {
            throw new Error(`Cannot clone configuration identity: selectedTopologies already contains ${newId}.`);
        }
        clone.selectedTopologies = renameExactKey(topologies, oldId, newId);
    }
    return clone;
}
function renameExactKey(source, oldKey, newKey) {
    return Object.fromEntries(Object.entries(source).map(([key, value]) => [key === oldKey ? newKey : key, value]));
}
function assertIdentity(value, name) {
    if (!value || value.trim() !== value) {
        throw new Error(`${name} must be a non-empty, trimmed configuration identity.`);
    }
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=configurationIdentity.js.map