import { nonEmptyString, objectOrEmpty } from '../util/coerce.js';
function strings(v) {
    return Array.isArray(v) ? v.filter((item) => typeof item === 'string') : [];
}
function numericMap(v) {
    return Object.fromEntries(Object.entries(objectOrEmpty(v)).filter((entry) => typeof entry[1] === 'number'));
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
    const key = preferred.map(nonEmptyString).filter(Boolean).join(':');
    return `${prefix}:${key || hash(value)}`;
}
function asArray(v) {
    return Array.isArray(v) ? v.filter((item) => typeof item === 'object' && item !== null) : [];
}
export async function fetchFabricOptions(http, ctx) {
    const [topo, roles, storage] = await Promise.all([
        http.send({ endpoint: 'getTopologies', method: 'GET', path: '/getTopologies', responseKind: 'json', timeoutClass: 'fast', ctx }),
        http.send({ endpoint: 'node_roles', method: 'GET', path: '/node_roles', responseKind: 'json', timeoutClass: 'fast', ctx }),
        http.send({ endpoint: 'getStoragePreferences', method: 'GET', path: '/getStoragePreferences', responseKind: 'json', timeoutClass: 'fast', ctx }),
    ]);
    const topologyRoot = objectOrEmpty(topo.raw);
    const storageRoot = objectOrEmpty(storage.raw);
    const topologies = asArray(topologyRoot['networkTopology']).flatMap((source) => {
        const shortName = nonEmptyString(source['shortName']);
        return shortName ? [{ ...source, id: id('topology', source, [shortName]), shortName,
                description: nonEmptyString(source['description']) ?? shortName }] : [];
    });
    const networkDevices = asArray(topologyRoot['networkDevices']).flatMap((source) => {
        const option = nonEmptyString(source['option']);
        if (!option)
            return [];
        const feature = nonEmptyString(source['feature']) ?? '';
        return [{ ...source, id: id('network-device', source, [option, feature, source['description']]),
                option, feature, description: nonEmptyString(source['description']) ?? '',
                topologies: strings(source['topologies']), topologyConnectors: numericMap(source['topologyConnectors']) }];
    });
    const networkTypes = asArray(topologyRoot['networkType']).flatMap((source) => {
        const name = nonEmptyString(source['name']);
        return name ? [{ ...source, id: id('network-type', source, [name]), name,
                defaultNetworkTechnology: nonEmptyString(source['defaultNetworkTechnology']) ?? '',
                defaultLayout: nonEmptyString(source['defaultLayout']) ?? '' }] : [];
    });
    const cables = asArray(topologyRoot['cables']).map((source) => ({ ...source,
        id: id('cable', source, [source['featureCode'], source['option'], source['code'], hash(source)]),
        featureCode: nonEmptyString(source['featureCode']) ?? '', description: nonEmptyString(source['description']) ?? '',
        topologies: strings(source['topologies']), compatibility: strings(source['compatibility']) }));
    const selectedServices = asArray(topologyRoot['selectedServices']).map((source) => ({ ...source,
        id: id('network-service', source, [source['featureCode'], source['option'], hash(source)]),
        featureCode: nonEmptyString(source['featureCode']) ?? '', description: nonEmptyString(source['description']) ?? '' }));
    const leafNodeCabling = asArray(topologyRoot['leafNodeCabling']).flatMap((source) => {
        const description = nonEmptyString(source['description']);
        return description ? [{ ...source, id: id('leaf-cabling', source, [description]), description }] : [];
    });
    const nodeRoles = asArray(roles.raw).flatMap((source) => {
        const role = nonEmptyString(source['role']);
        return role ? [{ ...source, id: id('node-role', source, [role]), role,
                description: nonEmptyString(source['description']) ?? role }] : [];
    });
    const storageSwitches = asArray(storageRoot['switches']).flatMap((source) => {
        const option = nonEmptyString(source['option']);
        return option ? [{ ...source, id: id('storage-switch', source, [option, source['featureCode']]),
                option, featureCode: nonEmptyString(source['featureCode']), description: nonEmptyString(source['description']) ?? '',
                ...(typeof source['price'] === 'number' ? { price: source['price'] } : {}) }] : [];
    });
    const storageControllers = asArray(storageRoot['controllers']).flatMap((source) => {
        const option = nonEmptyString(source['option']);
        return option ? [{ ...source, id: id('storage-controller', source, [option, source['featureCode']]),
                option, featureCode: nonEmptyString(source['featureCode']), description: nonEmptyString(source['description']) ?? '',
                expansions: Array.isArray(source['expansions']) ? source['expansions'] : [],
                ...(typeof source['price'] === 'number' ? { price: source['price'] } : {}) }] : [];
    });
    return { topologies, networkDevices, networkTypes, cables, selectedServices, nodeRoles,
        ...(Object.hasOwn(topologyRoot, 'leafNodeCabling') ? { leafNodeCabling } : {}),
        storageSwitches, storageControllers };
}
//# sourceMappingURL=fabric.js.map