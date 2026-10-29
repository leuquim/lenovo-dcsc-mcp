/**
 * Applies DCSC's client-held configuration-ID metadata to physical workspace
 * items. The server only supplies the ordered feature catalog through
 * `/rmp/mip`; placement and autoDerive responses do not add these features.
 *
 * A physical item qualifies only when its associated configuration contains a
 * 5374-family HIPO product with a feature list. Distinct 5374 products consume
 * the catalog in physical layout order. Clone items reuse their root's mapping.
 */
export function assignConfigIdFeatures(input) {
    const rackData = structuredClone(input.rackData);
    const nonRackData = structuredClone(input.nonRackData);
    const configurations = new Map(input.configurations.flatMap(configuration => {
        const id = string(configuration['id']) || string(configuration['configurationId']);
        return id === '' ? [] : [[id, configuration]];
    }));
    const catalog = configIdCatalog(input.mipCatalog);
    const assignedByRoot = new Map();
    let cursor = 0;
    let assignedPhysicalItems = 0;
    for (const item of physicalItems(rackData, nonRackData)) {
        const itemId = string(item['id']);
        const originalId = string(array(item['originalIds'])[0]);
        const rootId = input.cloneRoots?.[itemId] ?? (originalId || itemId);
        const configuration = configurations.get(rootId) ?? configurations.get(itemId);
        const targetCodes = configIdTargetCodes(configuration);
        if (targetCodes.length === 0) {
            if (array(item['configIdFeatures']).length > 0)
                item['configIdFeatures'] = [];
            continue;
        }
        let assigned = assignedByRoot.get(rootId);
        if (!assigned) {
            assigned = new Map();
            assignedByRoot.set(rootId, assigned);
        }
        const features = [];
        for (const targetCode of targetCodes) {
            let feature = assigned.get(targetCode);
            if (!feature) {
                const source = catalog[cursor];
                if (!source) {
                    throw new Error(`DCSC /rmp/mip returned ${catalog.length} configuration IDs, ` +
                        `but the workspace needs at least ${cursor + 1}.`);
                }
                cursor += 1;
                feature = { ...source };
                assigned.set(targetCode, feature);
            }
            features.push({ ...feature });
        }
        if (item['shipUninstalled'] !== true)
            item['configIdFeatures'] = features;
        assignedPhysicalItems += 1;
    }
    return { rackData, nonRackData, assignedPhysicalItems, consumedCatalogFeatures: cursor };
}
/** Extracts the exact 5374 family consumed by the current DCSC SPA. */
export function configIdCatalog(value) {
    const source = object(value)['5374'];
    return array(source).flatMap(entry => {
        const feature = object(entry);
        const featureCode = string(feature['featureCode']);
        if (featureCode === '')
            return [];
        return [{ featureCode, quantity: 1, description: string(feature['description']) }];
    });
}
function physicalItems(racks, loose) {
    const result = [];
    const append = (item) => {
        const nodes = records(item['nodes']);
        if (nodes.length > 0)
            nodes.forEach(append);
        else
            result.push(item);
    };
    for (const rack of racks)
        records(rack['servers'] ?? rack['rackItems']).forEach(append);
    for (const item of loose)
        append(item);
    return result;
}
export function configIdTargetCodes(configuration) {
    if (!configuration)
        return [];
    const result = [];
    const seen = new Set();
    for (const raw of array(configuration['hipoDerivedItems'])) {
        const hipo = object(raw);
        const targetCode = string(hipo['targetCtoCode']);
        if (!targetCode.startsWith('5374') || !Array.isArray(hipo['features']) || seen.has(targetCode))
            continue;
        seen.add(targetCode);
        result.push(targetCode);
    }
    return result;
}
function records(value) {
    return array(value).filter((entry) => typeof entry === 'object' && entry !== null);
}
function array(value) {
    if (value === undefined || value === null)
        return [];
    return Array.isArray(value) ? value : [value];
}
function object(value) {
    return typeof value === 'object' && value !== null ? value : {};
}
function string(value) {
    return typeof value === 'string' ? value : '';
}
//# sourceMappingURL=configIdFeatures.js.map