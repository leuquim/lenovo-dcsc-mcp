import { cloneConfigurationRaw } from './configurationIdentity.js';
import { isObject } from '../util/coerce.js';
/**
 * Resolves the one clone group containing an edited configuration.
 *
 * DCSC does not require the root to be the first member. Preserve the accepted
 * array order because the SPA forwards it as `customizingIds`; use `rootId`
 * separately wherever root identity matters.
 */
export function resolveLinkedCloneGroup(value, configurationIds, initiatingId) {
    const ids = new Set(configurationIds);
    assertIdentity(initiatingId, 'initiatingId');
    if (!ids.has(initiatingId))
        throw new Error(`Configuration ${initiatingId} is not in the workspace.`);
    if (value !== undefined && !isObject(value)) {
        throw new Error('Workspace cloneDependency must be an object of configuration identity arrays.');
    }
    const owners = new Map();
    const groups = new Map();
    for (const [rootId, rawMembers] of Object.entries(value ?? {})) {
        assertIdentity(rootId, 'cloneDependency root');
        if (!ids.has(rootId))
            throw new Error(`Clone dependency root ${rootId} is not in the workspace.`);
        if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
            throw new Error(`Clone dependency ${rootId} has invalid members.`);
        }
        const memberIds = [];
        const withinGroup = new Set();
        for (const rawMember of rawMembers) {
            if (typeof rawMember !== 'string') {
                throw new Error(`Clone dependency ${rootId} has invalid members.`);
            }
            assertIdentity(rawMember, `cloneDependency member of ${rootId}`);
            if (!ids.has(rawMember)) {
                throw new Error(`Clone dependency ${rootId} refers to unknown configuration ${rawMember}.`);
            }
            if (withinGroup.has(rawMember)) {
                throw new Error(`Clone dependency ${rootId} contains duplicate configuration ${rawMember}.`);
            }
            withinGroup.add(rawMember);
            memberIds.push(rawMember);
            const owner = owners.get(rawMember);
            if (owner !== undefined && owner !== rootId) {
                throw new Error(`Configuration ${rawMember} belongs to multiple clone groups.`);
            }
            owners.set(rawMember, rootId);
        }
        if (!withinGroup.has(rootId)) {
            throw new Error(`Clone dependency ${rootId} does not include its root configuration.`);
        }
        groups.set(rootId, memberIds);
    }
    const rootId = owners.get(initiatingId);
    if (rootId === undefined) {
        return { rootId: initiatingId, memberIds: [initiatingId], linked: false };
    }
    const memberIds = groups.get(rootId);
    if (!memberIds)
        throw new Error(`Clone dependency group ${rootId} is incomplete.`);
    return { rootId, memberIds: [...memberIds], linked: memberIds.length > 1 };
}
/**
 * Expands DCSC's single authoritative GP clone response to its explicit
 * `updateConfigurationIds` targets. The response list is treated as an exact
 * set while the accepted dependency order controls the returned projections.
 */
export function projectLinkedCloneResponse(response, group) {
    const responseId = response.id;
    if (typeof responseId !== 'string' || !responseId.trim()) {
        throw new Error('DCSC linked-clone response has no configuration identity.');
    }
    if (!group.memberIds.includes(responseId)) {
        throw new Error(`DCSC returned configuration ${responseId} outside clone group ${group.rootId}.`);
    }
    const rawTargets = response.updateConfigurationIds;
    if (!Array.isArray(rawTargets) || rawTargets.some(id => typeof id !== 'string')) {
        throw new Error('DCSC linked-clone response omitted updateConfigurationIds.');
    }
    const targets = rawTargets;
    const uniqueTargets = new Set(targets);
    if (uniqueTargets.size !== targets.length) {
        throw new Error('DCSC linked-clone response contains duplicate updateConfigurationIds.');
    }
    if (!sameSet(uniqueTargets, new Set(group.memberIds))) {
        throw new Error(`DCSC linked-clone response targets do not match clone group ${group.rootId}.`);
    }
    return group.memberIds.map(targetId => targetId === responseId
        ? structuredClone(response)
        : cloneConfigurationRaw(response, responseId, targetId));
}
function sameSet(left, right) {
    return left.size === right.size && [...left].every(value => right.has(value));
}
function assertIdentity(value, label) {
    if (!value || value.trim() !== value)
        throw new Error(`${label} must be a non-empty, trimmed identity.`);
}
/** Native HPC applies repeated shared-root records in response order. */
export function projectHpcLinkedResponses(responses, current, dependency, requiredRoot, allowedRoots, rootOnlyDependentRoots = new Set()) {
    const ids = current.map(c => {
        if (typeof c.id !== 'string')
            throw new Error('Current HPC configuration has no identity.');
        return c.id;
    });
    const last = new Map();
    const targets = new Map();
    for (const response of responses) {
        const root = response?.id;
        const original = current.find(c => c.id === root);
        if (typeof root !== 'string' || !original || !allowedRoots.has(root) || !Array.isArray(response.tabs) ||
            response.type !== original.type || (response.code || response.sliceCtoCode) !== (original.code || original.sliceCtoCode)) {
            throw new Error('Unexpected HPC linked response identity or product.');
        }
        const group = resolveLinkedCloneGroup(dependency, ids, root);
        if (group.rootId !== root)
            throw new Error('HPC response must identify the shared clone root.');
        const updateIds = response.updateConfigurationIds;
        if (!Array.isArray(updateIds) || !updateIds.length || new Set(updateIds).size !== updateIds.length ||
            updateIds.some(id => typeof id !== 'string' || !group.memberIds.includes(id))) {
            throw new Error('HPC response has invalid or foreign update targets.');
        }
        const union = targets.get(root) ?? new Set();
        for (const id of updateIds)
            union.add(id);
        targets.set(root, union);
        last.set(root, response);
    }
    if (!last.has(requiredRoot))
        throw new Error('HPC response omitted the edited clone root.');
    return [...last].flatMap(([root, response]) => {
        const group = resolveLinkedCloneGroup(dependency, ids, root);
        const nativeSharedChild = root !== requiredRoot && rootOnlyDependentRoots.has(root) &&
            sameSet(targets.get(root), new Set([root]));
        if (!nativeSharedChild && !sameSet(targets.get(root), new Set(group.memberIds))) {
            throw new Error('HPC response target union does not cover the clone group.');
        }
        return projectLinkedCloneResponse({ ...response, updateConfigurationIds: [...group.memberIds] }, group);
    });
}
//# sourceMappingURL=linkedCloneEdit.js.map