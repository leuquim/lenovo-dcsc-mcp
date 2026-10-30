import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toToolError } from '../http/errors.js';
import { configurationListPrice } from '../domain/pricing.js';
import type { DcscService } from './service.js';
import type { ConfigSession } from '../session/SessionStore.js';

export function registerUnconfiguredTools(server: McpServer, service: DcscService): void {
  const response = (session: ConfigSession) => {
    const workspace = service.sessions.getWorkspace(session.id)!;
    return { session: session.id, configurationRevision: session.revision, workspace: workspace.id,
      workspaceRevision: workspace.revision, totalPrice: configurationListPrice(session.raw),
      options: { tool: 'dcsc_list_options', arguments: { session: session.id } },
      undo: { tool: 'dcsc_workspace_history', arguments: { session: workspace.id, action: 'undo', expectedRevision: workspace.revision } },
      note: 'Unconfigured selections are native client-held options. Run manufacturing validation before handoff.' };
  };
  const handle = async (work: () => Promise<ConfigSession>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(response(await work())) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error)) }] }; }
  };
  const target = { session: z.string().describe('One configuration handle.'), expectedWorkspaceRevision: z.number().int().min(1) };
  server.registerTool('dcsc_load_unconfigured', {
    title: 'Load native Unconfigured options',
    description: 'Loads the website Unconfigured catalog for one product and its linked copies, preserves selections, and refreshes their prices. Saves available sections in the configuration so dcsc_list_options can inspect them. Requires the current workspace revision. Catalog loading does not select parts or run hardware derivation.',
    inputSchema: target,
  }, args => handle(() => service.loadUnconfigured(args.session, args.expectedWorkspaceRevision, service.newCtx())));
  server.registerTool('dcsc_set_unconfigured', {
    title: 'Edit native Unconfigured selections',
    description: 'Adds, changes or removes Unconfigured selections using exact sections and codes from dcsc_list_options after dcsc_load_unconfigured. Mirrors client-held native selections without hardware derivation. Updates linked copies atomically; unavailable choices on any member reject the batch. Quantity zero removes a selection. Workspace history supports undo. Native edit/export parity is verified for one General Purpose reference design; broader product and linked-copy browser coverage remain open.',
    inputSchema: { ...target, changes: z.array(z.object({ section: z.string(), code: z.string(), quantity: z.number().int().min(0) })).min(1).max(20) },
  }, args => handle(() => service.setUnconfigured(args.session, args.changes, args.expectedWorkspaceRevision)));
}
