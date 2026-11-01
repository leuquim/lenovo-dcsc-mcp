import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { CableDistanceQuery, CablingCandidate, CablingChange } from '../app/cabling.js';
import { PAGE_BYTE_BUDGET } from '../config/constants.js';
import type { ManualConnectionView } from '../domain/manualCabling.js';
import type { RequestCtx } from '../http/request.js';
import { projectJsonPage } from '../model/pagedJson.js';
import { jsonBytes } from '../util/jsonBytes.js';
import { guard } from './toolSupport.js';

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
  inspectCabling(session: string, input: {
    expectedRevision?: number | undefined; refreshConnectionId?: string | undefined;
    candidate?: Omit<CablingCandidate, 'expectedRevision'> | undefined; distance?: CableDistanceQuery | undefined; ctx: RequestCtx;
  }): Promise<{ workspace: string; revision: number; report: unknown }>;
  applyCablingChanges(session: string, changes: readonly CablingChange[], expectedRevision: number, ctx: RequestCtx): Promise<{
    workspace: string; revision: number;
    results: Array<{ action: CablingChange['action']; result: ManualCablingEditResult }>;
  }>;
}

const MAX_CABLING_CHANGES = 10;

const endpointSchema = z.object({
  configurationId: z.string().min(1).describe('Endpoint ID from dcsc_cabling_get.'),
  portName: z.string().min(1),
  portNumber: z.string().min(1),
}).strict();

const distanceSchema = z.object({
  from: z.string().min(1).describe('Source endpoint ID.'),
  to: z.string().min(1).describe('Destination endpoint ID.'),
  topology: z.string().min(1),
}).strict();

const candidateSchema = z.object({
  network: z.string().min(1), topology: z.string().min(1),
  source: endpointSchema, destination: endpointSchema,
  connectionType: z.enum(['point-to-point', 'breakout-4']).optional()
    .describe('breakout-4: one 25GbE branch of a 100GbE DAC breakout.'),
});

const changeSchema = z.discriminatedUnion('action', [
  candidateSchema.extend({
    action: z.literal('create'),
    cablePart: z.string().min(1).describe('Part from the cable choices.'),
    pinExistingRoutes: z.boolean().optional().default(false).describe('Convert AUTO rows to MANUAL so their routes are kept.'),
  }),
  z.object({
    action: z.literal('edit'),
    connectionId: z.string().regex(/^connection_[0-9a-f]{20}$/),
    source: endpointSchema.optional(),
    destination: endpointSchema.optional(),
    cablePart: z.string().min(1).optional().describe('compatibleCables[].part of this connection.'),
    cableQuantities: z.object({ oldPart: z.number().int().min(0), newPart: z.number().int().min(1) }).optional()
      .describe('Quantities after replacement, including spares.'),
  }),
]);

function withoutCableChoices(view: ManualConnectionView): Omit<ManualConnectionView, 'compatibleCables'> {
  const { compatibleCables: _choices, ...row } = view;
  return row;
}

function projectChangeResult(entry: { action: string; result: ManualCablingEditResult }): Record<string, unknown> {
  const { result } = entry;
  return {
    action: entry.action,
    connection: withoutCableChoices(result.connection),
    ...(entry.action === 'create' ? {
      pinnedConnectionCount: result.pinnedConnectionCount ?? 0,
      sourceConfigurationIds: result.sourceConfigurationIds,
      destinationConfigurationIds: result.destinationConfigurationIds,
      additionalConnectionCount: result.additionalConnectionCount ?? 0,
    } : {}),
    ...(result.swappedConnections?.length ? { swappedConnections: result.swappedConnections.map(withoutCableChoices) } : {}),
    ...(result.updatedConnections?.length ? { updatedConnections: result.updatedConnections.map(withoutCableChoices) } : {}),
    ...(result.configurationChange ? { configurationChange: result.configurationChange } : {}),
  };
}

export function registerManualCablingTools(server: McpServer, service: ManualCablingService): void {
  server.registerTool('dcsc_cabling_get', {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Cable configuration panel',
    description: 'Lists the connections with stable row IDs. Pass refreshConnectionId for one connection\'s cable choices, candidate for the cables of a new connection, or distance for the cable run between two endpoints.',
    inputSchema: {
      session: z.string().describe('Workspace or configuration handle.'),
      expectedRevision: z.number().int().min(1).optional().describe('Workspace revision; required with refreshConnectionId or candidate.'),
      refreshConnectionId: z.string().min(1).optional(),
      candidate: candidateSchema.optional().describe('Needs an assigned network and topology.'),
      distance: distanceSchema.optional().describe('Distance calculator.'),
      path: z.array(z.string()).optional().default([]),
      offset: z.number().int().min(0).optional().default(0),
      limit: z.number().int().min(1).max(1000).optional().default(20),
    },
  }, async args => guard(async () => {
    const snapshot = await service.inspectCabling(args.session, {
      expectedRevision: args.expectedRevision, refreshConnectionId: args.refreshConnectionId,
      candidate: args.candidate, distance: args.distance, ctx: service.newCtx(),
    });
    const page = projectJsonPage(snapshot.report, {
      tool: 'dcsc_cabling_get',
      arguments: { session: args.session, expectedRevision: snapshot.revision,
        ...(args.refreshConnectionId ? { refreshConnectionId: args.refreshConnectionId } : {}),
        ...(args.candidate ? { candidate: args.candidate } : {}),
        ...(args.distance ? { distance: args.distance } : {}) },
      path: args.path ?? [], offset: args.offset ?? 0, limit: args.limit ?? 20,
    });
    return { session: args.session, revision: snapshot.revision, ...page };
  }, 'dcsc_cabling_get failed'));

  server.registerTool('dcsc_cabling_set', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    title: 'Create or edit cable connections',
    description: `Creates or edits manual connections, up to ${MAX_CABLING_CHANGES} changes in order. Selecting an occupied port on the same component swaps the two connections.`,
    inputSchema: {
      session: z.string().describe('Workspace or configuration handle.'),
      expectedRevision: z.number().int().min(1).describe('Workspace revision.'),
      changes: z.array(changeSchema).min(1).max(MAX_CABLING_CHANGES),
    },
  }, async args => guard(async () => {
    args.changes.forEach((change, index) => {
      if (change.action === 'edit' && !change.source && !change.destination && !change.cablePart) {
        throw new Error(`Change ${index + 1}: supply a source, destination or cable-part change.`);
      }
    });
    const applied = await service.applyCablingChanges(args.session, args.changes, args.expectedRevision, service.newCtx());
    const response: Record<string, unknown> = {
      session: args.session, revision: applied.revision,
      results: applied.results.map(projectChangeResult),
      inspect: { tool: 'dcsc_cabling_get', arguments: {
        session: applied.workspace, expectedRevision: applied.revision, path: ['connections'], offset: 0, limit: 20,
      } },
    };
    if (jsonBytes(response) > PAGE_BYTE_BUDGET) {
      response['results'] = applied.results.map(({ action, result }) =>
        ({ action, connection: { id: result.connection.id, type: result.connection.type } }));
      response['compacted'] = true;
    }
    return response;
  }, 'dcsc_cabling_set failed'));
}
