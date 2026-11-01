import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { compareScenarios, sizeScaleOut } from '../app/compare.js';
import { launchEntry, LAUNCH_MODES } from '../app/launchEntry.js';
import { assertWorkspaceRevision } from '../app/serviceHelpers.js';
import { inspectValidationJobs } from '../app/validation.js';
import {
  inspectBaskets,
  inspectHistory,
  inspectWorkspace,
  requireConfigSession,
  requireWorkspaceOf,
} from '../app/workspaceView.js';
import { PAGE_BYTE_BUDGET } from '../config/constants.js';
import { redactConfig } from '../config/schema.js';
import { projectSummary } from '../model/project.js';
import { listSessionRecoveryArchives } from '../session/persist.js';
import { projectJsonPage } from '../model/pagedJson.js';
import { jsonBytes } from '../util/jsonBytes.js';
import type { DcscService } from './service.js';
import { guard } from './toolSupport.js';

export { positiveQuantity } from '../app/compare.js';

export function requireSession(service: DcscService, id: string) {
  return requireConfigSession(service, id);
}

/** The `{ session, revision }` header every write returns; revision is the workspace revision. */
export function writeHeader(service: DcscService, handle: string): { session: string; workspace?: string; revision: number } {
  const workspace = requireWorkspaceOf(service, handle);
  return { session: handle, ...(workspace.id !== handle ? { workspace: workspace.id } : {}), revision: workspace.revision };
}

const expectedRevision = z.number().int().min(1).optional().describe('Workspace revision you last read; the call fails if it moved.');

