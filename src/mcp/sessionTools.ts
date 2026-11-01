import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchRuleVersionsInfo } from '../domain/ruleVersions.js';
import { z } from 'zod';

import { CONFIG_MODES } from '../config/constants.js';
import { redactConfig } from '../config/schema.js';
import { aggregatePower, assessRackDensity, extractPowerReport } from '../domain/power.js';
import { configurationListPrice } from '../domain/pricing.js';
import { storageComponentQuantities, unplacedManagedStorageComponentIds } from '../domain/storagePreferences.js';
import { storagePhysicalConfigurations } from '../domain/storagePhysicalState.js';
import { projectSummary } from '../model/project.js';
import {
  projectWorkspaceIntegrity,
  projectWorkspacePage,
  projectWorkspaceSummary,
} from '../model/workspaceProjection.js';
import type { DcscService } from './service.js';
import { guard } from './toolSupport.js';
import { jsonBytes } from '../util/jsonBytes.js';
import { PAGE_BYTE_BUDGET } from '../config/constants.js';

export function requireSession(service: DcscService, id: string) {
  const resolved = service.sessions.resolveHandle(id);
  if (!resolved) {
    throw new Error(
      `No such configuration session: ${id}. Use dcsc_session_list to see open sessions, or dcsc_launch to start one.`,
    );
  }
  if (resolved.kind === 'configuration') return resolved.session;
  const sessions = [...resolved.workspace.configurations.values()];
  if (sessions.length === 1) return sessions[0]!;
  throw new Error(
    `Workspace ${id} contains ${sessions.length} configurations, so a configuration target is ambiguous. ` +
      `Pass one configuration session ID: ${sessions.map((session) => session.id).join(', ')}.`,
  );
}

