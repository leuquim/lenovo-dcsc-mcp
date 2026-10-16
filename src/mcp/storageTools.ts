import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { STORAGE_LAYOUTS, STORAGE_TYPES } from '../domain/storagePreferences.js';
import { toToolError } from '../http/errors.js';
import type { DcscService } from './service.js';

export function registerStorageTools(server: McpServer, service: DcscService): void {
  server.registerTool('dcsc_place_storage_network', {
    title: 'Place a storage network in a rack',
    description: 'Performs the website rack + Storage Network action for one existing HPC and AI storage definition. It creates fresh physical controller and SAN-switch instances from their managed templates, places them in the selected rack, and lets DCSC arrange and connect the full workspace. Use the exact storage definition name and rack ID from dcsc_workspace_layout. Automated Rack PDU must be disabled when no PDU preference is configured.',
    inputSchema: {
      session: z.string().describe('Workspace handle containing the storage definition and target rack.'),
      name: z.string().trim().min(1).max(200).describe('Exact storage definition name from dcsc_workspace_layout storageNetworks.'),
      rackId: z.string().trim().min(1).describe('Exact target rack ID from dcsc_workspace_layout.'),
      expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision for optimistic concurrency.'),
    },
  }, async args => {
    try {
      const result = await service.placeStorageNetwork(args.session, {
        name: args.name,
        rackId: args.rackId,
        expectedRevision: args.expectedRevision,
        ctx: service.newCtx(),
      });
      const placements = result.placements.map(({ raw: _raw, controllerExpansion: _expansion, ...placement }) => placement);
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        ...result,
        placements,
        inspect: { tool: 'dcsc_workspace_layout', arguments: {
          session: result.workspace,
          expectedWorkspaceRevision: result.revision,
          path: ['rawRackArea'], offset: 0, limit: 20,
        } },
        export: { tool: 'dcsc_export', arguments: { session: result.workspace },
          purpose: 'Export the accepted physical storage placement and its commercial quantities.' },
      }, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error), null, 2) }] };
    }
  });

  server.registerTool('dcsc_customize_storage_controller', {
    title: 'Open a storage network controller for customization',
    description: 'Performs the website Storage > Edit Item action for one existing storage definition. The controller remains managed through storageConnectionNetworks and is not synthesized as a rack or non-rack item. A new controller is launched, assigned a stable configuration identity and validated with the full workspace layout; reopening returns the existing configuration handle without resetting its selections.',
    inputSchema: {
      session: z.string().describe('Workspace handle containing the storage definition.'),
      name: z.string().trim().min(1).max(200).describe('Exact storage definition name from dcsc_workspace_layout storageNetworks.'),
      expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision for optimistic concurrency.'),
    },
  }, async args => {
    try {
      const result = await service.openStorageController(args.session, {
        name: args.name,
        expectedRevision: args.expectedRevision,
        ctx: service.newCtx(),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        ...result,
        inspect: { tool: 'dcsc_session_info', arguments: { session: result.session } },
        next: { tool: 'dcsc_list_options', arguments: { session: result.session },
          purpose: 'Browse the controller tabs, section IDs and feature codes before configuring it.' },
        configure: {
          tool: 'dcsc_configure', session: result.session,
          instruction: 'Pass one or more explicit changes from dcsc_list_options; each change needs a section, feature code and quantity.',
        },
      }, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error), null, 2) }] };
    }
  });

  server.registerTool('dcsc_customize_storage_switch', {
    title: 'Open a storage network SAN switch for customization',
    description: 'Performs the website Storage > SAN Switch > Edit Item action for one existing storage definition. The switch remains managed through storageConnectionNetworks and is not synthesized as a rack or non-rack item or added to switchMap. A new switch is launched, assigned a stable configuration identity and validated with the full workspace layout; reopening returns the existing configuration handle without resetting its selections.',
    inputSchema: {
      session: z.string().describe('Workspace handle containing the storage definition.'),
      name: z.string().trim().min(1).max(200).describe('Exact storage definition name from dcsc_workspace_layout storageNetworks.'),
      expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision for optimistic concurrency.'),
    },
  }, async args => {
    try {
      const result = await service.openStorageSwitch(args.session, {
        name: args.name,
        expectedRevision: args.expectedRevision,
        ctx: service.newCtx(),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        ...result,
        inspect: { tool: 'dcsc_session_info', arguments: { session: result.session } },
        next: { tool: 'dcsc_list_options', arguments: { session: result.session },
          purpose: 'Browse the SAN switch tabs, section IDs and feature codes before configuring it.' },
        configure: {
          tool: 'dcsc_configure', session: result.session,
          instruction: 'Pass one or more explicit changes from dcsc_list_options; each change needs a section, feature code and quantity.',
        },
      }, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error), null, 2) }] };
    }
  });

  server.registerTool('dcsc_assign_storage_network', {
    title: 'Assign a storage network to a server configuration',
    description: 'Applies the website Configuration > Network > Manage storage networks selection to one configuration handle. Use an exact name from dcsc_workspace_layout storageNetworks, or null for No storage networking. DCSC re-derives the selected server in full workspace context and the result is saved atomically. Cable generation is explicit: autoConnect defaults to false; when omitted, follow the returned dcsc_add_cabling continuation.',
    inputSchema: {
      session: z.string().describe('Configuration handle from dcsc_session_list, not the workspace handle.'),
      networkName: z.string().trim().min(1).max(200).nullable(),
      autoConnect: z.boolean().optional().describe('Also run DCSC auto-connect after accepting the assignment. Defaults to false.'),
      expectedRevision: z.number().int().min(1).optional().describe('Expected configuration revision for optimistic concurrency.'),
    },
  }, async args => {
    try {
      const result = await service.assignStorageNetwork(args.session, {
        networkName: args.networkName,
        autoConnect: args.autoConnect,
        expectedRevision: args.expectedRevision,
        ctx: service.newCtx(),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        ...result,
        inspect: { tool: 'dcsc_session_info', arguments: { session: result.session } },
        ...(result.autoConnectRequired ? {
          next: { tool: 'dcsc_add_cabling', arguments: { session: result.workspace, mode: 'auto' } },
          reason: 'The storage assignment is saved, but cables were not regenerated because autoConnect was not true.',
        } : {}),
      }, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error), null, 2) }] };
    }
  });

  server.registerTool('dcsc_edit_storage_network', {
    title: 'Update, rename or remove a storage network definition',
    description: 'Edits an existing definition by its exact current name from dcsc_workspace_layout storageNetworks. Update accepts preference changes using current fabric catalog IDs and requires expectedRevision. Controller choice locks after Edit Item; storage type locks while controllers are racked. Replacing a SAN switch retains its configured hardware and physical placements, counting each physical unit once. Update marks existing cables stale unless autoConnect=true successfully regenerates them. Rename preserves fields and updates assignment references. Removing an assigned definition requires clearAssignments=true and deletes exclusively owned managed components. All edits save atomically and support workspace undo.',
    inputSchema: {
      session: z.string(), action: z.enum(['rename', 'remove', 'update']), name: z.string().min(1),
      newName: z.string().trim().min(1).max(200).optional(), clearAssignments: z.boolean().optional(),
      changes: z.object({ controllerId: z.string().optional(), expansionId: z.string().optional(),
        expansionQuantity: z.number().int().min(0).optional(), switchId: z.string().optional(),
        type: z.enum(STORAGE_TYPES).optional(), layout: z.enum(STORAGE_LAYOUTS).optional(),
      }).strict().optional(), autoConnect: z.boolean().optional(),
      expectedRevision: z.number().int().min(1).optional(),
    },
  }, async args => {
    try {
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
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result,
        ...('retainedComponents' in result && result.retainedComponents.length > 0 ? {
          retainedHardware: { tool: 'dcsc_workspace_layout', arguments: {
            session: result.workspace, expectedWorkspaceRevision: result.revision,
            path: ['detachedStorageComponents'], offset: 0, limit: 10,
          } },
        } : {}),
        inspect: { tool: 'dcsc_workspace_layout', arguments: {
          session: result.workspace, expectedWorkspaceRevision: result.revision,
          path: ['storageNetworks'], offset: 0, limit: 20,
        } },
      }, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error), null, 2) }] };
    }
  });

  server.registerTool('dcsc_add_storage_network', {
    title: 'Create an unassigned storage network definition',
    description: 'Creates the workspace preference used by the website Add Storage action. Only a unique name is needed; the default controller is the first catalog choice, as on the website. Optionally choose controllerId and switchId from dcsc_fabric_options; use direct-attached to omit a switch. This saves a definition without purchasing hardware, assigning nodes or generating cables. Inspect saved definitions through the returned workspace-layout continuation.',
    inputSchema: {
      session: z.string(), name: z.string().trim().min(1).max(200),
      controllerId: z.string().optional(), expansionId: z.string().optional(),
      expansionQuantity: z.number().int().min(0).optional(), switchId: z.string().optional(),
      type: z.enum(STORAGE_TYPES).optional(), layout: z.enum(STORAGE_LAYOUTS).optional(),
      expectedRevision: z.number().int().min(1).optional(),
    },
  }, async args => {
    try {
      const { session, expectedRevision, ...input } = args;
      const result = await service.addStorageNetwork(session, {
        input, expectedRevision, ctx: service.newCtx(),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result,
        inspect: { tool: 'dcsc_workspace_layout', arguments: {
          session: result.workspace, expectedWorkspaceRevision: result.revision,
          path: ['storageNetworks'], offset: 0, limit: 20,
        } },
      }, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error), null, 2) }] };
    }
  });
}
