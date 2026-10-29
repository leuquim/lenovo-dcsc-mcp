function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function objects(value) {
    return Array.isArray(value)
        ? value.filter((entry) => object(entry) !== undefined)
        : [];
}
function nonempty(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
function positiveInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : undefined;
}
function identity(item, label) {
    const id = nonempty(item['id']);
    const configurationId = nonempty(item['configurationId']);
    if (id && configurationId && id !== configurationId) {
        throw new Error(`${label} has conflicting id and configurationId values.`);
    }
    const resolved = configurationId ?? id;
    if (!resolved)
        throw new Error(`${label} has no configuration identity.`);
    return resolved;
}
function assertSimpleRackItem(item, sourceId) {
    for (const key of ['nodes', 'children', 'rackItems']) {
        if (objects(item[key]).length > 0) {
            throw new Error(`Racked clone source ${sourceId} contains ${key}; nested physical cloning requires an authoritative contract.`);
        }
    }
    if (item['asVLH'] === true || nonempty(item['vlhId'])) {
        throw new Error(`Racked clone source ${sourceId} is a VLH item; VLH cloning requires an authoritative contract.`);
    }
    if (object(item['controllerExpansion']) || nonempty(item['controllerId'])) {
        throw new Error(`Racked clone source ${sourceId} has controller expansion metadata; controller cloning requires an authoritative contract.`);
    }
    if (nonempty(item['originalId'])) {
        throw new Error(`Racked clone source ${sourceId} already has originalId metadata; its identity semantics are not captured.`);
    }
    const rule = object(item['rule']);
    if (rule && (rule['mtMinMaxRule'] != null || rule['productMinMaxRule'] != null)) {
        throw new Error(`Racked clone source ${sourceId} has placement rules that require authoritative placement.`);
    }
}
function occupiedPositions(rack, rackSize) {
    const occupied = new Set();
    for (const raw of objects(rack['rackItems'])) {
        const itemId = identity(raw, 'Rack item');
        const position = positiveInteger(raw['position']);
        const size = positiveInteger(raw['size']);
        if (!position || !size || position + size - 1 > rackSize) {
            throw new Error(`Rack item ${itemId} has incomplete or invalid placement metadata.`);
        }
        for (let u = position; u < position + size; u += 1) {
            if (occupied.has(u))
                throw new Error(`Rack ${String(rack['id'])} has overlapping physical items at U${u}.`);
            occupied.add(u);
        }
    }
    const locked = rack['lockedSpace'];
    if (!Array.isArray(locked))
        throw new Error(`Rack ${String(rack['id'])} has invalid lockedSpace metadata.`);
    for (const raw of locked) {
        const position = positiveInteger(raw);
        if (!position || position > rackSize) {
            throw new Error(`Rack ${String(rack['id'])} has unsupported locked-space metadata.`);
        }
        occupied.add(position);
    }
    return occupied;
}
function firstFreePosition(occupied, size, lowest, highest) {
    const lastStart = highest - size + 1;
    for (let position = lowest; position <= lastStart; position += 1) {
        if (Array.from({ length: size }, (_, offset) => position + offset)
            .every((value) => !occupied.has(value)))
            return position;
    }
    return undefined;
}
function normalizeDependency(value) {
    if (value === undefined)
        return {};
    const source = object(value);
    if (!source)
        throw new Error('cloneDependency must be an object of identity arrays.');
    const normalized = {};
    const owners = new Map();
    for (const [root, rawMembers] of Object.entries(source)) {
        if (!nonempty(root) || !Array.isArray(rawMembers) || rawMembers.length === 0) {
            throw new Error('cloneDependency contains an invalid identity group.');
        }
        const members = [];
        for (const raw of rawMembers) {
            const member = nonempty(raw);
            if (!member)
                throw new Error(`cloneDependency group ${root} contains an invalid identity.`);
            const owner = owners.get(member);
            if (owner && owner !== root)
                throw new Error(`cloneDependency identity ${member} belongs to multiple groups.`);
            owners.set(member, root);
            if (!members.includes(member))
                members.push(member);
        }
        normalized[root] = members.includes(root) ? [root, ...members.filter(member => member !== root)] : [root, ...members];
    }
    return normalized;
}
function extendDependency(value, sourceId, cloneIds, rackId) {
    const dependency = normalizeDependency(value);
    const containing = Object.entries(dependency).filter(([, members]) => members.includes(sourceId));
    if (containing.length > 1)
        throw new Error(`Clone source ${sourceId} belongs to multiple dependency groups.`);
    const root = containing[0]?.[0] ?? sourceId;
    const members = dependency[root] ?? [sourceId];
    if (!members.includes(sourceId))
        members.push(sourceId);
    for (const cloneId of cloneIds) {
        const owner = Object.entries(dependency).find(([, group]) => group.includes(cloneId));
        if (owner)
            throw new Error(`Clone identity ${cloneId} already belongs to dependency group ${owner[0]}.`);
        members.push(cloneId);
    }
    dependency[root] = root === sourceId
        ? [sourceId, ...members.filter(member => member !== sourceId)]
        : [root, ...members.filter(member => member !== root)];
    dependency[rackId] ??= [rackId];
    return dependency;
}
/**
 * Stages the browser's captured `Clone Multiple` physical operation for a
 * direct, rule-free rack item. The returned clone has a new identity,
 * `newHardware: true`, and the first free contiguous rack position. DCSC must
 * still accept the staged layout through rack customize/auto-derive.
 *
 * Copy, non-rack items, nested chassis/VLH, and rule-governed placements are
 * deliberately rejected because their current browser contracts are not yet
 * verified.
 */
