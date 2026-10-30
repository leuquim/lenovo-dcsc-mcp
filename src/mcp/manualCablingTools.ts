import type { NativeManualConnectionRequest } from '../domain/nativeManualCabling.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { ManualCablingCatalog, ManualConnectionEdit, ManualConnectionView } from '../domain/manualCabling.js';
import { toToolError } from '../http/errors.js';
import type { RequestCtx } from '../http/request.js';
import { projectJsonPage } from '../model/pagedJson.js';

export interface ManualCablingInspection {
  workspace: string;
  revision: number;
  report: ManualCablingCatalog;
}

export interface ManualCablingEditResult {
  pinnedConnectionCount?: number;
  sourceConfigurationIds?: string[];
  destinationConfigurationIds?: string[];
  additionalConnectionCount?: number;
  workspace: string;
  revision: number;
  connection: ManualConnectionView;
  swappedConnections?: ManualConnectionView[] | undefined;
  updatedConnections?: ManualConnectionView[] | undefined;
  configurationChange?: {
    session: string;
    configurationId: string;
    previousTotalPrice?: number | null | undefined;
    totalPrice?: number | null | undefined;
    priceDelta?: number | null | undefined;
    currency?: string | undefined;
    priceScope?: 'editable-configuration' | undefined;
  } | undefined;
}

/** Thin service contract: DcscService owns transaction, HTTP and derive orchestration. */
export interface ManualCablingService {
  newCtx(): RequestCtx;
  inspectNativeManualCabling(session: string, input: Omit<NativeManualConnectionRequest, 'cablePart'> & {
    expectedRevision: number; ctx: RequestCtx;
  }): Promise<{ workspace: string; revision: number; report: unknown }>;
  createNativeManualCabling(session: string, input: NativeManualConnectionRequest & {
    expectedRevision: number; ctx: RequestCtx;
  }): Promise<ManualCablingEditResult>;
  inspectManualCabling(session: string, expectedWorkspaceRevision?: number):
    ManualCablingInspection | Promise<ManualCablingInspection>;
  inspectManualCableChoices(session: string, connectionId: string, expectedWorkspaceRevision: number | undefined, ctx: RequestCtx): Promise<ManualCablingInspection>;
  editManualCabling(session: string, input: ManualConnectionEdit & {
    expectedRevision: number;
    ctx: RequestCtx;
  }): Promise<ManualCablingEditResult>;
}

const endpointSchema = z.object({
  configurationId: z.string().min(1).describe('Physical endpoint ID returned by dcsc_cabling_connections.'),
  portName: z.string().min(1),
  portNumber: z.string().min(1),
}).strict();

