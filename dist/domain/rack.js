/** Rack hardware available in the current solution mode or compatible-parent catalog. */
export async function fetchRackCabinets(http, ctx, masterCode, hardwareType = 'rack') {
    const res = await http.send({
        endpoint: 'racks_categories',
        method: 'GET',
        path: masterCode ? '/ctos/racks/compatible_categories' : '/ctos/racks/categories',
        ...(masterCode ? { query: { masterCode } } : {}),
        responseKind: 'json',
        timeoutClass: 'fast',
        ctx,
    });
    const out = [];
    const walk = (nodes) => {
        for (const node of nodes) {
            for (const p of node.products ?? []) {
                const code = p['code'];
                if (typeof code !== 'string')
                    continue;
                // The same endpoint supplies compatible chassis and nested nodes.
                // Default cabinet discovery continues to exclude other hardware.
                if (p['hardwareType'] !== hardwareType)
                    continue;
                const description = p['description'];
                const machineType = p['machineType'];
                const price = p['price'];
                out.push({
                    code,
                    description: typeof description === 'string' ? description : '',
                    ...(typeof machineType === 'string' ? { machineType } : {}),
                    ...(typeof price === 'number' ? { price } : {}),
                });
            }
            if (node.children?.length)
                walk(node.children);
        }
    };
    walk(res.raw ?? []);
    return out;
}
/**
 * Physical envelope for each product code.
 *
 * This is the only way to learn a product's U height and weight — the
 * configuration tree does not carry them.
 */
export async function fetchEnvelopes(http, ctx, items) {
    const out = new Map();
    if (items.length === 0)
        return out;
    const res = await http.send({
        endpoint: 'racks_customize_non_rack',
        method: 'POST',
        path: '/ctos/racks/customize/non_rack',
        body: {
            kind: 'json',
            value: items.map((i) => ({ type: i.type, asVLH: false, code: i.code })),
        },
        responseKind: 'json',
        timeoutClass: 'interactive',
        ctx,
    });
    for (const entry of res.raw ?? []) {
        const code = entry['code'];
        if (typeof code !== 'string')
            continue;
        out.set(code.toUpperCase(), {
            code,
            type: String(entry['type'] ?? 'server'),
            sizeU: num(entry['size']) ?? 1,
            weightKg: num(entry['weight']) ?? 0,
            widthMm: num(entry['width']),
            depthMm: num(entry['depth']),
            raw: entry,
        });
    }
    return out;
}
/** Uses DCSC's own product classification when requesting a physical envelope. */
export function buildEnvelopeRequest(raw) {
    const code = str(raw['sliceCtoCode']) ?? str(raw['code']) ?? str(raw['lfoCode']);
    if (!code)
        throw new Error('Cannot request a physical envelope without a product code.');
    return { code, type: classifyRackHardware(raw), asVLH: raw['asVLH'] === true };
}
/**
 * Classifies a rackable product from server-authored values only.
 *
 * Live launch evidence returns `server`, `switch`, and `rack` in `type`.
 * `hardwareType` wins when the rack service has already made it more specific.
 */
