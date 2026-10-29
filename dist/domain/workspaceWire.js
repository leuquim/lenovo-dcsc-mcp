import { hardwareModeFamily } from './modeFamily.js';
import { projectLockedSpaceToSpa } from './rackLocks.js';
function rows(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'object' && item !== null) : [];
}
function code(prefix, ordinal) {
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 99) {
        throw new Error(`Cannot encode ${prefix} layout ordinal ${ordinal}.`);
    }
    return `${prefix}${String(ordinal).padStart(2, '0')}`;
}
/** Export hierarchy, distinct from the physical one-based rackData contract. */
export function buildItemHierarchy(item, rackIndex) {
    const derivedResults = [];
    if (rackIndex !== undefined) {
        derivedResults.push({ featureCode: code('31', rackIndex + 1), quantity: 1 });
        derivedResults.push({ featureCode: code('32', Number(item.position)), name: 'MI_P', quantity: 1 });
    }
    if (item.type === 'chassis' && item.filler && typeof item.filler === 'object' && !Array.isArray(item.filler)) {
        const filler = item.filler;
        if (typeof filler.code === 'string' && typeof filler.size === 'number') {
            derivedResults.push({ featureCode: filler.code, quantity: filler.size });
        }
    }
    for (const feature of rows(item.thinkAgileMIFeatures)) {
        derivedResults.push({ featureCode: feature.partNumberOrFeatureCode, name: 'MI_P', quantity: 1 });
    }
    const configFeatures = new Map();
    for (const feature of rows(item.configIdFeatures)) {
        const key = String(feature.featureCode);
        const prior = configFeatures.get(key);
        if (prior)
            prior.quantity = Number(prior.quantity) + 1;
        else
            configFeatures.set(key, { featureCode: key, quantity: feature.quantity || 1, name: 'CONFIG_ID', description: feature.description });
    }
    derivedResults.push(...configFeatures.values());
    const result = {
        id: item.id,
        quantity: typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1,
        size: item.type === 'node' ? item.occupiedBay : item.size ?? 1,
        type: item.type ?? 'server',
        originalIds: Array.isArray(item.originalIds) && item.originalIds.length > 0
            ? structuredClone(item.originalIds) : [item.id],
        derivedResults, removedResults: [],
    };
    if (item.asVLH === true)
        Object.assign(result, { asVLH: true, vlhId: item.vlhId });
    const nodes = rows(item.nodes);
    if (item.type === 'chassis' || nodes.length > 0)
        result.children = nodes.map((node) => buildItemHierarchy(node));
    return result;
}
/** Current SPA _buildStructure contract, captured with a rack and SR630 V3. */
export function buildRackHierarchy(rack, rackIndex = 0) {
    const items = rows(rack.rackItems);
    const lockedSpace = Array.isArray(rack.lockedSpace) ? structuredClone(rack.lockedSpace) : [];
    const derivedResults = [];
    if (items.length > 0)
        derivedResults.push({ featureCode: code('31', rackIndex + 1), name: 'MI_P', quantity: 1 });
    for (const position of lockedSpace)
        derivedResults.push({ featureCode: code('32', Number(position)), name: 'MI_P', quantity: 1 });
    for (const feature of rows(rack.thinkAgileMIFeatures)) {
        derivedResults.push({ featureCode: feature.partNumberOrFeatureCode, name: 'MI_P', quantity: 1 });
    }
    // CTO fillers have distinct manufacturing features for 5U, 3U and 1U.
    for (const section of rows(rack.features).filter((entry) => ['MECH_DERIVE_FCS', 'EXTENSION_KIT'].includes(String(entry.name)))) {
        if (!rows(section.results).some((entry) => entry.code === 'AUEE'))
            continue;
        for (const [size, featureCode] of [[5, 'B34A'], [3, 'B349'], [1, 'B348']]) {
            const quantity = rows(rack.filler).filter((entry) => Number(entry.size) === size).length;
            if (quantity > 0)
                derivedResults.push({ featureCode, name: section.name, quantity });
        }
    }
    return {
        id: rack.id, originalIds: [rack.id], quantity: 1, type: 'rack', size: rack.size,
        lockedSpace, derivedResults, removedResults: [],
        children: items.map((item) => buildItemHierarchy(item, rackIndex)),
        ...(rack.childrenStability !== undefined ? { childrenStability: structuredClone(rack.childrenStability) } : {}),
        ...(rack.asVLH === true ? { asVLH: true, vlhId: rack.vlhId } : {}),
    };
}
export function physicalRackData(rack) {
    if (Array.isArray(rack.servers) && !Array.isArray(rack.rackItems)) {
        throw new Error('Legacy rack layout needs reconciliation before export; expected one-based rackItems.');
    }
    const projected = structuredClone(rack);
    if (Array.isArray(rack.lockedSpace))
        projected.lockedSpace = projectLockedSpaceToSpa(rack.lockedSpace, Number(rack.size));
    return projected;
}
/** A workspace request must use the hardware family represented by every configuration. */
export function workspaceHardwareMode(configurations) {
    const modes = new Set([...configurations].map(configuration => hardwareModeFamily(configuration.mode)));
    if (modes.size > 1)
        throw new Error('Mixed CTO and LFO hardware requires separate workspaces.');
    return modes.has('lfo') ? 'lfo' : 'cto';
}
//# sourceMappingURL=workspaceWire.js.map