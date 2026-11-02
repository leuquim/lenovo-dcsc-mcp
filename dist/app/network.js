import { invalidateConnectionGraph } from '../domain/cabling.js';
import { listNetworkLeafCablingChoices, listTopologyConnectors } from '../domain/networkPreferences.js';
import { listStorageExpansions } from '../domain/storagePreferences.js';
import { workspaceNetworkTypes } from '../domain/workspaceNetworkPreferences.js';
import { projectCatalogPage } from '../model/catalogPage.js';
import { applyTopology } from './cabling.js';
import { workspaceId } from './runtime.js';
import { setNetworkPreferences } from './storage.js';
export const NETWORK_COLLECTIONS = ['topologies', 'networkDevices', 'networkTypes', 'cables', 'selectedServices',
    'nodeRoles', 'storageSwitches', 'storageControllers', 'leafNodeCabling', 'connectors'];
/** The one configuration a handle designates; a workspace handle qualifies only when it holds exactly one. */
export function requireSingleConfiguration(rt, handle) {
    const resolved = rt.sessions.resolveHandle(handle);
    if (!resolved)
        throw new Error(`No such session: ${handle}. Use dcsc_session_list to see open sessions.`);
    if (resolved.kind === 'configuration')
        return resolved.session;
    const sessions = [...resolved.workspace.configurations.values()];
    if (sessions.length === 1)
        return sessions[0];
    throw new Error(`Workspace ${handle} contains ${sessions.length} configurations, so the target is ambiguous. ` +
        `Pass one configuration session ID: ${sessions.map(session => session.id).join(', ')}.`);
}
export async function browseNetwork(rt, query) {
    const workspace = query.session ? rt.sessions.getWorkspace(query.session) : undefined;
    if (query.session && !workspace)
        throw new Error(`Session ${query.session} not found. Use dcsc_session_list to see open sessions.`);
    const ctx = rt.newCtx(workspace ? { locale: workspace.locale, solution: workspace.solution } : {});
    const solution = workspace?.solution ?? await rt.resolveSolution(ctx, query.solutionMode);
    const catalog = await rt.fabricOptions(ctx, solution);
    const fabric = { ...catalog, leafNodeCabling: listNetworkLeafCablingChoices(catalog),
        ...(workspace ? { networkTypes: workspaceNetworkTypes(catalog, workspace.serverState) } : {}) };
    let all;
    if (query.collection === 'connectors') {
        if (!query.session || !query.topology)
            throw new Error('The connectors collection requires session and topology.');
        all = listTopologyConnectors(requireSingleConfiguration(rt, query.session).raw, catalog, query.topology)
            .map(({ raw: _raw, ...choice }) => ({ ...choice }));
    }
    else if (query.collection === 'storageControllers') {
        all = fabric.storageControllers.map(controller => ({ ...controller,
            expansions: listStorageExpansions(controller).map(({ raw, ...choice }) => ({ ...raw, ...choice })) }));
    }
    else {
        all = (fabric[query.collection] ?? []);
    }
    const selected = query.optionId ? all.filter(item => item.id === query.optionId) : all;
    if (query.optionId && selected.length === 0)
        throw new Error('Unknown optionId in this network collection.');
    const items = selected.map(item => query.fields
        ? Object.fromEntries(Object.entries(item).filter(([key]) => key === 'id' || query.fields.includes(key)))
        : { ...item });
    return projectCatalogPage({
        tool: 'dcsc_network_get', collection: 'items', context: ctx.locale,
        arguments: { session: query.session, solutionMode: solution.solutionMode, collection: query.collection,
            topology: query.topology, optionId: query.optionId, fields: query.fields },
        offset: query.optionId && query.path === undefined ? 0 : query.offset, limit: query.limit, path: query.path,
        expectedCatalogFingerprint: query.expectedCatalogFingerprint, items,
        base: { ...(query.session ? { session: query.session } : {}),
            ...(workspace ? { revision: workspace.revision } : {}),
            solutionMode: solution.solutionMode, currency: ctx.locale.currency,
            collection: query.collection, total: all.length, offset: query.offset, limit: query.limit,
            collections: Object.fromEntries(Object.entries(fabric).map(([key, values]) => [key, values?.length ?? 0])) },
    });
}
async function setNodeRole(rt, session, role, expectedRevision) {
    const ctx = rt.newCtx({ locale: session.locale, solution: session.solution });
    const roles = await rt.fabricOptions(ctx, session.solution);
    const match = roles.nodeRoles.find(candidate => candidate.role.toLowerCase() === role.toLowerCase());
    if (!match) {
        throw new Error(`Unknown node role "${role}". Valid roles: ${roles.nodeRoles.map(candidate => candidate.role).join(', ')}.`);
    }
    await rt.sessions.transact(workspaceId(rt, session.id), { expectedRevision }, (workspace) => {
        const draft = workspace.configurations.get(session.id);
        if (!draft)
            throw new Error(`Configuration session ${session.id} no longer exists.`);
        if (draft.raw.nodeRole !== match.role) {
            invalidateConnectionGraph(workspace.serverState, 'Node role changed. Regenerate connections.');
        }
        draft.raw.nodeRole = match.role;
    });
    return { nodeRole: match.role };
}
/** Applies one Network-tab change and reports the new workspace revision and whether cables need regenerating. */
export async function setNetwork(rt, handle, change, expectedRevision) {
    let outcome;
    if (change.kind === 'preferences') {
        const workspace = rt.sessions.getWorkspace(handle);
        if (!workspace)
            throw new Error(`Workspace ${handle} not found. Use dcsc_session_list to see open sessions.`);
        const { workspace: _workspace, revision: _revision, ...result } = await setNetworkPreferences(rt, handle, {
            selections: change.selections, expectedRevision, autoConnect: change.autoConnect ?? false,
            ctx: rt.newCtx({ locale: workspace.locale, solution: workspace.solution })
        });
        outcome = result;
    }
    else {
        const session = requireSingleConfiguration(rt, handle);
        if (change.kind === 'nodeRole') {
            outcome = await setNodeRole(rt, session, change.role, expectedRevision);
        }
        else {
            const result = await applyTopology(rt, { sessionHandle: session.id, topology: change.topology,
                networkName: change.networkName, connectorIds: change.connectorIds, ports: change.ports,
                expectedRevision, autoConnect: change.autoConnect ?? true,
                ctx: rt.newCtx({ locale: session.locale, solution: session.solution }) });
            outcome = { topology: result.topology, selectedTopologies: result.selectedTopologies,
                ...(result.autoConnect ? { autoConnect: { connectionCount: result.autoConnect.connections.length,
                        messages: result.autoConnect.messages } } : {}) };
        }
    }
    const workspace = rt.sessions.getWorkspace(handle);
    const connectionGraphStale = workspace.serverState.connectionGraphInvalidation !== undefined;
    return { session: handle, revision: workspace.revision, ...outcome, connectionGraphStale,
        ...(connectionGraphStale ? { regenerateConnections: { tool: 'dcsc_auto_connect',
                arguments: { session: handle, expectedRevision: workspace.revision } } } : {}) };
}
//# sourceMappingURL=network.js.map