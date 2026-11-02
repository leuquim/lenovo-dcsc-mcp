import { createCloneDependencyColor } from './cloneDependency.js';
import { physicalIds } from './workspaceReferences.js';
import { resolveStoragePhysicalAliases } from './storagePlacement.js';
import { detachedStorageTemplateIds, readDetachedStorageComponents, } from './storageComponentLifecycle.js';
import { objectOrUndefined, stringOrEmpty } from '../util/coerce.js';
export const STORAGE_TYPES = ['Balance Warehouse', 'General Storage'];
export const STORAGE_LAYOUTS = ['Fully Redundant', 'Minimal Cabling'];
export const DIRECT_ATTACHED = 'direct-attached';
/** Raw inspection must remain possible even for an unsupported imported value. */
export function storageConnectionNetworkSource(state) {
    const networking = objectOrUndefined(state['networkingInformation']);
    const previous = objectOrUndefined(state['autoConnectState']);
    return state['storageConnectionNetworks'] ?? previous?.['storageConnectionNetworks'] ??
        networking?.['storageConnectionNetworks'] ?? networking?.['storageNetworks'] ?? [];
}
/** Resolve current and imported storage envelopes without discarding retained fields. */
export function readStorageConnectionNetworks(state) {
    const value = storageConnectionNetworkSource(state);
    if (!Array.isArray(value) || value.some(item => !objectOrUndefined(item) || typeof item.name !== 'string')) {
        throw new Error('Saved storage definitions are malformed. Inspect the recovery snapshot before editing them.');
    }
    const networks = structuredClone(value);
    // Native CFXML import keeps option/featureCode but omits the UI-only
    // hardwareType. Restore it from the explicit component role; launch still
    // verifies the returned product code and type before committing anything.
    for (const network of networks) {
        for (const [role, hardwareType] of [['controller', 'storage'], ['expansion', 'storage'], ['mainSwitch', 'switch']]) {
            const component = objectOrUndefined(network[role]);
            if (component && typeof component.option === 'string' && component.option.trim() &&
                component.hardwareType === undefined)
                component.hardwareType = hardwareType;
        }
    }
    return networks;
}
/** Controllers and SAN switches referenced by storage definitions are managed configurations,
 * not implicitly loose physical servers. Keep explicitly returned placements. */
export function managedStorageComponentIds(state) {
    const source = storageConnectionNetworkSource(state);
    // Read projections must remain available for recovery even when a retained
    // definition is malformed. Mutators use the strict reader above.
    const active = !Array.isArray(source) ? [] : source.flatMap(value => {
        return ['controller', 'mainSwitch'].flatMap(key => {
            const id = objectOrUndefined(objectOrUndefined(value)?.[key])?.id;
            return typeof id === 'string' && id.trim() ? [id] : [];
        });
    });
    return new Set([...active, ...detachedStorageTemplateIds(state)]);
}
/** Physical storage instances have separate IDs from their editable templates. */
export function storagePhysicalTemplateIds(workspace) {
    const state = workspace.serverState ?? {};
    const managed = managedStorageComponentIds(state);
    if (managed.size === 0)
        return new Map();
    const detached = readDetachedStorageComponents(state);
    const result = new Map(resolveStoragePhysicalAliases({
        rackArea: workspace.rackArea ?? [], nonRackArea: workspace.nonRackArea ?? [],
        storageConnectionNetworks: readStorageConnectionNetworks(state),
        managedTemplates: detached.map(record => ({
            templateId: record.templateId, code: record.code, type: record.type,
            roles: record.roles, networkNames: [record.sourceNetworkName],
        })),
        cloneDependency: state.cloneDependency,
    }).map(instance => [instance.physicalId, instance.templateId]));
    for (const record of detached) {
        const actual = [...result].filter(([, templateId]) => templateId === record.templateId)
            .map(([physicalId]) => physicalId);
        if (actual.length !== record.physicalIds.length || actual.some(id => !record.physicalIds.includes(id))) {
            throw new Error(`Detached storage template ${record.templateId} physical identities do not match its dependency graph.`);
        }
    }
    // Keep an explicitly returned placement of a template itself. It must not
    // become an additional synthesized loose item during wire projection.
    for (const item of [...(workspace.rackArea ?? []), ...(workspace.nonRackArea ?? [])]) {
        for (const id of physicalIds(item))
            if (managed.has(id))
                result.set(id, id);
    }
    return result;
}
/** Storage physical aliases share a template; they are not editable clone sessions. */
export function configurationCloneDependency(workspace) {
    const dependency = workspace.serverState?.cloneDependency;
    const aliases = storagePhysicalTemplateIds(workspace);
    if (aliases.size === 0 || !objectOrUndefined(dependency))
        return dependency;
    return Object.fromEntries(Object.entries(dependency).map(([root, members]) => [root,
        Array.isArray(members) ? members.filter(member => typeof member !== 'string' || !aliases.has(member) || aliases.get(member) === member) : members,
    ]));
}
/** The browser retains managed component templates at raw quantity one but exports
 * zero commercial units until the managed product has a physical instance. */
