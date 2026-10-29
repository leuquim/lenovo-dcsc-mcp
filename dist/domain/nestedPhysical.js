import { physicalIds } from './workspaceReferences.js';
/** Explicit native Delete Node intent, distinct from a freshly launched loose product. */
export function detachedNestedNodeIds(workspace) {
    const marked = workspace.serverState.detachedNestedNodeIds;
    const present = new Set([...workspace.rackArea, ...workspace.nonRackArea].flatMap(item => [...physicalIds(item)]));
    return new Set(Array.isArray(marked) ? marked.filter((id) => typeof id === 'string' && !present.has(id)) : []);
}
/** A successful backend response must still perform the requested nested edit. */
export function assertAcceptedNestedEdit(expected, accepted) {
    const identities = (areas) => {
        const result = [];
        const visit = (item) => {
            if (typeof item.id === 'string')
                result.push(item.id);
            for (const field of ['rackItems', 'nodes']) {
                if (Array.isArray(item[field]))
                    item[field].forEach(visit);
            }
        };
        areas.forEach(visit);
        return result.sort();
    };
    const expectedIds = identities([...expected.rackArea, ...expected.nonRackArea]);
    const acceptedIds = identities([...accepted.rackArea, ...accepted.nonRackArea]);
    if (JSON.stringify(expectedIds) !== JSON.stringify(acceptedIds) ||
        new Set(acceptedIds).size !== acceptedIds.length) {
        throw new Error('DCSC did not preserve the requested nested layout identities. Workspace was not committed.');
    }
    const containment = (layout) => {
        const result = [];
        const visit = (item, parent) => {
            result.push(JSON.stringify([item.id, item.type, parent]));
            for (const field of ['rackItems', 'nodes']) {
                if (Array.isArray(item[field]))
                    item[field].forEach(child => visit(child, JSON.stringify([field, item.id])));
            }
        };
        layout.rackArea.forEach(item => visit(item, 'rackArea'));
        layout.nonRackArea.forEach(item => visit(item, 'nonRackArea'));
        return result.sort();
    };
    if (JSON.stringify(containment(expected)) !== JSON.stringify(containment(accepted))) {
        throw new Error('DCSC did not accept the requested nested containment or non-rack placement. Workspace was not committed.');
    }
}
function objects(value) {
    return Array.isArray(value)
        ? value.filter((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
        : [];
}
function identity(value) {
    const raw = value['id'] ?? value['configurationId'];
    return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
}
function positiveInteger(value) {
    return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}
function visitPhysical(racks, loose, visitor) {
    const visit = (item) => {
        visitor(item);
        for (const node of objects(item['nodes']))
            visit(node);
        for (const child of objects(item['children']))
            visit(child);
        for (const rackItem of objects(item['rackItems']))
            visit(rackItem);
    };
    for (const item of racks)
        visit(item);
    for (const item of loose)
        visit(item);
}
/**
 * Stage the captured DCSC `Add Node -> Already Configured Nodes -> As Copy`
 * action. The existing configured node remains in the non-rack area and the
 * new physical identity is nested beneath the selected chassis. DCSC remains
 * authoritative for the accepted bay/size representation returned by rack
 * customization.
 */
export function stageConfiguredNodeCopy(options) {
    const { chassisId, sourceNodeId, copyId } = options;
    if (!chassisId.trim() || !sourceNodeId.trim() || !copyId.trim()) {
        throw new Error('Nested node copy requires chassisId, sourceNodeId, and copyId.');
    }
    let collision = false;
    visitPhysical(options.rackArea, options.nonRackArea, item => {
        if (identity(item) === copyId)
            collision = true;
    });
    if (collision)
        throw new Error(`Nested node copy identity ${copyId} already exists.`);
    const rackArea = structuredClone(options.rackArea);
    const nonRackArea = structuredClone(options.nonRackArea);
    const sourceMatches = nonRackArea.filter(item => identity(item) === sourceNodeId);
    if (sourceMatches.length !== 1) {
        throw new Error(`Nested node copy source ${sourceNodeId} is not one unique non-rack item.`);
    }
    const source = sourceMatches[0];
    if (source['type'] !== 'node')
        throw new Error(`Nested node copy source ${sourceNodeId} is not a node.`);
    if (objects(source['nodes']).length > 0 || objects(source['children']).length > 0) {
        throw new Error(`Nested node copy source ${sourceNodeId} has an unsupported child hierarchy.`);
    }
    const chassisMatches = [];
    for (const rack of rackArea) {
        for (const item of objects(rack['rackItems'])) {
            if (identity(item) === chassisId)
                chassisMatches.push({ rack, chassis: item });
        }
    }
    if (chassisMatches.length !== 1) {
        throw new Error(`Nested node copy chassis ${chassisId} is not one unique direct rack item.`);
    }
    const { rack, chassis } = chassisMatches[0];
    if (chassis['type'] !== 'chassis')
        throw new Error(`Nested node copy target ${chassisId} is not a chassis.`);
    const occupiedBay = positiveInteger(source['occupiedBay']);
    if (!occupiedBay)
        throw new Error(`Nested node copy source ${sourceNodeId} has no authoritative occupiedBay.`);
    const capacity = positiveInteger(chassis['capacity']);
    if (!capacity)
        throw new Error(`Nested node copy chassis ${chassisId} has no authoritative capacity.`);
    const nodes = objects(chassis['nodes']);
    const used = nodes.reduce((total, node) => total + (positiveInteger(node['occupiedBay']) ?? 0), 0);
    if (used + occupiedBay > capacity)
        throw new Error(`Nested node copy exceeds chassis ${chassisId} capacity.`);
    const copy = structuredClone(source);
    copy['id'] = copyId;
    delete copy['configurationId'];
    chassis['nodes'] = [...nodes, copy];
    const rackId = identity(rack);
    if (!rackId)
        throw new Error(`Nested node copy chassis ${chassisId} belongs to a rack without identity.`);
    return {
        rackArea,
        nonRackArea,
        placement: { rackId, chassisId, nodeId: copyId, occupiedBay },
        configurationIdMapping: { [copyId]: sourceNodeId },
    };
}
//# sourceMappingURL=nestedPhysical.js.map