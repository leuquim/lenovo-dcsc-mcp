import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { STORAGE_LAYOUTS, STORAGE_TYPES } from '../domain/storagePreferences.js';
import type { DcscService } from './service.js';
import { guard } from './toolSupport.js';

export function registerStorageTools(server: McpServer, service: DcscService): void {
  server.registerTool('dcsc_place_storage_network', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    title: 'Place a storage network in a rack',
    description: 'Places physical controller and SAN-switch instances for an existing HPC & AI storage definition into the target rack and connects the workspace. Disable Automated Rack PDU when no PDU preference is configured.',
    inputSchema: {
      session: z.string().describe('Workspace handle containing the storage definition and target rack.'),
      name: z.string().trim().min(1).max(200).describe('Exact storage definition name from dcsc_workspace_layout storageNetworks.'),
      rackId: z.string().trim().min(1).describe('Exact target rack ID from dcsc_workspace_layout.'),
      expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision for optimistic concurrency.'),
    },
  }, async args => guard(async () => {
    const result = await service.placeStorageNetwork(args.session, {
      name: args.name,
      rackId: args.rackId,
      expectedRevision: args.expectedRevision,
      ctx: service.newCtx(),
    });
    const placements = result.placements.map(({ raw: _raw, controllerExpansion: _expansion, ...placement }) => placement);
    return {
      ...result,
      placements,
      inspect: { tool: 'dcsc_workspace_layout', arguments: {
        session: result.workspace,
        expectedRevision: result.revision,
        path: ['rawRackArea'], offset: 0, limit: 20,
      } },
      export: { tool: 'dcsc_export', arguments: { session: result.workspace },
        purpose: 'Export the accepted physical storage placement and its commercial quantities.' },
    };
  }, 'dcsc_place_storage_network failed'));

  server.registerTool('dcsc_customize_storage_controller', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Open a storage network controller for customization',
    description: 'Opens the managed controller template for an existing storage definition (Storage > Edit Item). Reopening returns the existing configuration handle without resetting selections.',
    inputSchema: {
      session: z.string().describe('Workspace handle containing the storage definition.'),
      name: z.string().trim().min(1).max(200).describe('Exact storage definition name from dcsc_workspace_layout storageNetworks.'),
      expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision for optimistic concurrency.'),
    },
  }, async args => guard(async () => {
    const result = await service.openStorageController(args.session, {
      name: args.name,
      expectedRevision: args.expectedRevision,
      ctx: service.newCtx(),
    });
    return {
      ...result,
      inspect: { tool: 'dcsc_session_info', arguments: { session: result.session } },
      next: { tool: 'dcsc_list_options', arguments: { session: result.session },
        purpose: 'Browse the controller tabs, section IDs and feature codes before configuring it.' },
      configure: {
        tool: 'dcsc_configure', session: result.session,
        instruction: 'Pass one or more explicit changes from dcsc_list_options; each change needs a section, feature code and quantity.',
      },
    };
  }, 'dcsc_customize_storage_controller failed'));

  server.registerTool('dcsc_customize_storage_switch', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Open a storage network SAN switch for customization',
    description: 'Opens the managed SAN switch template for an existing storage definition (Storage > SAN Switch > Edit Item). Reopening returns the existing configuration handle without resetting selections.',
    inputSchema: {
      session: z.string().describe('Workspace handle containing the storage definition.'),
      name: z.string().trim().min(1).max(200).describe('Exact storage definition name from dcsc_workspace_layout storageNetworks.'),
      expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision for optimistic concurrency.'),
    },
  }, async args => guard(async () => {
    const result = await service.openStorageSwitch(args.session, {
      name: args.name,
      expectedRevision: args.expectedRevision,
      ctx: service.newCtx(),
    });
    return {
      ...result,
      inspect: { tool: 'dcsc_session_info', arguments: { session: result.session } },
      next: { tool: 'dcsc_list_options', arguments: { session: result.session },
        purpose: 'Browse the SAN switch tabs, section IDs and feature codes before configuring it.' },
      configure: {
        tool: 'dcsc_configure', session: result.session,
        instruction: 'Pass one or more explicit changes from dcsc_list_options; each change needs a section, feature code and quantity.',
      },
    };
  }, 'dcsc_customize_storage_switch failed'));

  server.registerTool('dcsc_assign_storage_network', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Assign a storage network to a server configuration',
    description: 'Assigns a storage network definition (or null to clear) to a server configuration and re-derives in workspace context. Set autoConnect=true to regenerate cables immediately.',
    inputSchema: {
      session: z.string().describe('Configuration handle from dcsc_session_list, not the workspace handle.'),
      networkName: z.string().trim().min(1).max(200).nullable(),
      autoConnect: z.boolean().optional().describe('Also run DCSC auto-connect after accepting the assignment. Defaults to false.'),
      expectedRevision: z.number().int().min(1).optional().describe('Expected configuration revision for optimistic concurrency.'),
    },
  }, async args => guard(async () => {
    const result = await service.assignStorageNetwork(args.session, {
      networkName: args.networkName,
      autoConnect: args.autoConnect,
      expectedRevision: args.expectedRevision,
      ctx: service.newCtx(),
    });
    return {
      ...result,
      inspect: { tool: 'dcsc_session_info', arguments: { session: result.session } },
      ...(result.autoConnectRequired ? {
        next: { tool: 'dcsc_add_cabling', arguments: { session: result.workspace, mode: 'auto' } },
        reason: 'The storage assignment is saved, but cables were not regenerated because autoConnect was not true.',
      } : {}),
    };
  }, 'dcsc_assign_storage_network failed'));

  server.registerTool('dcsc_edit_storage_network', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    title: 'Update, rename or remove a storage network definition',
    description: 'Edits an existing storage definition by name. update requires changes and expectedRevision (controller locks after Edit Item; storage type locks while racked). rename updates assignment references. remove requires clearAssignments=true when assigned.',
    inputSchema: {
      session: z.string(), action: z.enum(['rename', 'remove', 'update']), name: z.string().min(1),
      newName: z.string().trim().min(1).max(200).optional(), clearAssignments: z.boolean().optional(),
      changes: z.object({ controllerId: z.string().optional(), expansionId: z.string().optional(),
        expansionQuantity: z.number().int().min(0).optional(), switchId: z.string().optional(),
        type: z.enum(STORAGE_TYPES).optional(), layout: z.enum(STORAGE_LAYOUTS).optional(),
      }).strict().optional(), autoConnect: z.boolean().optional(),
      expectedRevision: z.number().int().min(1).optional(),
    },
  }, async args => guard(async () => {
    const { session, ...edit } = args;
    if (edit.action !== 'rename' && edit.newName !== undefined) throw new Error('newName applies only to rename.');
    if (edit.action !== 'remove' && edit.clearAssignments !== undefined) throw new Error('clearAssignments applies only to remove.');
    if (edit.action !== 'update' && (edit.changes !== undefined || edit.autoConnect !== undefined)) throw new Error('changes and autoConnect apply only to update.');
    if (edit.action === 'update' && (!edit.changes || edit.expectedRevision === undefined)) {
      throw new Error('Storage update requires changes and expectedRevision from dcsc_workspace_layout.');
    }
    const result = edit.action === 'update'
      ? await service.reconfigureStorageNetwork(session, { name: edit.name, changes: edit.changes!,
        expectedRevision: edit.expectedRevision!, autoConnect: edit.autoConnect, ctx: service.newCtx() })
      : await service.editStorageNetwork(session, { ...edit, action: edit.action });
    return { ...result,
      ...('retainedComponents' in result && result.retainedComponents.length > 0 ? {
        retainedHardware: { tool: 'dcsc_workspace_layout', arguments: {
          session: result.workspace, expectedRevision: result.revision,
          path: ['detachedStorageComponents'], offset: 0, limit: 10,
        } },
      } : {}),
      inspect: { tool: 'dcsc_workspace_layout', arguments: {
        session: result.workspace, expectedRevision: result.revision,
        path: ['storageNetworks'], offset: 0, limit: 20,
      } },
    };
  }, 'dcsc_edit_storage_network failed'));

  server.registerTool('dcsc_add_storage_network', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    title: 'Create an unassigned storage network definition',
    description: 'Creates a workspace storage network preference (Add Storage). Defaults to the first catalog controller; optionally pass controllerId and switchId from dcsc_fabric_options (or direct-attached to omit a switch).',
    inputSchema: {
      session: z.string(), name: z.string().trim().min(1).max(200),
      controllerId: z.string().optional(), expansionId: z.string().optional(),
      expansionQuantity: z.number().int().min(0).optional(), switchId: z.string().optional(),
      type: z.enum(STORAGE_TYPES).optional(), layout: z.enum(STORAGE_LAYOUTS).optional(),
      expectedRevision: z.number().int().min(1).optional(),
    },
  }, async args => guard(async () => {
    const { session, expectedRevision, ...input } = args;
    const result = await service.addStorageNetwork(session, {
      input, expectedRevision, ctx: service.newCtx(),
    });
    return { ...result,
      inspect: { tool: 'dcsc_workspace_layout', arguments: {
        session: result.workspace, expectedRevision: result.revision,
        path: ['storageNetworks'], offset: 0, limit: 20,
      } },
    };
  }, 'dcsc_add_storage_network failed'));
}
