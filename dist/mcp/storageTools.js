import { z } from 'zod';
import { applyStorageChange, inspectStorageNetworks } from '../app/storage.js';
import { STORAGE_LAYOUTS, STORAGE_TYPES } from '../domain/storagePreferences.js';
import { projectJsonPage } from '../model/pagedJson.js';
import { guard } from './toolSupport.js';
const storageName = z.string().trim().min(1).max(200);
const definitionFields = {
    controllerId: z.string().optional().describe('From dcsc_network_get; defaults to the first catalog controller.'),
    expansionId: z.string().optional(),
    expansionQuantity: z.number().int().min(0).optional(),
    switchId: z.string().optional().describe('SAN switch ID from dcsc_network_get, or direct-attached for none.'),
    type: z.enum(STORAGE_TYPES).optional(),
    layout: z.enum(STORAGE_LAYOUTS).optional(),
};
const named = { name: storageName };
const autoConnect = z.boolean().optional().describe('Run Auto-Connect afterwards.');
const storageChangeSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('add'), ...named, ...definitionFields }),
    z.object({
        action: z.literal('update'), ...named, autoConnect,
        changes: z.object({ ...definitionFields }).strict().describe('The controller locks after customize; the type locks while racked.'),
    }),
    z.object({ action: z.literal('rename'), ...named, newName: storageName }),
    z.object({
        action: z.literal('remove'), ...named,
        clearAssignments: z.boolean().optional().describe('Required when configurations are assigned.'),
    }),
    z.object({
        action: z.literal('assign'), autoConnect,
        networkName: storageName.nullable().describe('Storage network for the configuration; null clears it.'),
    }),
    z.object({ action: z.literal('place'), ...named, rackId: z.string().trim().min(1) }),
    z.object({ action: z.literal('customize'), ...named, component: z.enum(['controller', 'switch']) }),
]);
export function registerStorageTools(server, service) {
    server.registerTool('dcsc_storage_get', {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        title: 'Storage networks',
        description: 'Reads the storage network definitions, their assigned configurations and detached storage hardware.',
        inputSchema: {
            session: z.string().describe('Workspace handle.'),
            expectedRevision: z.number().int().min(1).optional().describe('Workspace revision.'),
            path: z.array(z.string()).default([]),
            offset: z.number().int().min(0).default(0),
            limit: z.number().int().min(1).max(100).default(20),
        },
    }, args => guard(async () => {
        const snapshot = inspectStorageNetworks(service, args.session, args.expectedRevision);
        return { session: args.session, revision: snapshot.revision,
            ...projectJsonPage(snapshot.report, { tool: 'dcsc_storage_get',
                arguments: { session: args.session, expectedRevision: snapshot.revision },
                path: args.path ?? [], offset: args.offset ?? 0, limit: args.limit ?? 20 }) };
    }, 'dcsc_storage_get failed'));
    server.registerTool('dcsc_storage_set', {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        title: 'Edit storage networks',
        description: 'Adds, updates, renames, removes, assigns, places or customizes (controller or SAN switch) a storage network.',
        inputSchema: {
            session: z.string().describe('Workspace handle; configuration handle for assign.'),
            expectedRevision: z.number().int().min(1).optional().describe('Workspace revision; required for update.'),
            change: storageChangeSchema,
        },
    }, args => guard(async () => {
        const result = await applyStorageChange(service, args.session, args.change, args.expectedRevision, service.newCtx());
        const retained = Array.isArray(result['retainedComponents']) && result['retainedComponents'].length > 0;
        return { ...result,
            ...(retained ? { retainedHardware: { tool: 'dcsc_storage_get', arguments: {
                        session: result['workspace'], expectedRevision: result['revision'],
                        path: ['detachedStorageComponents'], offset: 0, limit: 10
                    } } } : {}),
            ...(args.change.action === 'assign' && result['autoConnectRequired'] === true ? {
                next: { tool: 'dcsc_auto_connect', arguments: { session: result['workspace'] } },
                reason: 'The storage assignment is saved, but cables were not regenerated because autoConnect was not true.'
            } : {}),
            inspect: args.change.action === 'place'
                ? { tool: 'dcsc_workspace_get', arguments: { session: result['workspace'], view: 'layout', path: ['rawRackArea'],
                        expectedRevision: result['revision'], offset: 0, limit: 20 } }
                : { tool: 'dcsc_storage_get', arguments: { session: result['workspace'], expectedRevision: result['revision'] } } };
    }, 'dcsc_storage_set failed'));
}
//# sourceMappingURL=storageTools.js.map