export function stageRackedCloneMultiple(options) {
    const sourceId = nonempty(options.sourceId);
    if (!sourceId)
        throw new Error('Racked clone sourceId is required.');
    if (options.cloneIds.length === 0)
        throw new Error('Clone Multiple requires at least one clone identity.');
    const cloneIds = options.cloneIds.map((id) => {
        const normalized = nonempty(id);
        if (!normalized)
            throw new Error('Clone Multiple received an empty clone identity.');
        return normalized;
    });
    if (new Set(cloneIds).size !== cloneIds.length || cloneIds.includes(sourceId)) {
        throw new Error('Clone Multiple identities must be unique and differ from the source.');
    }
    const rackArea = structuredClone(options.rackArea);
    const nonRackArea = structuredClone(options.nonRackArea);
    if (nonRackArea.some(item => identity(item, 'Non-rack item') === sourceId)) {
        throw new Error(`Clone source ${sourceId} is not racked; non-rack clone placement is not captured.`);
    }
    const allIdentities = new Set();
    let match;
    for (const rack of rackArea) {
        const rackId = identity(rack, 'Rack');
        if (allIdentities.has(rackId))
            throw new Error(`Physical identity ${rackId} is duplicated.`);
        allIdentities.add(rackId);
        if (rackId === sourceId)
            throw new Error('Rack cabinets cannot be cloned with the captured item contract.');
        for (const item of objects(rack['rackItems'])) {
            const itemId = identity(item, 'Rack item');
            if (allIdentities.has(itemId))
                throw new Error(`Physical identity ${itemId} is duplicated.`);
            allIdentities.add(itemId);
            if (itemId === sourceId) {
                if (match)
                    throw new Error(`Clone source ${sourceId} occurs more than once in the layout.`);
                match = { rack, item };
            }
        }
    }
    for (const item of nonRackArea) {
        const itemId = identity(item, 'Non-rack item');
        if (allIdentities.has(itemId))
            throw new Error(`Physical identity ${itemId} is duplicated.`);
        allIdentities.add(itemId);
    }
    if (!match)
        throw new Error(`Racked clone source ${sourceId} was not found.`);
    for (const cloneId of cloneIds) {
        if (allIdentities.has(cloneId))
            throw new Error(`Clone identity ${cloneId} already exists in the physical layout.`);
    }
    assertSimpleRackItem(match.item, sourceId);
    const rackId = identity(match.rack, 'Rack');
    const rackSize = positiveInteger(match.rack['size']);
    const itemSize = positiveInteger(match.item['size']);
    const lowest = positiveInteger(match.item['lowestPosition']);
    const highest = positiveInteger(match.item['highestPosition']);
    if (!rackSize || !itemSize || !lowest || !highest || lowest > highest || highest > rackSize) {
        throw new Error(`Racked clone source ${sourceId} has incomplete placement bounds.`);
    }
    const occupied = occupiedPositions(match.rack, rackSize);
    const items = objects(match.rack['rackItems']);
    const placements = [];
    for (const cloneId of cloneIds) {
        const position = firstFreePosition(occupied, itemSize, lowest, highest);
        if (position === undefined) {
            throw new Error(`Rack ${rackId} has no captured-contract placement for clone ${cloneId}; authoritative placement is required.`);
        }
        const clone = structuredClone(match.item);
        clone['id'] = cloneId;
        if (Object.hasOwn(clone, 'configurationId'))
            clone['configurationId'] = cloneId;
        delete clone['originalId'];
        clone['position'] = position;
        clone['lock'] = false;
        clone['newHardware'] = true;
        items.push(clone);
        for (let offset = 0; offset < itemSize; offset += 1)
            occupied.add(position + offset);
        placements.push({ configurationId: cloneId, rackId, position });
    }
    match.rack['rackItems'] = items;
    return {
        rackArea,
        nonRackArea,
        cloneDependency: extendDependency(options.cloneDependency, sourceId, cloneIds, rackId),
        placements,
    };
}
//# sourceMappingURL=physicalClone.js.map