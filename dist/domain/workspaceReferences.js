import { objectOrUndefined } from '../util/coerce.js';
/** Removes an existing physical instance without cloning it or changing its metadata. */
export function detachPhysicalItem(workspace, id) {
    let found;
    const detach = (items) => items.filter((item) => {
        if (item.id === id) {
            if (found)
                throw new Error(`Duplicate physical instance ${id}; reconcile the layout before moving it.`);
            found = item;
            return false;
        }
        for (const key of ['rackItems', 'nodes']) {
            if (Array.isArray(item[key]))
                item[key] = detach(item[key]);
        }
        return true;
    });
    workspace.rackArea = detach(workspace.rackArea);
    workspace.nonRackArea = detach(workspace.nonRackArea);
    return found;
}
export function physicalIds(item) {
    const ids = new Set();
    const visit = (current) => {
        if (typeof current.id === 'string')
            ids.add(current.id);
        for (const key of ['rackItems', 'nodes']) {
            if (Array.isArray(current[key]))
                current[key].forEach(visit);
        }
    };
    visit(item);
    return ids;
}
/** Known live identity fields; history and recovery data remain independent. */
const identityFields = ['id', 'configId', 'configurationId', 'sourceId', 'destinationId',
    'fromId', 'toId', 'fromConfigId', 'toConfigId', 'rackId', 'rack', 'targetWorkspaceId', 'templateId'];
function prune(value, removed) {
    if (Array.isArray(value))
        return value.filter((item) => !(typeof item === 'string' && removed.has(item)))
            .map((item) => prune(item, removed)).filter((item) => item !== undefined);
    if (!value || typeof value !== 'object')
        return value;
    const object = value;
    if (Array.isArray(object.appliedConfigurations) && object.appliedConfigurations.length > 0 &&
        object.appliedConfigurations.every(id => typeof id === 'string' && removed.has(id)))
        return undefined;
    if (identityFields.some((key) => typeof object[key] === 'string' && removed.has(object[key]))) {
        return undefined;
    }
    return Object.fromEntries(Object.entries(object).filter(([key]) => !removed.has(key))
        .map(([key, item]) => [key, prune(item, removed)]).filter(([, item]) => item !== undefined));
}
/**
 * The DCSC SPA promotes the first surviving member when a Clone Multiple root is
 * removed. Compute that promotion before mutating the workspace so an identity
 * collision cannot leave a partially detached layout.
 */
function rebaseCloneReferences(serverState, removed) {
    const source = objectOrUndefined(serverState.cloneDependency);
    if (!source)
        return { dependency: undefined, colors: undefined, affectedRoots: new Set() };
    const dependency = {};
    const promotions = new Map();
    const affectedRoots = new Set();
    for (const [root, rawMembers] of Object.entries(source)) {
        if (!Array.isArray(rawMembers) || rawMembers.some(member => typeof member !== 'string')) {
            if (!removed.has(root))
                dependency[root] = prune(rawMembers, removed);
            continue;
        }
        const originalMembers = [...new Set([root, ...rawMembers])];
        const affected = originalMembers.some(member => removed.has(member));
        if (affected)
            affectedRoots.add(root);
        const members = originalMembers.filter(member => !removed.has(member));
        if (members.length === 0)
            continue;
        const promotedRoot = removed.has(root) ? members[0] : root;
        if (Object.hasOwn(dependency, promotedRoot)) {
            throw new Error(`Cannot remove configuration ${root}; promoted clone root ${promotedRoot} conflicts with an existing clone group.`);
        }
        dependency[promotedRoot] = affected ? members : structuredClone(rawMembers);
        promotions.set(root, { root: promotedRoot, members });
    }
    const sourceColors = objectOrUndefined(serverState.cloneDependencyColor);
    if (!sourceColors)
        return { dependency, colors: undefined, affectedRoots };
    const colors = prune(sourceColors, removed);
    for (const root of affectedRoots) {
        const promotion = promotions.get(root);
        delete colors[root];
        if (!promotion)
            continue;
        if (Object.hasOwn(colors, promotion.root)) {
            throw new Error(`Cannot remove configuration ${root}; promoted clone color ${promotion.root} conflicts with an existing clone group.`);
        }
        const sourceColor = objectOrUndefined(sourceColors[root]);
        if (sourceColor)
            colors[promotion.root] = { ...structuredClone(sourceColor), dependBy: [...promotion.members] };
    }
    return { dependency, colors, affectedRoots };
}
export function removeWorkspaceReferences(workspace, removed) {
    const removedIds = new Set(removed);
    const detached = workspace.serverState.detachedStorageComponents;
    if (Array.isArray(detached)) {
        for (const raw of detached) {
            const value = objectOrUndefined(raw);
            if (typeof value?.templateId !== 'string' || !removedIds.has(value.templateId) ||
                !Array.isArray(value.physicalIds))
                continue;
            for (const id of value.physicalIds)
                if (typeof id === 'string')
                    removedIds.add(id);
        }
    }
    const cloneReferences = rebaseCloneReferences(workspace.serverState, removedIds);
    for (const id of removedIds) {
        detachPhysicalItem(workspace, id);
    }
    workspace.cables = workspace.cables.filter((item) => !removedIds.has(item.fromConfigId) && !removedIds.has(item.toConfigId));
    workspace.floorItems = workspace.floorItems.filter((item) => !removedIds.has(item.rackId));
    workspace.powerSelections = workspace.powerSelections.filter((item) => !removedIds.has(item.rackId));
    workspace.rackSummaries = workspace.rackSummaries.filter((rack) => !removedIds.has(rack.id))
        .map((rack) => ({ ...rack, items: rack.items.filter((item) => !removedIds.has(item.id)) }));
    // Imported source envelopes and validated clone expansions are recovery
    // provenance, not active references. In particular, pruning one member out
    // of an expansion would leave its original quantity inconsistent with its
    // identity list and turn valid historical evidence into malformed state.
    const imports = workspace.serverState.imports;
    const importCloneExpansion = workspace.serverState.importCloneExpansion;
    workspace.serverState = prune(workspace.serverState, removedIds);
    if (imports !== undefined)
        workspace.serverState.imports = imports;
    if (importCloneExpansion !== undefined)
        workspace.serverState.importCloneExpansion = importCloneExpansion;
    if (cloneReferences.dependency !== undefined)
        workspace.serverState.cloneDependency = cloneReferences.dependency;
    if (cloneReferences.colors !== undefined)
        workspace.serverState.cloneDependencyColor = cloneReferences.colors;
    const linkedEdits = objectOrUndefined(workspace.serverState.linkedConfigurationEdits);
    if (linkedEdits && cloneReferences.affectedRoots.size > 0) {
        for (const root of cloneReferences.affectedRoots)
            delete linkedEdits[root];
    }
    for (const session of workspace.configurations.values()) {
        if (session.raw.selectedTopologies)
            session.raw.selectedTopologies = prune(session.raw.selectedTopologies, removedIds);
        if (session.raw.selectedStorageNetwork)
            session.raw.selectedStorageNetwork = prune(session.raw.selectedStorageNetwork, removedIds);
    }
}
//# sourceMappingURL=workspaceReferences.js.map