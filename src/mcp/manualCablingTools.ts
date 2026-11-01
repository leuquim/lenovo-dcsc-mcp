import type { NativeManualConnectionRequest } from '../domain/nativeManualCabling.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { ManualCablingCatalog, ManualConnectionEdit, ManualConnectionView } from '../domain/manualCabling.js';
import type { RequestCtx } from '../http/request.js';
import { projectJsonPage } from '../model/pagedJson.js';
import { guard } from './toolSupport.js';

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
  inspectManualCabling(session: string, expectedRevision?: number):
    ManualCablingInspection | Promise<ManualCablingInspection>;
  inspectManualCableChoices(session: string, connectionId: string, expectedRevision: number | undefined, ctx: RequestCtx): Promise<ManualCablingInspection>;
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
    connectionType: z.enum(['point-to-point', 'breakout-4']).optional().describe('Use breakout-4 for one 25GbE SFP28 branch of a 100GbE QSFP28 DAC breakout.'),
    expectedRevision: z.number().int().min(1).describe('Workspace revision from dcsc_cabling_connections.'),
  };
  server.registerTool('dcsc_manual_cabling_options', {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Find cables for a new native connection',
    description: 'Discovers compatible cable parts and BOM quantities for a new connection between physical ports from dcsc_cabling_connections. Requires an assigned source network/topology (for storage, assign with dcsc_assign_storage_network and select ports with dcsc_set_topology first). Read-only; pass the returned revision to dcsc_create_cabling_connection.',
    inputSchema: { ...createFields, path: z.array(z.string()).optional().default([]),
      offset: z.number().int().min(0).optional().default(0), limit: z.number().int().min(1).max(1000).optional().default(20) },
  }, async args => guard(async () => {
    const { session, path, offset, limit, ...request } = args;
    const result = await service.inspectNativeManualCabling(session, { ...request, ctx: service.newCtx() });
    const page = projectJsonPage(result.report, { tool: 'dcsc_manual_cabling_options',
      arguments: { session, ...request, expectedRevision: result.revision }, path, offset, limit });
    return { workspace: result.workspace,
      workspaceRevision: result.revision, revisionScope: 'workspace', ...page };
  }, 'dcsc_manual_cabling_options failed'));

  server.registerTool('dcsc_create_cabling_connection', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    title: 'Create a native manual cable connection',
    description: 'Creates a native MANUAL cable connection between placed ports and adds its cable to the BOM atomically. Inspect dcsc_manual_cabling_options first. Set pinExistingRoutes=true to convert existing AUTO network rows to MANUAL before adding. Source port selections propagate across linked configurations; linked destinations must all be placed. See dcsc://docs/capabilities for protocol and breakout-4 reimport notes.',
    inputSchema: { ...createFields, pinExistingRoutes: z.boolean().optional().default(false).describe('Convert existing AUTO network rows to MANUAL to preserve their exact routes.'), cablePart: z.string().min(1).describe('Exact part returned by dcsc_manual_cabling_options.') },
  }, async args => guard(async () => {
    const { session, ...request } = args;
    const result = await service.createNativeManualCabling(session, { ...request, ctx: service.newCtx() });
    const { compatibleCables: _choices, ...connection } = result.connection;
    return { workspace: result.workspace,
      workspaceRevision: result.revision, revisionScope: 'workspace', connection, pinnedConnectionCount: result.pinnedConnectionCount ?? 0,
      sourceConfigurationIds: result.sourceConfigurationIds, destinationConfigurationIds: result.destinationConfigurationIds, additionalConnectionCount: result.additionalConnectionCount ?? 0,
      inspect: { tool: 'dcsc_cabling_connections', arguments: { session: result.workspace,
        expectedRevision: result.revision, path: ['connections'], offset: 0, limit: 20 } } };
  }, 'dcsc_create_cabling_connection failed'));

  server.registerTool('dcsc_cabling_connections', {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Inspect editable DCSC cable connections',
    description: 'Lists the current connection graph, stable row IDs, physical endpoint/port choices and compatible cable parts. Pass refreshConnectionId with expectedRevision to fetch missing imported cable choices without mutating the design.',
    inputSchema: {
      session: z.string().describe('Workspace or configuration handle.'),
      refreshConnectionId: z.string().min(1).optional().describe('Fetch current compatible cables for this existing connection without changing the design.'),
      expectedRevision: z.number().int().min(1).optional()
        .describe('Optional read guard. A mismatch rejects stale navigation.'),
      path: z.array(z.string()).optional().default([]),
      offset: z.number().int().min(0).optional().default(0),
      limit: z.number().int().min(1).max(1000).optional().default(20),
    },
  }, async args => guard(async () => {
    const snapshot = args.refreshConnectionId
      ? await service.inspectManualCableChoices(args.session, args.refreshConnectionId, args.expectedRevision, service.newCtx())
      : await service.inspectManualCabling(args.session, args.expectedRevision);
    const page = projectJsonPage(snapshot.report, {
      tool: 'dcsc_cabling_connections',
      arguments: { session: args.session, expectedRevision: snapshot.revision,
        ...(args.refreshConnectionId ? { refreshConnectionId: args.refreshConnectionId } : {}) },
      path: args.path, offset: args.offset, limit: args.limit,
    });
    return {
      workspace: snapshot.workspace, workspaceRevision: snapshot.revision,
      revisionScope: 'workspace', ...page,
    };
  }, 'dcsc_cabling_connections failed'));

  server.registerTool('dcsc_edit_cabling_connection', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    title: 'Edit one existing DCSC cable connection',
    description: 'Edits the source, destination or compatible cablePart of an existing connection row from dcsc_cabling_connections. Selecting an occupied port on the same component swaps the two connections. Edit endpoints and cablePart in separate revision-bound calls.',
    inputSchema: {
      session: z.string().describe('Workspace or configuration handle.'),
      connectionId: z.string().regex(/^connection_[0-9a-f]{20}$/),
      source: endpointSchema.optional(),
      destination: endpointSchema.optional(),
      cablePart: z.string().min(1).optional()
        .describe('Exact compatibleCables[].part value returned for this row.'),
      cableQuantities: z.object({ oldPart: z.number().int().min(0), newPart: z.number().int().min(1) }).optional()
        .describe('Optional per-product quantities after replacement, including spares.'),
      expectedRevision: z.number().int().min(1)
        .describe('Required workspace revision returned by dcsc_cabling_connections.'),
    },
  }, async args => guard(async () => {
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
    const { compatibleCables: _compatibleCables, ...connection } = result.connection;
    return {
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
        expectedRevision: result.revision,
        path: ['connections'], offset: 0, limit: 20,
      } },
    };
  }, 'dcsc_edit_cabling_connection failed'));
}
