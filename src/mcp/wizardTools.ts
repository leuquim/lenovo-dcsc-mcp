import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { projectJsonPage } from '../model/pagedJson.js';
import type { DcscService } from './service.js';
import { writeHeader } from './sessionTools.js';
import { guard } from './toolSupport.js';

const WIZARDS = ['pci', 'storage'] as const;

export function registerWizardTools(server: McpServer, service: DcscService): void {
  server.registerTool('dcsc_wizard_get', {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: 'Read the PCI or storage wizard',
    description: 'Lists the native wizard options, adapter or storage groups and current selections. Follow continuations.',
    inputSchema: {
      session: z.string(),
      wizard: z.enum(WIZARDS),
      path: z.array(z.string()).default([]),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(20),
      expectedRevision: z.number().int().min(1).optional().describe('From a continuation.'),
    },
  }, async args => guard(async () => {
    if (args.path.length > 0 && args.expectedRevision === undefined) {
      throw new Error('Follow a revision-bound dcsc_wizard_get continuation.');
    }
    const report = args.wizard === 'pci'
      ? service.inspectPciWizard(args.session, args.expectedRevision)
      : service.inspectStorageWizard(args.session, args.expectedRevision);
    return { session: report.session, workspace: report.workspace, revision: report.workspaceRevision,
      ...projectJsonPage(report, { tool: 'dcsc_wizard_get',
        arguments: { session: args.session, wizard: args.wizard, expectedRevision: report.workspaceRevision },
        path: args.path, offset: args.offset, limit: args.limit }),
    };
  }, 'dcsc_wizard_get failed'));

  server.registerTool('dcsc_wizard_set', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Change the PCI or storage wizard',
    description:
      'pci: select optionId, or a riser rowId with enabled and/or slotCodes. storage: select optionId, clear it with null, or set one component with feature. Use choices from dcsc_wizard_get; linked copies update together.',
    inputSchema: {
      session: z.string(),
      wizard: z.enum(WIZARDS),
      expectedRevision: z.number().int().min(1),
      optionId: z.string().min(1).nullable().describe('Wizard option (configId). Null clears the storage option.'),
      rowId: z.string().optional().describe('pci: adapter row (adapterSlots[].lineNumber).'),
      enabled: z.boolean().optional().describe('pci: set true when choosing slots on an unchecked row.'),
      slotCodes: z.array(z.string().min(1)).min(1).max(32).optional().describe('pci: optional slot codes.'),
      feature: z.object({ groupIndex: z.number().int().min(0), code: z.string().min(1), quantity: z.number().int().min(0) })
        .optional().describe('storage: component edit in the active option.'),
    },
  }, async args => guard(async () => {
    if (args.wizard === 'pci') {
      if (args.optionId === null) throw new Error('optionId is required for the pci wizard.');
      if (args.feature !== undefined) throw new Error('feature applies to the storage wizard only.');
      const report = await service.setPciWizard(args.session, { optionId: args.optionId,
        ...(args.rowId !== undefined ? { rowId: args.rowId } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.slotCodes !== undefined ? { slotCodes: args.slotCodes } : {}) }, args.expectedRevision, service.newCtx());
      return { ...writeHeader(service, args.session), configurationRevision: report.configurationRevision,
        affectedConfigurationCount: report.affectedConfigurationIds.length };
    }
    if (args.rowId !== undefined || args.enabled !== undefined || args.slotCodes !== undefined) {
      throw new Error('rowId, enabled and slotCodes apply to the pci wizard only.');
    }
    const report = await service.setStorageWizard(args.session, { optionId: args.optionId,
      ...(args.feature ? { feature: args.feature } : {}) }, args.expectedRevision, service.newCtx());
    const active = report.options.find(option => option['activate'] === true);
    const groups = active?.['storageWizardTargetGroups'] as Array<{ features?: Array<Record<string, unknown>> }> | undefined;
    const accepted = args.feature ? groups?.[args.feature.groupIndex]?.features?.find(f => f['featureCode'] === args.feature!.code) : undefined;
    return { ...writeHeader(service, args.session), configurationRevision: report.configurationRevision,
      affectedConfigurationCount: report.affectedConfigurationIds.length, optionId: active?.['configId'] ?? null,
      ...(args.feature ? { feature: { code: args.feature.code, requestedQuantity: args.feature.quantity,
        acceptedQuantity: accepted?.['defaultValue'] ?? null } } : {}),
      storageWizardErrorCount: Array.isArray(report.errors) ? report.errors.length : null,
      storageWizardWarningCount: Array.isArray(report.warnings) ? report.warnings.length : null,
    };
  }, 'dcsc_wizard_set failed'));
}