export function classifyRackHardware(...sources) {
    for (const source of sources) {
        if (!source)
            continue;
        const value = str(source['hardwareType']) ?? str(source['type']);
        if (value)
            return value.toLowerCase();
    }
    throw new Error('DCSC did not provide a hardware type for this product.');
}
/** Projects full configuration trees into the compact shape posted by the SPA. */
export function buildRackConfigurations(configurations) {
    return configurations.map((configuration) => {
        const id = str(configuration['id']) ?? str(configuration['configurationId']);
        const code = str(configuration['code']) ?? str(configuration['sliceCtoCode']) ?? str(configuration['lfoCode']);
        if (!id || !code)
            throw new Error('Rack configuration requires both an id and product code.');
        const sections = [];
        for (const tab of rows(configuration['tabs'])) {
            const tabType = str(tab['type']);
            for (const subTab of rows(tab['subTabs'])) {
                for (const section of rows(subTab['sections']))
                    appendSection(sections, section, tabType);
            }
        }
        for (const section of rows(configuration['unSelectableCharacters'])) {
            appendSection(sections, section);
        }
        return {
            id,
            code,
            sections,
            name: str(configuration['name']) ?? '',
            description: str(configuration['description']) ?? '',
            connectors: Array.isArray(configuration['connectors']) ? configuration['connectors'] : [],
            selectedTopologies: object(configuration['selectedTopologies']),
            selectedStorageNetwork: configuration['selectedStorageNetwork'],
            sliceCtoCode: str(configuration['sliceCtoCode']) ?? code,
            slice: configuration['slice'],
            asVLH: configuration['asVLH'] === true,
            vlhId: configuration['vlhId'],
        };
    });
}
/** Adds projected configurations while retaining all caller-owned workspace state. */
export function buildRackCustomizePayload(state, configurations) {
    const compact = buildRackConfigurations(configurations);
    const byId = new Map(compact.map(configuration => [configuration.id, configuration]));
    const roots = new Map();
    for (const [root, value] of Object.entries(object(state['cloneDependency']))) {
        if (Array.isArray(value))
            for (const id of value)
                if (typeof id === 'string')
                    roots.set(id, root);
    }
    for (const [root, value] of Object.entries(object(state['cloneDependencyColor']))) {
        const members = object(value)['dependBy'];
        if (Array.isArray(members))
            for (const id of members)
                if (typeof id === 'string')
                    roots.set(id, root);
    }
    const project = (source, racked, cabinet = false) => {
        const item = structuredClone(source);
        // customizePrepareData unwraps the node bay-size object returned by the
        // layout service. Sending that response object back fails deserialization.
        if (item['type'] === 'node' && item['size'] !== null && typeof item['size'] === 'object') {
            const value = object(item['size'])['value'];
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
                throw new Error('DCSC node physical size has no usable numeric value.');
            }
            item['size'] = value;
        }
        const id = str(item['id']);
        const configuration = id ? byId.get(roots.get(id) ?? id) : undefined;
        if (configuration) {
            const previous = rows(item['features']);
            item['features'] = configuration.sections.filter(section => !section.name.includes('UNCONFIGURED_'))
                .map(section => ({ name: section.name, results: section.features.map(feature => {
                    // The SPA shares these compact result objects with the physical payload,
                    // including the OR-ed auto-connect flag across linked physical aliases.
                    const result = feature;
                    if (racked) {
                        const old = previous.find(value => value['name'] === section.name);
                        const prior = rows(old?.['results']).find(value => value['code'] === feature.code);
                        if (prior)
                            result.forAutoConnect = result.forAutoConnect === true || prior['forAutoConnect'] === true;
                    }
                    return result;
                }) }));
            if (!item['description'])
                item['description'] = configuration['description'];
            if (!cabinet || !item['name'])
                item['name'] = configuration['name'];
            if (cabinet)
                item['baseFeatureCode'] = configuration.sections.find(section => section.name === 'BASE')?.features[0]?.code;
        }
        for (const key of ['rackItems', 'nodes']) {
            if (Array.isArray(item[key]))
                item[key] = rows(item[key]).map(child => project(child, racked));
        }
        return item;
    };
    return { ...state, configurations: compact,
        rackArea: state.rackArea.map(rack => project(rack, true, true)),
        nonRackArea: state.nonRackArea.map(item => project(item, false)) };
}
/** The SPA applies derive placement metadata to selected results before preparing rack requests. */
export function withDerivedPlacements(configuration, response) {
    const id = str(configuration['workspaceId']) ?? str(configuration['id']) ?? str(configuration['configurationId']);
    const targets = configuration['updateConfigurationIds'];
    if (Array.isArray(targets) && !targets.includes(configuration['id']))
        return configuration;
    const placements = rows(object(response)['placementResults']).filter(value => value['workspaceId'] === id);
    if (placements.length === 0)
        return configuration;
    if (placements.length > 1)
        throw new Error(`DCSC returned ambiguous placement results for ${id}.`);
    const enriched = structuredClone(configuration);
    const sections = rows(enriched['tabs']).flatMap(tab => rows(tab['subTabs']))
        .flatMap(tab => rows(tab['sections'])).concat(rows(enriched['unSelectableCharacters']));
    for (const placement of rows(placements[0]['sectionPlacement'])) {
        for (const section of sections.filter(value => value['name'] === placement['sectionName'])) {
            for (const feature of rows(placement['featurePlacement'])) {
                for (const result of rows(section['results']).filter(value => value['code'] === feature['featureCode'])) {
                    result['installations'] = Array.isArray(feature['installations']) ? structuredClone(feature['installations']) : [];
                }
            }
        }
    }
    return enriched;
}
/**
 * Applies the configuration patch returned by /ctos/autoDerive.
 *
 * The endpoint wraps a partial list in `configurations`: live responses omit
 * configurations that did not change. Match only by the opaque configuration
 * id and retain every omitted configuration in its original order.
 */
