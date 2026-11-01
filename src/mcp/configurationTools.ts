import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  configurationRecommendations,
  configurationRuleVersions,
  explainConfiguration,
  upstreamFeatureSpecs,
} from '../app/configurationView.js';
import { applySelections } from '../app/launch.js';
import { assertWorkspaceRevision, linkedGroup } from '../app/serviceHelpers.js';
import { PAGE_BYTE_BUDGET } from '../config/constants.js';
import { configurationListPrice } from '../domain/pricing.js';
import { diffConfigurations } from '../model/diff.js';
import { resolveSection, searchFeatures } from '../model/index.js';
import {
  projectFeatureDetail,
  projectOptions,
  projectSummary,
  projectTab,
} from '../model/project.js';
import { jsonBytes } from '../util/jsonBytes.js';
import type { DcscService } from './service.js';
import { requireSession, writeHeader } from './sessionTools.js';
import { guard } from './toolSupport.js';

const expectedRevision = z.number().int().min(1).optional().describe('Workspace revision you last read; the call fails if it moved.');

export function registerConfigurationTools(server: McpServer, service: DcscService): void {

  server.registerTool(
    'dcsc_configuration_get',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: 'Read a configuration',
      description:
        'Reads one configuration: summary and tabs, options (search, tab or section), selected parts, feature detail, DCSC rule changes, recommendations or rule versions.',
      inputSchema: {
        session: z.string().optional().describe('Required except for view rules with ctoCode.'),
        ctoCode: z.string().optional().describe('rules: CTO code to inspect without a session.'),
        view: z.enum(['summary', 'options', 'selections', 'features', 'explain', 'recommendations', 'rules'])
          .optional().default('summary'),
        query: z.string().optional().describe('options: free text, e.g. "64gb rdimm" or a feature code.'),
        tab: z.string().optional().describe('options: tab title, e.g. "Processors".'),
        section: z.string().optional().describe('options: section id from a tab listing.'),
        filter: z.enum(['all', 'selected', 'selectable']).optional().default('all').describe('options: which options to list.'),
        codes: z.array(z.string()).min(1).max(10).optional().describe('features: option codes to detail.'),
        upstream: z.boolean().optional().describe('features: also fetch lead times, lifecycle dates and price breakdown from DCSC.'),
        sinceRevision: z.number().int().optional().describe('explain: compare against this configuration revision.'),
        recommendation: z.enum(['subtab', 'summary', 'smart-lfo']).optional().default('subtab').describe('recommendations: which kind.'),
        country: z.string().optional().describe('recommendations smart-lfo: 2-letter country code.'),
        ruleTableCode: z.string().optional().describe('rules: rule table code, default 203.'),
        limit: z.number().int().min(1).max(100).optional().default(25),
        offset: z.number().int().min(0).optional().default(0),
      },
    },
    async (args) =>
      guard(async () => {
        if (args.view === 'rules' && !args.session) {
          if (!args.ctoCode) throw new Error('Pass session, or ctoCode for view rules.');
          return configurationRuleVersions(service, args.ctoCode, args.ruleTableCode);
        }
        if (!args.session) throw new Error('session is required.');
        const session = requireSession(service, args.session);
        const workspace = service.sessions.getWorkspace(session.workspaceId)!;
        const header = { session: session.id, revision: workspace.revision };
        const summary = projectSummary({
          sessionId: session.id,
          revision: workspace.revision,
          raw: session.raw,
          index: session.index,
          currency: session.locale.currency,
          country: session.locale.country,
          pricedAt: session.pricedAt,
        });
        switch (args.view) {
          case 'summary':
            return summary;
          case 'options': {
            if (args.tab && !args.query && !args.section && args.offset === 0 && args.filter === 'all') {
              return { ...projectTab({
                sessionId: session.id, revision: workspace.revision, index: session.index,
                tab: args.tab, currency: session.locale.currency,
              }) };
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
              revision: workspace.revision,
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
          }
          case 'selections': {
            const selected = session.index.features.filter((feature) => feature.selectedQty > 0);
            const page = selected.slice(args.offset, args.offset + args.limit);
            const project = () => {
              const byTab = new Map<string, Array<Record<string, unknown>>>();
              for (const feature of page) {
                const items = byTab.get(feature.tab) ?? [];
                items.push({ code: feature.code, qty: feature.selectedQty, description: feature.description,
                  unitPrice: feature.unitPrice, section: feature.section, sectionTitle: feature.sectionTitle });
                byTab.set(feature.tab, items);
              }
              return { ...summary, total: selected.length, offset: args.offset, returned: page.length,
                selections: [...byTab.entries()].map(([tab, items]) => ({ tab, items })),
                ...(args.offset + page.length < selected.length ? { next: { tool: 'dcsc_configuration_get',
                  arguments: { session: session.id, view: 'selections', offset: args.offset + page.length, limit: args.limit } } } : {}) };
            };
            let result = project();
            while (jsonBytes(result) > PAGE_BYTE_BUDGET && page.length > 1) {
              page.pop(); result = project();
            }
            if (jsonBytes(result) > PAGE_BYTE_BUDGET) {
              throw new Error('Configuration summary exceeds the response budget. Use view options with filter selected to inspect selected parts.');
            }
            return result;
          }
          case 'features': {
            if (!args.codes) throw new Error('codes is required for view features.');
            const found = args.codes.map((code) => ({
              code,
              detail: projectFeatureDetail(session.index, session.raw, code) ?? null,
            }));
            return {
              ...header,
              currency: session.locale.currency,
              features: found,
              notFound: found.filter((f) => f.detail === null).map((f) => f.code),
              ...(args.upstream ? { upstream: await upstreamFeatureSpecs(service, session, args.codes) } : {}),
            };
          }
          case 'explain':
            return { ...header, ...explainConfiguration(session, args.sinceRevision) };
          case 'recommendations':
            return { ...header, ...(await configurationRecommendations(service, session, args.recommendation, args.country)) };
          default:
            return { ...header, ...(await configurationRuleVersions(service, args.ctoCode ?? session.product.code, args.ruleTableCode)) };
        }
      }, 'dcsc_configuration_get failed'),
  );

  server.registerTool(
    'dcsc_configure',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: 'Change a configuration',
      description:
        'Applies option changes in one round trip and returns the diff, including changes DCSC made itself. Optionally sets the sales quantity, name-independent Guided/Expert mode or Auto-Correct for the workspace.',
      inputSchema: {
        session: z.string(),
        changes: z
          .array(z.object({
            section: z.string().describe('Section id, internal name or display title, from dcsc_configuration_get.'),
            code: z.string().describe('Feature code, e.g. "BYWK".'),
            quantity: z.number().int().min(0).describe('0 removes the option.'),
          }))
          .max(20)
          .optional(),
        salesQuantity: z.number().int().min(1).max(99).optional().describe('How many units of this configuration.'),
        validationMode: z.enum(['guided', 'expert']).optional().describe('Applies to the whole workspace.'),
        autoCorrect: z.boolean().optional().describe('Applies to the whole workspace; Expert mode forces it off.'),
        expectedRevision,
      },
    },
    async (args) =>
      guard(async () => {
        const changes = args.changes ?? [];
        const wantsControls = args.validationMode !== undefined || args.autoCorrect !== undefined;
        if (changes.length === 0 && args.salesQuantity === undefined && !wantsControls) {
          throw new Error('Provide changes, salesQuantity, validationMode or autoCorrect.');
        }
        let session = requireSession(service, args.session);
        const workspace = service.sessions.getWorkspace(session.workspaceId)!;
        assertWorkspaceRevision(workspace, args.expectedRevision);
        const ctx = service.newCtx({ locale: session.locale, solution: session.solution });
        const extendedPrice = (target: { raw: Parameters<typeof configurationListPrice>[0] & { quantity?: number } }): number | null => {
          const unit = configurationListPrice(target.raw);
          return unit === null ? null : Math.round(unit * (target.raw.quantity ?? 1) * 100) / 100;
        };
        const priceBefore = extendedPrice(session);

        if (wantsControls) {
          await service.setConfigurationControls(session.id, {
            validationMode: args.validationMode, autoCorrect: args.autoCorrect,
            expectedRevision: args.expectedRevision, ctx,
          });
          session = requireSession(service, args.session);
        }
        if (args.salesQuantity !== undefined) {
          session = await service.setQuantity(session, args.salesQuantity, session.revision);
        }
        let diffResult: Record<string, unknown> = {};
        if (changes.length > 0) {
          const beforeIndex = session.index;
          const beforeRaw = session.raw;
          const applied = await applySelections(service, session, changes, ctx, args.expectedRevision);
          const updated = applied.session;
          session = updated;
          const diff = diffConfigurations({
            beforeIndex, afterIndex: updated.index, beforeRaw, afterRaw: updated.raw,
            currency: updated.locale.currency, requested: new Set(changes.map((c) => c.code)),
          });
          const actualQuantity = (change: { section: string; code: string }): number => {
            const beforeSection = resolveSection(beforeIndex, change.section);
            const afterSection = beforeSection && updated.index.sections.find((section) =>
              section.name === beforeSection.name && section.tab === beforeSection.tab && section.subTab === beforeSection.subTab);
            if (!afterSection) return 0;
            return Math.max(0, ...updated.index.features.filter((feature) =>
              feature.section === afterSection.id && feature.code === change.code).map((feature) => feature.selectedQty));
          };
          const notApplied = changes.filter((change) => actualQuantity(change) !== change.quantity);
          const touched = diff.added.length > 0 || diff.removed.length > 0 || diff.replaced.length > 0 || diff.quantityChanged.length > 0;
          const notes: string[] = [];
          if (diff.autoChanges > 0) {
            notes.push(`${diff.autoChanges} change(s) were made by DCSC's rules engine, not requested. Report these to the user.`);
          }
          if (notApplied.length > 0) {
            notes.push(
              `DCSC did not apply: ${notApplied.map((c) => `${c.code} (asked ${c.quantity}, got ${actualQuantity(c)})`).join(', ')}. ` +
                'The request was accepted but the selection did not stick: this is a DCSC-side rejection, ' +
                'not a transport error. Do not report these as configured.',
            );
          }
          diffResult = {
            applied: notApplied.length === 0 && touched,
            partiallyApplied: notApplied.length > 0 && touched,
            notApplied: notApplied.length > 0 ? notApplied : undefined,
            requested: changes,
            ...diff,
            note: notes.length > 0 ? notes.join(' ') : undefined,
          };
        }
        const current = service.sessions.getWorkspace(session.workspaceId)!;
        const group = linkedGroup(current, session.configurationId);
        const connectionsStale = current.serverState.connectionGraphInvalidation !== undefined;
        const priceAfter = extendedPrice(session);
        const totalPrice = configurationListPrice(session.raw);
        return {
          ...writeHeader(service, args.session),
          configurationRevision: session.revision,
          ...(connectionsStale ? { connectionGraphStale: true } : {}),
          ...(group.linked ? { linkedUpdate: { configurationIds: group.memberIds, rootConfigurationId: group.rootId } } : {}),
          validationMode: session.validationMode,
          autoCorrect: session.autoCorrect,
          quantity: session.raw.quantity ?? 1,
          totalPrice,
          extendedPrice: priceAfter,
          priceAvailable: totalPrice !== null,
          priceChange: { before: priceBefore, after: priceAfter, currency: session.locale.currency },
          priceType: 'LIST',
          ...diffResult,
        };
      }, 'dcsc_configure failed'),
  );

  server.registerTool(
    'dcsc_auto_fix',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: 'Auto-fix rule errors',
      description: 'Resolves rule validation errors for eligible hardware CTO sections, as the website Auto-fix button does.',
      inputSchema: {
        session: z.string(),
        sections: z.array(z.string()).optional().describe('Section character names to fix, e.g. ["PROCESSOR"]. Defaults to all candidates.'),
        expectedRevision,
      },
    },
    async (args) =>
      guard(async () => {
        const target = requireSession(service, args.session);
        assertWorkspaceRevision(service.sessions.getWorkspace(target.workspaceId)!, args.expectedRevision);
        const report = await service.autoFix(args.session, {
          sections: args.sections,
          expectedRevision: target.revision,
          ctx: service.newCtx(),
        });
        return {
          ...writeHeader(service, args.session),
          applied: report.result.applied,
          sectionsChanged: report.result.sectionsChanged,
          notices: report.result.notices,
          message: report.result.message,
          totalPrice: configurationListPrice(report.session.raw),
        };
      }, 'dcsc_auto_fix failed'),
  );
}
