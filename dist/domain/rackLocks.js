import { objectItems } from '../util/coerce.js';
function identity(value, label) {
    const id = typeof value['id'] === 'string' && value['id'].trim() ? value['id'] : undefined;
    const configurationId = typeof value['configurationId'] === 'string' && value['configurationId'].trim()
        ? value['configurationId'] : undefined;
    if (id && configurationId && id !== configurationId)
        throw new Error(`${label} has conflicting identities.`);
    const resolved = configurationId ?? id;
    if (!resolved)
        throw new Error(`${label} has no identity.`);
    return resolved;
}
function rackSize(rack) {
    const size = rack['size'];
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) {
        throw new Error(`Rack ${String(rack['id'])} has invalid size metadata.`);
    }
    return size;
}
function canonicalPosition(value, size, label) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > size) {
        throw new Error(`${label} must be a one-based U position from 1 to ${size}.`);
    }
    return value;
}
/** Convert canonical/customize one-based lock positions to the SPA derive/export projection. */
export function projectLockedSpaceToSpa(value, size) {
    if (!Array.isArray(value))
        throw new Error('Rack lockedSpace must be an array.');
    return value.map(position => canonicalPosition(position, size, 'Rack lockedSpace position') - 1);
}
/** Hydrate the SPA derive/export zero-based lock projection into canonical one-based positions. */
export function hydrateLockedSpaceFromSpa(value, size) {
    if (!Array.isArray(value))
        throw new Error('SPA lockedSpace must be an array.');
    return value.map(position => {
        if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0 || position >= size) {
            throw new Error(`SPA lockedSpace position must be zero-based from 0 to ${size - 1}.`);
        }
        return position + 1;
    });
}
function findRack(rackArea, rackId) {
    const matches = rackArea.filter(rack => identity(rack, 'Rack') === rackId);
    if (matches.length !== 1)
        throw new Error(`Rack ${rackId} must occur exactly once in the layout.`);
    return matches[0];
}
/** Stage the website's direct rack-item Lock/Unlock mutation in canonical physical state. */
export function stageRackItemLock(rackArea, itemId, locked) {
    if (!itemId.trim())
        throw new Error('Rack item identity is required.');
    const next = structuredClone(rackArea);
    const matches = [];
    for (const rack of next) {
        for (const item of objectItems(rack['rackItems'])) {
            if (identity(item, 'Rack item') === itemId)
                matches.push({ rack, item });
        }
    }
    if (matches.length !== 1)
        throw new Error(`Rack item ${itemId} must occur exactly once in the layout.`);
    const { rack, item } = matches[0];
    const position = canonicalPosition(item['position'], rackSize(rack), `Rack item ${itemId} position`);
    item['lock'] = locked;
    return { rackArea: next, rackId: identity(rack, 'Rack'), position, locked };
}
/** Stage the website's empty-U Lock/Unlock mutation in canonical physical state. */
export function stageRackSpaceLock(rackArea, rackId, position, locked) {
    if (!rackId.trim())
        throw new Error('Rack identity is required.');
    const next = structuredClone(rackArea);
    const rack = findRack(next, rackId);
    const size = rackSize(rack);
    const canonical = canonicalPosition(position, size, 'Rack lock position');
    const occupied = objectItems(rack['rackItems']).some(item => {
        const start = canonicalPosition(item['position'], size, `Rack item ${identity(item, 'Rack item')} position`);
        const itemSize = item['size'];
        if (typeof itemSize !== 'number' || !Number.isSafeInteger(itemSize) || itemSize < 1 || start + itemSize - 1 > size) {
            throw new Error(`Rack item ${identity(item, 'Rack item')} has invalid size metadata.`);
        }
        return canonical >= start && canonical < start + itemSize;
    });
    if (occupied)
        throw new Error(`Rack ${rackId} U${canonical} is occupied and cannot be space-locked.`);
    const current = rack['lockedSpace'];
    if (!Array.isArray(current))
        throw new Error(`Rack ${rackId} has invalid lockedSpace metadata.`);
    const positions = current.map(value => canonicalPosition(value, size, `Rack ${rackId} lockedSpace position`));
    const present = positions.includes(canonical);
    if (locked && !present)
        positions.push(canonical);
    if (!locked && present)
        positions.splice(positions.indexOf(canonical), 1);
    rack['lockedSpace'] = positions;
    return { rackArea: next, rackId, position: canonical, locked };
}
//# sourceMappingURL=rackLocks.js.map