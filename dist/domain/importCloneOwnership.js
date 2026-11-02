import { isDeepStrictEqual } from 'node:util';
import { cloneConfigurationRaw } from './configurationIdentity.js';
import { serializeSections } from './dcscWire.js';
import { buildExportGroups } from './exportGroups.js';
import { powerLoadFactor } from './power.js';
function objectValue(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
/** Read a persisted color owner and reject malformed present ownership. */
export function cloneColorMembers(value, root, options = {}) {
    const color = objectValue(value);
    if (!color || !Object.hasOwn(color, 'dependBy'))
        return undefined;
    const raw = color['dependBy'];
    if (!Array.isArray(raw) || raw.some(member => typeof member !== 'string' || member.trim() === '') ||
        new Set(raw).size !== raw.length ||
        raw.length === 0 && options.allowEmpty !== true ||
        raw.length > 0 && !raw.includes(root) && options.allowRootless !== true) {
        throw new Error(`Clone dependency color ${root} has invalid dependBy ownership.`);
    }
    return raw;
}
export function sameIdentitySet(left, right) {
    const actual = new Set(left);
    const expected = new Set(right);
    return actual.size === left.length && actual.size === expected.size && [...actual].every(identity => expected.has(identity));
}
/** Identifies a complete physical-only storage color group whose managed template is outside the group. */
export function exactStorageAliasRoot(members, storageAliases) {
    const roots = new Set(members.map(member => storageAliases.get(member)));
    if (roots.has(undefined) || roots.size !== 1)
        return undefined;
    const root = [...roots][0];
    if (!root)
        return undefined;
    const expected = [...storageAliases].filter(([physicalId, templateId]) => templateId === root && physicalId !== templateId).map(([physicalId]) => physicalId);
    return expected.length > 0 && sameIdentitySet(expected, members) ? root : undefined;
}
function validateDependencyPartition(dependency) {
    const owners = new Map();
    for (const [root, members] of Object.entries(dependency)) {
        if (!root.trim() || !Array.isArray(members) || members.length === 0 ||
            members.some(member => typeof member !== 'string' || member.trim() === '') ||
            !members.includes(root) || new Set(members).size !== members.length) {
            throw new Error(`Clone dependency ${root || '(empty root)'} has invalid ownership.`);
        }
        for (const member of members) {
            const owner = owners.get(member);
            if (owner && owner !== root) {
                throw new Error(`Clone dependency identity ${member} belongs to overlapping roots ${owner} and ${root}.`);
            }
            owners.set(member, root);
        }
    }
}
function validateCanonicalColorPartition(dependency, colors, activeConfigurationIds, storageRoots, storageAliases) {
    const dependencyOwners = new Map();
    for (const [root, members] of Object.entries(dependency)) {
        for (const member of members)
            dependencyOwners.set(member, root);
    }
    const owners = new Map();
    for (const [root, value] of Object.entries(colors)) {
        const members = cloneColorMembers(value, root, { allowEmpty: true, allowRootless: true });
        if (!members)
            continue;
        if (members.length === 0) {
            if (!storageRoots.has(root) &&
                (activeConfigurationIds.has(root) || dependencyOwners.has(root) || Object.hasOwn(dependency, root))) {
                throw new Error(`Clone dependency color ${root} has empty ownership for an active clone identity.`);
            }
            continue;
        }
        const mappedStorageMembers = members.filter(member => storageAliases.has(member));
        if (mappedStorageMembers.length > 0) {
            const expectedStorageMembers = [root, ...[...storageAliases]
                    .filter(([physicalId, templateId]) => templateId === root && physicalId !== root)
                    .map(([physicalId]) => physicalId)];
            const canonicalStorage = storageRoots.has(root) && dependency[root] !== undefined &&
                sameIdentitySet(dependency[root], expectedStorageMembers) &&
                sameIdentitySet(members, expectedStorageMembers);
            const aliasTemplate = exactStorageAliasRoot(members, storageAliases);
            const storagePresentation = aliasTemplate !== undefined &&
                (storageAliases.get(root) === aliasTemplate ||
                    (!activeConfigurationIds.has(root) && !dependencyOwners.has(root) &&
                        !Object.hasOwn(dependency, root) && !storageRoots.has(root)));
            if (!canonicalStorage && !storagePresentation) {
                throw new Error(`Clone dependency color ${root} has incomplete or conflicting managed storage ownership.`);
            }
            for (const member of members) {
                const owner = owners.get(member);
                if (owner && owner !== root) {
                    throw new Error(`Clone dependency color identity ${member} belongs to overlapping roots ${owner} and ${root}.`);
                }
                owners.set(member, root);
            }
            continue;
        }
        if (!members.includes(root)) {
            throw new Error(`Clone dependency color ${root} has rootless ownership outside a managed storage group.`);
        }
        for (const member of members) {
            const owner = owners.get(member);
            if (owner && owner !== root) {
                throw new Error(`Clone dependency color identity ${member} belongs to overlapping roots ${owner} and ${root}.`);
            }
            owners.set(member, root);
        }
        if (storageRoots.has(root))
            continue;
        const expected = dependency[root];
        if (activeConfigurationIds.has(root)) {
            if (!expected || !sameIdentitySet(expected, members)) {
                throw new Error(`Clone dependency color ${root} conflicts with the active dependency group.`);
            }
        }
        else if (members.some(member => activeConfigurationIds.has(member))) {
            throw new Error(`Clone dependency color ${root} owns an active configuration from an unknown root.`);
        }
    }
}
function semanticCloneState(raw, identity, mode) {
    const products = buildExportGroups(raw, identity, mode)[0]?.products.map(product => {
        const { id: _id, shippingStatus: _shippingStatus, ...commercial } = product;
        return commercial;
    }) ?? [];
    return {
        products,
        sections: serializeSections(raw),
        hipoDerivedItems: structuredClone(raw.hipoDerivedItems ?? []),
        hipoServiceCtoServices: structuredClone(raw.hipoServiceCtoServices ?? []),
        selectedTopologies: structuredClone(raw.selectedTopologies ?? {}),
        selectedStorageNetwork: structuredClone(raw.selectedStorageNetwork ?? null),
        nodeRole: raw.nodeRole ?? '',
        voltage: structuredClone(raw.voltage ?? {}),
        currentPowerPolicy: raw.currentPowerPolicy ?? 5,
        loadFactor: powerLoadFactor(raw) ?? 70,
        serviceCtoFlag: structuredClone(raw.serviceCtoFlag ?? {}),
    };
}
function isEquivalentCloneRaw(source, sourceId, member, memberId, sourceMode, memberMode) {
    const exact = memberId === sourceId
        ? source
        : cloneConfigurationRaw(source, sourceId, memberId);
    if (isDeepStrictEqual(member, exact))
        return true;
    // DCSC hydrates availability and other catalog presentation data only on the
    // compressed root during a layout roundtrip. The sellable lines, selected
    // section results and persisted configuration controls remain authoritative.
    return isDeepStrictEqual(semanticCloneState(exact, memberId, sourceMode), semanticCloneState(member, memberId, memberMode));
}
/**
 * Releases before the compressed-import dependency fix persisted the validated
 * clone expansion only as provenance. Repair exactly that known shape: every
 * member is still an active singleton, the retained native root color names
 * the same identities, and each member still equals a clone of the source.
 * Anything else may represent a later independent edit and fails closed.
 */
export function reconcileImportedCloneOwnership(opts) {
    const { dependency, colors, provenance, activeConfigurationIds, storageRoots, configurations } = opts;
    const storageAliases = opts.storageAliases ?? new Map();
    if (!Array.isArray(provenance))
        return { dependency, colors, changed: false };
    validateDependencyPartition(dependency);
    const result = structuredClone(dependency);
    const resultColors = structuredClone(colors);
    let changed = false;
    for (const raw of provenance) {
        const evidence = objectValue(raw);
        const sourceId = evidence?.['sourceId'];
        const ids = evidence?.['ids'];
        const original = objectValue(evidence?.['original']);
        const originalId = original?.['configurationId'] ?? original?.['id'];
        const originalIds = original?.['originalIds'];
        const parentQuantity = evidence?.['parentQuantity'] ?? 1;
        if (typeof sourceId !== 'string' || !Array.isArray(ids) || ids.length < 2 ||
            ids.some(id => typeof id !== 'string' || id.trim() === '') ||
            new Set(ids).size !== ids.length || !ids.includes(sourceId) || originalId !== sourceId ||
            typeof parentQuantity !== 'number' || !Number.isSafeInteger(parentQuantity) || parentQuantity < 1 ||
            parentQuantity > 1 && original?.['type'] !== 'node' ||
            Number(original?.['quantity']) * parentQuantity !== ids.length || !Array.isArray(originalIds) ||
            originalIds.some(id => typeof id !== 'string') || !sameIdentitySet(originalIds, ids)) {
            throw new Error('Imported clone expansion provenance is malformed; reimport the source XML before exporting.');
        }
        const members = ids;
        // Removed configurations make the original provenance historical. The
        // active dependency was rebased by the removal transaction and stays authoritative.
        if (members.some(id => !activeConfigurationIds.has(id)))
            continue;
        if (members.some(id => storageRoots.has(id))) {
            throw new Error(`Imported clone expansion ${sourceId} overlaps a managed storage dependency.`);
        }
        const exact = result[sourceId];
        const alreadyLinked = exact && sameIdentitySet(exact, members) && Object.entries(result).every(([root, group]) => root === sourceId || group.every(id => !members.includes(id)));
        const allSingletons = members.every(id => result[id]?.length === 1 && result[id]?.[0] === id);
        const retainedNativeMembers = cloneColorMembers(resultColors[sourceId], sourceId);
        if (!alreadyLinked && (!allSingletons || !retainedNativeMembers || !sameIdentitySet(retainedNativeMembers, members))) {
            throw new Error(`Clone dependency for imported group ${sourceId} conflicts with its validated expansion; ` +
                'reimport the source XML before exporting.');
        }
        if (!alreadyLinked) {
            const source = configurations.find(configuration => configuration.configurationId === sourceId);
            if (!source || members.some(memberId => {
                const member = configurations.find(configuration => configuration.configurationId === memberId);
                if (!member)
                    return true;
                return source.mode !== member.mode ||
                    source.validationMode !== member.validationMode ||
                    source.autoCorrect !== member.autoCorrect ||
                    source.configurable !== member.configurable ||
                    !isEquivalentCloneRaw(source.raw, sourceId, member.raw, memberId, source.mode, member.mode);
            })) {
                throw new Error(`Imported clone group ${sourceId} has diverged configuration state and cannot be relinked safely; ` +
                    'reimport the source XML before exporting.');
            }
            for (const id of members)
                delete result[id];
            result[sourceId] = [...members];
            changed = true;
        }
        if (retainedNativeMembers && !sameIdentitySet(retainedNativeMembers, members) &&
            !(retainedNativeMembers.length === 1 && retainedNativeMembers[0] === sourceId)) {
            throw new Error(`Clone dependency color ${sourceId} conflicts with the imported clone group.`);
        }
        const rootColor = objectValue(resultColors[sourceId]);
        if (rootColor && retainedNativeMembers && !sameIdentitySet(retainedNativeMembers, members)) {
            resultColors[sourceId] = { ...rootColor, dependBy: [...members] };
            changed = true;
        }
        for (const [colorRoot, value] of Object.entries(resultColors)) {
            if (colorRoot === sourceId)
                continue;
            const owned = cloneColorMembers(value, colorRoot, { allowEmpty: true, allowRootless: true });
            const touchesGroup = members.includes(colorRoot) || owned?.some(id => members.includes(id));
            if (!touchesGroup)
                continue;
            if (!retainedNativeMembers) {
                throw new Error(`Clone dependency color ${sourceId} is missing ownership for imported clone group ${sourceId}.`);
            }
            if (members.includes(colorRoot) && owned?.length === 1 && owned[0] === colorRoot) {
                delete resultColors[colorRoot];
                changed = true;
                continue;
            }
            throw new Error(`Clone dependency color ${colorRoot} overlaps imported clone group ${sourceId}.`);
        }
    }
    validateDependencyPartition(result);
    validateCanonicalColorPartition(result, resultColors, activeConfigurationIds, storageRoots, storageAliases);
    return { dependency: result, colors: resultColors, changed };
}
//# sourceMappingURL=importCloneOwnership.js.map