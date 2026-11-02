import { z } from 'zod';
import { browseNetwork, NETWORK_COLLECTIONS, setNetwork } from '../app/network.js';
import { PAGE_BYTE_BUDGET } from '../config/constants.js';
import { cablingDiagnostics } from '../domain/cablingDiagnostics.js';
import { EXISTING_CUSTOMER_SWITCH_ID } from '../domain/networkPreferences.js';
import { jsonBytes } from '../util/jsonBytes.js';
import { guard } from './toolSupport.js';
export function projectAutoConnectToolResult(workspace, result) {
    const settings = Object.fromEntries(['autoAddPDU', 'autoAddSwitch', 'p2pCabling']
        .filter(key => typeof result.settings[key] === 'boolean')
        .map(key => [key, result.settings[key]]));
    const messageCount = result.messages.reduce((sum, group) => sum + group.messages.length, 0);
    const { networks: _networks, ...diagnostics } = cablingDiagnostics([...workspace.configurations.values()].map(session => session.raw), workspace.serverState);
    const page = (path) => ({
        tool: 'dcsc_workspace_get',
        arguments: {
            session: workspace.id,
            expectedRevision: workspace.revision,
            path,
            offset: 0,
            limit: 20,
        },
    });
    const pages = {
        diagnostics: { inspect: page(['cablingDiagnostics']) },
        rawConnections: { total: result.rawConnections.length, inspect: page(['rawConnections']) },
        messages: { total: result.messages.length, messageCount, inspect: page(['autoConnectMessages']) },
    };
    const connections = result.connections.map(connection => ({
        id: connection.id,
        fromId: connection.fromId,
        fromPort: connection.fromPort,
        toId: connection.toId,
        toPort: connection.toPort,
        cableCode: connection.cableCode,
        description: connection.description,
    }));
    const note = result.connections.length === 0
        ? 'DCSC returned no connections. Inspect pages.diagnostics and Lenovo messages before changing hardware.'
        : undefined;
    const full = {
        session: workspace.id,
        revision: workspace.revision,
        settings,
        connectionCount: result.connections.length,
        diagnostics,
        connections,
        messageGroupCount: result.messages.length,
        messageCount,
        messages: result.messages,
        pages,
        ...(note ? { note } : {}),
        next: 'Inspect pages.diagnostics for missing networks; dcsc_cabling_get lists the connections that dcsc_cabling_set can edit.',
    };
    if (jsonBytes(full) <= PAGE_BYTE_BUDGET)
        return full;
    const clip = (value) => value === undefined ? {} : value.length <= 160 ? { value } : { value: value.slice(0, 160), truncated: true };
    const compactConnections = result.connections.slice(0, 5).map((connection, index) => {
        const projected = { detail: page(['rawConnections', String(index)]) };
        for (const field of ['id', 'fromId', 'fromPort', 'toId', 'toPort', 'cableCode', 'description']) {
            const clipped = clip(connection[field]);
            if (clipped.value !== undefined)
                projected[field] = clipped.value;
            if (clipped.truncated)
                projected[`${field}Truncated`] = true;
        }
        return projected;
    });
    const compactMessages = result.messages.slice(0, 3).map((group, groupIndex) => {
        const rackId = clip(group.rackId);
        return {
            ...(rackId.value !== undefined ? { rackId: rackId.value } : {}),
            ...(rackId.truncated ? { rackIdTruncated: true } : {}),
            messageCount: group.messages.length,
            messages: group.messages.slice(0, 2).map((message, messageIndex) => {
                const clipped = clip(message);
                return clipped.truncated
                    ? { text: clipped.value, truncated: true,
                        detail: page(['autoConnectMessages', String(groupIndex), 'messages', String(messageIndex)]) }
                    : message;
            }),
            detail: page(['autoConnectMessages', String(groupIndex)]),
        };
    });
    const compact = {
        ...full,
        connections: compactConnections,
        connectionsReturned: compactConnections.length,
        messages: compactMessages,
        messageGroupsReturned: compactMessages.length,
        compacted: true,
    };
    while (jsonBytes(compact) > PAGE_BYTE_BUDGET && compactConnections.length > 0) {
        compactConnections.pop();
        compact['connectionsReturned'] = compactConnections.length;
    }
    while (jsonBytes(compact) > PAGE_BYTE_BUDGET && compactMessages.length > 0) {
        compactMessages.pop();
        compact['messageGroupsReturned'] = compactMessages.length;
    }
    if (jsonBytes(compact) > PAGE_BYTE_BUDGET) {
        throw new Error('Auto-connect result context exceeds the response budget. Inspect the workspace recovery snapshot.');
    }
    return compact;
}
const catalogDevice = `Catalog device ID, or ${EXISTING_CUSTOMER_SWITCH_ID} to clear it.`;
const clearable = 'Empty string clears it.';
const networkSelectionSchema = z.object({
    networkTypeId: z.string(), topology: z.string().optional(),
    layout: z.enum(['Centralized', 'Distributed']).optional(),
    mainDeviceId: z.string().optional().describe(catalogDevice),
    leafDeviceId: z.string().optional().describe(catalogDevice),
    mainTrunks: z.number().int().min(0).optional().describe('Bounded by the switch topology capacity.'),
    leafTrunks: z.number().int().min(0).optional(),
    leafCabling: z.string().optional().describe('Description from the leafNodeCabling collection.'),
    vlanNetworkTypeIds: z.array(z.string()).optional().describe('Peer networks sharing the main switch; [] clears the joins.'),
    customCableId: z.string().optional().describe('With an existing customer main switch; manual-cable clears the fixed cable.'),
    cableId: z.string().optional(), leafCableId: z.string().optional(),
    cableColor: z.string().optional().describe(clearable),
    leafCableColor: z.string().optional().describe(clearable),
});
const networkChangeSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('topology'),
        topology: z.string().describe('Topology shortName, e.g. "IB_XDR".'),
        networkName: z.string().optional().describe('Network name or ID; required when the topology does not identify one.'),
        connectorIds: z.array(z.string()).optional().describe('[] clears this network\'s ports.'),
        ports: z.array(z.string()).optional().describe('Exact port selectors; [] clears this network\'s ports.'),
        autoConnect: z.boolean().optional().default(true).describe('Run Auto-Connect afterwards when racks exist.'),
    }),
    z.object({ kind: z.literal('nodeRole'), role: z.string().describe('From the nodeRoles collection, e.g. "Compute".') }),
    z.object({
        kind: z.literal('preferences'),
        selections: z.array(networkSelectionSchema).min(1),
        autoConnect: z.boolean().optional().default(false).describe('Run Auto-Connect after saving.'),
    }),
]);
export function registerFabricPowerTools(server, service) {
    server.registerTool('dcsc_auto_connect', {
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        title: 'Auto-Connect',
        description: 'Runs Auto-Connect to generate the workspace cabling, optionally updating the Automated Rack PDU, Switch and P2P settings.',
        inputSchema: {
            session: z.string().describe('Workspace or configuration handle.'),
            expectedRevision: z.number().int().min(1).optional().describe('Workspace revision.'),
            settings: z.object({
                autoAddPDU: z.boolean().optional().describe('Automatically add rack PDUs.'),
                autoAddSwitch: z.boolean().optional().describe('Automatically add switches for the network preferences.'),
                p2pCabling: z.boolean().optional().describe('Enable point-to-point cabling.'),
            }).strict().optional().describe('Omitted fields keep the saved setting.'),
        },
    }, async (args) => guard(async () => {
        const result = await service.runAutoConnect(args.session, service.newCtx(), args.expectedRevision, args.settings);
        return projectAutoConnectToolResult(service.sessions.getWorkspace(args.session), result);
    }, 'dcsc_auto_connect failed'));
    server.registerTool('dcsc_network_get', {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        title: 'Network tab',
        description: 'Browses the network catalog (topologies, devices, network types, cables, node roles, storage controllers and switches) and the connectors of a topology.',
        inputSchema: {
            session: z.string().optional().describe('Workspace or configuration whose locale and solution apply.'),
            solutionMode: z.string().optional(),
            collection: z.enum(NETWORK_COLLECTIONS).default('topologies'),
            topology: z.string().optional().describe('shortName; required for connectors, which needs a configuration session.'),
            optionId: z.string().optional(),
            fields: z.array(z.string()).optional().describe('Top-level fields to return, plus id.'),
            offset: z.number().int().min(0).default(0),
            limit: z.number().int().min(1).max(100).default(20),
            path: z.array(z.string()).optional().describe('From a continuation.'),
            expectedCatalogFingerprint: z.string().optional().describe('From a continuation.'),
        },
    }, async (args) => guard(() => browseNetwork(service, {
        ...args, collection: args.collection ?? 'topologies', offset: args.offset ?? 0, limit: args.limit ?? 20,
    }), 'dcsc_network_get failed'));
    server.registerTool('dcsc_network_set', {
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        title: 'Set network topology, node role or preferences',
        description: 'Selects a topology and connectors, sets the node role (configuration handle), or saves network preferences (workspace handle).',
        inputSchema: {
            session: z.string().describe('Configuration handle (topology, nodeRole) or workspace handle (preferences).'),
            expectedRevision: z.number().int().min(1).optional().describe('Workspace revision.'),
            change: networkChangeSchema,
        },
    }, async (args) => guard(() => setNetwork(service, args.session, args.change, args.expectedRevision), 'dcsc_network_set failed'));
}
//# sourceMappingURL=fabricPowerTools.js.map