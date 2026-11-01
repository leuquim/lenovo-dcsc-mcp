import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { projectJsonPage } from '../model/pagedJson.js';
import type { DcscService } from './service.js';
import { guard } from './toolSupport.js';

export function registerPciWizardTools(server: McpServer, service: DcscService): void {
  const runSetPciWizard = async (args: {
    session: string;
    expectedRevision: number;
    optionId: string;
    rowId?: string | undefined;
    enabled?: boolean | undefined;
    slotCodes?: string[] | undefined;
  }) => {
    const report = await service.setPciWizard(args.session, { optionId: args.optionId,
      ...(args.rowId !== undefined ? { rowId: args.rowId } : {}),
      ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      ...(args.slotCodes !== undefined ? { slotCodes: args.slotCodes } : {}) }, args.expectedRevision, service.newCtx());
    return { session: report.session,
      workspace: report.workspace, workspaceRevision: report.workspaceRevision, configurationRevision: report.configurationRevision,
      affectedConfigurationCount: report.affectedConfigurationIds.length,
      inspect: { tool: 'dcsc_pci_wizard', arguments: { session: report.session, expectedRevision: report.workspaceRevision } },
    };
  };

  server.registerTool('dcsc_pci_wizard', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Inspect or update PCI wizard options, adapter assignments and optional slots',
    description: 'Lists native PCI wizard options (or applies an inline update when optionId is supplied). Use configId as optionId and adapterSlots[].lineNumber as rowId. Follow revision-bound continuations to see slot codes, required rows and current selections.',
    inputSchema: { session: z.string(), expectedRevision: z.number().int().min(1).optional(),
      path: z.array(z.string()).default([]), offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(20),
      optionId: z.string().min(1).optional(), rowId: z.string().optional(), enabled: z.boolean().optional(),
      slotCodes: z.array(z.string().min(1)).min(1).max(32).optional(),
    },
  }, async args => guard(async () => {
    if (args.optionId !== undefined) {
      if (args.expectedRevision === undefined) {
        throw new Error('expectedRevision is required when mutating PCI wizard options.');
      }
      return runSetPciWizard({
        session: args.session,
        expectedRevision: args.expectedRevision,
        optionId: args.optionId,
        rowId: args.rowId,
        enabled: args.enabled,
        slotCodes: args.slotCodes,
      });
    }
    if (args.path.length > 0 && args.expectedRevision === undefined) {
      throw new Error('Follow a revision-bound dcsc_pci_wizard continuation.');
    }
    const report = service.inspectPciWizard(args.session, args.expectedRevision);
    return { session: report.session,
      workspace: report.workspace, workspaceRevision: report.workspaceRevision,
      ...projectJsonPage(report, { tool: 'dcsc_pci_wizard',
        arguments: { session: args.session, expectedRevision: report.workspaceRevision },
        path: args.path, offset: args.offset, limit: args.limit }),
    };
  }, 'dcsc_pci_wizard failed'));

  server.registerTool('dcsc_set_pci_wizard', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Select a PCI wizard option or change an optional riser slot',
    description: 'Uses choices from dcsc_pci_wizard. Select optionId alone, or specify rowId with enabled and/or slotCodes. Set enabled=true when choosing slots on an unchecked row. Validates additional slots, reallocates adapters, derives the configuration and updates linked copies atomically.',
    inputSchema: { session: z.string(), expectedRevision: z.number().int().min(1),
      optionId: z.string().min(1), rowId: z.string().optional(), enabled: z.boolean().optional(),
      slotCodes: z.array(z.string().min(1)).min(1).max(32).optional() },
  }, async args => guard(() => runSetPciWizard(args), 'dcsc_set_pci_wizard failed'));
}