export function registerSessionTools(server: McpServer, service: DcscService): void {

  server.registerTool(
    'dcsc_launch',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: 'Start configuring',
      description:
        'Opens a configuration, reference solution, software or services basket, or loads the Unconfigured options of a session. Pass session to add to an existing workspace.',
      inputSchema: {
        mode: z.enum(LAUNCH_MODES).optional().default('cto')
          .describe('cto, lfo (preconfigured) or lfo-as-cto for hardware; reference-solution; software; services; unconfigured.'),
        productCode: z.string().optional().describe('Product code, e.g. "7D73CTO1WW". Required for hardware and services.'),
        sid: z.string().max(160).optional().describe('Reference solution SID or CRN id, for mode reference-solution.'),
        session: z.string().optional().describe('Existing workspace to add to, or the configuration for mode unconfigured.'),
        expectedRevision,
        label: z.string().optional(),
        solutionMode: z.string().optional(),
        replace: z.boolean().optional().default(false).describe('Software and services: reset the basket.'),
        refresh: z.boolean().optional().default(false).describe('Software and services: reload the catalog and keep selections.'),
        productQuantity: z.number().int().min(1).max(9999).optional().default(1).describe('Services: quantity of the serviced product.'),
        productDescription: z.string().optional().describe('Services: description of the serviced product.'),
        subCategory: z.string().optional().default('Point of Sale').describe('Services: sub-category.'),
      },
    },
    async (args) =>
      guard(async () => {
        const outcome = await launchEntry(service, args);
        if (outcome.kind === 'configuration' || outcome.kind === 'unconfigured') {
          const session = outcome.session;
          const workspace = requireWorkspaceOf(service, session.id);
          return {
            session: session.id,
            workspace: workspace.id,
            revision: workspace.revision,
            ...projectSummary({
              sessionId: session.id,
              revision: workspace.revision,
              raw: session.raw,
              index: session.index,
              currency: session.locale.currency,
              country: session.locale.country,
              pricedAt: session.pricedAt,
            }),
            ...(outcome.kind === 'configuration'
              ? {
                  solutionMode: outcome.solutionMode,
                  availableIn: outcome.availableIn,
                  ...(outcome.outOfCatalog
                    ? {
                        warning:
                          `${args.productCode} is not in the "${outcome.solutionMode}" catalog ` +
                          `(it belongs to: ${outcome.availableIn.join(', ')}). This session will configure and price ` +
                          'normally, but exporting it and importing it back under this mode will fail. ' +
                          `Relaunch with solutionMode "${outcome.availableIn[0]}" unless you have a reason not to.`,
                      }
                    : {}),
                }
              : { note: 'Unconfigured options are loaded; read them with dcsc_configuration_get and edit them with dcsc_configure.' }),
          };
        }
        if (outcome.kind === 'reference-solution') {
          const { result } = outcome;
          const workspace = requireWorkspaceOf(service, result.workspaceId);
          return {
            session: workspace.id,
            revision: workspace.revision,
            importedConfigurations: result.sessions.length,
            standaloneKind: result.standaloneKind,
            diagnostics: {
              missingParts: result.diagnostics.missingParts.length,
              removedParts: result.diagnostics.removedParts.length,
              replacedParts: result.diagnostics.replacedParts.length,
              eccnRestricted: result.diagnostics.eccnRestricted,
              warningCount: result.diagnostics.warnings?.length ?? 0,
            },
          };
        }
        const workspace = outcome.workspace;
        return {
          session: workspace.id,
          revision: workspace.revision,
          basket: outcome.kind,
          ...(outcome.kind === 'software' ? { catalogItems: outcome.state.features.length } : {}),
          solutionMode: workspace.solution.solutionMode,
          country: workspace.locale.country,
          currency: workspace.locale.currency,
          priceType: 'LIST',
        };
      }, 'dcsc_launch failed'),
  );

  server.registerTool(
    'dcsc_session_list',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'List open sessions',
      description:
        'Lists open configurations and workspaces, most recent first. view health shows client health and restore diagnostics; view recovery pages through restore warnings and archives.',
      inputSchema: {
        view: z.enum(['sessions', 'health', 'recovery']).optional().default('sessions'),
        session: z.string().optional().describe('Only list configurations in this workspace.'),
        path: z.array(z.string()).optional().default([]).describe('Recovery detail path from a returned continuation.'),
        limit: z.number().int().min(1).max(100).optional().default(15),
        offset: z.number().int().min(0).optional().default(0),
      },
    },
    async (args) =>
      guard(async () => {
        if (args.view === 'health') {
          const report = service.sessions.lastRestoreReport;
          return {
            ...service.http.health,
            activeLocale: service.locale,
            openSessions: service.sessions.list().length,
            recovery: {
              warningCount: report.warnings.length,
              quarantinedRecords: report.quarantined.length,
              archiveCount: report.recoveryArchives.length,
              inspect: { tool: 'dcsc_session_list', arguments: { view: 'recovery' } },
            },
            config: redactConfig(service.config),
          };
        }
        if (args.view === 'recovery') {
          const report = { ...service.sessions.lastRestoreReport, recoveryArchives: listSessionRecoveryArchives(service.config) };
          return projectJsonPage(report, { tool: 'dcsc_session_list', arguments: { view: 'recovery' },
            path: args.path, offset: args.offset, limit: args.limit });
        }
        if (args.session && !service.sessions.getWorkspace(args.session)) {
          throw new Error(`Workspace ${args.session} not found.`);
        }
        const configurations = service.sessions.list()
          .filter(s => !args.session || s.workspaceId === args.session)
          .map(s => ({ session: s.id, configurationId: s.configurationId, workspace: s.workspaceId, kind: 'configuration',
            label: s.label?.slice(0, 128), product: s.product.code,
            description: s.product.description.slice(0, 60),
            revision: service.sessions.getWorkspace(s.workspaceId)?.revision,
            totalPrice: s.raw.totalPrice ?? null, currency: s.locale.currency,
            updatedAt: new Date(s.lastAccessAt).toISOString() }));
        const standalone = service.sessions.listWorkspaces()
          .filter(ws => ws.configurations.size === 0 && (!args.session || ws.id === args.session))
          .map(ws => ({ session: ws.id, workspace: ws.id, kind: 'workspace',
            label: ws.label?.slice(0, 128), revision: ws.revision, currency: ws.locale.currency,
            updatedAt: new Date(ws.lastAccessAt).toISOString(),
            next: { tool: 'dcsc_workspace_get', arguments: { session: ws.id } } }));
        const all = [...configurations, ...standalone]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.session.localeCompare(b.session));
        const page = all.slice(args.offset, args.offset + args.limit);
        const result = () => ({ total: all.length, offset: args.offset, limit: args.limit, returned: page.length, sessions: page,
          ...(args.offset + page.length < all.length ? { next: { tool: 'dcsc_session_list',
            arguments: { ...args, offset: args.offset + page.length } } } : {}),
        });
        while (jsonBytes(result()) > PAGE_BYTE_BUDGET && page.length > 1) page.pop();
        return result();
      }, 'dcsc_session_list failed'),
  );

  server.registerTool(
    'dcsc_session_close',
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      title: 'Close a session',
      description: 'Discards a configuration or a whole workspace and frees its memory.',
      inputSchema: { session: z.string(), expectedRevision },
    },
    async (args) =>
      guard(async () => {
        const resolved = service.sessions.resolveHandle(args.session);
        const workspace = resolved?.workspace;
        let closed = false;
        if (resolved?.kind === 'workspace') {
          closed = await service.closeSession(args.session, args.expectedRevision);
        } else if (resolved?.kind === 'configuration' && workspace) {
          assertWorkspaceRevision(workspace, args.expectedRevision);
          closed = await service.closeSession(args.session, resolved.session.revision);
        }
        const current = workspace ? service.sessions.getWorkspace(workspace.id) : undefined;
        return { session: args.session, revision: current?.revision ?? null, closed };
      }, 'dcsc_session_close failed'),
  );

  server.registerTool(
    'dcsc_undo',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Undo or redo an edit',
      description:
        'Restores the previous or next committed workspace state (up to 10 edits). With scope configuration, reverts only the last dcsc_configure call on one configuration.',
      inputSchema: {
        session: z.string(),
        action: z.enum(['undo', 'redo']).optional().default('undo'),
        scope: z.enum(['workspace', 'configuration']).optional().default('workspace'),
        expectedRevision,
      },
    },
    async (args) =>
      guard(async () => {
        const workspace = requireWorkspaceOf(service, args.session);
        let changed: boolean;
        if (args.scope === 'configuration') {
          if (args.action === 'redo') throw new Error('Redo is only available for scope workspace.');
          assertWorkspaceRevision(workspace, args.expectedRevision);
          const target = requireConfigSession(service, args.session);
          changed = await service.undo(target, target.revision);
        } else {
          changed = args.action === 'undo'
            ? await service.sessions.undoWorkspace(workspace.id, args.expectedRevision)
            : await service.sessions.redoWorkspace(workspace.id, args.expectedRevision);
        }
        const history = inspectHistory(service, args.session);
        return { ...writeHeader(service, args.session), changed,
          undoAvailable: history['undoAvailable'], redoAvailable: history['redoAvailable'],
          ...(workspace.serverState.connectionGraphInvalidation !== undefined
            ? { connectionGraphStale: true, note: 'Configuration selections changed; regenerate connections with dcsc_auto_connect.' } : {}) };
      }, 'dcsc_undo failed'),
  );

  server.registerTool(
    'dcsc_workspace_get',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Inspect a workspace',
      description:
        'Reads a configuration or workspace: summary, rack and floor layout, standalone baskets, undo history or saved validation jobs. Follow returned continuations for large collections.',
      inputSchema: {
        session: z.string(),
        view: z.enum(['summary', 'layout', 'baskets', 'history', 'validation']).optional().default('summary'),
        jobId: z.string().optional().describe('View validation: one saved job to inspect.'),
        path: z.array(z.string()).optional().describe('Detail path from a returned continuation.'),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(1000).optional().default(20),
        expectedRevision: z.number().int().min(1).optional().describe('Revision carried by a continuation; rejects pages from a workspace that moved.'),
      },
    },
    async (args) =>
      guard(async () => {
        switch (args.view) {
          case 'history': return inspectHistory(service, args.session);
          case 'baskets': return inspectBaskets(service, args);
          case 'validation': {
            const workspace = requireWorkspaceOf(service, args.session);
            return { session: args.session, revision: workspace.revision,
              ...inspectValidationJobs(service, { session: args.session, jobId: args.jobId, path: args.path ?? [], offset: args.offset, limit: args.limit }) };
          }
          default: return inspectWorkspace(service, { ...args, view: args.view });
        }
      }, 'dcsc_workspace_get failed'),
  );

  server.registerTool(
    'dcsc_compare',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: 'Compare designs',
      description:
        'Local analysis: scenarios compares 2-6 designs by price, power and heat; scale-out sizes racks for N nodes; parts lists the differences between two configurations; insights fetches service savings or flag summary.',
      inputSchema: {
        analysis: z.enum(['scenarios', 'scale-out', 'parts', 'insights']),
        sessions: z.array(z.string()).min(2).max(6).optional().describe('scenarios: session or workspace ids.'),
        session: z.string().optional().describe('scale-out and insights: the session to analyse.'),
        sessionA: z.string().optional().describe('parts: first configuration.'),
        sessionB: z.string().optional().describe('parts: second configuration.'),
        nodes: z.number().int().min(1).max(10000).optional().describe('scale-out: cluster size; scenarios: scale each scenario to this many nodes.'),
        rackCode: z.string().optional().describe('scale-out: rack cabinet code from dcsc_rack_get.'),
        insight: z.enum(['serviceSaving', 'flagSummary']).optional().default('serviceSaving').describe('insights: which summary to fetch.'),
      },
    },
    async (args) =>
      guard(async () => {
        switch (args.analysis) {
          case 'scenarios':
            if (!args.sessions) throw new Error('sessions is required for analysis scenarios.');
            return compareScenarios(service, args.sessions, args.nodes);
          case 'scale-out':
            if (!args.session || args.nodes === undefined || !args.rackCode) {
              throw new Error('session, nodes and rackCode are required for analysis scale-out.');
            }
            return sizeScaleOut(service, { session: args.session, nodes: args.nodes, rackCode: args.rackCode });
          case 'parts':
            if (!args.sessionA || !args.sessionB) throw new Error('sessionA and sessionB are required for analysis parts.');
            return service.diffSessions(args.sessionA, args.sessionB);
          default:
            if (!args.session) throw new Error('session is required for analysis insights.');
            return service.summaryInsights({ session: args.session, type: args.insight });
        }
      }, 'dcsc_compare failed'),
  );
}