export function mergeDerivedConfigurations(current, response) {
    const currentById = new Map();
    for (const configuration of current) {
        const id = configurationId(configuration, 'current');
        if (currentById.has(id)) {
            throw new Error(`Duplicate current rack configuration id: ${id}`);
        }
        currentById.set(id, configuration);
    }
    const wrapper = object(response);
    if (!Array.isArray(wrapper['configurations'])) {
        throw new Error('Auto-derive response is missing its configurations array.');
    }
    const derived = wrapper['configurations'].map((configuration, index) => {
        if (typeof configuration !== 'object' || configuration === null || Array.isArray(configuration)) {
            throw new Error(`Auto-derive configuration at index ${index} is not an object.`);
        }
        return configuration;
    });
    const updates = new Map();
    for (const configuration of derived) {
        const id = configurationId(configuration, 'derived');
        if (updates.has(id)) {
            throw new Error(`Duplicate derived rack configuration id: ${id}`);
        }
        const existing = currentById.get(id);
        if (!existing) {
            throw new Error(`Derived rack configuration has unknown id: ${id}`);
        }
        const existingCode = configurationCode(existing);
        const derivedCode = configurationCode(configuration);
        if (existingCode && derivedCode && existingCode.toUpperCase() !== derivedCode.toUpperCase()) {
            throw new Error(`Derived rack configuration ${id} changed product code from ${existingCode} to ${derivedCode}`);
        }
        updates.set(id, configuration);
    }
    return current.map((configuration) => updates.get(configurationId(configuration, 'current')) ?? configuration);
}
/**
 * Posts a layout for validation and returns DCSC's corrected version.
 *
 * The response is authoritative: items may have moved, been rejected, or been
 * pushed out to nonRackArea, and weights and stability are recomputed.
 */
