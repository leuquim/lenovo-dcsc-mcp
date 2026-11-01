import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { linkedGroup } from '../app/serviceHelpers.js';
import { mandatoryVerifyConfig } from '../domain/mandatorySoftware.js';
import { errorCustomizeWithAutoDerive } from '../domain/autoFix.js';
import { z } from 'zod';

import { configurationListPrice } from '../domain/pricing.js';
import { diffConfigurations } from '../model/diff.js';
import { buildIndex, resolveSection, searchFeatures } from '../model/index.js';
import {
  projectFeatureDetail,
  projectOptions,
  projectSummary,
  projectTab,
} from '../model/project.js';
import type { DcscService } from './service.js';
import type { VerifyMandatorySoftwareInput } from '../domain/mandatorySoftware.js';
import { requireSession } from './sessionTools.js';
import { guard } from './toolSupport.js';
import { projectValidationToolResult } from './validationTools.js';
import { jsonBytes } from '../util/jsonBytes.js';
import { PAGE_BYTE_BUDGET } from '../config/constants.js';

export function registerConfigurationTools(server: McpServer, service: DcscService): void {

  server.registerTool(
    'dcsc_list_options',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'List or search configurable options',
      description:
        'Explores the option tree of a configuration:\n' +
        '  - query: searches every tab and returns matches with location.\n' +
        '  - tab: lists sections of one tab with current selections.\n' +
        '  - section: lists individual options in one section (paginated). Use dcsc_get_feature to inspect full attributes before selecting.',
      inputSchema: {
        session: z.string(),
        query: z.string().optional().describe('Free text, e.g. "64gb rdimm" or a feature code.'),
        tab: z.string().optional().describe('Tab title, e.g. "Processors".'),
        section: z.string().optional().describe('Section id from a previous tab listing.'),
        filter: z.enum(['all', 'selected', 'selectable']).optional().default('all'),
        limit: z.number().int().min(1).max(100).optional().default(25),
        offset: z.number().int().min(0).optional().default(0),
      },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);

        if (args.tab && !args.query && !args.section && args.offset === 0 && args.filter === 'all') {
          return projectTab({
            sessionId: session.id,
            revision: session.revision,
            index: session.index,
            tab: args.tab,
            currency: session.locale.currency,
          });
        }

        const found = searchFeatures(session.index, {
          ...(args.query !== undefined ? { query: args.query } : {}),
          ...(args.tab !== undefined ? { tab: args.tab } : {}),
          ...(args.section !== undefined ? { section: args.section } : {}),
          filter: args.filter,
          limit: args.limit,
          offset: args.offset,
        });

        return projectOptions({
          sessionId: session.id,
          revision: session.revision,
          currency: session.locale.currency,
          items: found.items,
          total: found.total,
          offset: found.offset,
          limit: found.limit,
          index: session.index,
          ...(args.section !== undefined ? { section: args.section } : {}),
          ...(args.query !== undefined ? { query: args.query } : {}),
          ...(args.tab !== undefined ? { tab: args.tab } : {}),
          filter: args.filter,
        });
      }, 'dcsc_list_options failed'),
  );

  server.registerTool(
    'dcsc_get_feature',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Get full detail for option codes',
      description:
        'Returns complete detail for up to 10 feature codes, including the attribute map and untruncated description (socket limits, thermal requirements, form factor).',
      inputSchema: {
        session: z.string(),
        codes: z.array(z.string()).min(1).max(10),
      },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);
        const found = args.codes.map((code) => ({
          code,
          detail: projectFeatureDetail(session.index, session.raw, code) ?? null,
        }));
        return {
          session: session.id,
          currency: session.locale.currency,
          features: found,
          notFound: found.filter((f) => f.detail === null).map((f) => f.code),
        };
      }, 'dcsc_get_feature failed'),
  );

  server.registerTool(
    'dcsc_get_configuration',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Get the selected parts of a configuration',
      description:
        'Returns the bill of materials (currently selected parts grouped by tab) or summary for a configuration.',
      inputSchema: {
        session: z.string(),
        format: z.enum(['selections', 'summary']).optional().default('selections'),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(20),
      },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);
        const summary = projectSummary({
          sessionId: session.id,
          revision: session.revision,
          raw: session.raw,
          index: session.index,
          currency: session.locale.currency,
          country: session.locale.country,
          pricedAt: session.pricedAt,
        });
        if (args.format === 'summary') return summary;

        const selected = session.index.features.filter((feature) => feature.selectedQty > 0);
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 20;
        const page = selected.slice(offset, offset + limit);
        const project = () => {
          const byTab = new Map<string, Array<Record<string, unknown>>>();
          for (const feature of page) {
            const items = byTab.get(feature.tab) ?? [];
            items.push({ code: feature.code, qty: feature.selectedQty, description: feature.description,
              unitPrice: feature.unitPrice, section: feature.section, sectionTitle: feature.sectionTitle });
            byTab.set(feature.tab, items);
          }
          return { ...summary, total: selected.length, offset, returned: page.length,
            selections: [...byTab.entries()].map(([tab, items]) => ({ tab, items })),
            ...(offset + page.length < selected.length ? { next: { tool: 'dcsc_get_configuration',
              arguments: { session: session.id, format: 'selections', offset: offset + page.length, limit } } } : {}) };
        };
        let result = project();
        while (jsonBytes(result) > PAGE_BYTE_BUDGET && page.length > 1) {
          page.pop(); result = project();
        }
        if (jsonBytes(result) > PAGE_BYTE_BUDGET) {
          throw new Error('Configuration summary exceeds the response budget. Use dcsc_list_options with selectedOnly=true to inspect selected parts.');
        }
        return result;
      }, 'dcsc_get_configuration failed'),
  );

  server.registerTool(
    'dcsc_validate',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: 'Validate a configuration with DCSC (LMC)',
      description:
        'Runs DCSC manufacturing validation (/lmc_validation).',
      inputSchema: {
        session: z.string(),
        deadlineMs: z.number().int().min(1000).max(300000).optional().describe('Total validation deadline, at most five minutes.'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = service.sessions.get(args.session);
        const ws = service.sessions.getWorkspace(args.session);
        if (!session && !ws) throw new Error(`No such session/workspace: ${args.session}`);
        const ctx = service.newCtx({
          locale: session?.locale ?? ws!.locale,
          solution: session?.solution ?? ws!.solution,
        });
        const report = await service.validate(args.session, ctx, { deadlineMs: args.deadlineMs });
        const result = {
          session: args.session,
          workspaceId: report.workspaceId,
          source: report.source,
          isValid: report.isValid,
          status: report.status,
          jobId: report.jobId,
          inspect: { tool: 'dcsc_validation_jobs', arguments: { session: args.session, jobId: report.jobId } },
          payloadSha256: report.payloadSha256,
          validatedRevision: report.validatedRevision,
          stale: report.stale,
          freshValidationRequired: report.freshValidationRequired,
          validatedScope: report.validatedScope,
          localDiagnostics: report.localDiagnostics,
          localErrorCount: report.localErrorCount,
          localWarningCount: report.localWarningCount,
          localInfoCount: report.localInfoCount,
          errorCount: report.errorCount,
          warningCount: report.warningCount,
          infoCount: report.infoCount,
          messages: report.messages,
          lmc: report.server
            ? {
                buildEntityNumber: report.server.buildEntityNumber,
                uuid: report.server.uuid,
                lmcURL: report.server.lmcURL,
              }
            : undefined,
          rackDataOmitted: report.rackDataOmitted,
          ...(report.warning !== undefined ? { warning: report.warning } : {}),
          headroom: report.headroom,
          next: report.isValid
            ? 'dcsc_export for deliverables.'
            : report.freshValidationRequired
              ? 'Run dcsc_validate again for a fresh validation job.'
              : 'Inspect the server and local diagnostics, correct the configuration, then validate again.',
        };
        return projectValidationToolResult(result, {
          session: args.session,
          jobId: report.jobId,
        });
      }, 'dcsc_validate failed'),
  );

  server.registerTool(
    'dcsc_set_configuration_controls',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: 'Set Guided or Expert mode and Auto-Correct',
      description: 'Updates validationMode (guided/expert) and autoCorrect for every configuration in the workspace and derives selections atomically. Expert mode forces autoCorrect off.',
      inputSchema: {
        session: z.string(),
        validationMode: z.enum(['guided', 'expert']).optional(),
        autoCorrect: z.boolean().optional(),
        expectedRevision: z.number().int().min(1).optional(),
      },
    },
    async (args) => guard(async () => service.setConfigurationControls(args.session, {
      validationMode: args.validationMode, autoCorrect: args.autoCorrect,
      expectedRevision: args.expectedRevision, ctx: service.newCtx(),
    }), 'dcsc_set_configuration_controls failed'),
  );

  server.registerTool(
    'dcsc_configure',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: 'Change selections in a configuration',
      description:
        'Applies one or more option changes in a single round trip and returns the diff (added, removed, replaced, price delta, constraints, and auto-derived changes). Linked Clone Multiple edits update all members atomically. On storage-wizard CTOs, submit RAID_CONFIG mode switches alone before selecting new storage parts. Edit software sections separately from hardware/services.',
      inputSchema: {
        session: z.string(),
        changes: z
          .array(
            z.object({
              section: z
                .string()
                .describe(
                  'Section from dcsc_list_options — id ("storage.m-2-ssd"), internal name ("M.2_SSD") or display title ("M.2 SSD").',
                ),
              code: z.string().describe('Feature code, e.g. "BYWK".'),
              quantity: z.number().int().min(0).describe('0 removes the option.'),
            }),
          )
          .min(1)
          .max(20),
        expectedRevision: z
          .number()
          .int()
          .optional()
          .describe('Fails if the configuration moved on since you last read it.'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);

        if (args.expectedRevision !== undefined && args.expectedRevision !== session.revision) {
          throw new Error(
            `Configuration has changed since revision ${args.expectedRevision} (now ${session.revision}). ` +
              'Re-read it with dcsc_session_info before retrying.',
          );
        }

        const beforeIndex = session.index;
        const beforeRaw = session.raw;
        const ctx = service.newCtx({ locale: session.locale, solution: session.solution });

        const updated = await service.configure(session, args.changes, ctx, args.expectedRevision);
        const workspace = service.sessions.getWorkspace(updated.id);
        const updatedGroup = workspace ? linkedGroup(workspace, updated.configurationId) : undefined;

        const diff = diffConfigurations({
          beforeIndex,
          afterIndex: updated.index,
          beforeRaw,
          afterRaw: updated.raw,
          currency: session.locale.currency,
          requested: new Set(args.changes.map((c) => c.code)),
        });

        const actualQuantity = (change: { section: string; code: string }): number => {
          const beforeSection = resolveSection(beforeIndex, change.section);
          const afterSection = beforeSection && updated.index.sections.find((section) =>
            section.name === beforeSection.name && section.tab === beforeSection.tab && section.subTab === beforeSection.subTab);
          if (!afterSection) return 0;
          return Math.max(0, ...updated.index.features.filter((feature) =>
            feature.section === afterSection.id && feature.code === change.code).map((feature) => feature.selectedQty));
        };
        const notApplied = args.changes.filter((change) => actualQuantity(change) !== change.quantity);
        const touched =
          diff.added.length > 0 ||
          diff.removed.length > 0 ||
          diff.replaced.length > 0 ||
          diff.quantityChanged.length > 0;

        const notes: string[] = [];
        if (diff.autoChanges > 0) {
          notes.push(
            `${diff.autoChanges} change(s) were made by DCSC's rules engine, not requested. Report these to the user.`,
          );
        }
        if (notApplied.length > 0) {
          notes.push(
            `DCSC did not apply: ${notApplied
              .map((c) => `${c.code} (asked ${c.quantity}, got ${actualQuantity(c)})`)
              .join(', ')}. ` +
              'The request was accepted but the selection did not stick — this is a DCSC-side rejection, ' +
              'not a transport error. Do not report these as configured.',
          );
        }

        return {
          session: updated.id,
          revision: updated.revision,
          ...(workspace ? { workspace: workspace.id, workspaceRevision: workspace.revision,
            connectionGraphStale: workspace.serverState.connectionGraphInvalidation !== undefined,
            ...(workspace.serverState.connectionGraphInvalidation !== undefined ? {
              regenerateConnections: { tool: 'dcsc_add_cabling', arguments: {
                session: workspace.id, mode: 'auto', expectedRevision: workspace.revision,
              } },
            } : {}),
          } : {}),
          ...(updatedGroup?.linked ? { linkedUpdate: { configurationIds: updatedGroup.memberIds,
            rootConfigurationId: updatedGroup.rootId, workspace: workspace!.id, workspaceRevision: workspace!.revision } } : {}),
          applied: notApplied.length === 0 && touched,
          partiallyApplied: notApplied.length > 0 && touched,
          notApplied: notApplied.length > 0 ? notApplied : undefined,
          requested: args.changes,
          ...diff,
          priceType: 'LIST',
          note: notes.length > 0 ? notes.join(' ') : undefined,
        };
      }, 'dcsc_configure failed'),
  );

  server.registerTool(
    'dcsc_set_quantity',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Set how many units of this configuration',
      description:
        'Sets the sales quantity (1–99) of this configuration locally and updates extended price and exported line quantity (quantity > 1 must be placed in a rack to export).',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected configuration revision.'),
        session: z.string(),
        quantity: z.number().int().min(1).max(99),
      },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);
        const beforeUnit = configurationListPrice(session.raw);
        const before = beforeUnit === null ? null : beforeUnit * (session.raw.quantity ?? 1);
        const updated = await service.setQuantity(session, args.quantity, args.expectedRevision);
        const summary = projectSummary({
          sessionId: updated.id,
          revision: updated.revision,
          raw: updated.raw,
          index: updated.index,
          currency: updated.locale.currency,
          country: updated.locale.country,
          pricedAt: updated.pricedAt,
        });
        return {
          ...summary,
          priceChange: {
            before: before === null ? null : Math.round(before * 100) / 100,
            after: summary.extendedPrice,
            currency: updated.locale.currency,
          },
        };
      }, 'dcsc_set_quantity failed'),
  );

  server.registerTool(
    'dcsc_undo',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Undo the last configuration change',
      description:
        'Reverts the most recent dcsc_configure call locally (up to 10 steps). Linked edits undo all members atomically; if histories diverged or an HPC edit changed its parent chassis, use dcsc_workspace_history.',
      inputSchema: { session: z.string(), expectedRevision: z.number().int().min(1).optional().describe('Expected configuration revision.') },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);
        const undone = await service.undo(session, args.expectedRevision);
        if (!undone) {
          throw new Error('Nothing to undo — this configuration has no recorded changes.');
        }
        const workspace = service.sessions.getWorkspace(session.id);
        const group = workspace ? linkedGroup(workspace, session.configurationId) : undefined;
        return {
          undone: true,
          ...(workspace ? { workspace: workspace.id, workspaceRevision: workspace.revision,
            connectionGraphStale: workspace.serverState.connectionGraphInvalidation !== undefined,
            ...(workspace.serverState.connectionGraphInvalidation !== undefined ? {
              regenerateConnections: { tool: 'dcsc_add_cabling', arguments: {
                session: workspace.id, mode: 'auto', expectedRevision: workspace.revision,
              } },
            } : {}),
          } : {}),
          ...(group?.linked ? { linkedUpdate: { configurationIds: group.memberIds,
            rootConfigurationId: group.rootId, workspace: workspace!.id, workspaceRevision: workspace!.revision } } : {}),
          ...projectSummary({
            sessionId: session.id,
            revision: session.revision,
            raw: session.raw,
            index: session.index,
            currency: session.locale.currency,
            country: session.locale.country,
            pricedAt: session.pricedAt,
          }),
        };
      }, 'dcsc_undo failed'),
  );

  server.registerTool(
    'dcsc_explain',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Explain why the configuration looks the way it does',
      description:
        'Explains what DCSC\'s rules engine added, removed or substituted on its own and surfaces its rule messages verbatim.',
      inputSchema: {
        session: z.string(),
        sinceRevision: z
          .number()
          .int()
          .optional()
          .describe('Compare against this revision instead of the one immediately before.'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);

        const snapshots = session.snapshots;
        const baseline =
          args.sinceRevision !== undefined
            ? snapshots.find((s) => s.revision === args.sinceRevision)
            : snapshots[snapshots.length - 1];

        const messages = (
          (session.raw as {
            expansionMessages?: Array<{
              type?: string;
              text?: string;
              code?: string;
              sectionName?: string;
            }>;
          }).expansionMessages ?? []
        ).map((m) => ({
          severity: m.type ?? 'info',
          ...(m.code !== undefined ? { code: m.code } : {}),
          ...(m.sectionName !== undefined ? { section: m.sectionName } : {}),
          message: m.text ?? String(m),
        }));

        const lastIntent = session.intents[session.intents.length - 1];

        if (!baseline) {
          return {
            session: session.id,
            revision: session.revision,
            ruleMessages: messages,
            note:
              'No earlier revision is retained, so only the current rule messages are available. ' +
              'Rule messages explain constraints DCSC is enforcing on this configuration.',
          };
        }

        const diff = diffConfigurations({
          beforeIndex: buildIndex(baseline.raw),
          afterIndex: session.index,
          beforeRaw: baseline.raw,
          afterRaw: session.raw,
          currency: session.locale.currency,
          requested: new Set((lastIntent?.changes ?? []).map((c) => c.code)),
        });

        return {
          session: session.id,
          comparedFrom: baseline.revision,
          comparedTo: session.revision,
          requested: lastIntent?.changes ?? [],
          ...diff,
          ruleMessages: messages,
          note:
            'Entries flagged "auto" were chosen by DCSC, not requested. Rule messages are the engine\'s ' +
            'own words for the constraint it applied.',
        };
      }, 'dcsc_explain failed'),
  );

  server.registerTool(
    'dcsc_auto_fix',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: 'Hardware auto-fix for CTO rule errors',
      description: 'Automatically resolves rule validation errors for eligible hardware CTO sections or executes batch error customize.',
      inputSchema: {
        session: z.string().optional().describe('Configuration session or workspace ID. Optional if errorCustomizeConfigurations is provided.'),
        sections: z
          .array(z.string())
          .optional()
          .describe('Optional list of section character names to fix (e.g. ["PROCESSOR"]). Defaults to all auto-fix candidates.'),
        expectedRevision: z.number().int().min(1).optional().describe('Expected configuration revision for optimistic concurrency.'),
        mode: z.enum(['cto', 'lfo']).optional().describe('Mode for errorCustomizeWithAutoDerive (cto or lfo).'),
        errorCustomizeConfigurations: z.array(z.unknown()).optional().describe('Configurations array for errorCustomizeWithAutoDerive.'),
      },
    },
    async (args) =>
      guard(async () => {
        if (args.errorCustomizeConfigurations !== undefined) {
          const session = args.session ? service.sessions.get(args.session) : undefined;
          const ws = args.session ? service.sessions.getWorkspace(args.session) : undefined;
          const solution = session?.solution ?? ws?.solution ?? (await service.resolveSolution(service.newCtx()));
          const locale = session?.locale ?? ws?.locale;
          const ctx = service.newCtx({
            ...(locale ? { locale } : {}),
            solution,
          });
          const configurations = await errorCustomizeWithAutoDerive(
            service.http,
            await service.ctxEnsuringSolution(ctx),
            { mode: args.mode, configurations: args.errorCustomizeConfigurations },
          );
          return {
            mode: args.mode ?? 'cto',
            configurations,
          };
        }
        if (!args.session) {
          throw new Error('A session ID or errorCustomizeConfigurations is required for dcsc_auto_fix.');
        }
        const report = await service.autoFix(args.session, {
          sections: args.sections,
          expectedRevision: args.expectedRevision,
          ctx: service.newCtx(),
        });
        return {
          session: report.session.id,
          revision: report.session.revision,
          applied: report.result.applied,
          sectionsChanged: report.result.sectionsChanged,
          notices: report.result.notices,
          message: report.result.message,
          totalPrice: configurationListPrice(report.session.raw),
        };
      }, 'dcsc_auto_fix failed'),
  );

  server.registerTool(
    'dcsc_verify_mandatory_software',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: 'Verify mandatory software selections',
      description: 'Validates mandatory OS/hypervisor or software selections for a configuration or LFO.',
      inputSchema: {
        mode: z.enum(['cto', 'lfo']).optional().describe('Configuration mode.'),
        configuration: z.object({
          id: z.string(),
          code: z.string(),
          lfoCode: z.string().optional(),
          sections: z.array(z.unknown()),
        }).passthrough().describe('Configuration object.'),
      },
    },
    async (args) =>
      guard(async () => {
        return mandatoryVerifyConfig(service.http, await service.ctxWithSolution(), args as unknown as VerifyMandatorySoftwareInput);
      }, 'dcsc_verify_mandatory_software failed'),
  );

  server.registerTool(
    'dcsc_summary_insights',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: 'Fetch service savings and flag summary insights',
      description: 'Fetches service pricing savings or selectable special feature flag summary from the workspace snapshot.',
      inputSchema: {
        session: z.string().optional().describe('Session or workspace handle to resolve export snapshot from.'),
        type: z.enum(['serviceSaving', 'flagSummary']).optional().describe('Insight type.'),
        workspaceSnapshot: z.record(z.string(), z.unknown()).optional().describe('Complete workspace export snapshot data.'),
      },
    },
    async (args) =>
      guard(async () => {
        return service.summaryInsights(args as unknown as { session?: string; type?: 'serviceSaving' | 'flagSummary' | string; workspaceSnapshot?: Record<string, unknown> });
      }, 'dcsc_summary_insights failed'),
  );
}
