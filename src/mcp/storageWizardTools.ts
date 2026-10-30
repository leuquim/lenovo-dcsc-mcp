import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toToolError } from '../http/errors.js';
import { projectJsonPage } from '../model/pagedJson.js';
import type { DcscService } from './service.js';

export function registerStorageWizardTools(server: McpServer, service: DcscService): void {
  server.registerTool('dcsc_storage_wizard', {
    title: 'Inspect storage wizard options, controllers, backplanes and diagnostics',
    description: 'Lists native storage wizard options and their storageWizardTargetGroups. Use configId as optionId, the group array index as groupIndex, and featureCode/quantityOptions for component edits. Includes selected intent, recommended combinations and current native errors. Follow revision-bound continuations.',
    inputSchema: { session: z.string(), expectedWorkspaceRevision: z.number().int().min(1).optional(),
      path: z.array(z.string()).default([]), offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(20) },
  }, async args => {
    try {
      if (args.path.length > 0 && args.expectedWorkspaceRevision === undefined) throw new Error('Follow a revision-bound dcsc_storage_wizard continuation.');
      const report = service.inspectStorageWizard(args.session, args.expectedWorkspaceRevision);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ session: report.session,
        workspace: report.workspace, workspaceRevision: report.workspaceRevision,
        ...projectJsonPage(report, { tool: 'dcsc_storage_wizard',
          arguments: { session: args.session, expectedWorkspaceRevision: report.workspaceRevision },
          path: args.path, offset: args.offset, limit: args.limit }),
      }, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error)) }] };
    }
  });
  server.registerTool('dcsc_set_storage_wizard', {
    title: 'Select a storage wizard option or edit one of its components',
    description: 'Explicitly selects an option, clears it with optionId=null when no storage drives remain, or edits one component of the currently selected option using native offered quantities. Preserves userSelected intent through derive/export and updates linked configurations atomically with history. Adding a controller does not automatically remove another: inspect native errors and edit other components as needed. Saving an editable state is not manufacturing validation; use dcsc_validate before handoff.',
    inputSchema: { session: z.string(), expectedWorkspaceRevision: z.number().int().min(1), optionId: z.string().min(1).nullable().describe('Null clears the whole option; configured storage drives must first be removed.'),
      feature: z.object({ groupIndex: z.number().int().min(0), code: z.string().min(1), quantity: z.number().int().min(0) }).optional() },
  }, async args => {
    try {
      const report = await service.setStorageWizard(args.session, { optionId: args.optionId,
        ...(args.feature ? { feature: args.feature } : {}) }, args.expectedWorkspaceRevision, service.newCtx());
      const active = report.options.find(option => option['activate'] === true);
      const groups = active?.['storageWizardTargetGroups'] as Array<{ features?: Array<Record<string, unknown>> }> | undefined;
      const accepted = args.feature ? groups?.[args.feature.groupIndex]?.features?.find(f => f['featureCode'] === args.feature!.code) : undefined;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ session: report.session,
        workspace: report.workspace, workspaceRevision: report.workspaceRevision, configurationRevision: report.configurationRevision,
        affectedConfigurationCount: report.affectedConfigurationIds.length, optionId: active?.['configId'] ?? null,
        ...(args.feature ? { feature: { code: args.feature.code, requestedQuantity: args.feature.quantity,
          acceptedQuantity: accepted?.['defaultValue'] ?? null } } : {}),
        storageWizardErrorCount: Array.isArray(report.errors) ? report.errors.length : null,
        storageWizardWarningCount: Array.isArray(report.warnings) ? report.warnings.length : null,
        inspect: { tool: 'dcsc_storage_wizard', arguments: { session: report.session, expectedWorkspaceRevision: report.workspaceRevision } },
        validate: { tool: 'dcsc_validate', arguments: { session: report.workspace } },
      }, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error)) }] };
    }
  });
}
