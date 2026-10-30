import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toToolError } from '../http/errors.js';
import { projectJsonPage } from '../model/pagedJson.js';
import type { DcscService } from './service.js';

export function registerPciWizardTools(server: McpServer, service: DcscService): void {
  server.registerTool('dcsc_pci_wizard', {
    title: 'Inspect PCI wizard options, adapter assignments and optional slots',
    description: 'Lists native PCI wizard options. Use configId as optionId and adapterSlots[].lineNumber as rowId. Follow revision-bound continuations to see slot codes, required rows and current selections. Availability depends on the product and current configuration.',
    inputSchema: { session: z.string(), expectedWorkspaceRevision: z.number().int().min(1).optional(),
      path: z.array(z.string()).default([]), offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(20) },
  }, async args => {
    try {
      if (args.path.length > 0 && args.expectedWorkspaceRevision === undefined) throw new Error('Follow a revision-bound dcsc_pci_wizard continuation.');
      const report = service.inspectPciWizard(args.session, args.expectedWorkspaceRevision);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ session: report.session,
        workspace: report.workspace, workspaceRevision: report.workspaceRevision,
        ...projectJsonPage(report, { tool: 'dcsc_pci_wizard',
          arguments: { session: args.session, expectedWorkspaceRevision: report.workspaceRevision },
          path: args.path, offset: args.offset, limit: args.limit }),
      }, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error)) }] };
    }
  });
  server.registerTool('dcsc_set_pci_wizard', {
    title: 'Select a PCI wizard option or change an optional riser slot',
    description: 'Uses choices from dcsc_pci_wizard. Select optionId alone, or specify rowId with enabled and/or slotCodes. Set enabled=true when choosing slots on an unchecked row. Lenovo validates additional slots, reallocates adapters and derives the final configuration; it can add supporting risers. Saves atomically with workspace history and updates linked copies. Inspect the final choices after saving.',
    inputSchema: { session: z.string(), expectedWorkspaceRevision: z.number().int().min(1),
      optionId: z.string().min(1), rowId: z.string().optional(), enabled: z.boolean().optional(),
      slotCodes: z.array(z.string().min(1)).min(1).max(32).optional() },
  }, async args => {
    try {
      const report = await service.setPciWizard(args.session, { optionId: args.optionId,
        ...(args.rowId !== undefined ? { rowId: args.rowId } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.slotCodes !== undefined ? { slotCodes: args.slotCodes } : {}) }, args.expectedWorkspaceRevision, service.newCtx());
      return { content: [{ type: 'text' as const, text: JSON.stringify({ session: report.session,
        workspace: report.workspace, workspaceRevision: report.workspaceRevision, configurationRevision: report.configurationRevision,
        affectedConfigurationCount: report.affectedConfigurationIds.length,
        inspect: { tool: 'dcsc_pci_wizard', arguments: { session: report.session, expectedWorkspaceRevision: report.workspaceRevision } },
      }, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error)) }] };
    }
  });
}
