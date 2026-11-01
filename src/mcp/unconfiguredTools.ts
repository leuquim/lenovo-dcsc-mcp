import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { configurationListPrice } from '../domain/pricing.js';
import type { DcscService } from './service.js';
import type { ConfigSession } from '../model/session.js';
import { guard } from './toolSupport.js';

export function registerUnconfiguredTools(server: McpServer, service: DcscService): void {
  const response = (session: ConfigSession) => {
    const workspace = service.sessions.getWorkspace(session.id)!;
    return { session: session.id, configurationRevision: session.revision, workspace: workspace.id,
      workspaceRevision: workspace.revision, totalPrice: configurationListPrice(session.raw),
      options: { tool: 'dcsc_list_options', arguments: { session: session.id } },
      undo: { tool: 'dcsc_workspace_history', arguments: { session: workspace.id, action: 'undo', expectedRevision: workspace.revision } },
      note: 'Unconfigured selections are native client-held options. Run manufacturing validation before handoff.' };
  };
  const target = { session: z.string().describe('One configuration handle.'), expectedRevision: z.number().int().min(1) };
  const changesSchema = z.array(z.object({ section: z.string(), code: z.string(), quantity: z.number().int().min(0) })).min(1).max(20);
  server.registerTool('dcsc_load_unconfigured', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Load or edit native Unconfigured options',
    description: 'Loads the website Unconfigured catalog for one product and its linked copies, preserving selections and refreshing prices so dcsc_list_options can inspect them. Optionally applies Unconfigured selection changes inline when changes is supplied.',
    inputSchema: { ...target, changes: changesSchema.optional() },
  }, args => guard(async () => {
    if (args.changes !== undefined) {
      const existing = service.sessions.get(args.session);
      const hasUnconfiguredTab = existing?.raw.tabs?.some(tab => tab.type === 'UNCONFIGURED_TAB');
      if (!hasUnconfiguredTab) {
        await service.loadUnconfigured(args.session, args.expectedRevision, service.newCtx());
        const nextRev = service.sessions.getWorkspace(args.session)!.revision;
        return response(await service.setUnconfigured(args.session, args.changes, nextRev));
      }
      return response(await service.setUnconfigured(args.session, args.changes, args.expectedRevision));
    }
    return response(await service.loadUnconfigured(args.session, args.expectedRevision, service.newCtx()));
  }, 'dcsc_load_unconfigured failed'));

  server.registerTool('dcsc_set_unconfigured', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Edit native Unconfigured selections',
    description: 'Adds, changes or removes Unconfigured selections using exact sections and codes from dcsc_list_options after dcsc_load_unconfigured. Updates linked copies atomically; quantity zero removes a selection.',
    inputSchema: { ...target, changes: changesSchema },
  }, args => guard(async () => response(await service.setUnconfigured(args.session, args.changes, args.expectedRevision)), 'dcsc_set_unconfigured failed'));
}
