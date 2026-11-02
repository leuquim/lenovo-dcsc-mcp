import { DEFAULT_FLOOR_PREFERENCE } from './floor.js';
import { nonEmptyStringOrNumberText, objectOrEmpty } from '../util/coerce.js';
/** Import/export stores these toggles in customizingFlags; live requests use settings. */
export function readAutoConnectSettings(state) {
    const flags = objectOrEmpty(state['customizingFlags']);
    const imported = Object.fromEntries(['autoAddPDU', 'autoAddSwitch', 'p2pCabling']
        .filter(key => typeof flags[key] === 'boolean').map(key => [key, flags[key]]));
    return structuredClone({ ...imported,
        ...objectOrEmpty(objectOrEmpty(state['networkingInformation'])['autoConnectSettings']),
        ...objectOrEmpty(objectOrEmpty(state['autoConnectState'])['autoConnectSettings']),
        ...objectOrEmpty(state['autoConnectSettings']),
    });
}
/** Canonical live graph takes precedence, including an authoritative empty array. */
export function readConnectionGraph(state) {
    const networking = objectOrEmpty(state['networkingInformation']);
    for (const value of [state['connections'], objectOrEmpty(state['autoConnectState'])['connections'],
        state['autoConnectResults'], networking['autoConnectResults'], networking['connections']]) {
        if (Array.isArray(value))
            return structuredClone(value);
    }
    return [];
}
/** Retain the last graph for inspection, but never export it as a current design. */
export function invalidateConnectionGraph(state, reason) {
    if (readConnectionGraph(state).length > 0)
        state['connectionGraphInvalidation'] = { reason };
}
export function assertCurrentConnectionGraph(state) {
    if (state['connectionGraphInvalidation'] !== undefined) {
        throw new Error('The saved connection graph predates a workspace change. Run dcsc_auto_connect with the workspace session before exporting or validating the workspace.');
    }
}
export function readSwitchMap(state) {
    for (const value of [state['switchMap'], objectOrEmpty(state['autoConnectState'])['switchMap'],
        objectOrEmpty(state['networkingInformation'])['switchMap']]) {
        if (Array.isArray(value))
            return structuredClone(value);
    }
    return [];
}
/** Captured SPA export groups by cablePart; AI/HPC excludes Power connections. */
export function buildCableGroups(connections, includePower) {
    const groups = new Map();
    for (const value of connections) {
        const connection = objectOrEmpty(value);
        if (!includePower && connection['network'] === 'Power')
            continue;
        const code = nonEmptyStringOrNumberText(connection['cablePart']);
        if (!code)
            throw new Error('Cannot export a connection without its selected cable part. Re-run auto-connect.');
        const existing = groups.get(code);
        if (existing)
            existing.quantity += 1;
        else {
            const description = nonEmptyStringOrNumberText(connection['cableType']);
            groups.set(code, { code, ...(description === undefined ? {} : { description }), quantity: 1 });
        }
    }
    return [...groups.values()];
}
/** Website settings are a partial edit; retain imported settings we do not expose. */
export function mergeAutoConnectSettings(current, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('Auto-connect settings must be an object of boolean options.');
    }
    for (const [key, value] of Object.entries(patch)) {
        if (!['autoAddPDU', 'autoAddSwitch', 'p2pCabling'].includes(key) || typeof value !== 'boolean') {
            throw new Error(`Invalid auto-connect setting ${key}; use boolean autoAddPDU, autoAddSwitch or p2pCabling.`);
        }
    }
    return { ...structuredClone(objectOrEmpty(current)), ...patch };
}
/** One projection for graphs returned by either auto-connect or rack customization. */
export function projectConnectionGraph(rawConnections) {
    const connections = rawConnections.map(summariseConnection);
    return { connections, cables: connections.map(toCableLink) };
}
function makeCloneDependency(configurations) {
    const result = {};
    for (const configuration of configurations) {
        const id = nonEmptyStringOrNumberText(configuration['id']) ?? nonEmptyStringOrNumberText(configuration['configurationId']);
        if (id)
            result[id] = [id];
    }
    return result;
}
/** Mirrors the SPA's converNetworkTopologies2ClusterPreference adapter. */
export function buildClusterPreferences(networkDevices, networkTypes) {
    const find = (feature, option) => networkDevices.find((device) => device.feature === feature && device.option === option);
    return networkTypes.map((network) => {
        const main = find(network['defaultMainSwitch'], network['defaultMainSwitchOption']);
        const leaf = find(network['defaultLeafSwitch'], network['defaultLeafSwitchOption']);
        const topology = nonEmptyStringOrNumberText(network['defaultNetworkTechnology']) ?? '';
        const base = {
            cableColor: network['defaultCableColor'], cableType: network['defaultCableType'],
            mainSwitch: main ? { feature: main.feature, option: main.option, topologyConnectors: main.topologyConnectors } : {},
            maximumPorts: main?.topologyConnectors[topology], name: network.name,
            networkLayout: network.defaultLayout, networkType: topology,
            trunks: network['mainSwitchTrunks'], vlan: Array.isArray(network['defaultVlan']) ? network['defaultVlan'] : [],
            customCable: network['customCable'],
        };
        if (network.defaultLayout === 'Centralized') {
            return { ...base, leafCableColor: network['defaultLeafCableColor'], leafCableType: '',
                leafSwitch: {}, leafMaximumPorts: 0, leafTrunks: 0, leafCabling: '' };
        }
        return { ...base, leafCableColor: network['defaultLeafCableColor'],
            leafCableType: network['defaultLeafCableType'],
            leafSwitch: leaf ? { feature: leaf.feature, option: leaf.option, topologyConnectors: leaf.topologyConnectors } : {},
            leafMaximumPorts: leaf?.topologyConnectors[topology], leafTrunks: network['leafSwitchTrunks'] ?? 0,
            leafCabling: network['defaultLeafCabling'] ?? '' };
    });
}
/** Exact /auto_connect request shape: the SPA never seeds regeneration with prior graph rows. */
export function buildAutoConnectRequest(payload) {
    const requestState = {
        nonRackArea: [], controllerExpansionMap: {}, floorPreference: DEFAULT_FLOOR_PREFERENCE,
        floorItems: [], clusterPreference: [], powerPreference: [], storageConnectionNetworks: [],
        cloneRackMapping: {}, autoConnectSettings: {}, switchMap: [],
        virtualContainerIdMapping: {}, virtualContainerRule2ConfigMapping: {},
        virtualContainerInvalidRuleIdMapping: {}, vlhItems: [],
        cloneDependency: makeCloneDependency(payload.configurations),
        ...structuredClone(payload),
    };
    // Keep stale/manual rows in local state until the transaction accepts the
    // response, but never let them influence the complete recalculation.
    delete requestState.connections;
    return requestState;
}
export async function autoConnect(http, ctx, payload, query, seedConnections) {
    if (payload.rackArea.length === 0 && (payload.nonRackArea?.length ?? 0) === 0) {
        throw new Error('Nothing to cable: the workspace has no racks or non-rack items. Add and place products first.');
    }
    const requestState = buildAutoConnectRequest(payload);
    // Only explicit manual creation seeds a graph. Normal regeneration still
    // drops payload.connections, including stale imported rows.
    if (seedConnections !== undefined)
        requestState.connections = structuredClone([...seedConnections]);
    const res = await http.send({ endpoint: 'auto_connect', method: 'POST', path: '/auto_connect', query,
        body: { kind: 'json', value: requestState }, responseKind: 'json', timeoutClass: 'heavy', ctx });
    const rawState = objectOrEmpty(res.raw);
    const rawConnections = Array.isArray(rawState['connections']) ? rawState['connections'] : [];
    const { connections, cables } = projectConnectionGraph(rawConnections);
    const rackArea = Array.isArray(rawState['rackArea']) ? rawState['rackArea'] : payload.rackArea;
    const nonRackArea = Array.isArray(rawState['nonRackArea']) ? rawState['nonRackArea'] : payload.nonRackArea ?? [];
    return { settings: structuredClone(requestState.autoConnectSettings ?? {}),
        connections, cables, rawRackArea: rackArea,
        rawNonRackArea: nonRackArea, rawConnections,
        errors: Array.isArray(rawState['errors']) ? rawState['errors'] : [], rawState,
        messages: extractAutoConnectMessages(rackArea) };
}
function summariseConnection(value) {
    const raw = objectOrEmpty(value);
    const fromId = nonEmptyStringOrNumberText(raw['sourceId']);
    const toId = nonEmptyStringOrNumberText(raw['destinationId']);
    const sourcePortName = nonEmptyStringOrNumberText(raw['sourcePortName']);
    const sourcePortNumber = nonEmptyStringOrNumberText(raw['sourcePortNumber']);
    const destinationPortName = nonEmptyStringOrNumberText(raw['destinationPortName']);
    const destinationPortNumber = nonEmptyStringOrNumberText(raw['destinationPortNumber']);
    const cableCode = nonEmptyStringOrNumberText(raw['cablePart']);
    const description = nonEmptyStringOrNumberText(raw['cableType']);
    const network = nonEmptyStringOrNumberText(raw['network']);
    const topology = nonEmptyStringOrNumberText(raw['topology']);
    const key = [cableCode, sourcePortName, sourcePortNumber, fromId,
        destinationPortName, destinationPortNumber, toId].filter(Boolean).join(':');
    return { id: nonEmptyStringOrNumberText(raw['id']) ?? (key || 'connection'), fromId, toId,
        fromPort: [sourcePortName, sourcePortNumber].filter(Boolean).join(' - ') || undefined,
        toPort: [destinationPortName, destinationPortNumber].filter(Boolean).join(' - ') || undefined,
        sourcePortName, sourcePortNumber, destinationPortName, destinationPortNumber,
        cableCode, description, network, topology, raw };
}
function toCableLink(connection) {
    return { id: connection.id, fromConfigId: connection.fromId ?? '', fromPort: connection.fromPort ?? '',
        toConfigId: connection.toId ?? '', toPort: connection.toPort ?? '',
        ...(connection.cableCode !== undefined ? { cableCode: connection.cableCode } : {}),
        ...(connection.description !== undefined ? { description: connection.description } : {}) };
}
function extractAutoConnectMessages(rackArea) {
    const out = [];
    for (const rack of rackArea) {
        const errors = rack['errors'];
        if (!Array.isArray(errors))
            continue;
        const messages = errors.filter((error) => String(objectOrEmpty(error)['code'] ?? '') === '102')
            .map((error) => String(objectOrEmpty(error)['message'] ?? '')).filter(Boolean);
        if (messages.length > 0)
            out.push({ rackId: String(rack['id'] ?? ''), messages });
    }
    return out;
}
//# sourceMappingURL=cabling.js.map