export function unplacedManagedStorageComponentIds(workspace) {
    return new Set([...storageComponentQuantities(workspace)].filter(([, quantity]) => quantity === 0).map(([id]) => id));
}
/** Templates stay at raw quantity one; commercial and power totals count their physical IDs. */
export function storageComponentQuantities(workspace) {
    const quantities = new Map([...managedStorageComponentIds(workspace.serverState ?? {})].map(id => [id, 0]));
    for (const templateId of storagePhysicalTemplateIds(workspace).values()) {
        quantities.set(templateId, (quantities.get(templateId) ?? 0) + 1);
    }
    return quantities;
}
/** The SPA's export color map also carries the template-to-physical identity links. */
export function storageDependencyColors(workspace) {
    const state = workspace.serverState ?? {};
    const result = structuredClone(objectOrUndefined(state.cloneDependencyColor) ?? {});
    const aliases = storagePhysicalTemplateIds(workspace);
    for (const templateId of new Set(aliases.values())) {
        const members = [templateId, ...[...aliases].filter(([physicalId, root]) => root === templateId && physicalId !== templateId).map(([physicalId]) => physicalId)];
        const existing = objectOrUndefined(result[templateId]);
        if (existing) {
            result[templateId] = { ...existing, dependBy: members };
            continue;
        }
        // Color is presentation state, generated locally by the website. Stable
        // colors avoid changes across restart; dependBy is the semantic contract.
        result[templateId] = createCloneDependencyColor(templateId, members);
    }
    return result;
}
function expansionId(controller, expansion) {
    return ['storage-expansion', controller.option, stringOrEmpty(expansion['option']),
        stringOrEmpty(expansion['featureCode']), stringOrEmpty(expansion['description'])]
        .map(encodeURIComponent).join(':');
}
function catalogIds(items) {
    return items.map((item) => item.id).join(', ') || 'none';
}
function uniqueById(items, requested, kind) {
    const matches = items.filter((item) => item.id === requested);
    if (matches.length === 1)
        return matches[0];
    if (matches.length === 0)
        throw new Error(`Unknown ${kind} "${requested}". Available: ${catalogIds(items)}.`);
    throw new Error(`${kind} "${requested}" is not unique in the storage catalog. Refresh the catalog before selecting it.`);
}
/** Adds stable client keys to the expansion records nested under one controller. */
export function listStorageExpansions(controller) {
    return controller.expansions.flatMap((value) => {
        const raw = objectOrUndefined(value);
        if (!raw)
            return [];
        const maximum = Number(raw['maximum']);
        return [{
                id: expansionId(controller, raw), controllerId: controller.id,
                option: stringOrEmpty(raw['option']), featureCode: stringOrEmpty(raw['featureCode']),
                description: stringOrEmpty(raw['description']),
                maximum: Number.isFinite(maximum) && maximum >= 0 ? Math.trunc(maximum) : 0,
                raw: structuredClone(raw),
            }];
    });
}
function compactSelection(hardwareType, item) {
    return {
        hardwareType,
        ...(item ? { option: item.option, featureCode: item.featureCode ?? '' } : {}),
    };
}
function resolveExpansion(controller, requestedId) {
    const choices = listStorageExpansions(controller);
    if (requestedId !== undefined)
        return uniqueById(choices, requestedId, 'expansionId');
    // This is the website's observed Add Storage behavior: it picks the first expansion of the
    // selected controller, or an empty storage placeholder when the controller has none.
    return choices[0];
}
function resolveSwitch(fabric, requested) {
    if (requested === undefined || requested === DIRECT_ATTACHED)
        return undefined;
    return uniqueById(fabric.storageSwitches, requested, 'switchId');
}
function assertChoice(requested, available, kind) {
    if (!available.includes(requested)) {
        throw new Error(`Unknown storage ${kind} "${requested}". Available: ${available.join(', ')}.`);
    }
}
/**
 * Builds the compact workspace storage record produced by DCSC's Add Storage editor. Catalog
 * descriptions/prices are lookup data; the saved controller, expansion and switch carry only
 * hardware type, option and feature code.
 */
