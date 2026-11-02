import { cloneConfigurationRaw } from './configurationIdentity.js';
import { objectOrUndefined } from '../util/coerce.js';
function cloneMembers(root, value, label) {
    if (!root.trim() || !Array.isArray(value) || value.length === 0 ||
        value.some(id => typeof id !== 'string' || !id.trim())) {
        throw new Error(`${label} ${root || '(empty root)'} must be a nonempty identity array.`);
    }
    const members = value;
    if (!members.includes(root) || new Set(members).size !== members.length) {
        throw new Error(`${label} ${root} must contain its root exactly once and cannot contain duplicate identities.`);
    }
    // Membership order is server-owned and is forwarded on linked edits. The
    // root only has to be present; do not silently move it to the first slot.
    return [...members];
}
function cloneGroups(value, label) {
    if (value === undefined)
        return undefined;
    const source = objectOrUndefined(value);
    if (!source)
        throw new Error(`${label} must be an object of identity arrays.`);
    const result = {};
    const owners = new Map();
    for (const [root, rawMembers] of Object.entries(source)) {
        const members = cloneMembers(root, rawMembers, label);
        for (const id of members) {
            const owner = owners.get(id);
            if (owner && owner !== root) {
                throw new Error(`${label} identity ${id} belongs to overlapping roots ${owner} and ${root}.`);
            }
            owners.set(id, root);
        }
        result[root] = members;
    }
    return result;
}
function nonemptyString(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function importedStorageOwnership(payload) {
    const networking = objectOrUndefined(payload.networkingInformation);
    const networkSource = payload.storageConnectionNetworks ?? networking?.storageConnectionNetworks ??
        networking?.storageNetworks;
    const storageCodes = new Set();
    const switchCodes = new Set();
    const templates = new Set();
    if (Array.isArray(networkSource))
        for (const value of networkSource) {
            const network = objectOrUndefined(value);
            if (!network)
                continue;
            const controller = objectOrUndefined(network.controller);
            const controllerCode = nonemptyString(controller?.option)?.toUpperCase();
            if (controllerCode)
                storageCodes.add(controllerCode);
            const controllerId = nonemptyString(controller?.id);
            if (controllerId)
                templates.add(controllerId);
            const mainSwitch = objectOrUndefined(network.mainSwitch);
            const switchCode = nonemptyString(mainSwitch?.option)?.toUpperCase();
            if (switchCode)
                switchCodes.add(switchCode);
            const switchId = nonemptyString(mainSwitch?.id);
            if (switchId)
                templates.add(switchId);
        }
    const physicalIds = new Set();
    const visit = (value) => {
        const item = objectOrUndefined(value);
        if (!item)
            throw new Error('Imported physical storage hierarchy contains a non-object item.');
        const id = nonemptyString(item.configurationId ?? item.id);
        if (id)
            physicalIds.add(id);
        for (const child of Array.isArray(item.children) ? item.children : [])
            visit(child);
    };
    const workspace = objectOrUndefined(payload.workspace);
    for (const item of [
        ...(Array.isArray(workspace?.rackArea) ? workspace.rackArea : []),
        ...(Array.isArray(workspace?.nonRackArea) ? workspace.nonRackArea : []),
    ])
        visit(item);
    const result = new Map();
    if (!Array.isArray(payload.configuration))
        return { aliases: result, templates };
    for (const value of payload.configuration) {
        const raw = objectOrUndefined(value);
        const id = nonemptyString(raw?.id ?? raw?.configurationId);
        const code = nonemptyString(raw?.sliceCtoCode ?? raw?.code)?.toUpperCase();
        const type = nonemptyString(raw?.type)?.toLowerCase();
        if (!id || !code || !physicalIds.has(id))
            continue;
        if (type === 'storage' && storageCodes.has(code) || type === 'switch' && switchCodes.has(code)) {
            result.set(id, `${type}:${code}`);
        }
    }
    return { aliases: result, templates };
}
function colorGroups(value, dependency, activeConfigurationIds, storageAliases, storageTemplateIds) {
    if (value === undefined)
        return undefined;
    const source = objectOrUndefined(value);
    if (!source)
        throw new Error('Imported cloneDependencyColor must be an object.');
    const memberships = {};
    const storageOwners = new Map();
    for (const [root, rawColor] of Object.entries(source)) {
        const color = objectOrUndefined(rawColor);
        if (!color)
            throw new Error(`Imported cloneDependencyColor ${root} must be an object.`);
        if (color.dependBy === undefined)
            continue;
        if (!root.trim() || !Array.isArray(color.dependBy) ||
            color.dependBy.some(id => typeof id !== 'string' || !id.trim()) ||
            new Set(color.dependBy).size !== color.dependBy.length) {
            throw new Error(`Imported clone color group ${root || '(empty root)'} has malformed ownership.`);
        }
        const members = color.dependBy;
        const dependencyTouchesRoot = Object.entries(dependency)
            .some(([owner, owned]) => owner === root || owned.includes(root));
        if (members.length === 0) {
            if (!storageTemplateIds.has(root) && (activeConfigurationIds.has(root) || dependencyTouchesRoot)) {
                throw new Error(`Imported clone color group ${root} cannot have empty ownership for an active clone identity.`);
            }
            // Native storage imports can retain a presentation color whose managed
            // template was not returned. It owns no identity and is not clone evidence.
            continue;
        }
        const allStorageAliases = members.every(member => storageAliases.has(member));
        if (allStorageAliases) {
            const signatures = new Set(members.map(member => storageAliases.get(member)));
            if (signatures.size !== 1) {
                throw new Error(`Imported storage color group ${root} mixes different managed component types or product codes.`);
            }
            if (activeConfigurationIds.has(root) && !storageAliases.has(root) && !storageTemplateIds.has(root)) {
                throw new Error(`Imported storage color group ${root} conflicts with an active configuration.`);
            }
            // Native import can materialize every storage instance as an editable
            // configuration and rebase its color owner to the first physical ID. The
            // SPA then uses that rooted color group as clone dependency ownership.
            const touchingDependency = touchingGroups(dependency, new Set(members));
            const materializedGroup = members.includes(root) && members.every(id => activeConfigurationIds.has(id)) &&
                !members.some(id => storageTemplateIds.has(id)) &&
                !touchingDependency.some(([owner]) => storageTemplateIds.has(owner));
            if (touchingDependency.length > 0) {
                const exact = touchingDependency.length === 1 &&
                    (storageTemplateIds.has(touchingDependency[0][0]) || materializedGroup && touchingDependency[0][0] === root) &&
                    sameMembers(touchingDependency[0][1].filter(member => storageAliases.has(member)), members) &&
                    touchingDependency[0][1].every(member => storageAliases.has(member) || member === touchingDependency[0][0]);
                if (!exact) {
                    throw new Error(`Imported storage color group ${root} conflicts with explicit clone dependency ownership.`);
                }
            }
            for (const member of members) {
                const owner = storageOwners.get(member);
                if (owner && owner !== root) {
                    throw new Error(`Imported storage color identity ${member} belongs to overlapping roots ${owner} and ${root}.`);
                }
                storageOwners.set(member, root);
            }
            if (materializedGroup) {
                memberships[root] = members;
                continue;
            }
            // Physical storage color groups may omit a managed template that the
            // import response did not return. Preserve the raw color metadata, but do
            // not treat physical aliases as editable configuration clones.
            continue;
        }
        if (members.some(member => storageAliases.has(member))) {
            throw new Error(`Imported clone color group ${root} mixes managed storage aliases with ordinary clone identities.`);
        }
        memberships[root] = members;
    }
    return cloneGroups(memberships, 'Imported clone color group');
}
function sameMembers(left, right) {
    return left.length === right.length && left.every(id => right.includes(id));
}
function touchingGroups(groups, ids) {
    return Object.entries(groups).filter(([, members]) => members.some(id => ids.has(id)));
}
/**
 * A compressed native import is stronger evidence than singleton fallback
 * dependency records: its originalIds, quantity and configuration identity have
 * already been validated together. Promote that exact ownership while refusing
 * partial or overlapping groups.
 */
function promoteExpansion(dependency, sourceId, rawIds) {
    const members = [...rawIds];
    const ids = new Set(members);
    const touching = touchingGroups(dependency, ids);
    if (touching.length === 0) {
        dependency[sourceId] = members;
        return;
    }
    if (touching.length === 1 && touching[0][0] === sourceId && sameMembers(touching[0][1], members)) {
        dependency[sourceId] = members;
        return;
    }
    // Older MCP imports could retain only one singleton per expanded identity.
    // The validated compressed source proves these exact identities are one group,
    // so this one legacy shape can be repaired without guessing from product codes.
    if (touching.length === members.length && touching.every(([root, group]) => ids.has(root) && group.length === 1 && group[0] === root)) {
        for (const [root] of touching)
            delete dependency[root];
        dependency[sourceId] = members;
        return;
    }
    throw new Error(`Imported clone dependency conflicts with validated expansion ${sourceId}. ` +
        'Re-export the configuration from DCSC or reconcile clone ownership before importing.');
}
function assertMatchingColors(dependency, colors) {
    if (!colors)
        return;
    for (const [root, members] of Object.entries(dependency)) {
        const touching = touchingGroups(colors, new Set(members));
        if (touching.length === 0)
            continue;
        if (touching.length !== 1 || touching[0][0] !== root ||
            !sameMembers(touching[0][1], members)) {
            throw new Error(`Imported clone color ownership conflicts with clone dependency ${root}. ` +
                'Re-export the configuration from DCSC or reconcile clone ownership before importing.');
        }
    }
}
/**
 * CFXML imports compress identical products into one configuration and an
 * originalIds list. The captured SPA expands those IDs into physical instances
 * before customization. A group quantity alone is not enough to invent IDs.
 */
export function expandImportedClones(source) {
    const payload = structuredClone(source);
    const workspace = objectOrUndefined(payload.workspace);
    if (!workspace || !Array.isArray(payload.configuration) || !Array.isArray(workspace.nonRackArea))
        return payload;
    const configurations = payload.configuration;
    const dependency = cloneGroups(payload.cloneDependency, 'Imported clone dependency') ?? {};
    const activeConfigurationIds = new Set(configurations.map(raw => String(raw.id ?? raw.configurationId ?? ''))
        .filter(Boolean));
    const storage = importedStorageOwnership(payload);
    const colors = colorGroups(payload.cloneDependencyColor, dependency, activeConfigurationIds, storage.aliases, storage.templates);
    const byId = new Map(configurations.map(raw => [String(raw.id), raw]));
    const expansions = [];
    const generated = new Set();
    const expandItem = (item, inRack, parentQuantity = 1) => {
        const sourceId = String(item.configurationId ?? item.id ?? '');
        const ids = item.originalIds;
        const grouped = Array.isArray(ids) && ids.length > 1;
        const children = Array.isArray(item.children) ? item.children : [];
        if (!grouped && children.length === 0)
            return [item];
        if (item.type === 'rack' || item.asVLH === true ||
            children.length > 0 && item.type !== 'chassis') {
            throw new Error('Cloned racks and nested containers require a captured expansion contract.');
        }
        const raw = byId.get(sourceId);
        const memberIds = grouped ? ids : [sourceId];
        if (grouped && (!raw || ids.some(id => typeof id !== 'string' || !id.trim()) ||
            new Set(ids).size !== ids.length || !ids.includes(sourceId) ||
            Number(item.quantity) * parentQuantity !== ids.length || Number(raw.quantity ?? 1) !== 1)) {
            throw new Error(`Imported clone group ${sourceId} has inconsistent identities or quantities. No workspace was committed.`);
        }
        const childrenByParent = memberIds.map(() => []);
        for (const value of children) {
            const child = objectOrUndefined(value);
            if (!child || child.type !== 'node' || (Array.isArray(child.children) && child.children.length > 0)) {
                throw new Error('Nested chassis expansion requires direct node children.');
            }
            const perParent = Number(child.quantity ?? 1);
            const childIds = child.originalIds ?? (memberIds.length === 1 && perParent === 1
                ? [String(child.configurationId ?? child.id ?? '')] : undefined);
            if (!Number.isSafeInteger(perParent) || perParent < 1 || !Array.isArray(childIds) ||
                childIds.length !== perParent * memberIds.length) {
                throw new Error(`Imported chassis ${sourceId} has inconsistent child identities or quantities.`);
            }
            const expanded = expandItem(child, false, memberIds.length);
            for (let index = 0; index < memberIds.length; index++) {
                childrenByParent[index].push(...expanded.slice(index * perParent, (index + 1) * perParent));
            }
        }
        const positions = grouped && inRack ? groupedRackPositions(item, memberIds.length) : undefined;
        const members = memberIds.map((id, index) => {
            if (grouped) {
                if (generated.has(id) || (id !== sourceId && byId.has(id))) {
                    throw new Error(`Imported clone identity ${id} collides with another configuration.`);
                }
                generated.add(id);
                if (id !== sourceId)
                    configurations.push(cloneConfigurationRaw(raw, sourceId, id));
            }
            const member = { ...structuredClone(item), id, configurationId: id, quantity: 1, originalIds: [id] };
            if (children.length > 0)
                member.children = childrenByParent[index];
            if (positions)
                member.derivedResults = [
                    ...(Array.isArray(item.derivedResults) ? item.derivedResults.filter(result => !/^32\d{2}$/.test(String(objectOrUndefined(result)?.featureCode))) : []),
                    { featureCode: `32${String(positions[index]).padStart(2, '0')}`, name: 'MI_P', quantity: 1 },
                ];
            return member;
        });
        if (grouped)
            expansions.push({ sourceId, original: structuredClone(item), ids: memberIds,
                ...(parentQuantity > 1 ? { parentQuantity } : {}) });
        return members;
    };
    const expandItems = (items, inRack) => items.flatMap(value => {
        const item = objectOrUndefined(value);
        if (!item)
            throw new Error('Imported physical item is not an object.');
        return expandItem(item, inRack);
    });
    workspace.nonRackArea = expandItems(workspace.nonRackArea, false);
    if (Array.isArray(workspace.rackArea))
        for (const value of workspace.rackArea) {
            const rack = objectOrUndefined(value);
            if (rack && Array.isArray(rack.children))
                rack.children = expandItems(rack.children, true);
        }
    if (expansions.length > 0) {
        for (const expansion of expansions)
            promoteExpansion(dependency, expansion.sourceId, expansion.ids);
        assertMatchingColors(dependency, colors);
        // Native references also retain singleton colors for the rack and spare
        // products. Preserve their explicit ownership alongside expanded groups so
        // persisted restore sees the same complete dependency/color partition.
        for (const [root, members] of Object.entries(colors ?? {})) {
            if (members.length === 1 && activeConfigurationIds.has(root) &&
                touchingGroups(dependency, new Set(members)).length === 0)
                dependency[root] = [...members];
        }
        payload.cloneDependency = dependency;
        // Preserve the compressed source records for inspection/recovery.
        payload.importCloneExpansion = expansions;
    }
    else
        assertMatchingColors(dependency, colors);
    // A rooted native color is explicit ownership evidence even when import
    // returns separate quantity-one records rather than a compressed originalIds
    // group. Do not infer these links from matching product codes alone.
    let materializedStorage = false;
    for (const [root, members] of Object.entries(colors ?? {})) {
        if (members.length < 2 || !storage.aliases.has(root) ||
            !members.every(id => storage.aliases.has(id) && activeConfigurationIds.has(id)) ||
            members.some(id => storage.templates.has(id)))
            continue;
        promoteExpansion(dependency, root, members);
        materializedStorage = true;
    }
    if (materializedStorage) {
        assertMatchingColors(dependency, colors);
        payload.cloneDependency = dependency;
    }
    return payload;
}
/** Native buildWorkspaceImportData expands position runs in originalIds order. */
function groupedRackPositions(item, count) {
    const size = Number(item.size);
    const positions = [];
    for (const value of Array.isArray(item.derivedResults) ? item.derivedResults : []) {
        const result = objectOrUndefined(value);
        if (!/^32\d{2}$/.test(String(result?.featureCode)))
            continue;
        const start = Number(String(result.featureCode).slice(2));
        const quantity = Number(result.quantity);
        if (!Number.isInteger(size) || size < 1 || !Number.isInteger(quantity) || quantity < 1 ||
            quantity > count || start < 1 || start + size * (quantity - 1) > 99) {
            throw new Error(`Imported rack clone group ${item.id} has invalid position runs.`);
        }
        for (let index = 0; index < quantity; index++)
            positions.push(start + index * size);
    }
    if (positions.length !== count || new Set(positions).size !== count) {
        throw new Error(`Imported rack clone group ${item.id} has inconsistent positions and identities.`);
    }
    return positions;
}
//# sourceMappingURL=importClones.js.map