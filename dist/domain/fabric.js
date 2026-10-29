function str(v) {
    return typeof v === 'string' && v !== '' ? v : undefined;
}
function strings(v) {
    return Array.isArray(v) ? v.filter((item) => typeof item === 'string') : [];
}
function object(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
}
function numericMap(v) {
    return Object.fromEntries(Object.entries(object(v)).filter((entry) => typeof entry[1] === 'number'));
}
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
        return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
}
function hash(value) {
    let result = 0x811c9dc5;
    for (const char of stableJson(value)) {
        result ^= char.charCodeAt(0);
        result = Math.imul(result, 0x01000193);
    }
    return (result >>> 0).toString(36);
}
function id(prefix, value, preferred) {
    const key = preferred.map(str).filter(Boolean).join(':');
    return `${prefix}:${key || hash(value)}`;
}
function asArray(v) {
    return Array.isArray(v) ? v.filter((item) => typeof item === 'object' && item !== null) : [];
}
export function paginateFabric(items, opts = {}) {
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
    const limit = Math.max(1, Math.trunc(opts.limit ?? 50));
    const page = items.slice(offset, offset + limit);
    return { items: page, total: items.length, offset, limit,
        ...(offset + page.length < items.length ? { nextOffset: offset + page.length } : {}) };
}
export async function fetchFabricOptions(http, ctx) {
    const [topo, roles, storage] = await Promise.all([
        http.send({ endpoint: 'getTopologies', method: 'GET', path: '/getTopologies', responseKind: 'json', timeoutClass: 'fast', ctx }),
        http.send({ endpoint: 'node_roles', method: 'GET', path: '/node_roles', responseKind: 'json', timeoutClass: 'fast', ctx }),
        http.send({ endpoint: 'getStoragePreferences', method: 'GET', path: '/getStoragePreferences', responseKind: 'json', timeoutClass: 'fast', ctx }),
    ]);
    const topologyRoot = object(topo.raw);
    const storageRoot = object(storage.raw);
    const topologies = asArray(topologyRoot['networkTopology']).flatMap((source) => {
        const shortName = str(source['shortName']);
        return shortName ? [{ ...source, id: id('topology', source, [shortName]), shortName,
                description: str(source['description']) ?? shortName }] : [];
    });
    const networkDevices = asArray(topologyRoot['networkDevices']).flatMap((source) => {
        const option = str(source['option']);
        if (!option)
            return [];
        const feature = str(source['feature']) ?? '';
        return [{ ...source, id: id('network-device', source, [option, feature, source['description']]),
                option, feature, description: str(source['description']) ?? '',
                topologies: strings(source['topologies']), topologyConnectors: numericMap(source['topologyConnectors']) }];
    });
    const networkTypes = asArray(topologyRoot['networkType']).flatMap((source) => {
        const name = str(source['name']);
        return name ? [{ ...source, id: id('network-type', source, [name]), name,
                defaultNetworkTechnology: str(source['defaultNetworkTechnology']) ?? '',
                defaultLayout: str(source['defaultLayout']) ?? '' }] : [];
    });
    const cables = asArray(topologyRoot['cables']).map((source) => ({ ...source,
        id: id('cable', source, [source['featureCode'], source['option'], source['code'], hash(source)]),
        featureCode: str(source['featureCode']) ?? '', description: str(source['description']) ?? '',
        topologies: strings(source['topologies']), compatibility: strings(source['compatibility']) }));
    const selectedServices = asArray(topologyRoot['selectedServices']).map((source) => ({ ...source,
        id: id('network-service', source, [source['featureCode'], source['option'], hash(source)]),
        featureCode: str(source['featureCode']) ?? '', description: str(source['description']) ?? '' }));
    const leafNodeCabling = asArray(topologyRoot['leafNodeCabling']).flatMap((source) => {
        const description = str(source['description']);
        return description ? [{ ...source, id: id('leaf-cabling', source, [description]), description }] : [];
    });
    const nodeRoles = asArray(roles.raw).flatMap((source) => {
        const role = str(source['role']);
        return role ? [{ ...source, id: id('node-role', source, [role]), role,
                description: str(source['description']) ?? role }] : [];
    });
    const storageSwitches = asArray(storageRoot['switches']).flatMap((source) => {
        const option = str(source['option']);
        return option ? [{ ...source, id: id('storage-switch', source, [option, source['featureCode']]),
                option, featureCode: str(source['featureCode']), description: str(source['description']) ?? '',
                ...(typeof source['price'] === 'number' ? { price: source['price'] } : {}) }] : [];
    });
    const storageControllers = asArray(storageRoot['controllers']).flatMap((source) => {
        const option = str(source['option']);
        return option ? [{ ...source, id: id('storage-controller', source, [option, source['featureCode']]),
                option, featureCode: str(source['featureCode']), description: str(source['description']) ?? '',
                expansions: Array.isArray(source['expansions']) ? source['expansions'] : [],
                ...(typeof source['price'] === 'number' ? { price: source['price'] } : {}) }] : [];
    });
    return { topologies, networkDevices, networkTypes, cables, selectedServices, nodeRoles,
        ...(Object.hasOwn(topologyRoot, 'leafNodeCabling') ? { leafNodeCabling } : {}),
        storageSwitches, storageControllers };
}
//# sourceMappingURL=fabric.js.map