export function buildStorageConnectionNetwork(fabric, input) {
    const name = input.name.trim();
    if (!name)
        throw new Error('Storage network name is required.');
    const type = input.type ?? 'General Storage';
    const layout = input.layout ?? 'Fully Redundant';
    assertChoice(type, STORAGE_TYPES, 'type');
    assertChoice(layout, STORAGE_LAYOUTS, 'layout');
    const controller = uniqueById(fabric.storageControllers, input.controllerId, 'controllerId');
    const expansion = resolveExpansion(controller, input.expansionId);
    const storageSwitch = resolveSwitch(fabric, input.switchId);
    // Add Storage initializes this preference to one even when the controller has
    // no expansion choices. It is a stored limit, not a count of installed units.
    let quantity = 1;
    if (input.expansionQuantity !== undefined) {
        if (!Number.isInteger(input.expansionQuantity) || input.expansionQuantity < 0) {
            throw new Error('expansionQuantity must be a non-negative integer.');
        }
        if (!expansion && input.expansionQuantity !== 0) {
            throw new Error(`Controller "${controller.id}" has no expansion; expansionQuantity must be 0.`);
        }
        if (expansion && input.expansionQuantity > expansion.maximum) {
            throw new Error(`expansionQuantity ${input.expansionQuantity} exceeds ${expansion.id}'s maximum of ${expansion.maximum}.`);
        }
        quantity = input.expansionQuantity;
    }
    const expansionRecord = expansion
        ? { ...compactSelection('storage', expansion), ...(input.expansionQuantity !== undefined ? { quantity } : {}) }
        : compactSelection('storage');
    return {
        name,
        maximumExpansions: quantity,
        type,
        layout,
        controller: compactSelection('storage', controller),
        expansion: expansionRecord,
        mainSwitch: compactSelection('switch', storageSwitch),
    };
}
/** Appends a new, uniquely named storage network while retaining all existing raw fields. */
export function addStorageConnectionNetwork(existing, fabric, input) {
    const added = buildStorageConnectionNetwork(fabric, input);
    if (existing.some((item) => item.name.toLocaleLowerCase() === added.name.toLocaleLowerCase())) {
        throw new Error(`Storage network name "${added.name}" already exists. Choose a unique name.`);
    }
    return [...structuredClone(existing), added];
}
/** Definition names are references used by configurations, so edits target one exact name. */
export function editStorageConnectionNetwork(existing, edit) {
    const matches = existing.filter(item => item.name === edit.name);
    if (matches.length !== 1)
        throw new Error(`Storage network "${edit.name}" is ${matches.length ? 'ambiguous' : 'unknown'}. Inspect storageNetworks for the exact current name.`);
    if (edit.action === 'remove')
        return structuredClone(existing.filter(item => item.name !== edit.name));
    const name = edit.newName?.trim();
    if (!name)
        throw new Error('A nonempty newName is required to rename storage.');
    if (existing.some(item => item.name !== edit.name && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new Error(`Storage network name "${name}" already exists. Choose a unique name.`);
    }
    return existing.map(item => ({ ...structuredClone(item), ...(item.name === edit.name ? { name } : {}) }));
}
/** Website preference controls update only the selected fields, preserving managed identities. */
export function reconfigureStorageConnectionNetwork(existing, fabric, name, changes, rackedTemplateIds = new Set()) {
    const matches = existing.filter(item => item.name === name);
    if (matches.length !== 1)
        throw new Error(`Storage network "${name}" is ambiguous or unknown.`);
    if (!Object.values(changes).some(value => value !== undefined))
        throw new Error('Provide at least one storage preference change.');
    const current = matches[0];
    const next = structuredClone(current);
    const matchesSelection = (selection, choice) => selection['option'] === choice.option && stringOrEmpty(selection['featureCode']) === (choice.featureCode ?? '');
    if (changes.type !== undefined) {
        assertChoice(changes.type, STORAGE_TYPES, 'type');
        if (changes.type !== current.type && rackedTemplateIds.has(stringOrEmpty(current.controller['id']))) {
            throw new Error('Move the storage controller instances out of their racks before changing the storage type, as required by the website.');
        }
        next.type = changes.type;
    }
    if (changes.layout !== undefined) {
        assertChoice(changes.layout, STORAGE_LAYOUTS, 'layout');
        next.layout = changes.layout;
    }
    let controllerChanged = false;
    if (changes.controllerId !== undefined) {
        const controller = uniqueById(fabric.storageControllers, changes.controllerId, 'controllerId');
        controllerChanged = !matchesSelection(current.controller, controller);
        if (controllerChanged) {
            if (stringOrEmpty(current.controller['id']))
                throw new Error('The website locks the controller choice after Edit Item creates its configuration. Create a new storage definition to choose another controller.');
            const expansion = resolveExpansion(controller, undefined);
            next.controller = { option: controller.option, featureCode: controller.featureCode ?? '' };
            next.expansion = expansion ? { option: expansion.option, featureCode: expansion.featureCode } : {};
            next.maximumExpansions = expansion ? 1 : 0;
        }
    }
    if (changes.expansionId !== undefined || changes.expansionQuantity !== undefined) {
        const controller = fabric.storageControllers.filter(choice => matchesSelection(next.controller, choice));
        if (controller.length !== 1)
            throw new Error('The current storage controller cannot be uniquely resolved in the catalog.');
        const choices = listStorageExpansions(controller[0]);
        const expansion = changes.expansionId !== undefined
            ? uniqueById(choices, changes.expansionId, 'expansionId')
            : choices.find(choice => matchesSelection(next.expansion, choice));
        const expansionChanged = expansion !== undefined && !matchesSelection(next.expansion, expansion);
        const quantityChanged = changes.expansionQuantity !== undefined && changes.expansionQuantity !== next.maximumExpansions;
        if ((expansionChanged || quantityChanged) && rackedTemplateIds.has(stringOrEmpty(current.expansion['id']))) {
            throw new Error('Move the storage expansion instances out of their racks before changing expansion preferences.');
        }
        if (expansionChanged)
            next.expansion = { option: expansion.option, featureCode: expansion.featureCode };
        if (changes.expansionQuantity !== undefined) {
            const quantity = changes.expansionQuantity;
            if (!Number.isInteger(quantity) || quantity < 0 || quantity > (expansion?.maximum ?? 0)) {
                throw new Error(`expansionQuantity must be an integer between 0 and ${expansion?.maximum ?? 0}.`);
            }
            next.expansion = { ...next.expansion, quantity };
            next.maximumExpansions = quantity;
        }
    }
    if (changes.switchId !== undefined) {
        const selected = resolveSwitch(fabric, changes.switchId);
        const changed = selected ? !matchesSelection(current.mainSwitch, selected) : Boolean(stringOrEmpty(current.mainSwitch['option']));
        if (changed)
            next.mainSwitch = { ...compactSelection('switch', selected),
                ...(!selected ? { option: '', featureCode: '' } : {}) };
    }
    return existing.map(item => item.name === name ? next : structuredClone(item));
}
//# sourceMappingURL=storagePreferences.js.map