export async function customizeLayout(http, ctx, payload, opts = {}) {
    const res = await http.send({
        endpoint: 'racks_customize',
        method: 'POST',
        path: opts.mode === 'lfo' ? '/lfos/racks/customize' : '/ctos/racks/customize',
        query: {
            autoArrange: opts.autoArrange ?? false,
            autoConnect: opts.autoConnect ?? false,
            cogValidation: opts.cogValidation ?? true,
        },
        body: { kind: 'json', value: payload },
        responseKind: 'json',
        timeoutClass: 'heavy',
        ctx,
    });
    const raw = object(res.raw);
    const rackArea = Array.isArray(raw['rackArea']) ? raw['rackArea'] : [];
    const nonRackArea = Array.isArray(raw['nonRackArea']) ? raw['nonRackArea'] : [];
    const allErrors = [];
    const racks = rackArea.map((r) => {
        const items = (r['rackItems'] ?? []).map((it) => {
            const sizeU = num(it['size']) ?? 1;
            const position = num(it['position']) ?? 0;
            return {
                id: String(it['id'] ?? ''),
                code: String(it['code'] ?? ''),
                description: str(it['description']),
                position,
                // DCSC raw endPosition is exclusive; the public U range is inclusive.
                endPosition: position + sizeU - 1,
                sizeU,
            };
        });
        const errors = toErrors(r['errors']);
        allErrors.push(...errors);
        const sizeU = num(r['size']) ?? 0;
        const usedU = items.reduce((acc, i) => acc + i.sizeU, 0);
        return {
            id: String(r['id'] ?? ''),
            code: String(r['code'] ?? ''),
            description: str(r['description']),
            sizeU,
            usedU,
            freeU: Math.max(0, sizeU - usedU),
            emptyWeightKg: num(r['emptyRackWeight']),
            totalWeightKg: num(r['totalWeight']),
            stableStatus: str(r['stableStatus']),
            items,
            errors,
        };
    });
    return {
        racks,
        unplaced: nonRackArea.map((n) => ({
            id: str(n['id']),
            code: String(n['code'] ?? ''),
            description: str(n['description']),
        })),
        errors: allErrors,
        rawRackArea: rackArea,
        rawNonRackArea: nonRackArea,
        connections: Array.isArray(raw['connections']) ? raw['connections'] : [],
        rawState: raw,
    };
}
/** Builds a rackItem entry for a product placed at a given U position. */
export function buildRackItem(envelope, configurationId, position, quantity = 1) {
    return {
        ...envelope.raw,
        id: configurationId,
        code: envelope.code,
        sliceCtoCode: envelope.code,
        type: envelope.type,
        quantity,
        position,
        endPosition: position + envelope.sizeU - 1,
    };
}
/** Builds a rackArea entry for an empty rack cabinet. */
export function buildRackObject(envelope, rackId, items = []) {
    return {
        ...envelope.raw,
        id: rackId,
        code: envelope.code,
        sliceCtoCode: envelope.code,
        type: 'rack',
        quantity: 1,
        rackItems: items,
    };
}
function num(v) {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}
function str(v) {
    return typeof v === 'string' && v !== '' ? v : undefined;
}
function object(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
}
function rows(v) {
    return Array.isArray(v)
        ? v.filter((item) => typeof item === 'object' && item !== null)
        : [];
}
function configurationId(configuration, source) {
    const id = str(configuration['id']) ?? str(configuration['configurationId']);
    if (!id)
        throw new Error(`${source === 'current' ? 'Current' : 'Derived'} rack configuration is missing its id.`);
    return id;
}
function configurationCode(configuration) {
    return str(configuration['code']) ?? str(configuration['sliceCtoCode']) ?? str(configuration['lfoCode']);
}
function appendSection(target, section, defaultType) {
    const name = str(section['name']) ?? str(section['sectionName']);
    if (!name)
        return;
    const features = rows(section['results']).flatMap((result) => {
        const code = str(result['code']);
        if (!code)
            return [];
        const feature = {
            code,
            quantity: num(result['quantity']) ?? 0,
            installations: Array.isArray(result['installations']) ? result['installations'] : [],
            description: str(result['description']),
            type: defaultType ?? str(result['type']),
            ...(typeof result['forAutoConnect'] === 'boolean'
                ? { forAutoConnect: result['forAutoConnect'] }
                : {}),
        };
        return [feature];
    });
    if (features.length > 0)
        target.push({ name, features });
}
function toErrors(v) {
    if (!Array.isArray(v))
        return [];
    const out = [];
    for (const e of v) {
        if (typeof e === 'string') {
            out.push({ message: e });
            continue;
        }
        if (typeof e !== 'object' || e === null)
            continue;
        const o = e;
        const message = o['message'];
        if (typeof message !== 'string')
            continue;
        out.push({ code: str(o['code']), message });
    }
    return out;
}
//# sourceMappingURL=rack.js.map