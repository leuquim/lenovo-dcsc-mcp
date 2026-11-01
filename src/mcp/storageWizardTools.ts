import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { projectJsonPage } from '../model/pagedJson.js';
import type { DcscService } from './service.js';
import { guard } from './toolSupport.js';

export function registerStorageWizardTools(server: McpServer, service: DcscService): void {
  const runSetStorageWizard = async (args: {
    session: string;
    expectedRevision: number;
    optionId: string | null;
    feature?: { groupIndex: number; code: string; quantity: number } | undefined;
  }) => {
    const report = await service.setStorageWizard(args.session, { optionId: args.optionId,
      ...(args.feature ? { feature: args.feature } : {}) }, args.expectedRevision, service.newCtx());
    const active = report.options.find(option => option['activate'] === true);
    const groups = active?.['storageWizardTargetGroups'] as Array<{ features?: Array<Record<string, unknown>> }> | undefined;
    const accepted = args.feature ? groups?.[args.feature.groupIndex]?.features?.find(f => f['featureCode'] === args.feature!.code) : undefined;
    return { session: report.session,
      workspace: report.workspace, workspaceRevision: report.workspaceRevision, configurationRevision: report.configurationRevision,
      affectedConfigurationCount: report.affectedConfigurationIds.length, optionId: active?.['configId'] ?? null,
      ...(args.feature ? { feature: { code: args.feature.code, requestedQuantity: args.feature.quantity,
        acceptedQuantity: accepted?.['defaultValue'] ?? null } } : {}),
      storageWizardErrorCount: Array.isArray(report.errors) ? report.errors.length : null,
      storageWizardWarningCount: Array.isArray(report.warnings) ? report.warnings.length : null,
      inspect: { tool: 'dcsc_storage_wizard', arguments: { session: report.session, expectedRevision: report.workspaceRevision } },
      validate: { tool: 'dcsc_validate', arguments: { session: report.workspace } },
    };
  };

  server.registerTool('dcsc_storage_wizard', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Inspect or update storage wizard options, controllers, backplanes and diagnostics',
    description: 'Lists native storage wizard options and their storageWizardTargetGroups (or applies an inline update when optionId is supplied). Use configId as optionId, the group array index as groupIndex, and featureCode/quantityOptions for component edits. Follow revision-bound continuations.',
    inputSchema: { session: z.string(), expectedRevision: z.number().int().min(1).optional(),
      path: z.array(z.string()).default([]), offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(20),
      optionId: z.string().min(1).nullable().optional(),
      feature: z.object({ groupIndex: z.number().int().min(0), code: z.string().min(1), quantity: z.number().int().min(0) }).optional() },
  }, async args => guard(async () => {
    if (args.optionId !== undefined) {
      if (args.expectedRevision === undefined) {
        throw new Error('expectedRevision is required when mutating storage wizard options.');
      }
      return runSetStorageWizard({
        session: args.session,
        expectedRevision: args.expectedRevision,
        optionId: args.optionId,
        feature: args.feature,
      });
    }
    if (args.path.length > 0 && args.expectedRevision === undefined) {
      throw new Error('Follow a revision-bound dcsc_storage_wizard continuation.');
    }
    const report = service.inspectStorageWizard(args.session, args.expectedRevision);
    return { session: report.session,
      workspace: report.workspace, workspaceRevision: report.workspaceRevision,
      ...projectJsonPage(report, { tool: 'dcsc_storage_wizard',
        arguments: { session: args.session, expectedRevision: report.workspaceRevision },
        path: args.path, offset: args.offset, limit: args.limit }),
    };
  }, 'dcsc_storage_wizard failed'));

  server.registerTool('dcsc_set_storage_wizard', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    title: 'Select a storage wizard option or edit one of its components',
    description: 'Selects an option, clears it with optionId=null (when no storage drives remain), or edits one component of the active option using native offered quantities. Updates linked configurations atomically with history. Use dcsc_validate before manufacturing handoff.',
    inputSchema: { session: z.string(), expectedRevision: z.number().int().min(1), optionId: z.string().min(1).nullable().describe('Null clears the whole option; configured storage drives must first be removed.'),
      feature: z.object({ groupIndex: z.number().int().min(0), code: z.string().min(1), quantity: z.number().int().min(0) }).optional() },
  }, async args => guard(() => runSetStorageWizard(args), 'dcsc_set_storage_wizard failed'));
}