export function registerManualCablingTools(server: McpServer, service: ManualCablingService): void {
  const createFields = {
    session: z.string(), network: z.string().min(1), topology: z.string().min(1),
    source: endpointSchema, destination: endpointSchema,
    connectionType: z.enum(['point-to-point', 'breakout-4']).optional().describe('Use breakout-4 for one 25GbE SFP28 branch of a 100GbE QSFP28 DAC breakout. Up to four matching branches may share its destination port.'),
    expectedRevision: z.number().int().min(1).describe('Workspace revision from dcsc_cabling_connections.'),
  };
  server.registerTool('dcsc_manual_cabling_options', {
    title: 'Find cables for a new native connection',
    description: 'Choose physical ports from dcsc_cabling_connections and an assigned source network/topology. For storage, explicitly configure compatible controller hardware, assign the storage network with dcsc_assign_storage_network, then select source ports with dcsc_set_topology using that exact network name. Intersects native distance choices with Lenovo catalog topology and the requested connection shape, then lists parts with required BOM quantities. Use connectionType=breakout-4 to discover four-way 100G QSFP28 to 25G SFP28 DAC branches, including a matching partially occupied destination. Read-only; use the returned revision with dcsc_create_cabling_connection. Follow paging continuations unchanged.',
    inputSchema: { ...createFields, path: z.array(z.string()).optional().default([]),
      offset: z.number().int().min(0).optional().default(0), limit: z.number().int().min(1).max(1000).optional().default(20) },
  }, async args => {
    try {
      const { session, path, offset, limit, ...request } = args;
      const result = await service.inspectNativeManualCabling(session, { ...request, ctx: service.newCtx() });
      const page = projectJsonPage(result.report, { tool: 'dcsc_manual_cabling_options',
        arguments: { session, ...request, expectedRevision: result.revision }, path, offset, limit });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ workspace: result.workspace,
        workspaceRevision: result.revision, revisionScope: 'workspace', ...page }) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error)) }] };
    }
  });
  server.registerTool('dcsc_create_cabling_connection', {
    title: 'Create a native manual cable connection',
    description: 'Creates a native MANUAL connection between compatible placed ports and adds its cable to the BOM atomically. First inspect dcsc_manual_cabling_options. Revalidates catalog topology, cable shape and available port capacity. Preserves existing connections and selected cable quantities; rejects silent native regeneration. Set pinExistingRoutes=true to mark existing AUTO network rows MANUAL and preserve their routes; returns the count converted. Requires assigned source network and CTO hardware. Source port selections are shared across linked configurations; native Auto-Connect can add sibling routes, reported in additionalConnectionCount. Inspect sourceConfigurationIds and destinationConfigurationIds before creating. Linked destinations select the same per-member cable quantity across the group, covering the busiest member and retaining spares; all members must be placed. Managed physical endpoint IDs resolve selections through their owning template. DB710S Management sources and DE2000H 10GbE copper destinations, including fresh controller setup and placement, have verified lifecycle coverage; two shared DE2000H instances are verified with one route and two selected DACs per instance; demand growth beyond existing spares remains unverified. connectionType=breakout-4 creates one SFP28 branch of a four-way 100G QSFP28 DAC breakout, sharing cable quantity across matching branches; other splitter shapes remain unsupported. DCSC website reimport currently loses breakout shape; MCP import restores supported saved shapes from the original CFXML. Verified for Management, including linked SN2201 destinations, 10 GbE copper storage and 100 GbE copper, including linked sources; other protocols remain unverified. This differs from local-only dcsc_add_cabling manual planning.',
    inputSchema: { ...createFields, pinExistingRoutes: z.boolean().optional().default(false).describe('Convert existing AUTO network rows to MANUAL to preserve their exact routes. Inspect pinnableConnectionCount first; committed count is returned.'), cablePart: z.string().min(1).describe('Exact part returned by dcsc_manual_cabling_options.') },
  }, async args => {
    try {
      const { session, ...request } = args;
      const result = await service.createNativeManualCabling(session, { ...request, ctx: service.newCtx() });
      const { compatibleCables: _choices, ...connection } = result.connection;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ workspace: result.workspace,
        workspaceRevision: result.revision, revisionScope: 'workspace', connection, pinnedConnectionCount: result.pinnedConnectionCount ?? 0,
        sourceConfigurationIds: result.sourceConfigurationIds, destinationConfigurationIds: result.destinationConfigurationIds, additionalConnectionCount: result.additionalConnectionCount ?? 0,
        inspect: { tool: 'dcsc_cabling_connections', arguments: { session: result.workspace,
          expectedWorkspaceRevision: result.revision, path: ['connections'], offset: 0, limit: 20 } } }) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error)) }] };
    }
  });

  server.registerTool('dcsc_cabling_connections', {
    title: 'Inspect editable DCSC cable connections',
    description: 'Lists the authoritative current connection graph, stable row IDs, physical endpoint/port choices and compatible cable parts. Use refreshConnectionId with expectedWorkspaceRevision to fetch missing imported cable choices without changing the design. Follow returned continuations unchanged. Use these ports with dcsc_manual_cabling_options for creation, or row IDs with dcsc_edit_cabling_connection; it does not create or delete rows.',
    inputSchema: {
      session: z.string().describe('Workspace or configuration handle.'),
      refreshConnectionId: z.string().min(1).optional().describe('Fetch current compatible cables for this existing connection without changing the design. Requires expectedWorkspaceRevision; useful after import omitted saved cable choices.'),
      expectedWorkspaceRevision: z.number().int().min(1).optional()
        .describe('Optional read guard. A mismatch rejects stale navigation.'),
      path: z.array(z.string()).optional().default([]),
      offset: z.number().int().min(0).optional().default(0),
      limit: z.number().int().min(1).max(1000).optional().default(20),
    },
  }, async args => {
    try {
      const snapshot = args.refreshConnectionId
        ? await service.inspectManualCableChoices(args.session, args.refreshConnectionId, args.expectedWorkspaceRevision, service.newCtx())
        : await service.inspectManualCabling(args.session, args.expectedWorkspaceRevision);
      const page = projectJsonPage(snapshot.report, {
        tool: 'dcsc_cabling_connections',
        arguments: { session: args.session, expectedWorkspaceRevision: snapshot.revision,
          ...(args.refreshConnectionId ? { refreshConnectionId: args.refreshConnectionId } : {}) },
        path: args.path, offset: args.offset, limit: args.limit,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        workspace: snapshot.workspace, workspaceRevision: snapshot.revision,
        revisionScope: 'workspace', ...page,
      }, null, 2) }] };
    } catch (error) {
      return { isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error), null, 2) }] };
    }
  });

  server.registerTool('dcsc_edit_cabling_connection', {
    title: 'Edit one existing DCSC cable connection',
    description: 'Edits the source, destination, or compatible cable part of one authoritative existing connection row selected by the stable ID from dcsc_cabling_connections. Endpoint values and cablePart must be exact identifiers from that inspection. Selecting an occupied destination port on the same component swaps the other connection to the original port; same-component source swaps also support matching connector names, assigned network and topology. Both accepted rows are returned. A cable-part replacement runs its coupled hardware-selection derive before the complete accepted graph commits atomically. Replacing a supported four-way breakout cable updates all branches sharing its destination port and reports additional updatedConnections. Edit endpoints and cablePart in separate revision-bound calls. The website exposes Edit for existing rows; this tool does not claim Add/Delete semantics.',
    inputSchema: {
      session: z.string().describe('Workspace or configuration handle.'),
      connectionId: z.string().regex(/^connection_[0-9a-f]{20}$/),
      source: endpointSchema.optional(),
      destination: endpointSchema.optional(),
      cablePart: z.string().min(1).optional()
        .describe('Exact compatibleCables[].part value returned for this row.'),
      cableQuantities: z.object({ oldPart: z.number().int().min(0), newPart: z.number().int().min(1) }).optional()
        .describe('Optional per-product quantities after replacement, including spares. Apply across linked/shared destinations. Use for native pair or pack requirements; quantities must cover every remaining route.'),
      expectedRevision: z.number().int().min(1)
        .describe('Required workspace revision returned by dcsc_cabling_connections.'),
    },
  }, async args => {
    try {
      if (!args.source && !args.destination && !args.cablePart) {
        throw new Error('Supply a source, destination or cable-part change.');
      }
      const result = await service.editManualCabling(args.session, {
        connectionId: args.connectionId,
        ...(args.source ? { source: args.source } : {}),
        ...(args.destination ? { destination: args.destination } : {}),
        ...(args.cablePart ? { cablePart: args.cablePart } : {}),
        ...(args.cableQuantities ? { cableQuantities: args.cableQuantities } : {}),
        expectedRevision: args.expectedRevision,
        ctx: service.newCtx(),
      });
      // Compatible choices can contain dozens of opaque upstream records.
      // Mutation output carries the accepted row identity/state; callers use
      // the bounded inspection continuation to retrieve choices.
      const { compatibleCables: _compatibleCables, ...connection } = result.connection;
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        workspace: result.workspace,
        workspaceRevision: result.revision,
        revisionScope: 'workspace',
        connection,
        ...(result.swappedConnections?.length ? {
          swappedConnections: result.swappedConnections.map(({ compatibleCables: _choices, ...row }) => row),
        } : {}),
        ...(result.updatedConnections?.length ? { updatedConnections: result.updatedConnections.map(({ compatibleCables: _choices, ...row }) => row) } : {}),
        ...(result.configurationChange ? { configurationChange: result.configurationChange } : {}),
        inspect: { tool: 'dcsc_cabling_connections', arguments: {
          session: result.workspace,
          expectedWorkspaceRevision: result.revision,
          path: ['connections'], offset: 0, limit: 20,
        } },
      }, null, 2) }] };
    } catch (error) {
      return { isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error), null, 2) }] };
    }
  });
}
