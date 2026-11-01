import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { applyStorageChange, inspectStorageNetworks } from '../app/storage.js';
import { STORAGE_LAYOUTS, STORAGE_TYPES } from '../domain/storagePreferences.js';
import { projectJsonPage } from '../model/pagedJson.js';
import type { DcscService } from './service.js';
import { guard } from './toolSupport.js';

const storageName = z.string().trim().min(1).max(200);

const definitionFields = {
  controllerId: z.string().optional().describe('Controller ID from dcsc_network_get; defaults to the first catalog controller.'),
  expansionId: z.string().optional(),
  expansionQuantity: z.number().int().min(0).optional(),
  switchId: z.string().optional().describe('SAN switch ID from dcsc_network_get, or direct-attached for none.'),
  type: z.enum(STORAGE_TYPES).optional(),
  layout: z.enum(STORAGE_LAYOUTS).optional(),
};

const storageChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), name: storageName, ...definitionFields }),
  z.object({
    action: z.literal('update'),
    name: storageName,
    changes: z.object({ ...definitionFields }).strict()
      .describe('The controller locks after customize, and the storage type locks while racked.'),
    autoConnect: z.boolean().optional().describe('Run Auto-Connect after the update.'),
  }),
  z.object({ action: z.literal('rename'), name: storageName, newName: storageName }),
  z.object({
    action: z.literal('remove'),
    name: storageName,
    clearAssignments: z.boolean().optional().describe('Required when configurations are assigned to this storage network.'),
  }),
  z.object({
    action: z.literal('assign'),
    networkName: storageName.nullable().describe('Storage network to assign to the configuration; null clears the assignment.'),
    autoConnect: z.boolean().optional().describe('Run Auto-Connect after the assignment.'),
  }),
  z.object({ action: z.literal('place'), name: storageName, rackId: z.string().trim().min(1).describe('Target rack ID.') }),
  z.object({
    action: z.literal('customize'),
    name: storageName,
    component: z.enum(['controller', 'switch']).describe('Opens the controller or SAN switch template for configuring.'),
  }),
]);

export function registerStorageTools(server: McpServer, service: DcscService): void {
  server.registerTool('dcsc_storage_get', {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: 'Storage networks',
    description: 'Reads the workspace storage network definitions, which configurations are assigned to them, and storage hardware left detached by edits.',
    inputSchema: {
      session: z.string().describe('Workspace handle.'),
      expectedRevision: z.number().int().min(1).optional().describe('Workspace revision; continuations carry it.'),
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
    description: 'Adds, updates, renames or removes a storage network definition, assigns one to a server configuration, places it in a rack, or opens its controller or SAN switch for customizing.',
    inputSchema: {
      session: z.string().describe('Workspace handle; a configuration handle for assign.'),
      expectedRevision: z.number().int().min(1).optional().describe('Workspace revision; required for update.'),
      change: storageChangeSchema,
    },
  }, args => guard(async () => {
    const result = await applyStorageChange(service, args.session, args.change, args.expectedRevision, service.newCtx());
    const retained = Array.isArray(result['retainedComponents']) && result['retainedComponents'].length > 0;
    return { ...result,
      ...(retained ? { retainedHardware: { tool: 'dcsc_storage_get', arguments: {
        session: result['workspace'], expectedRevision: result['revision'],
        path: ['detachedStorageComponents'], offset: 0, limit: 10 } } } : {}),
      ...(args.change.action === 'assign' && result['autoConnectRequired'] === true ? {
        next: { tool: 'dcsc_auto_connect', arguments: { session: result['workspace'] } },
        reason: 'The storage assignment is saved, but cables were not regenerated because autoConnect was not true.' } : {}),
      inspect: { tool: 'dcsc_storage_get', arguments: { session: result['workspace'], expectedRevision: result['revision'] } } };
  }, 'dcsc_storage_set failed'));
}