export function positiveQuantity(quantity: number | null | undefined): number {
  return typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

export function registerSessionTools(server: McpServer, service: DcscService): void {

  server.registerTool(
    'dcsc_launch',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: 'Start configuring a DCSC product',
      description:
        'Launches a configuration session for a product code and returns a compact summary (tabs, price, constraints) and session handle. Pass session to add a product to an existing multi-product solution.',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision when adding a product to an existing workspace.'),
        productCode: z.string().describe('Product code from dcsc_find_products, e.g. "7D73CTO1WW".'),
        mode: z
          .enum(CONFIG_MODES)
          .optional()
          .default('cto')
          .describe('cto for configure-to-order, lfo for a preconfigured model.'),
        label: z.string().optional().describe('Optional friendly name for this session.'),
        session: z
          .string()
          .optional()
          .describe('Optional existing workspace or session ID to add a product to a multi-product solution.'),
        solutionMode: z.string().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const workspace = args.session ? service.sessions.getWorkspace(args.session) : undefined;
        if (args.session && !workspace) throw new Error(`Workspace ${args.session} not found.`);
        const ctx = service.newCtx(workspace ? { locale: workspace.locale, solution: workspace.solution } : {});
        const solution = await service.resolveSolution(ctx, args.solutionMode ?? workspace?.solution.solutionMode);

        const availability = await service.modesContaining(ctx, [args.productCode]);
        const availableIn = availability.get(args.productCode.toUpperCase()) ?? [];
        const outOfCatalog = availableIn.length > 0 && !availableIn.includes(solution.solutionMode);

        const session = await service.launch({
          productCode: args.productCode,
          mode: args.mode,
          solution,
          ctx,
          workspaceId: args.session,
          expectedRevision: args.expectedRevision,
          ...(args.label !== undefined ? { label: args.label } : {}),
        });
        return {
          workspace: session.workspaceId,
          workspaceRevision: service.sessions.getWorkspace(session.workspaceId)!.revision,
          ...projectSummary({
            sessionId: session.id,
            revision: session.revision,
            raw: session.raw,
            index: session.index,
            currency: session.locale.currency,
            country: session.locale.country,
            pricedAt: session.pricedAt,
          }),
          solutionMode: solution.solutionMode,
          availableIn,
          ...(outOfCatalog
            ? {
                warning:
                  `${args.productCode} is not in the "${solution.solutionMode}" catalog ` +
                  `(it belongs to: ${availableIn.join(', ')}). This session will configure and price ` +
                  'normally, but exporting it and importing it back under this mode will fail. ' +
                  `Relaunch with solutionMode "${availableIn[0]}" unless you have a reason not to.`,
              }
            : {}),
          next: 'dcsc_list_options(session, tab: "<tab title>") or dcsc_list_options(session, query: "...")',
        };
      }, 'dcsc_launch failed'),
  );

  server.registerTool(
    'dcsc_session_list',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'List open DCSC configuration sessions',
      description:
        'Lists open configuration sessions and multi-product workspaces, most recently used first (paginated).',
      inputSchema: {
        session: z.string().optional().describe('Only list configurations in this workspace.'),
        limit: z.number().int().min(1).max(100).optional().default(15),
        offset: z.number().int().min(0).optional().default(0),
      },
    },
    async (args) =>
      guard(async () => {
        const limit = args.limit ?? 15;
        const offset = args.offset ?? 0;
        if (args.session && !service.sessions.getWorkspace(args.session)) {
          throw new Error(`Workspace ${args.session} not found.`);
        }
        const configurations = service.sessions.list()
          .filter(s => !args.session || s.workspaceId === args.session)
          .map(s => ({ session: s.id, configurationId: s.configurationId, workspace: s.workspaceId, kind: 'configuration',
            label: s.label?.slice(0, 128), product: s.product.code,
            description: s.product.description.slice(0, 60), revision: s.revision,
            totalPrice: s.raw.totalPrice ?? null, currency: s.locale.currency,
            updatedAt: new Date(s.lastAccessAt).toISOString() }));
        const standalone = service.sessions.listWorkspaces()
          .filter(ws => ws.configurations.size === 0 && (!args.session || ws.id === args.session))
          .map(ws => ({ session: ws.id, workspace: ws.id, kind: 'workspace',
            label: ws.label?.slice(0, 128), revision: ws.revision, currency: ws.locale.currency,
            updatedAt: new Date(ws.lastAccessAt).toISOString(),
            next: { tool: 'dcsc_session_info', arguments: { session: ws.id } } }));
        const all = [...configurations, ...standalone]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.session.localeCompare(b.session));
        const page = all.slice(offset, offset + limit);
        const result = () => ({ total: all.length, offset, limit, returned: page.length, sessions: page,
          ...(offset + page.length < all.length ? { next: { tool: 'dcsc_session_list',
            arguments: { ...args, offset: offset + page.length, limit } } } : {}),
        });
        while (jsonBytes(result()) > PAGE_BYTE_BUDGET && page.length > 1) page.pop();
        return result();
      }, 'dcsc_session_list failed'),
  );

  server.registerTool(
    'dcsc_session_close',
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      title: 'Close a DCSC configuration session',
      description: 'Discards a configuration session or workspace and frees its memory.',
      inputSchema: { session: z.string(), expectedRevision: z.number().int().min(1).optional().describe('Expected configuration for a configuration handle, or workspace for a workspace handle revision.') },
    },
    async (args) => guard(async () => ({ closed: await service.closeSession(args.session, args.expectedRevision) }), 'dcsc_session_close failed'),
  );

  server.registerTool(
    'dcsc_workspace_history',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Undo or redo a workspace edit',
      description: 'Restores the previous or next committed workspace state (configurations, floor placement, cabling and preferences) atomically. Bounded to 10 edits.',
      inputSchema: { session: z.string(), action: z.enum(['undo', 'redo']),
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.') },
    },
    async (args) => guard(async () => {
      const workspace = service.sessions.getWorkspace(args.session);
      if (!workspace) throw new Error('Workspace not found.');
      const changed = args.action === 'undo'
        ? await service.sessions.undoWorkspace(workspace.id, args.expectedRevision)
        : await service.sessions.redoWorkspace(workspace.id, args.expectedRevision);
      return { workspace: workspace.id, revision: workspace.revision, changed,
        undoAvailable: (workspace.history?.undo.length ?? 0) > 0,
        redoAvailable: (workspace.history?.redo.length ?? 0) > 0 };
    }, 'dcsc_workspace_history failed'),
  );

  server.registerTool(
    'dcsc_session_info',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Summarise a DCSC configuration or workspace',
      description:
        'Returns the compact summary of a configuration or workspace: products, quantities, prices, tabs, constraints, and revisions. Optionally inspects CTO and rule versions.',
      inputSchema: {
        session: z.string().optional().describe('Session or workspace ID. Optional if inspecting rule versions via ctoCode.'),
        path: z.array(z.string()).optional().describe('Detail path from a returned inspect/detail continuation.'),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(1000).optional().default(20),
        expectedRevision: z.number().int().min(1).optional()
          .describe('Revision supplied by a continuation; rejects pages from a workspace that changed.'),
        includeRuleVersions: z.boolean().optional().describe('When true, fetches and includes CTO versions and rule versions.'),
        ruleTableCode: z.string().optional().describe('Rule table code for rule versions lookup (defaults to 203).'),
        ctoCode: z.string().optional().describe('CTO code for rule versions lookup when no session is supplied or to override.'),
      },
    },
    async (args) =>
      guard(async () => {
        if (args.ctoCode && !args.session) {
          const info = await fetchRuleVersionsInfo(service.http, await service.ctxEnsuringSolution(), {
            ctoCode: args.ctoCode,
            tableCode: args.ruleTableCode,
          });
          return {
            ctoCode: info.ctoCode,
            versions: info.versions,
            tableCode: info.tableCode,
            ruleVersions: info.ruleVersions,
          };
        }
        if (!args.session) {
          throw new Error('A session ID or ctoCode is required for dcsc_session_info.');
        }
        const resolved = service.sessions.resolveHandle(args.session);
        if (!resolved) {
          throw new Error(
            `No such session or workspace: ${args.session}. Use dcsc_session_list to see open sessions.`,
          );
        }
        const workspace = resolved.workspace;
        if (!workspace) {
          throw new Error(`Configuration ${args.session} is not attached to an open workspace.`);
        }
        if (args.expectedRevision !== undefined && args.expectedRevision !== workspace.revision) {
          throw new Error(
            `Workspace ${workspace.id} changed from revision ${args.expectedRevision} to ${workspace.revision}. ` +
            'Restart dcsc_session_info without path before following new continuations.',
          );
        }
        if (args.path !== undefined) {
          if (args.expectedRevision === undefined) {
            throw new Error(
              'expectedRevision is required for detail pages. ' +
              'Call dcsc_session_info without path and follow its continuation.',
            );
          }
          return projectWorkspacePage(workspace, {
            tool: 'dcsc_session_info',
            arguments: { session: workspace.id, expectedRevision: workspace.revision },
            path: args.path,
            offset: args.offset,
            limit: args.limit,
          });
        }
        if (resolved.kind === 'workspace' && resolved.workspace.configurations.size === 0) {
          const kind = workspace.serverState.standaloneServiceState ? 'service'
            : workspace.serverState.standaloneSoftwareState ? 'software'
              : workspace.serverState.standaloneHardwareState ? 'hardware' : 'empty';
          return { workspace: workspace.id, revision: workspace.revision, workspaceRevision: workspace.revision, revisionScope: 'workspace', kind,
            configurations: [],
            ...projectWorkspaceIntegrity(workspace, { tool: 'dcsc_session_info',
              arguments: { session: workspace.id, expectedRevision: workspace.revision } }),
            currency: workspace.locale.currency, country: workspace.locale.country,
            ...(kind !== 'empty' ? { next: { tool: kind === 'service' ? 'dcsc_services_inspect'
              : kind === 'hardware' ? 'dcsc_standalone_hardware_inspect' : 'dcsc_software_inspect',
              arguments: { session: workspace.id } } } : {}),
          };
        }
        if (
          resolved.kind === 'workspace' &&
          (workspace.configurations.size > 1 || workspace.serverState.standaloneSoftwareState ||
            workspace.serverState.standaloneHardwareState ||
            unplacedManagedStorageComponentIds(workspace).size > 0)
        ) {
          const summary = projectWorkspaceSummary(workspace, {
            tool: 'dcsc_session_info',
            arguments: { session: workspace.id, expectedRevision: workspace.revision },
          });
          if (args.includeRuleVersions) {
            const firstCto = args.ctoCode ?? [...workspace.configurations.values()][0]?.product.code;
            if (firstCto) {
              const ruleVersions = await fetchRuleVersionsInfo(service.http, await service.ctxEnsuringSolution(), {
                ctoCode: firstCto,
                tableCode: args.ruleTableCode,
              });
              return { ...summary, ruleVersions };
            }
          }
          return summary;
        }

        const session = requireSession(service, args.session);

        let ruleVersions: unknown = undefined;
        if (args.includeRuleVersions) {
          const targetCto = args.ctoCode ?? session.product.code;
          ruleVersions = await fetchRuleVersionsInfo(service.http, await service.ctxEnsuringSolution(), {
            ctoCode: targetCto,
            tableCode: args.ruleTableCode,
          });
        }

        return {
          workspace: session.workspaceId,
          workspaceRevision: resolved.workspace?.revision,
          revisionScope: 'configuration',
          ...projectSummary({
            sessionId: session.id,
            revision: session.revision,
            raw: session.raw,
            index: session.index,
            currency: session.locale.currency,
            country: session.locale.country,
            pricedAt: session.pricedAt,
          }),
          ...projectWorkspaceIntegrity(workspace, { tool: 'dcsc_session_info',
            arguments: { session: workspace.id, expectedRevision: workspace.revision } }),
          validationMode: session.validationMode,
          autoCorrect: session.autoCorrect,
          mode: session.mode,
          primed: session.primed,
          configurable: session.configurable,
          ...(ruleVersions !== undefined ? { ruleVersions } : {}),
          ...(session.primed
            ? {}
            : !session.configurable
              ? {
                  note:
                    'Preconfigured model with no configurable sections: there is nothing to prime and ' +
                    'dcsc_configure does not apply. Browsing, pricing and export all work.',
                }
              : session.mode === 'lfo'
                ? {
                    note:
                      'DCSC rejects the priming body on /lfos/autoDerive for this model, so ' +
                      'dcsc_configure will NOT work in "lfo" mode. Browsing, pricing and export do work. ' +
                      'To change anything, relaunch the same code with mode "lfo-as-cto" — that returns ' +
                      'a configurable tree and primes correctly (note it prices the CTO base, not the ' +
                      'preconfigured bundle).',
                  }
                : {
                    warning:
                      'This configuration could not be primed, so dcsc_configure may fail. ' +
                      'Browsing, pricing and export still work.',
                  }),
        };
      }, 'dcsc_session_info failed'),
  );

  server.registerTool(
    'dcsc_diff_sessions',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Compare two DCSC configurations side-by-side',
      description:
        'Compares two configuration sessions side-by-side and returns added, removed and replaced parts, quantity changes, price delta and resource headroom.',
      inputSchema: {
        sessionA: z.string().describe('First session ID to compare.'),
        sessionB: z.string().describe('Second session ID to compare.'),
      },
    },
    async (args) => guard(async () => service.diffSessions(args.sessionA, args.sessionB), 'dcsc_diff_sessions failed'),
  );

  server.registerTool(
    'dcsc_compare_scenarios',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Compare design scenarios side by side',
      description:
        'Compares 2–6 configurations or workspaces by list price, power and heat. Pass nodes with configuration session IDs to scale a repeated node while keeping other workspace products fixed.',
      inputSchema: {
        sessions: z
          .array(z.string())
          .min(2)
          .max(6)
          .describe('Session or workspace IDs to compare.'),
        nodes: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe('Scale each scenario to this many nodes before comparing.'),
      },
    },
    async (args) =>
      guard(async () => {
        const scale = args.nodes;
        const scenarios = args.sessions.map((handle) => {
          const resolved = service.sessions.resolveHandle(handle);
          if (!resolved) throw new Error(`Session / Workspace ${handle} not found`);

          if (
            scale !== undefined &&
            resolved.kind === 'workspace' &&
            resolved.workspace.configurations.size > 1
          ) {
            throw new Error(
              `Workspace ${handle} contains ${resolved.workspace.configurations.size} configurations. ` +
                'Pass the configuration session ID of the node to scale so the repeated and fixed products are explicit.',
            );
          }

          const target =
            resolved.kind === 'configuration'
              ? resolved.session
              : [...resolved.workspace.configurations.values()][0];
          if (!target) throw new Error(`Workspace ${handle} contains no configurations.`);

          const workspace = resolved.workspace;
          const storageQuantities = workspace && (resolved.kind === 'workspace' || scale !== undefined)
            ? storageComponentQuantities(workspace) : new Map<string, number>();
          const scoped =
            resolved.kind === 'workspace'
              ? [...resolved.workspace.configurations.values()]
              : scale !== undefined && workspace
                ? [...workspace.configurations.values()]
                : [target];
          const quantities = new Map(
            scoped.map((session) => [
              session.id,
              scale !== undefined && session.id === target.id
                ? scale
                : storageQuantities.get(session.configurationId) ?? positiveQuantity(session.raw.quantity),
            ]),
          );
          const units = new Map(scoped.map(session => [session.id,
            workspace && storageQuantities.has(session.configurationId) && !(scale !== undefined && session.id === target.id)
              ? storagePhysicalConfigurations(workspace, session.configurationId, session.raw).map(instance => ({ raw: instance.raw, quantity: 1 }))
              : [{ raw: session.raw, quantity: quantities.get(session.id) ?? 1 }],
          ]));
          const entries = scoped.flatMap((session) => {
            return units.get(session.id)!.flatMap(unit => {
              const report = extractPowerReport(unit.raw);
              return report && unit.quantity > 0 ? [{ report, quantity: unit.quantity }] : [];
            });
          });
          const power = entries.length > 0 ? aggregatePower(entries) : undefined;
          const contributing = scoped.filter(session => (quantities.get(session.id) ?? 1) > 0);
          const hasPrice = (session: typeof target) => units.get(session.id)!.every(unit => configurationListPrice(unit.raw) !== null);
          const sessionPrice = (session: typeof target) => units.get(session.id)!.reduce((total, unit) =>
            total + (configurationListPrice(unit.raw) ?? 0) * unit.quantity, 0);
          const priceAvailable = contributing.every(hasPrice);
          const knownListPriceSubtotal = contributing.reduce((total, session) =>
            total + sessionPrice(session), 0);
          const listPrice = priceAvailable ? knownListPriceSubtotal : null;
          const missingPower = contributing.filter(session => session.product.type.toLowerCase() !== 'rack' &&
            units.get(session.id)!.some(unit => !extractPowerReport(unit.raw)));
          const powerAvailable = power !== undefined && missingPower.length === 0;
          const physicalWorkspace = resolved.kind === 'workspace' ? resolved.workspace : undefined;
          const racks = scale === undefined ? (physicalWorkspace?.rackSummaries ?? []) : [];
          const products = scoped.map((session) => ({
            session: session.id,
            code: session.product.code,
            description: session.product.description,
            quantity: quantities.get(session.id) ?? 1,
            role:
              scale === undefined
                ? 'included'
                : session.id === target.id
                  ? 'repeated'
                  : 'fixed',
            listPrice: (quantities.get(session.id) ?? 1) === 0 ? 0 : hasPrice(session)
              ? sessionPrice(session) : null,
          }));
          return {
            session: handle,
            label: physicalWorkspace?.label ?? target.label ?? target.product.code,
            currency: target.locale.currency,
            scope:
              scale !== undefined
                ? workspace && workspace.configurations.size > 1
                  ? 'scaled-configuration-with-fixed-workspace-products'
                  : 'scaled-configuration'
                : resolved.kind,
            primaryProduct: target.product.code,
            description: target.product.description,
            configurations: scoped.length,
            products,
            ...(scale !== undefined
              ? {
                  scaledToNodes: scale,
                  unitListPrice: hasPrice(target) ? target.raw.totalPrice : null,
                  physicalLayout: 'not-calculated',
                  physicalLayoutRequirement:
                    'Use dcsc_scale_out with an explicit rackCode, or place independent configuration instances and validate the workspace layout.',
                }
              : {}),
            listPrice,
            priceAvailable,
            ...(!priceAvailable ? { knownListPriceSubtotal,
              unpricedConfigurations: contributing.filter(session => !hasPrice(session)).map(session => session.id) } : {}),
            powerAvailable,
            ...(!powerAvailable ? { missingPowerConfigurations: missingPower.map(session => session.id),
              ...(power ? { knownPowerSubtotal: power } : {}) } : {}),
            ...(power && powerAvailable
              ? {
                  expectedKW: power.expectedKW,
                  maxKW: power.maxKW,
                  heatBtuHrMax: Math.round(power.heatBtuHr.max),
                  pricePerExpectedKW:
                    listPrice !== null && power.expectedKW > 0 ? Math.round(listPrice / power.expectedKW) : undefined,
                }
              : {}),
            ...(physicalWorkspace && scale === undefined
              ? {
                  racks: racks.length,
                  rackWeightKg: racks.reduce((acc, rack) => acc + (rack.totalWeightKg ?? 0), 0),
                  stability: racks.map((rack) => rack.stableStatus).filter(Boolean),
                }
              : {}),
          };
        });

        const currencies = [...new Set(scenarios.map((scenario) => scenario.currency))];
        if (currencies.length > 1) {
          return {
            scenarios,
            ranking: {
              status: 'rejected',
              reason:
                `Cannot rank list prices across currencies (${currencies.join(', ')}). ` +
                'Relaunch the scenarios in one locale/currency or compare each independently.',
            },
            priceType: 'LIST',
            disclaimer: 'List prices retrieved anonymously. Not a quote.',
          };
        }

        const priceComplete = scenarios.every(scenario => scenario.priceAvailable);
        const byPrice = priceComplete ? [...scenarios].sort((a, b) => (a.listPrice ?? 0) - (b.listPrice ?? 0)) : [];
        const withPower = scenarios.filter(
          (s): s is typeof s & { expectedKW: number } => typeof s.expectedKW === 'number',
        );
        const byPower = withPower.length === scenarios.length
          ? [...withPower].sort((a, b) => a.expectedKW - b.expectedKW) : [];

        return {
          scenarios,
          currency: currencies[0],
          cheapest: byPrice[0]?.session,
          lowestPower: byPower[0]?.session,
          ...(!priceComplete ? { priceRanking: { status: 'unavailable',
            reason: 'At least one included configuration has no available list price. Known subtotals cannot establish the cheapest complete scenario.' } } : {}),
          ...(withPower.length !== scenarios.length ? { powerRanking: { status: 'unavailable',
            reason: 'At least one scenario lacks complete DCSC power reports for its included powered products.' } } : {}),
          priceType: 'LIST',
          note:
            'expectedKW applies DCSC\'s load factor and is the figure to size a room against. ' +
            'pricePerExpectedKW is list price divided by that, useful for comparing accelerator generations.',
          disclaimer:
            'List prices for the configured country and currency, retrieved anonymously. Not a quote.',
        };
      }, 'dcsc_compare_scenarios failed'),
  );

  server.registerTool(
    'dcsc_scale_out',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: 'Size a cluster from one designed node',
      description:
        'Measures how many units of a configured node fit per rack against DCSC placement rules, how many racks N nodes require, and the resulting list price, weight, power and cooling advisory. Does not create N separate configurations (use dcsc_clone_configuration for that).',
      inputSchema: {
        session: z.string().describe('Session holding the designed node.'),
        nodes: z.number().int().min(1).max(10000).describe('How many nodes in the cluster.'),
        rackCode: z.string().describe('Rack cabinet code from dcsc_list_racks.'),
      },
    },
    async (args) =>
      guard(async () => {
        const plan = await service.scaleOut({
          sessionHandle: args.session,
          nodes: args.nodes,
          rackCode: args.rackCode,
          ctx: service.newCtx(),
        });

        const advisory = assessRackDensity(
          plan.powerPerRack?.maxKW ?? 0,
          'unknown',
        );

        return {
          ...plan,
          ...(advisory && advisory.level !== 'standard' ? { coolingAdvisory: advisory } : {}),
          ...(plan.powerPerRack?.maxKW === undefined
            ? {
                powerNote:
                  'DCSC returned no power report for this product, so per-rack density could NOT be ' +
                  'assessed and no cooling advisory was produced. Absence of a warning here means ' +
                  'unknown, not acceptable — size the facility from the vendor datasheet.',
              }
            : {}),
          priceType: 'LIST',
          disclaimer:
            'List prices for the configured country and currency. Not a quote. ' +
            'Power figures are DCSC\'s for the node as configured, multiplied by node count.',
        };
      }, 'dcsc_scale_out failed'),
  );

  server.registerTool(
    'dcsc_health',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'DCSC client health',
      description:
        'Reports circuit breaker state, WAF cooldown, open session count, recovery archive diagnostics and redacted configuration.',
      inputSchema: {},
    },
    async () =>
      guard(async () => ({
        ...service.http.health,
        activeLocale: service.locale,
        openSessions: service.sessions.list().length,
        recovery: {
          warningCount: service.sessions.lastRestoreReport.warnings.length,
          quarantinedRecords: service.sessions.lastRestoreReport.quarantined.length,
          archiveCount: service.sessions.lastRestoreReport.recoveryArchives.length,
          inspect: { tool: 'dcsc_recovery_inspect', arguments: { path: [], offset: 0, limit: 20 } },
        },
        config: redactConfig(service.config),
      }), 'dcsc_health failed'),
  );
}
