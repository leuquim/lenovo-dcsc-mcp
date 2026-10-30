import { registerStorageWizardTools } from './storageWizardTools.js';
import { registerPciWizardTools } from './pciWizardTools.js';
import { detachedNestedNodeIds } from '../domain/nestedPhysical.js';
import { resolveLinkedCloneGroup } from '../domain/linkedCloneEdit.js';
import { configurationListPrice } from '../domain/pricing.js';
import { storagePhysicalConfigurations } from '../domain/storagePhysicalState.js';
import { physicalIds } from '../domain/workspaceReferences.js';
import { isDeepStrictEqual } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { CONFIG_MODES } from '../config/constants.js';
import { redactConfig } from '../config/schema.js';
import { browseCatalog, searchCatalogPage } from '../domain/catalog.js';
import { invalidateConnectionGraph, type AutoConnectResult } from '../domain/cabling.js';
import { cablingDiagnostics } from '../domain/cablingDiagnostics.js';
import { toToolError } from '../http/errors.js';
import { logger } from '../http/trace.js';
import { DEFAULT_EXPORT_TYPES, type ExportFileType } from '../domain/reduce.js';
import type { LayoutResult } from '../domain/rack.js';
import { aggregatePower, assessRackDensity, extractPowerReport, powerLoadFactor } from '../domain/power.js';
import { BLUEPRINTS, findBlueprint } from '../domain/blueprints.js';
import { sanitiseFileName, writeExportBundle } from '../files/artifactStore.js';
import { diffConfigurations } from '../model/diff.js';
import { buildIndex, resolveSection, searchFeatures } from '../model/index.js';
import { projectCatalogPage } from '../model/catalogPage.js';
import { projectCatalogBrowsePage } from '../model/catalogBrowsePage.js';
import {
  projectFeatureDetail,
  projectOptions,
  projectSummary,
  projectTab,
} from '../model/project.js';
import {
  projectWorkspaceIntegrity,
  projectWorkspaceLayout,
  projectWorkspacePage,
  projectWorkspaceSummary,
} from '../model/workspaceProjection.js';
import type { DcscService } from './service.js';
import type { WorkspaceSession } from '../session/SessionStore.js';
import { registerRecoveryTools } from './recoveryTools.js';
import { registerStorageTools } from './storageTools.js';
import { registerManualCablingTools } from './manualCablingTools.js';
import { registerPowerControlTools } from './powerControlTools.js';
import { registerReferenceSolutionTools } from './referenceSolutionTools.js';
import { registerUnconfiguredTools } from './unconfiguredTools.js';
import { projectValidationToolResult, registerValidationTools } from './validationTools.js';
import { registerReconciliationTools } from './reconciliationTools.js';
import { listTopologyConnectors, listNetworkLeafCablingChoices } from '../domain/networkPreferences.js';
import { workspaceNetworkTypes } from '../domain/workspaceNetworkPreferences.js';
import { listStorageExpansions, unplacedManagedStorageComponentIds, configurationCloneDependency,
  storageComponentQuantities, storagePhysicalTemplateIds } from '../domain/storagePreferences.js';
import { registerStandaloneTools, exportStandaloneSoftwareArtifact, exportProductServiceArtifact } from './standaloneTools.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  logger().error({ err: err instanceof Error ? err.message : String(err) }, 'Tool failed');
  return {
    content: [{ type: 'text', text: JSON.stringify(toToolError(err), null, 2) }],
    isError: true,
  };
}

/** Wraps a handler so no raw upstream detail can escape through a tool result. */
async function guard(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

/**
 * Presents a rack layout the way an architect reads one.
 *
 * Everything here is DCSC's verdict, not ours — in particular `unplaced` and
 * `errors`, which are how the server says a placement was refused.
 */
function projectLayout(layout: LayoutResult, workspace: WorkspaceSession): Record<string, unknown> {
  const unstable = layout.racks.filter((r) => r.stableStatus && r.stableStatus !== 'PASSED');
  const page = (path: string[]) => ({
    tool: 'dcsc_workspace_layout',
    arguments: {
      session: workspace.id,
      expectedWorkspaceRevision: workspace.revision,
      path,
      offset: 0,
      limit: 20,
    },
  });
  const rackRows = layout.racks.map((r) => ({
    rackId: r.id,
    code: r.code,
    description: r.description,
    sizeU: r.sizeU,
    usedU: r.usedU,
    freeU: r.freeU,
    totalWeightKg: r.totalWeightKg,
    stability: r.stableStatus,
    items: r.items,
  }));
  const full: Record<string, unknown> = {
    racks: rackRows,
    rackCount: layout.racks.length,
    unplaced: layout.unplaced,
    unplacedCount: layout.unplaced.length,
    errors: layout.errors,
    errorCount: layout.errors.length,
    pages: {
      racks: { total: layout.racks.length, inspect: page(['rawRackArea']) },
      unplaced: { total: layout.unplaced.length, inspect: page(['rawNonRackArea']) },
      errors: { total: layout.errors.length, inspect: page(['layoutErrors']) },
    },
    ...(layout.unplaced.length > 0
      ? {
          warning:
            `DCSC could not place ${layout.unplaced.length} item(s) in a rack. ` +
            'They remain outside the rack area — see errors for the rule that blocked them.',
        }
      : {}),
    ...(unstable.length > 0
      ? {
          stabilityWarning:
            `Centre-of-gravity check returned ${unstable
              .map((r) => `${r.code}=${r.stableStatus}`)
              .join(', ')}. FAILED means the rack is not safe to ship as laid out.`,
        }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(full, null, 2)) <= 7_000) return full;

  const clip = (value: string | undefined) => value === undefined
    ? { value: undefined, truncated: false }
    : value.length <= 160
      ? { value, truncated: false }
      : { value: value.slice(0, 160), truncated: true };
  const compactRacks = layout.racks.slice(0, 3).map((rack, index) => {
    const detail = page(['rawRackArea', String(index)]);
    const row: Record<string, unknown> = {
      sizeU: rack.sizeU, usedU: rack.usedU, freeU: rack.freeU,
      totalWeightKg: rack.totalWeightKg, stability: rack.stableStatus,
      itemCount: rack.items.length, errorCount: rack.errors.length, detail,
    };
    for (const [field, value] of [['rackId', rack.id], ['code', rack.code], ['description', rack.description]] as const) {
      const clipped = clip(value);
      if (clipped.value !== undefined) row[field] = clipped.value;
      if (clipped.truncated) row[`${field}Truncated`] = true;
    }
    return row;
  });
  const compactUnplaced = layout.unplaced.slice(0, 3).map((item, index) => {
    const detail = page(['rawNonRackArea', String(index)]);
    const row: Record<string, unknown> = { detail };
    for (const [field, value] of [['id', item.id], ['code', item.code], ['description', item.description]] as const) {
      const clipped = clip(value);
      if (clipped.value !== undefined) row[field] = clipped.value;
      if (clipped.truncated) row[`${field}Truncated`] = true;
    }
    return row;
  });
  const compactErrors = layout.errors.slice(0, 3).map((error, index) => {
    const detail = page(['layoutErrors', String(index)]);
    const row: Record<string, unknown> = { detail };
    for (const [field, value] of [['code', error.code], ['message', error.message]] as const) {
      const clipped = clip(value);
      if (clipped.value !== undefined) row[field] = clipped.value;
      if (clipped.truncated) row[`${field}Truncated`] = true;
    }
    return row;
  });
  const compact: Record<string, unknown> = {
    racks: compactRacks,
    rackCount: layout.racks.length,
    racksReturned: compactRacks.length,
    unplaced: compactUnplaced,
    unplacedCount: layout.unplaced.length,
    unplacedReturned: compactUnplaced.length,
    errors: compactErrors,
    errorCount: layout.errors.length,
    errorsReturned: compactErrors.length,
    pages: full['pages'],
    compacted: true,
    ...(layout.unplaced.length > 0
      ? { warning: `DCSC could not place ${layout.unplaced.length} item(s) in a rack. Follow pages.unplaced for the complete accepted state.` }
      : {}),
    ...(unstable.length > 0
      ? { stabilityWarning: `Centre-of-gravity check returned ${unstable.length} non-passing rack verdict(s). Follow pages.racks for complete details.` }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(compact, null, 2)) > 7_500) {
    throw new Error('Layout result context exceeds the response budget. Use dcsc_recovery_export to inspect the workspace.');
  }
  return compact;
}

function projectAutoConnectToolResult(
  workspace: WorkspaceSession,
  result: AutoConnectResult,
): Record<string, unknown> {
  const settings = Object.fromEntries(['autoAddPDU', 'autoAddSwitch', 'p2pCabling']
    .filter(key => typeof result.settings[key] === 'boolean')
    .map(key => [key, result.settings[key]]));
  const messageCount = result.messages.reduce((sum, group) => sum + group.messages.length, 0);
  const { networks: _networks, ...diagnostics } = cablingDiagnostics(
    [...workspace.configurations.values()].map(session => session.raw), workspace.serverState,
  );
  const page = (path: string[]) => ({
    tool: 'dcsc_workspace_layout',
    arguments: {
      session: workspace.id,
      expectedWorkspaceRevision: workspace.revision,
      path,
      offset: 0,
      limit: 20,
    },
  });
  const pages = {
    diagnostics: { inspect: page(['cablingDiagnostics']) },
    rawConnections: { total: result.rawConnections.length, inspect: page(['rawConnections']) },
    messages: { total: result.messages.length, messageCount, inspect: page(['autoConnectMessages']) },
  };
  const connections = result.connections.map(connection => ({
    id: connection.id,
    fromId: connection.fromId,
    fromPort: connection.fromPort,
    toId: connection.toId,
    toPort: connection.toPort,
    cableCode: connection.cableCode,
    description: connection.description,
  }));
  const note = result.connections.length === 0
    ? 'DCSC returned no connections. Inspect pages.diagnostics and Lenovo messages before changing hardware.'
    : undefined;
  const full: Record<string, unknown> = {
    session: workspace.id,
    revision: workspace.revision,
    mode: 'auto',
    settings,
    connectionCount: result.connections.length,
    diagnostics,
    connections,
    messageGroupCount: result.messages.length,
    messageCount,
    messages: result.messages,
    pages,
    ...(note ? { note } : {}),
    next: 'Inspect pages.diagnostics for missing networks. Use dcsc_cabling_connections to discover editable rows, then dcsc_edit_cabling_connection to change an existing connection.',
  };
  if (Buffer.byteLength(JSON.stringify(full, null, 2)) <= 7_000) return full;

  const clip = (value: string | undefined): { value?: string; truncated?: true } =>
    value === undefined ? {} : value.length <= 160 ? { value } : { value: value.slice(0, 160), truncated: true };
  const compactConnections = result.connections.slice(0, 5).map((connection, index) => {
    const projected: Record<string, unknown> = { detail: page(['rawConnections', String(index)]) };
    for (const field of ['id', 'fromId', 'fromPort', 'toId', 'toPort', 'cableCode', 'description'] as const) {
      const clipped = clip(connection[field]);
      if (clipped.value !== undefined) projected[field] = clipped.value;
      if (clipped.truncated) projected[`${field}Truncated`] = true;
    }
    return projected;
  });
  const compactMessages = result.messages.slice(0, 3).map((group, groupIndex) => {
    const rackId = clip(group.rackId);
    return {
      ...(rackId.value !== undefined ? { rackId: rackId.value } : {}),
      ...(rackId.truncated ? { rackIdTruncated: true } : {}),
      messageCount: group.messages.length,
      messages: group.messages.slice(0, 2).map((message, messageIndex) => {
        const clipped = clip(message);
        return clipped.truncated
          ? { text: clipped.value, truncated: true,
              detail: page(['autoConnectMessages', String(groupIndex), 'messages', String(messageIndex)]) }
          : message;
      }),
      detail: page(['autoConnectMessages', String(groupIndex)]),
    };
  });
  const compact: Record<string, unknown> = {
    ...full,
    connections: compactConnections,
    connectionsReturned: compactConnections.length,
    messages: compactMessages,
    messageGroupsReturned: compactMessages.length,
    compacted: true,
  };
  while (Buffer.byteLength(JSON.stringify(compact, null, 2)) > 7_000 && compactConnections.length > 0) {
    compactConnections.pop();
    compact['connectionsReturned'] = compactConnections.length;
  }
  while (Buffer.byteLength(JSON.stringify(compact, null, 2)) > 7_000 && compactMessages.length > 0) {
    compactMessages.pop();
    compact['messageGroupsReturned'] = compactMessages.length;
  }
  if (Buffer.byteLength(JSON.stringify(compact, null, 2)) > 7_500) {
    throw new Error('Auto-connect result context exceeds the response budget. Inspect the workspace recovery snapshot.');
  }
  return compact;
}

export function registerTools(server: McpServer, service: DcscService): void {
  registerReferenceSolutionTools(server, service);
  registerUnconfiguredTools(server, service);
  registerStorageTools(server, service);
  registerManualCablingTools(server, service);
  registerPowerControlTools(server, service);
  registerPciWizardTools(server, service);
  registerStorageWizardTools(server, service);
  registerStandaloneTools(server, service);
  registerReconciliationTools(server, service);
  registerValidationTools(server, service);
  registerRecoveryTools(server, service);
  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  server.registerTool(
    'dcsc_solution_modes',
    {
      title: 'List DCSC solution modes',
      description:
        'Lists available DCSC solution modes, their website labels, master slices and mode-specific website functions. ' +
        'Use this before planning networking, power preferences or automatic arrangement: these website controls differ by mode. Function flags describe website UI availability, not an API endpoint guarantee. Pass the exact mode into catalog and launch tools.',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const ctx = service.newCtx();
        const modes = await service.solutionModes(ctx);
        return { modes };
      }),
  );

  server.registerTool(
    'dcsc_find_products',
    {
      title: 'Search the DCSC product catalog',
      description:
        'Searches the Lenovo DCSC catalog for configurable products by name, model or product code. ' +
        'This is the normal way to get from a product name ("SR630 V3") to the product code ("7D73CTO1WW") that dcsc_launch needs. ' +
        'Prefer this over dcsc_browse_catalog.',
      inputSchema: {
        query: z.string().describe('Product name, model or code, e.g. "SR630 V3" or "7D73CTO1WW".'),
        type: z
          .enum(['CTO', 'LFO'])
          .optional()
          .describe('CTO = configure-to-order (built by Lenovo). LFO = preconfigured model.'),
        includeWithdrawn: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(50).optional().default(15),
        offset: z.number().int().min(0).optional().default(0),
        solutionMode: z.string().optional(),
        path: z.array(z.string()).optional().describe('Lossless detail path from a returned continuation.'),
        expectedCatalogFingerprint: z.string().optional().describe('Returned continuation fingerprint; rejects changed catalog or context.'),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const solution = await service.resolveSolution(ctx, args.solutionMode);
        const catalog = await service.catalog(ctx, solution);
        const page = searchCatalogPage(catalog, {
          query: args.query,
          ...(args.type !== undefined ? { type: args.type } : {}),
          includeWithdrawn: args.includeWithdrawn,
          limit: Math.max(catalog.entries.length, 1),
          offset: 0,
        });
        const hits = page.items;
        // A model is only configurable and importable in the modes whose
        // catalog contains it, and that is not always the mode searched.
        const availability = await service.modesContaining(
          ctx,
          hits.map((h) => h.code),
        );

        return projectCatalogPage({
          tool: 'dcsc_find_products', collection: 'products', context: ctx.locale,
          arguments: { query: args.query, type: args.type, includeWithdrawn: args.includeWithdrawn,
            solutionMode: solution.solutionMode },
          offset: args.offset, limit: args.limit, path: args.path,
          expectedCatalogFingerprint: args.expectedCatalogFingerprint,
          items: hits.map((h) => {
            const modes = availability.get(h.code.toUpperCase()) ?? [];
            return {
              code: h.code,
              type: h.type,
              description: h.description,
              path: h.path.join(' > '),
              ...(h.price !== undefined ? { listPrice: h.price } : {}),
              ...(h.withdrawn ? { withdrawn: true } : {}),
              availableIn: modes,
            };
          }),
          base: { solutionMode: solution.solutionMode, currency: ctx.locale.currency, country: ctx.locale.country,
            total: page.total, page: { total: page.total },
            action: 'dcsc_launch(productCode) to start configuring one of these.' },
        });
      }),
  );

  server.registerTool(
    'dcsc_browse_catalog',
    {
      title: 'Browse the DCSC catalog tree',
      description:
        'Walks one level of the DCSC category tree. Use only when you need to understand how the catalog is organised; ' +
        'dcsc_find_products is faster for locating a specific product. Follow the returned continuation unchanged; it pages categories and direct products together without gaps.',
      inputSchema: {
        path: z
          .array(z.string())
          .optional()
          .describe('Category breadcrumb, e.g. ["Servers", "Rack Server"]. Omit for the top level.'),
        offset: z.number().int().min(0).optional().default(0),
        categoryOffset: z.number().int().min(0).optional().default(0).describe('Category cursor returned by a continuation; pass it unchanged.'),
        limit: z.number().int().min(1).max(50).optional().default(25),
        includeWithdrawn: z.boolean().optional().default(false),
        solutionMode: z.string().optional(),
        detailPath: z.array(z.string()).optional().describe('Lossless detail path returned for an oversized category or product.'),
        expectedCatalogFingerprint: z.string().optional().describe('Returned continuation fingerprint; rejects changed catalog, breadcrumb or locale context.'),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const solution = await service.resolveSolution(ctx, args.solutionMode);
        const catalog = await service.catalog(ctx, solution);
        const result = browseCatalog(catalog, args.path ?? [], {
          offset: 0, limit: Math.max(catalog.entries.length, 1), includeWithdrawn: args.includeWithdrawn,
        });
        return projectCatalogBrowsePage({
          tool: 'dcsc_browse_catalog', context: ctx.locale, path: result.path,
          arguments: { path: result.path, solutionMode: solution.solutionMode,
            includeWithdrawn: args.includeWithdrawn },
          categories: result.children,
          products: result.products.map((p) => ({
            code: p.code,
            type: p.type,
            description: p.description,
          })),
          categoryOffset: args.categoryOffset, productOffset: args.offset, limit: args.limit,
          detailPath: args.detailPath,
          expectedCatalogFingerprint: args.expectedCatalogFingerprint,
        });
      }),
  );

  // -------------------------------------------------------------------------
  // Session lifecycle & Workspace
  // -------------------------------------------------------------------------

  server.registerTool(
    'dcsc_launch',
    {
      title: 'Start configuring a DCSC product',
      description:
        'Launches a configuration session for a product code and returns a compact summary (tabs, price, constraints). ' +
        'Returns a session handle used by all other configuration tools. Pass optional workspace to add a second product to a multi-product solution.',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision when adding a product to an existing workspace.'),
        productCode: z.string().describe('Product code from dcsc_find_products, e.g. "7D73CTO1WW".'),
        mode: z
          .enum(CONFIG_MODES)
          .optional()
          .default('cto')
          .describe('cto for configure-to-order, lfo for a preconfigured model.'),
        label: z.string().optional().describe('Optional friendly name for this session.'),
        workspace: z
          .string()
          .optional()
          .describe('Optional existing workspace or session ID to add a product to a multi-product solution.'),
        solutionMode: z.string().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const workspace = args.workspace ? service.sessions.getWorkspace(args.workspace) : undefined;
        if (args.workspace && !workspace) throw new Error(`Workspace ${args.workspace} not found.`);
        const ctx = service.newCtx(workspace ? { locale: workspace.locale, solution: workspace.solution } : {});
        const solution = await service.resolveSolution(ctx, args.solutionMode ?? workspace?.solution.solutionMode);

        // Launch succeeds for models outside the requested mode's catalog, but
        // the resulting configuration cannot be imported back under that mode.
        // Warn rather than block: the session is still usable and correctly
        // priced, the caller just needs to know which mode it belongs to.
        const availability = await service.modesContaining(ctx, [args.productCode]);
        const availableIn = availability.get(args.productCode.toUpperCase()) ?? [];
        const outOfCatalog = availableIn.length > 0 && !availableIn.includes(solution.solutionMode);

        const session = await service.launch({
          productCode: args.productCode,
          mode: args.mode,
          solution,
          ctx,
          workspaceId: args.workspace,
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
      }),
  );

  server.registerTool(
    'dcsc_session_list',
    {
      title: 'List open DCSC configuration sessions',
      description:
        'Lists the configuration sessions and multi-product workspaces currently open in this server, ' +
        'most recently used first. Paginated — a long-running server accumulates sessions and an ' +
        'unbounded list blows the response budget.',
      inputSchema: {
        workspace: z.string().optional().describe('Only list configurations in this workspace.'),
        limit: z.number().int().min(1).max(100).optional().default(15),
        offset: z.number().int().min(0).optional().default(0),
      },
    },
    async (args) =>
      guard(async () => {
        const limit = args.limit ?? 15;
        const offset = args.offset ?? 0;
        if (args.workspace && !service.sessions.getWorkspace(args.workspace)) {
          throw new Error(`Workspace ${args.workspace} not found.`);
        }
        const configurations = service.sessions.list()
          .filter(s => !args.workspace || s.workspaceId === args.workspace)
          .map(s => ({ session: s.id, configurationId: s.configurationId, workspace: s.workspaceId, kind: 'configuration',
            label: s.label?.slice(0, 128), product: s.product.code,
            description: s.product.description.slice(0, 60), revision: s.revision,
            totalPrice: s.raw.totalPrice ?? null, currency: s.locale.currency,
            updatedAt: new Date(s.lastAccessAt).toISOString() }));
        const standalone = service.sessions.listWorkspaces()
          .filter(ws => ws.configurations.size === 0 && (!args.workspace || ws.id === args.workspace))
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
        while (Buffer.byteLength(JSON.stringify(result(), null, 2)) > 7500 && page.length > 1) page.pop();
        return result();
      }),
  );

  server.registerTool(
    'dcsc_session_close',
    {
      title: 'Close a DCSC configuration session',
      description: 'Discards a configuration session or workspace and frees its memory.',
      inputSchema: { session: z.string(), expectedRevision: z.number().int().min(1).optional().describe('Expected configuration for a configuration handle, or workspace for a workspace handle revision.'), },
    },
    async (args) => guard(async () => ({ closed: await service.closeSession(args.session, args.expectedRevision) })),
  );

  server.registerTool(
    'dcsc_list_racks',
    {
      title: 'List rack cabinets and compatible chassis or nodes',
      description:
        'Lists rack cabinets. Pass session or productCode to return cabinets compatible with that product; omitted means the generic catalog. ' +
        'Use this to get a rackCode for dcsc_add_rack. Select hardwareType=chassis with a rack productCode, ' +
        'or hardwareType=node with a chassis productCode, to discover compatible nested hardware.',
      inputSchema: { solutionMode: z.string().optional(), session: z.string().optional(), productCode: z.string().optional(),
        hardwareType: z.enum(['rack', 'chassis', 'node']).optional().default('rack'),
        path: z.array(z.string()).optional().describe('Lossless detail path from a returned continuation.'),
        expectedCatalogFingerprint: z.string().optional().describe('Returned continuation fingerprint; rejects changed compatibility catalog or context.'),
        offset: z.number().int().min(0).optional().default(0), limit: z.number().int().min(1).max(50).optional().default(20) },
    },
    async (args) =>
      guard(async () => {
        const session = args.session ? requireSession(service, args.session) : undefined;
        if (session && args.productCode && args.productCode !== session.product.code) throw new Error('productCode conflicts with the selected configuration.');
        const masterCode = session?.product.code ?? args.productCode;
        const ctx = service.newCtx(session ? { locale: session.locale, solution: session.solution } : {});
        const solution = session?.solution ?? await service.resolveSolution(ctx, args.solutionMode);
        if (session && args.solutionMode && (await service.resolveSolution(ctx, args.solutionMode)).solutionMode !== solution.solutionMode) throw new Error('solutionMode conflicts with the selected configuration.');
        const hardwareType = args.hardwareType ?? 'rack';
        const racks = await service.rackCabinets(ctx, solution, masterCode, hardwareType);
        const result = projectCatalogPage({
          tool: 'dcsc_list_racks', collection: 'racks', context: ctx.locale,
          arguments: { session: args.session, productCode: args.productCode, solutionMode: solution.solutionMode, hardwareType },
          offset: args.offset, limit: args.limit, path: args.path,
          expectedCatalogFingerprint: args.expectedCatalogFingerprint, items: racks.map(rack => ({ ...rack })),
          base: { solutionMode: solution.solutionMode, hardwareType, total: racks.length, compatibleWith: masterCode ?? null,
            offset: args.offset, nextAction: hardwareType === 'rack'
              ? 'dcsc_add_rack(session, rackCode) to add one to a workspace.'
              : 'dcsc_launch(productCode, workspace) to configure the selected product, then dcsc_place_in_rack; include chassisId to copy a node into its chassis.' },
        });
        return args.path !== undefined ? result : { ...result, returned: (result.page as Record<string, unknown>).returned };
      }),
  );

  server.registerTool(
    'dcsc_add_rack',
    {
      title: 'Add a rack enclosure to a solution workspace',
      description:
        'Adds a rack cabinet to a solution workspace and returns the layout DCSC validated. ' +
        'The rack\'s U height, empty weight and placement rules come from DCSC, not from you — ' +
        'get valid rackCodes from dcsc_list_racks.',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
        session: z.string().describe('Session or workspace ID.'),
        rackCode: z.string().describe('Rack product code from dcsc_list_racks, e.g. "7D6DCTO1WW".'),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const layout = await service.addRack(args.session, args.rackCode, ctx, args.expectedRevision);
        const workspace = service.sessions.getWorkspace(args.session)!;
        return {
          session: args.session,
          revision: workspace.revision,
          ...projectLayout(layout, workspace),
          next: 'dcsc_place_in_rack(session, rackId, sessionId) to place a configuration in this rack.',
        };
      }),
  );

  server.registerTool(
    'dcsc_place_in_rack',
    {
      title: 'Place a configuration in a rack enclosure',
      description:
        'Places a configured product into a rack and returns DCSC\'s validated layout: occupied U positions, ' +
        'accumulated weight, and the centre-of-gravity stability verdict.\n' +
        'Omit uPosition to let DCSC choose a slot — placement rules are per product and per rack ' +
        '(an SR680a V3 cannot sit below U3 in a 42U cabinet), so guessing usually gets rejected.\n' +
        'Anything DCSC refuses to place is returned in "unplaced" with the reason in "errors" — always report those.\n' +
        'Places ONE item per configuration regardless of its quantity. For N nodes in a rack, ' +
        'create N configurations with dcsc_clone_configuration and place each. ' +
        'For managed storage, dcsc_place_storage_network creates instances; pass an existing physical instance ID here to move it. ' +
        'For a configured node in the non-rack area, supply chassisId to copy it into that placed chassis. ' +
        'This creates an independently editable node and retains the original; omit uPosition.',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
        session: z.string().describe('Session or workspace ID.'),
        rackId: z.string().describe('Rack ID from dcsc_add_rack.'),
        sessionId: z.string().describe('Configuration session/ID to place, or an existing managed-storage physical ID to move.'),
        chassisId: z.string().optional().describe('Placed chassis ID for Add Node As Copy. The source node remains in the non-rack area.'),
        uPosition: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('Starting U position. Omit to let DCSC arrange it.'),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const placed = service.sessions.get(args.sessionId);
        const quantity = placed?.raw.quantity ?? 1;

        const layout = await service.placeInRack(args.session, {
          rackId: args.rackId,
          expectedRevision: args.expectedRevision,
          sessionId: args.sessionId,
          ...(args.chassisId !== undefined ? { chassisId: args.chassisId } : {}),
          ...(args.uPosition !== undefined ? { position: args.uPosition } : {}),
          ctx,
        });
        const workspace = service.sessions.getWorkspace(args.session)!;
        return {
          session: args.session,
          revision: workspace.revision,
          ...projectLayout(layout, workspace),
          ...(layout.nestedPlacement ? { nestedPlacement: layout.nestedPlacement } : {}),
          // Quantity extends price and the export line but is still one
          // configuration, so the rack gains one item, not `quantity` items.
          ...(quantity > 1
            ? {
                quantityWarning:
                  `${args.sessionId} has quantity ${quantity}, but placement added ONE item ` +
                  `(${placed?.product.code ?? 'unknown'}) to the rack. The rack elevation, used U and ` +
                  'weight therefore reflect a single unit while the price reflects ' +
                  `${quantity}. Use dcsc_clone_configuration(session, count: ${quantity - 1}) and place ` +
                  'each copy to model the real cabinet.',
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    'dcsc_edit_layout',
    {
      title: 'Move, unplace, detach, remove or arrange workspace items',
      description: 'Edits a complete workspace atomically and reconciles it through DCSC. Moving preserves the existing physical instance. Arrange reorders rack contents; it does not place non-rack items, which require explicit move/place calls. Removing a rack or chassis defaults to retaining its products as non-rack items; contents="delete" explicitly deletes them. Detach matches the website Delete Node action: it removes a nested node from its chassis but retains its configuration and commercial lines, without creating a non-rack physical item. Lenovo reimport drops detached nodes; undo and use unplace to preserve them in a roundtrip. Remove deletes the configuration. Use workspace history to undo or redo accepted edits.',
      inputSchema: {
        session: z.string().describe('Workspace ID, or a configuration handle in that workspace.'),
        action: z.enum(['move', 'unplace', 'detach', 'remove', 'arrange']),
        configuration: z.string().optional().describe('Configuration session handle or physical instance ID; required except for arrange. Unplace with a managed storage template handle moves all its instances, matching Summary. A physical storage ID targets only that instance.'),
        rackId: z.string().optional().describe('Destination rack ID for move.'),
        uPosition: z.number().int().min(1).optional(),
        contents: z.enum(['unplace', 'delete']).default('unplace').describe('Disposition of products inside a removed rack or chassis. unplace preserves children as loose physical items; delete removes their configurations too.'),
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
      },
    },
    async (args) => guard(async () => {
      const workspace = service.sessions.getWorkspace(args.session);
      if (!workspace) throw new Error('Workspace not found.');
      const ctx = service.newCtx({ locale: workspace.locale, solution: workspace.solution });
      if (args.action !== 'arrange' && !args.configuration) throw new Error('configuration is required for this action.');
      let layout: LayoutResult;
      if (args.action === 'move') {
        if (!args.rackId) throw new Error('rackId is required when moving a configuration.');
        layout = await service.placeInRack(workspace.id, { rackId: args.rackId,
          sessionId: args.configuration!, position: args.uPosition, expectedRevision: args.expectedRevision, ctx });
      } else {
        layout = await service.editLayout(workspace.id, { action: args.action, configurationId: args.configuration,
          contents: args.contents, expectedRevision: args.expectedRevision, ctx });
      }
      return { workspace: workspace.id, revision: workspace.revision, ...projectLayout(layout, workspace),
        ...(args.action === 'detach' ? { warning: 'The node configuration remains in this workspace and its commercial export. Lenovo reimport drops detached nodes. Undo this action and use unplace to retain the node through an export/import roundtrip.' } : {}) };
    }),
  );

  server.registerTool(
    'dcsc_workspace_history',
    {
      title: 'Undo or redo a workspace edit',
      description: 'Restores the complete previous or next committed workspace, including configurations, floor placement, cabling and preferences. The restored state is persisted atomically; revisions remain monotonic. History is bounded to ten edits.',
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
    }),
  );

  server.registerTool(
    'dcsc_add_cabling',
    {
      title: 'Generate native cabling or record a local planning link',
      description:
        'Builds port-to-port cabling for a workspace.\n' +
        'Default mode is "auto": posts the current rack layout to DCSC /auto_connect and replaces ' +
        'the workspace cable list with the connections the server returns. Zero connections do not establish success: inspect the returned diagnostics for missing networks.\n' +
        'Optional settings match the website Automated Rack PDU, Automated Switch and P2P Cabling controls; ' +
        'provided fields are persisted with the accepted result and reused for subsequent layout/cabling calls.\n' +
        'Mode "manual" records a single port map locally for planning; DCSC does not validate ' +
        'these links, and they are excluded from Lenovo exports. Inspect them with dcsc_workspace_layout. Prefer auto for exportable connections. Manual endpoint/cable fields are rejected in auto mode rather than ignored. ' +
        'For native manual creation, use dcsc_manual_cabling_options followed by dcsc_create_cabling_connection. To edit existing native connections, use dcsc_cabling_connections followed by dcsc_edit_cabling_connection.',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
        session: z.string().describe('Session or workspace ID.'),
        mode: z
          .enum(['auto', 'manual'])
          .optional()
          .default('auto')
          .describe('auto = DCSC /auto_connect (default). manual = local port map only.'),
        settings: z.object({
          autoAddPDU: z.boolean().optional().describe('Automatically add rack PDUs. Disable when planning without automated PDU selection.'),
          autoAddSwitch: z.boolean().optional().describe('Automatically add switches for selected networking preferences.'),
          p2pCabling: z.boolean().optional().describe('Enable point-to-point cabling.'),
        }).strict().optional().describe('Auto mode only. Omitted fields retain the saved setting.'),
        fromConfigId: z
          .string()
          .optional()
          .describe('Manual mode: source configuration ID (DCSC configuration id).'),
        fromPort: z.string().optional().describe('Manual mode: source port name or number.'),
        toConfigId: z.string().optional().describe('Manual mode: destination configuration ID.'),
        toPort: z.string().optional().describe('Manual mode: destination port name or number.'),
        cableCode: z.string().optional().describe('Manual mode: optional cable part code.'),
        description: z.string().optional().describe('Manual mode: optional description.'),
      },
    },
    async (args) =>
      guard(async () => {
        const mode = args.mode ?? 'auto';
        if (mode === 'manual' && args.settings !== undefined) {
          throw new Error('Auto-connect settings require mode="auto".');
        }
        if (mode === 'auto' && [args.fromConfigId, args.fromPort, args.toConfigId, args.toPort,
          args.cableCode, args.description].some(value => value !== undefined)) {
          throw new Error('Endpoint, cableCode and description fields require mode="manual", which saves a local planning link excluded from Lenovo exports. ' +
            'Auto mode cannot create a specified manual connection: omit those fields to run native Auto-Connect, ' +
            'use dcsc_manual_cabling_options and dcsc_create_cabling_connection for native manual creation, or use dcsc_cabling_connections and dcsc_edit_cabling_connection to edit an existing native row.');
        }
        if (mode === 'auto') {
          const ctx = service.newCtx();
          const result = await service.runAutoConnect(args.session, ctx, args.expectedRevision, args.settings);
          return projectAutoConnectToolResult(service.sessions.getWorkspace(args.session)!, result);
        }

        if (!args.fromConfigId || !args.fromPort || !args.toConfigId || !args.toPort) {
          throw new Error(
            'Manual mode requires fromConfigId, fromPort, toConfigId and toPort. ' +
              'Or omit them and use mode "auto" to let DCSC cable the layout.',
          );
        }
        const link = await service.addManualCabling(args.session, {
          fromConfigId: args.fromConfigId,
          fromPort: args.fromPort,
          toConfigId: args.toConfigId,
          toPort: args.toPort,
          ...(args.cableCode !== undefined ? { cableCode: args.cableCode } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
        }, args.expectedRevision);
        return {
          session: args.session,
            revision: service.sessions.getWorkspace(args.session)!.revision,
          mode: 'manual',
          cabling: link,
          includedInLenovoExport: false,
          warning:
            'This planning link is saved locally and excluded from Lenovo exports. ' +
            'Prefer mode "auto" (dcsc_add_cabling with mode auto) for server-authored connections.',
          next: 'dcsc_add_cabling(session, mode: "auto") to replace manual links with DCSC auto-connect.',
        };
      }),
  );

  server.registerTool(
    'dcsc_import',
    {
      title: 'Import a Lenovo CFXML or Excel configuration',
      description:
        'Imports a saved Lenovo CFXML string or a local CFXML/Excel file into a configuration session or workspace. Excel files are uploaded intact to Lenovo; use an exported DCSC workbook, not an arbitrary spreadsheet. Specify solutionMode for Excel when the design is outside General Purpose.',
      inputSchema: {
        content: z.string().optional().describe('XML content string of the CFXML file.'),
        filePath: z.string().optional().describe('Absolute local file path to a CFXML (.xml) or DCSC Excel (.xlsx/.xls) file.'),
        mode: z.enum(CONFIG_MODES).optional(),
        expectedRevision: z.number().int().min(1).optional(),
        workspace: z.string().optional().describe('Optional existing workspace ID to import into.'),
        solutionMode: z
          .string()
          .optional()
          .describe(
            'Solution mode to import under. Defaults to the existing workspace mode, otherwise the XML declaration or General Purpose for Excel. ' +
              'DCSC resolves each model against this mode\'s catalog, so a model outside it ' +
              'is rejected even though the file is valid.',
          ),
      },
    },
    async (args) =>
      guard(async () => {
        let importContent: string | Uint8Array | undefined = args.content;
        const inputPath = args.filePath ?? (args.content &&
          (/\.(xml|xlsx|xls)$/i.test(args.content) || args.content.startsWith('/') || args.content.startsWith('./'))
          ? args.content : undefined);
        if (inputPath) {
          const { readFileSync } = await import('node:fs');
          importContent = readFileSync(inputPath);
        }
        if (!importContent) {
          throw new Error('Either content string or filePath must be provided.');
        }

        const ctx = service.newCtx();
        const res = await service.importConfig({
          content: importContent,
          ctx,
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          expectedRevision: args.expectedRevision,
          ...(args.workspace !== undefined ? { workspaceId: args.workspace } : {}),
          ...(args.solutionMode !== undefined ? { solutionMode: args.solutionMode } : {}),
          ...(inputPath !== undefined
            ? { fileName: inputPath.split(/[\\/]/).pop() ?? 'configuration.xml' }
            : {}),
        });

        const { missingParts, removedParts, replacedParts, eccnRestricted } = res.diagnostics;
        const lostParts = missingParts.length + removedParts.length;

        return {
          workspace: res.workspaceId,
          importedConfigurations: res.sessions.length,
          ...(res.standaloneKind ? { standaloneKind: res.standaloneKind } : {}),
          warnings: res.diagnostics.warnings ?? [],
          sessions: res.sessions.map((s) => ({
            id: s.id,
            productCode: s.product.code,
            description: s.product.description,
            quantity: s.raw.quantity ?? 1,
            totalPrice: configurationListPrice(s.raw),
            priceAvailable: configurationListPrice(s.raw) !== null,
          })),
          // Reported by DCSC's own import, so an empty set here means the file
          // round-trips cleanly through the real configurator, not merely that
          // the codes were re-launchable.
          missingParts,
          removedParts,
          replacedParts,
          eccnRestricted,
          ...(lostParts > 0
            ? {
                warning:
                  `DCSC could not carry ${lostParts} part(s) across the import. ` +
                  'The imported configuration is incomplete and its price is not comparable ' +
                  'to the original.',
              }
            : {}),
          next: res.standaloneKind ? { tool: res.standaloneKind === 'software' ? 'dcsc_software_inspect' : 'dcsc_services_inspect', arguments: { workspace: res.workspaceId } } : { tool: 'dcsc_session_info', arguments: { session: res.workspaceId } },
        };
      }),
  );

  server.registerTool(
    'dcsc_place_on_floor',
    {
      title: 'Place a rack on the floor grid (planning only)',
      description:
        'Positions a rack on floor-tile coordinates (x, y) for layout planning.\n' +
        'IMPORTANT: DCSC has no floor-grid endpoint — the web UI keeps the grid client-side too. ' +
        'This tool only checks that the rack exists in the workspace and that the tile is free. ' +
        'Floor placement is included in workspace exports.',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
        session: z.string().describe('Session or workspace ID.'),
        rackId: z.string().describe('Rack ID from dcsc_add_rack (configuration id of the rack).'),
        x: z.number().int().min(0).describe('Floor tile X coordinate (0-based).'),
        y: z.number().int().min(0).describe('Floor tile Y coordinate (0-based).'),
      },
    },
    async (args) =>
      guard(async () => {
        const result = await service.placeOnFloor(args.session, args.rackId, args.x, args.y, args.expectedRevision);
        return {
          session: args.session,
          revision: service.sessions.getWorkspace(args.session)!.revision,
          floorPlacement: result.item,
          clientSide: result.clientSide,
          warning: result.warning,
          next: 'dcsc_workspace_layout(session) to list floor items.',
        };
      }),
  );

  server.registerTool('dcsc_set_rack_lock', {
    title: 'Lock or unlock a rack item or empty U position',
    description: 'Locks an existing direct rack item in place, or reserves one empty rack U, using the website Lock/Unlock workflow. Positions are one-based. Returns the accepted server state; changes, repricing and workspace history commit atomically.',
    inputSchema: {
      session: z.string().describe('Workspace or configuration handle.'),
      target: z.union([
        z.object({ itemId: z.string().min(1).describe('Physical item ID from dcsc_workspace_layout.') }).strict(),
        z.object({ rackId: z.string().min(1), position: z.number().int().min(1).describe('Empty U position, one-based.') }).strict(),
      ]),
      locked: z.boolean().describe('true to lock; false to unlock.'),
      expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
    },
  }, async args => guard(async () => {
    const { layout: _layout, ...accepted } = await service.setRackLock(args.session, {
      target: args.target, locked: args.locked, expectedRevision: args.expectedRevision, ctx: service.newCtx(),
    });
    const workspace = service.sessions.getWorkspace(args.session)!;
    return { ...accepted, workspace: workspace.id, workspaceRevision: workspace.revision,
      revisionScope: 'workspace', next: { tool: 'dcsc_workspace_layout', arguments: { session: workspace.id } } };
  }));

  server.registerTool('dcsc_copy_rack_item', {
    title: 'Copy a configured rack item independently',
    description: 'Performs the website rack Copy action for one direct, rule-free General Purpose CTO item with quantity one. Creates an independently editable configuration named Copy_<source name> in the same rack, validates placement and re-derives the workspace atomically. Unlike Clone Multiple, the copy has separate commercial lines and edits do not propagate to its source. Populated HPC chassis with direct node children are also supported: Copy creates independent child configurations using the native physical customize workflow. A linked source can be copied through its root or a member; the original parent/child groups remain linked and the copy is independent. Managed storage templates, deeper containers and VLH items require separate workflows.',
    inputSchema: {
      session: z.string().describe('Explicit configuration handle of the racked item to copy.'),
      expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
    },
  }, async args => guard(async () => {
    const { source, copy, placement, nestedCopies } = await service.copyRackItem(args.session, {
      expectedRevision: args.expectedRevision, ctx: service.newCtx(),
    });
    return {
      ...projectSummary({ sessionId: copy.id, revision: copy.revision, raw: copy.raw, index: copy.index,
        currency: copy.locale.currency, country: copy.locale.country, pricedAt: copy.pricedAt }),
      workspace: copy.workspaceId,
      workspaceRevision: service.sessions.getWorkspace(copy.workspaceId)!.revision,
      configurationId: copy.configurationId, name: copy.raw.name,
      nestedConfigurationsCreated: nestedCopies.length,
      source: { session: source.id, configurationId: source.configurationId },
      placement,
      inspect: { tool: 'dcsc_workspace_layout', arguments: { session: copy.workspaceId } },
      next: { tool: 'dcsc_list_options', arguments: { session: copy.id } },
    };
  }));

  server.registerTool(
    'dcsc_clone_configuration',
    {
      title: 'Duplicate a configured product N times in the same workspace',
      description:
        'Copies an already-configured product into N additional configurations in the same ' +
        'solution workspace, identical down to the feature codes.\n' +
        'This is what you want for "8 of these nodes in a rack". dcsc_set_quantity prices N units ' +
        'but is a single configuration, so it places ONE item in a rack — only separate ' +
        'configurations can occupy separate U positions.\n' +
        'By default creates configuration copies locally; place each with dcsc_place_in_rack. ' +
        'Use placement="same-rack" for the website Clone Multiple workflow on a direct racked CTO item ' +
        'with quantity one and supported product/machine-type capacity bounds. It finds free U positions and validates/derives the complete layout atomically. ' +
        'Populated chassis clone their direct node children into separate linked groups. VLH, deeper containers, complex placement rules and the separate website Copy action are not supported by this mode.',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
        session: z.string().describe('Session holding the configured template product.'),
        placement: z.enum(['none', 'same-rack']).optional().describe('Default none creates configuration copies; same-rack also performs physical Clone Multiple.'),
        count: z
          .number()
          .int()
          .min(1)
          .max(32)
          .describe('How many additional copies to create (the source is not counted).'),
        labelPrefix: z
          .string()
          .optional()
          .describe('Names clones "<prefix> 2", "<prefix> 3", … Defaults to the source label.'),
      },
    },
    async (args) =>
      guard(async () => {
        const { source, clones, placements, nestedConfigurations } = await service.cloneConfiguration({
          sessionHandle: args.session,
          count: args.count,
          expectedRevision: args.expectedRevision,
          placement: args.placement,
          ctx: service.newCtx(),
          ...(args.labelPrefix !== undefined ? { labelPrefix: args.labelPrefix } : {}),
        });
        const unit = configurationListPrice(source.raw);
        const configurations = [source, ...clones, ...nestedConfigurations ?? []];
        const priceAvailable = configurations.every(session => configurationListPrice(session.raw) !== null);
        const total = configurations.reduce((sum, session) =>
          sum + (configurationListPrice(session.raw) ?? 0) * (session.raw.quantity ?? 1), 0);
        return {
          workspace: source.workspaceId,
          revision: source.revision,
          workspaceRevision: service.sessions.getWorkspace(source.workspaceId)!.revision,
          source: { session: source.id, productCode: source.product.code, unitPrice: unit },
          created: clones.map((c) => ({
            session: c.id,
            configurationId: c.configurationId,
            label: c.label,
            unitPrice: configurationListPrice(c.raw),
          })),
          totalConfigurations: configurations.length,
          ...(nestedConfigurations ? { nestedConfigurationsCreated: nestedConfigurations.length * clones.length / (clones.length + 1) } : {}),
          combinedListPrice: priceAvailable ? Math.round(total * 100) / 100 : null,
          priceAvailable,
          ...(!priceAvailable ? { knownListPriceSubtotal: Math.round(total * 100) / 100 } : {}),
          currency: source.locale.currency,
          priceType: 'LIST',
          nodeRole: source.reduced.nodeRole,
          ...(placements ? { placements } : {}),
          next: placements
            ? { tool: 'dcsc_workspace_layout', arguments: { session: source.workspaceId } }
            : 'dcsc_place_in_rack(session, rackId, sessionId) for each, or dcsc_scale_out to size racks first.',
        };
      }),
  );

  server.registerTool(
    'dcsc_workspace_layout',
    {
      title: 'Read back the validated rack and floor layout',
      description:
        'Returns the physical layout of a solution workspace: each rack with its U occupancy, ' +
        'weight and centre-of-gravity verdict, the items inside it, the cable list, floor tiles ' +
        'and per-rack power selections. Large collections return executable, revision-bound pages.\n' +
        'Use this view to inspect accepted placements and connections before exporting the complete workspace.',
      inputSchema: {
        session: z.string().describe('Session or workspace ID.'),
        path: z.array(z.string()).optional().describe('Detail path from a returned inspect/detail continuation.'),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(1000).optional().default(20),
        expectedWorkspaceRevision: z.number().int().min(1).optional()
          .describe('Revision supplied by a continuation; rejects pages from a workspace that changed.'),
      },
    },
    async (args) =>
      guard(async () => {
        const ws = service.sessions.getWorkspace(args.session);
        if (!ws) throw new Error(`Session / Workspace ${args.session} not found`);
        if (args.expectedWorkspaceRevision !== undefined && args.expectedWorkspaceRevision !== ws.revision) {
          throw new Error(
            `Workspace ${ws.id} changed from revision ${args.expectedWorkspaceRevision} to ${ws.revision}. ` +
            'Restart dcsc_workspace_layout without path before following new continuations.',
          );
        }
        if (args.path !== undefined) {
          if (args.expectedWorkspaceRevision === undefined) {
            throw new Error(
              'expectedWorkspaceRevision is required for detail pages. ' +
              'Call dcsc_workspace_layout without path and follow its continuation.',
            );
          }
          return projectWorkspacePage(ws, {
            tool: 'dcsc_workspace_layout',
            arguments: { session: ws.id, expectedWorkspaceRevision: ws.revision },
            path: args.path,
            offset: args.offset,
            limit: args.limit,
          });
        }
        return projectWorkspaceLayout(ws, {
          tool: 'dcsc_workspace_layout',
          arguments: { session: ws.id, expectedWorkspaceRevision: ws.revision },
        });
      }),
  );

  server.registerTool(
    'dcsc_configure_pdu',
    {
      title: 'Select PDUs and power cords on a rack',
      description:
        'Configures power distribution on a rack cabinet that was added with dcsc_add_rack.\n' +
        'The rack is a full configuration: its Power tab lists PDU, RACK_POWERCABLE and LINECORD ' +
        'options. This tool applies the selection through DCSC autoDerive and returns what the ' +
        'server accepted (quantity and price), not a local guess.\n' +
        'Call with only session+rackId to list available options and sidewall placement rules. ' +
        'Then call again with pduCode (and optional cordCode, quantity).',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
        session: z.string().describe('Session or workspace ID.'),
        rackId: z.string().describe('Rack ID from dcsc_add_rack (configuration id of the rack).'),
        pduCode: z
          .string()
          .optional()
          .describe('PDU feature code from the catalog, e.g. "C0CS". Omit to list options only.'),
        cordCode: z
          .string()
          .optional()
          .describe('Line cord or rack power cable feature code, e.g. "6500".'),
        quantity: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(1)
          .describe('Quantity for pduCode/cordCode. 0 removes. Default 1.'),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const result = await service.configurePdu(args.session, args.rackId, {
          ...(args.pduCode !== undefined ? { pduCode: args.pduCode } : {}),
          ...(args.cordCode !== undefined ? { cordCode: args.cordCode } : {}),
          quantity: args.quantity ?? 1,
          expectedRevision: args.expectedRevision,
          ctx,
        });

        if (result.catalog) {
          // Bucket by section before truncating. A single mixed list sorted by
          // whatever order DCSC returned put 25 jumper cords ahead of the first
          // LINECORD, so a flat slice(0, 20) hid every line cord on the rack —
          // and a rack whose PDUs cannot reach facility power is not orderable.
          // Kept lean: the bucket names carry the section, and these lists are
          // long enough that repeating it blows the response budget.
          const project = (o: (typeof result.catalog.options)[number]) => ({
            code: o.code,
            desc: o.description.slice(0, 64),
            max: o.max,
            unitPrice: o.unitPrice,
            ...(o.selectedQty > 0 ? { selectedQty: o.selectedQty } : {}),
          });
          const bucket = (pred: (s: string) => boolean, limit: number) => {
            const all = result.catalog!.options.filter((o) => pred(o.section.toUpperCase()));
            return {
              total: all.length,
              shown: Math.min(all.length, limit),
              truncated: all.length > limit,
              options: all.slice(0, limit).map(project),
            };
          };

          // Line cords get the most room: they are country- and voltage-
          // specific, so picking from a truncated list is how you get a rack
          // that cannot plug into the site.
          const pdus = bucket((s) => s === 'PDU', 14);
          const lineCords = bucket((s) => s === 'LINECORD', 18);
          const jumpers = bucket((s) => s === 'RACK_POWERCABLE', 6);
          const other = bucket(
            (s) => s !== 'PDU' && s !== 'LINECORD' && s !== 'RACK_POWERCABLE',
            4,
          );

          return {
            session: args.session,
            rackId: result.rackId,
            revision: service.sessions.getWorkspace(args.session)!.revision,
            rackSession: result.rackSessionId,
            listing: true,
            pduOptions: pdus.options,
            /** Feeds the rack from facility power. Required alongside any PDU. */
            lineCordOptions: lineCords.options,
            /** Connects installed equipment to the PDU outlets. Not a substitute. */
            jumperCordOptions: jumpers.options,
            otherPowerOptions: other.options,
            // Numbers only — spreading the buckets here serialised every
            // option list a second time and doubled the response.
            counts: {
              pdu: { total: pdus.total, shown: pdus.shown, truncated: pdus.truncated },
              lineCord: {
                total: lineCords.total,
                shown: lineCords.shown,
                truncated: lineCords.truncated,
              },
              jumperCord: {
                total: jumpers.total,
                shown: jumpers.shown,
                truncated: jumpers.truncated,
              },
              other: { total: other.total, shown: other.shown, truncated: other.truncated },
            },
            placementRules: result.catalog.placementRules,
            totalCombinedSlots: result.catalog.totalCombinedSlots,
            selected: result.selected,
            totalPrice: result.totalPrice,
            priceType: 'LIST',
            lineCordNote:
              lineCords.total === 0
                ? 'This rack tree carries no LINECORD options — check dcsc_list_options(rackSession, tab: "Power").'
                : 'A PDU needs a LINECORD to reach facility power; jumper cords only connect equipment ' +
                  'to the PDU. Line cords are country- and voltage-specific, so pick one that matches ' +
                  'the site feed.',
            next:
              'dcsc_configure_pdu(session, rackId, pduCode: "<code>", cordCode: "<lineCord>", quantity: N). ' +
              'Prices are anonymous LIST prices.',
          };
        }

        return {
          session: args.session,
          rackId: result.rackId,
            revision: service.sessions.getWorkspace(args.session)!.revision,
          rackSession: result.rackSessionId,
          powerSelection: result.selection,
          selected: result.selected,
          totalPrice: result.totalPrice,
          priceType: 'LIST',
          powerReadiness: result.powerReadiness,
          note:
            'Selection was applied through DCSC autoDerive. totalPrice is the rack cabinet LIST price ' +
            'after the change, not a quote.',
          next:
            result.powerReadiness && !result.powerReadiness.complete
              ? 'dcsc_configure_pdu(session, rackId, cordCode: "<code>", quantity: N) to add the line cords ' +
                'this rack still needs.'
              : 'dcsc_session_info(rackSession) for the full rack BOM, or dcsc_workspace_layout(session).',
        };
      }),
  );

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  server.registerTool(
    'dcsc_session_info',
    {
      title: 'Summarise a DCSC configuration or workspace',
      description:
        'Returns the compact summary of a configuration or multi-product workspace: products, quantities, prices, tabs and constraints. Large workspace collections return executable, revision-bound pages. A one-configuration summary reports its configuration revision and the separate workspaceRevision; use the revision matching the target of a mutation.',
      inputSchema: {
        session: z.string(),
        path: z.array(z.string()).optional().describe('Detail path from a returned inspect/detail continuation.'),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(1000).optional().default(20),
        expectedWorkspaceRevision: z.number().int().min(1).optional()
          .describe('Revision supplied by a continuation; rejects pages from a workspace that changed.'),
      },
    },
    async (args) =>
      guard(async () => {
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
        if (args.expectedWorkspaceRevision !== undefined && args.expectedWorkspaceRevision !== workspace.revision) {
          throw new Error(
            `Workspace ${workspace.id} changed from revision ${args.expectedWorkspaceRevision} to ${workspace.revision}. ` +
            'Restart dcsc_session_info without path before following new continuations.',
          );
        }
        if (args.path !== undefined) {
          if (args.expectedWorkspaceRevision === undefined) {
            throw new Error(
              'expectedWorkspaceRevision is required for detail pages. ' +
              'Call dcsc_session_info without path and follow its continuation.',
            );
          }
          return projectWorkspacePage(workspace, {
            tool: 'dcsc_session_info',
            arguments: { session: workspace.id, expectedWorkspaceRevision: workspace.revision },
            path: args.path,
            offset: args.offset,
            limit: args.limit,
          });
        }
        if (resolved.kind === 'workspace' && resolved.workspace.configurations.size === 0) {
          const kind = workspace.serverState.standaloneServiceState ? 'service'
            : workspace.serverState.standaloneSoftwareState ? 'software' : 'empty';
          return { workspace: workspace.id, revision: workspace.revision, workspaceRevision: workspace.revision, revisionScope: 'workspace', kind,
            configurations: [],
            ...projectWorkspaceIntegrity(workspace, { tool: 'dcsc_session_info',
              arguments: { session: workspace.id, expectedWorkspaceRevision: workspace.revision } }),
            currency: workspace.locale.currency, country: workspace.locale.country,
            ...(kind !== 'empty' ? { next: { tool: kind === 'service' ? 'dcsc_services_inspect' : 'dcsc_software_inspect',
              arguments: { workspace: workspace.id } } } : {}),
          };
        }
        if (
          resolved.kind === 'workspace' &&
          (workspace.configurations.size > 1 || workspace.serverState.standaloneSoftwareState ||
            unplacedManagedStorageComponentIds(workspace).size > 0)
        ) {
          return projectWorkspaceSummary(workspace, {
            tool: 'dcsc_session_info',
            arguments: { session: workspace.id, expectedWorkspaceRevision: workspace.revision },
          });
        }

        const session = requireSession(service, args.session);

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
            arguments: { session: workspace.id, expectedWorkspaceRevision: workspace.revision } }),
          validationMode: session.validationMode,
          autoCorrect: session.autoCorrect,
          mode: session.mode,
          primed: session.primed,
          configurable: session.configurable,
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
      }),
  );

  server.registerTool(
    'dcsc_list_options',
    {
      title: 'List or search configurable options',
      description:
        'Explores the option tree of a configuration. Search first, browse only to understand structure.\n' +
        '  - query: searches every tab and returns matches with their location. This is usually what you want.\n' +
        '  - tab: lists the sections of one tab with current selections, but no option lists.\n' +
        '  - section: lists the individual options in one section, paginated, priced relative to the current selection.\n' +
        'Services tab includes warranty packages and their component service lines. Configure a returned section/feature target and inspect the accepted selection and price.\n' +
        'Results are deliberately compact; use dcsc_get_feature to confirm details before selecting.',
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
      }),
  );

  server.registerTool(
    'dcsc_get_feature',
    {
      title: 'Get full detail for option codes',
      description:
        'Returns complete detail for up to 10 feature codes, including the attribute map and untruncated description. ' +
        'Use this to confirm a choice before selecting it — list views omit attributes that can be decisive ' +
        '(socket limits, thermal requirements, form factor).',
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
      }),
  );

  server.registerTool(
    'dcsc_get_configuration',
    {
      title: 'Get the selected parts of a configuration',
      description:
        'Returns the flat list of everything currently selected in a configuration, grouped by tab — ' +
        'the bill of materials view. Use this to review or report a configuration.',
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
        while (Buffer.byteLength(JSON.stringify(result, null, 2)) > 7500 && page.length > 1) {
          page.pop(); result = project();
        }
        if (Buffer.byteLength(JSON.stringify(result, null, 2)) > 7500) {
          throw new Error('Configuration summary exceeds the response budget. Use dcsc_list_options with selectedOnly=true to inspect selected parts.');
        }
        return result;
      }),
  );

  server.registerTool(
    'dcsc_validate',
    {
      title: 'Validate a configuration with DCSC (LMC)',
      description:
        'Runs DCSC\'s manufacturing validation (/lmc_validation) using the same payload shape the web UI exports, ' +
        'and merges any expansionMessages already on the configuration tree.\n' +
        'Submits a job and retrieves its authoritative result. A job ID or LMC link alone is not success. Returns valid/invalid/unavailable with revision, payload hash and separate local diagnostics. Interrupted validation requires a fresh request.',
      inputSchema: {
        session: z.string().describe('Session or workspace ID.'),
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
      }),
  );

  server.registerTool(
    'dcsc_list_locales',
    {
      title: 'List DCSC countries, languages and currencies',
      description:
        'Returns the country/region catalogue from DCSC /locales. Pick a full row (country + language + currency + geo) — ' +
        'mismatched pairings cause HTTP 500s. Pass the result into dcsc_set_locale or launch with a resolved locale.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Optional filter on country name or code, e.g. "Germany" or "DE".'),
        limit: z.number().int().min(1).max(50).optional().default(20),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        let locales = await service.listLocales(ctx);
        locales = locales.filter((l) => !l.countryInvalid);
        if (args.query) {
          const q = args.query.toLowerCase();
          locales = locales.filter(
            (l) =>
              l.countryCode.toLowerCase().includes(q) ||
              l.countryName.toLowerCase().includes(q) ||
              l.currency.toLowerCase().includes(q),
          );
        }
        const limit = args.limit ?? 20;
        return {
          count: locales.length,
          locales: locales.slice(0, limit).map((l) => ({
            country: l.countryCode,
            name: l.countryName,
            currency: l.currency,
            geo: l.region,
            languages: l.languages.map((x) => x.languageCode),
            defaultLanguage: l.languages.find((x) => x.defaulted)?.languageCode ?? l.languages[0]?.languageCode,
          })),
          current: service.locale,
          next: 'dcsc_set_locale(country: "DE") then dcsc_launch — new sessions use the chosen locale.',
        };
      }),
  );

  server.registerTool(
    'dcsc_set_locale',
    {
      title: 'Set country / language / currency for subsequent DCSC calls',
      description:
        'Resolves a country against DCSC /locales and sets the process locale used by newCtx/launch. ' +
        'This process-only default resets to configured locale after restart; existing saved workspaces retain their own locales. Prices after a locale change are still anonymous LIST prices for that country/currency.',
      inputSchema: {
        country: z.string().describe('ISO country code from dcsc_list_locales, e.g. "US", "DE", "GB".'),
        language: z.string().optional().describe('Optional language code; defaults to the country default.'),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const locale = await service.resolveLocale(ctx, args.country, args.language);
        service.setLocale(locale);
        return {
          locale,
          scope: 'process-default',
          persisted: false,
          priceType: 'LIST',
          note:
            'Subsequent launches and catalog searches use this locale. ' +
            'Prices are anonymous LIST prices for the configured country/currency, not a quote.',
          next: 'dcsc_launch or dcsc_find_products under the new locale.',
        };
      }),
  );

  server.registerTool(
    'dcsc_service_categories',
    {
      title: 'List Services portal categories (anonymous)',
      description:
        'Lists the top of the Lenovo Services portal category tree available without login.\n' +
        'On a launched product, use dcsc_list_options(session, tab: "Services") or query "warranty" to see ' +
        'the Services tab (package UI + currently selected CFC lines such as base warranty). ' +
        'Use dcsc_configure for an attached warranty package, or dcsc_services_launch for independently purchased product-bound services.',
      inputSchema: {
        solutionMode: z.string().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const solution = await service.resolveSolution(ctx, args.solutionMode);
        const root = await service.servicePortalCategories(ctx, solution);
        if (!root) {
          return {
            categories: [],
            warning: 'DCSC returned no services portal categories for this locale/mode.',
          };
        }
        return {
          root: { id: root.id, title: root.title },
          categories: root.children.map((c) => ({
            id: c.id,
            title: c.title,
            description: c.description,
            childCount: c.children.length,
            children: c.children.slice(0, 12).map((ch) => ({
              id: ch.id,
              title: ch.title,
              childCount: ch.children.length,
            })),
          })),
          note:
            'Portal catalogue only. Product Services tab: dcsc_list_options(session, tab: "Services"). ' +
            'Use dcsc_services_launch to choose independent product-bound services, or dcsc_configure to change an attached warranty package.',
          next: 'dcsc_launch then dcsc_list_options(session, tab: "Services") or query: "warranty".',
        };
      }),
  );

  server.registerTool(
    'dcsc_diff_sessions',
    {
      title: 'Compare two DCSC configurations side-by-side',
      description:
        'Compares two configuration sessions side-by-side and returns the precise differences: added, removed and replaced parts, quantity changes, price delta, and resource headroom comparison.',
      inputSchema: {
        sessionA: z.string().describe('First session ID to compare.'),
        sessionB: z.string().describe('Second session ID to compare.'),
      },
    },
    async (args) => guard(async () => service.diffSessions(args.sessionA, args.sessionB)),
  );

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  server.registerTool(
    'dcsc_set_configuration_controls',
    {
      title: 'Set Guided or Expert mode and Auto-Correct',
      description: 'Updates controls for every configuration in the containing workspace and derives the resulting selections atomically. Guided mode supports Auto-Correct on or off. Expert mode forces it off; Expert plus autoCorrect=true is rejected. expectedRevision refers to the workspace revision.',
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
    })),
  );

  server.registerTool(
    'dcsc_configure',
    {
      title: 'Change selections in a configuration',
      description:
        'Applies one or more option changes and returns ONLY what changed: parts added, removed or re-quantified, ' +
        'the price delta, and updated resource constraints. Linked Clone Multiple edits update every member atomically.\n' +
        'Pass several changes together — they are applied in one round trip, so a combined edit ' +
        '(swap the CPU and bump the memory) never leaves the configuration transiently invalid.\n' +
        'On storage-wizard CTOs, switching RAID_CONFIG mode removes previous drives, backplanes and controllers, matching the website. Submit that switch alone, then select new storage parts. ' +
        'DCSC reconciles dependencies itself: changing a processor may pull in a different heatsink. ' +
        'Anything DCSC decided on its own is flagged with "auto": true — always report those to the user.\n' +
        'Get section IDs and feature codes from dcsc_list_options first. Software groups use quantity 1 to select and 0 to remove; their nested filters expose separate section IDs. Edit software separately from hardware/services.',
      inputSchema: {
        session: z.string(),
        changes: z
          .array(
            z.object({
              section: z
                .string()
                .describe(
                  'Section from dcsc_list_options — the id ("storage.m-2-ssd"), the internal name ' +
                    '("M.2_SSD") or the display title ("M.2 SSD") all resolve. An unknown section is ' +
                    'rejected with the candidates listed, never silently ignored.',
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
        const linkedGroup = workspace ? resolveLinkedCloneGroup(configurationCloneDependency(workspace),
          [...workspace.configurations.values()].map(value => value.configurationId), updated.configurationId) : undefined;

        const diff = diffConfigurations({
          beforeIndex,
          afterIndex: updated.index,
          beforeRaw,
          afterRaw: updated.raw,
          currency: session.locale.currency,
          requested: new Set(args.changes.map((c) => c.code)),
        });

        // DCSC accepts a payload it then ignores, so "the request succeeded" is
        // not evidence the selection stuck. Verify each requested code against
        // the post-change index and report the truth.
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
          ...(linkedGroup?.linked ? { linkedUpdate: { configurationIds: linkedGroup.memberIds,
            rootConfigurationId: linkedGroup.rootId, workspace: workspace!.id, workspaceRevision: workspace!.revision } } : {}),
          applied: notApplied.length === 0 && touched,
          partiallyApplied: notApplied.length > 0 && touched,
          notApplied: notApplied.length > 0 ? notApplied : undefined,
          requested: args.changes,
          ...diff,
          priceType: 'LIST',
          note: notes.length > 0 ? notes.join(' ') : undefined,
        };
      }),
  );

  server.registerTool(
    'dcsc_set_quantity',
    {
      title: 'Set how many units of this configuration',
      description:
        'Sets the number of identical units — use this for "8 of these nodes" rather than launching eight sessions. ' +
        'Applies locally (no rules round trip) and updates the extended price and the exported line. ' +
        'Note DCSC caps quantity at 99.',
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
      }),
  );

  server.registerTool(
    'dcsc_undo',
    {
      title: 'Undo the last configuration change',
      description:
        'Reverts the most recent dcsc_configure call, locally. Does not re-run DCSC rules, so it restores ' +
        'the exact prior state rather than re-deriving it. Linked edits undo every member atomically; if their histories no longer match or an HPC edit also changed its parent chassis, use workspace history. Up to 10 steps are kept.',
      inputSchema: { session: z.string(), expectedRevision: z.number().int().min(1).optional().describe('Expected configuration revision.'), },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);
        const undone = await service.undo(session, args.expectedRevision);
        if (!undone) {
          throw new Error('Nothing to undo — this configuration has no recorded changes.');
        }
        const workspace = service.sessions.getWorkspace(session.id);
        const group = workspace ? resolveLinkedCloneGroup(configurationCloneDependency(workspace),
          [...workspace.configurations.values()].map(value => value.configurationId), session.configurationId) : undefined;
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
      }),
  );

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  server.registerTool(
    'dcsc_export',
    {
      title: 'Export a configuration or solution workspace as XML + Excel',
      description:
        'Exports the configuration or multi-product workspace to a ZIP on disk and returns the file paths.\n' +
        'The XML is Lenovo CFXML — it re-imports into DCSC and is the file used to raise a bid or quote ' +
        'in Lenovo Bid Portal. The XLSX is the quote spreadsheet.\n' +
        'Scope follows the handle: a configuration id exports that one product, a workspace id ' +
        'exports every product in the solution. Pass scope explicitly to override.\n' +
        'Workspace exports include rack/floor layout and requested reports. Standalone software is included when selected in the workspace.\n' +
        'Returns paths, never file contents.',
      inputSchema: {
        session: z.string(),
        scope: z
          .enum(['auto', 'configuration', 'workspace'])
          .optional()
          .describe(
            'auto (default) infers from the handle: configuration id -> that product only, ' +
              'workspace id -> the whole solution.',
          ),
        fileName: z
          .string()
          .optional()
          .describe('Base name for the archive, without extension.'),
        fileTypes: z
          .array(
            z.enum([
              'XML',
              'QUOTE',
              'QUOTE_CSV',
              'EPRICE_CSV',
              'SUMMARY',
              'POWER_REPORT',
              'QUOTE_SUPPLYINFO',
              'QUOTE_GROUP',
              'RACK_REPORT',
              'RACK_DIAGRAM',
              'FLOOR',
              'MESSAGE_HISTORY',
              'P2P_REPORT',
            ]),
          )
          .optional()
          .describe('Defaults to the applicable reports for this workflow.'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = service.sessions.get(args.session);
        const workspace = service.sessions.getWorkspace(args.session);
        if (!session && !workspace) throw new Error(`Session / Workspace ${args.session} not found`);

        const pCode = session?.product.code ?? [...workspace!.configurations.values()][0]?.product.code ?? 'solution';
        const fileName = sanitiseFileName(args.fileName ?? `${pCode}-${Date.now()}`);
        const solution = workspace?.solution ?? session!.solution;
        const ctx = service.newCtx({ locale: workspace?.locale ?? session!.locale, solution });
        const workspaceScope = args.scope === 'workspace' || (args.scope !== 'configuration' && args.session === workspace?.id);
        if (workspaceScope && workspace) {
          const software = workspace.serverState.standaloneSoftwareState as { selections?: unknown[] } | undefined;
          const services = workspace.serverState.standaloneServiceState as { selections?: unknown[] } | undefined;
          const softwareSelected = (software?.selections?.length ?? 0) > 0;
          const servicesSelected = (services?.selections?.length ?? 0) > 0;
          if (servicesSelected && (softwareSelected || workspace.configurations.size > 0)) {
            throw new Error('Combined independent service and hardware/software export is not yet verified. Export independent services with dcsc_services_export; no products have been silently omitted.');
          }
          if (servicesSelected || softwareSelected) {
            const bundle = servicesSelected
              ? await exportProductServiceArtifact(service, workspace, fileName)
              : await exportStandaloneSoftwareArtifact(service, workspace, fileName, {
                ...(args.fileTypes ? { fileTypes: args.fileTypes } : {}),
              });
            return { session: args.session, scope: 'workspace', configurationsExported: workspace.configurations.size,
              ...bundle, currency: workspace.locale.currency, priceType: 'LIST' };
          }
        }

        const { stream, contentDisposition, rackDataOmitted, scope, configurationsExported, manualPlanningLinksOmitted, breakoutBranchesAtRisk } =
          await service.exportZip(args.session, {
            fileTypes: (args.fileTypes ?? DEFAULT_EXPORT_TYPES) as ExportFileType[],
            fileName,
            ctx,
            ...(args.scope !== undefined ? { scope: args.scope } : {}),
          });

        const bundle = await writeExportBundle(stream, fileName, service.config);
        const powerSettings = (workspaceScope && workspace ? [...workspace.configurations.values()] : session ? [session] : [])
          .map(configuration => powerLoadFactor(configuration.raw));

        return {
          session: args.session,
          scope,
          configurationsExported,
          contentDisposition,
          ...bundle,
          priceType: 'LIST',
          rackDataOmitted,
          ...(powerSettings.some(value => value !== undefined && value !== 70) ? { powerSettingsWarning:
            'Lenovo CFXML reimport can reset custom load factors (verified SR630 V3: 100% to 70%). Saved MCP sessions retain them. Inspect dcsc_power_controls and reapply the desired load factor after XML import.' } : {}),
          ...(scope === 'workspace' && workspace && detachedNestedNodeIds(workspace).size > 0 ? {
            detachedNodesDroppedOnReimport: detachedNestedNodeIds(workspace).size,
            reimportWarning: 'Lenovo reimport drops physically detached nodes even though their commercial lines are exported. Undo detach and use unplace before exporting to retain them through reimport.',
          } : {}),
          ...(breakoutBranchesAtRisk > 0 ? { breakoutBranchesAtRisk,
            breakoutReimportWarning: 'DCSC website reimport has been observed to reset saved four-way breakout branches to point-to-point and change cable quantities. MCP import restores supported shapes and physical cable quantities from this XML; direct website handoff remains unverified.' } : {}),
          ...(manualPlanningLinksOmitted > 0 ? { manualPlanningLinksOmitted,
            warning: `${manualPlanningLinksOmitted} local planning link(s) are excluded from this Lenovo export. They remain inspectable in dcsc_workspace_layout. Use auto-connect for server-authored exportable connections.` } : {}),
          disclaimer:
            'List prices for the configured country and currency. Not a quote. ' +
            'A configuration containing errors cannot be imported into Lenovo quoting tools.',
        };
      }),
  );

  server.registerTool(
    'dcsc_compare_scenarios',
    {
      title: 'Compare design scenarios side by side',
      description:
        'Compares two or more explicitly scoped configurations or workspaces by list price, power and heat. ' +
        'Existing workspace comparisons include only the products and physical rack layout already present.\n' +
        'Pass configuration session IDs with nodes to repeat that selected configuration while preserving other ' +
        'explicitly modeled workspace products at their current quantities. Scaled comparisons omit rack totals ' +
        'because no physical layout has been calculated. Mixed currencies are returned but never ranked.',
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
          // Cabinets are passive; every included powered configuration needs
          // its own report before the workspace power total is comparable.
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

        // Rank on the axes where lower is better only after currency compatibility is established.
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
      }),
  );

  server.registerTool(
    'dcsc_blueprints',
    {
      title: 'List AI factory starting points and current availability',
      description: 'Lists curated AI factory starting points with current catalog availability by solution mode. Historical configuration checks and USD list prices retain their original date; catalog presence is not a fresh configured-design verification.',
      inputSchema: {},
    },
    async () =>
      guard(async () => ({
        blueprints: await service.blueprintAvailability(service.newCtx()),
        priceType: 'LIST',
        note:
          'Prices were verified on the stated date for US/USD and will drift. ' +
          'dcsc_start_from_blueprint(id) launches one and returns live pricing.',
        readBeforeQuoting:
          'Every blueprint launches as a partial node — check shipsWithout. The launch price ' +
          'covers the GPU baseboard, CPUs and memory, but none of these models include a boot ' +
          'device, local storage or fabric adapters, so a launched node is not yet a usable one.',
      })),
  );

  server.registerTool(
    'dcsc_start_from_blueprint',
    {
      title: 'Start a currently available blueprint',
      description:
        'Launches one of the reference AI factory configurations in the correct solution mode. ' +
        'Equivalent to dcsc_launch with the right product code and mode already chosen.',
      inputSchema: {
        blueprint: z.string().describe('Blueprint id or product code from dcsc_blueprints.'),
        label: z.string().optional(),
        solutionMode: z.string().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const blueprint = findBlueprint(args.blueprint);
        if (!blueprint) {
          throw new Error(
            `Unknown blueprint "${args.blueprint}". Valid ids: ${BLUEPRINTS.map((b) => b.id).join(', ')}.`,
          );
        }
        const ctx = service.newCtx();
        const availability = (await service.blueprintAvailability(ctx)).find(item => item.id === blueprint.id)!;
        if (!availability.available) throw new Error(`Blueprint ${blueprint.id} (${blueprint.productCode}) is absent from the current catalogs for this locale. Use dcsc_blueprints for available alternatives.`);
        const requestedMode = args.solutionMode ?? (availability.availableModes.includes(blueprint.solutionMode) ? blueprint.solutionMode : availability.availableModes[0]);
        const solution = await service.resolveSolution(ctx, requestedMode);
        if (!availability.availableModes.includes(solution.solutionMode)) throw new Error(`Blueprint ${blueprint.id} is not available in ${solution.solutionMode}. Available modes: ${availability.availableModes.join(', ')}.`);
        const session = await service.launch({
          productCode: blueprint.productCode,
          mode: 'cto',
          solution,
          ctx,
          ...(args.label !== undefined ? { label: args.label } : {}),
        });
        return {
          blueprint: blueprint.id,
          workspace: session.workspaceId,
          solutionMode: solution.solutionMode,
          ...projectSummary({
            sessionId: session.id,
            revision: session.revision,
            raw: session.raw,
            index: session.index,
            currency: session.locale.currency,
            country: session.locale.country,
            pricedAt: session.pricedAt,
          }),
          shipsWithout: blueprint.shipsWithout,
          incompleteWarning:
            `This node is NOT yet usable as launched. It ships without: ${blueprint.shipsWithout.join('; ')}. ` +
            'Add them with dcsc_configure before pricing or quoting it.',
          next: 'dcsc_list_options(session, tab: "Storage" | "PCI") to fill the gaps above, then dcsc_scale_out to size a cluster.',
        };
      }),
  );

  server.registerTool(
    'dcsc_scale_out',
    {
      title: 'Size a cluster from one designed node',
      description:
        'Takes a node you have already configured and sizes a cluster of N of them: how many fit per rack, ' +
        'how many racks that needs, and the resulting list price, weight and power per rack and in total.\n' +
        'Rack capacity is measured against DCSC, not calculated — placement rules mean an 8U node rarely ' +
        'yields 42/8 slots per cabinet.\n' +
        'Reports a cooling advisory when per-rack density exceeds what air can remove.\n' +
        'Reports configured-node subtotal and explicit excluded infrastructure costs; cabinet weight and physical capacity are modeled separately. It does not create N separate configurations — ' +
        'use dcsc_clone_configuration for that.',
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

        // Density decides feasibility long before price does, and DCSC will
        // happily size a rack no conventional hall can cool.
        const session = service.sessions.get(args.session);
        const blueprint = session ? findBlueprint(session.product.code) : undefined;
        const advisory = assessRackDensity(
          plan.powerPerRack?.maxKW ?? 0,
          blueprint?.cooling ?? 'unknown',
        );

        return {
          ...plan,
          ...(advisory && advisory.level !== 'standard' ? { coolingAdvisory: advisory } : {}),
          // Absent power is not the same as safe power — say which it is.
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
      }),
  );

  server.registerTool(
    'dcsc_explain',
    {
      title: 'Explain why the configuration looks the way it does',
      description:
        'Explains what DCSC\'s rules engine decided on its own and why: which parts it added, removed or ' +
        'substituted without being asked, and the rule messages it emitted.\n' +
        'Use this when a configuration contains something the user did not choose, or when a change had ' +
        'a larger effect than expected. The reasoning is DCSC\'s, surfaced verbatim — not inferred.',
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
      }),
  );

  // -------------------------------------------------------------------------
  // Power, thermal and fabric
  // -------------------------------------------------------------------------

  server.registerTool(
    'dcsc_power',
    {
      title: 'Power and thermal budget for a configuration or solution',
      description:
        'Reports DCSC\'s own power and heat figures: input power, current, apparent power and heat output, ' +
        'each as idle / expected / max / worst-case.\n' +
        'Given a workspace it aggregates across every configuration and breaks the total down per rack — ' +
        'using one power contribution per physical placement, independent of sales quantity. Sales units ' +
        'without a physical placement are reported separately.\n' +
        'Figures come from DCSC as configured; they are not estimates. ' +
        'Use dcsc_power_controls and dcsc_set_power_controls to inspect or change voltage, load factor and power policy.',
      inputSchema: {
        session: z.string().describe('Session or workspace ID.'),
      },
    },
    async (args) =>
      guard(async () => {
        const resolved = service.sessions.resolveHandle(args.session);
        if (!resolved) throw new Error(`Session / Workspace ${args.session} not found`);
        const workspace = resolved.workspace;
        const configs =
          resolved.kind === 'workspace'
            ? [...resolved.workspace.configurations.values()]
            : [resolved.session];
        const storageQuantities = resolved.kind === 'workspace'
          ? storageComponentQuantities(resolved.workspace) : new Map<string, number>();
        const units = new Map(configs.map(session => [session.id,
          workspace && storageQuantities.has(session.configurationId)
            ? storagePhysicalConfigurations(workspace, session.configurationId, session.raw)
                .map(instance => ({ ...instance, quantity: 1, power: extractPowerReport(instance.raw) }))
            : [{ physicalId: session.configurationId, raw: session.raw, quantity: positiveQuantity(session.raw.quantity),
                power: extractPowerReport(session.raw) }],
        ]));
        const perConfig = configs.map((s) => ({
          session: s.id,
          configurationId: s.configurationId,
          code: s.product.code,
          description: s.product.description,
          salesQuantity: storageQuantities.get(s.configurationId) ?? positiveQuantity(s.raw.quantity),
          ...(storageQuantities.has(s.configurationId) ? { managedStorageTemplate: true } : {}),
          power: units.get(s.id)!.every(unit => isDeepStrictEqual(unit.power, units.get(s.id)![0]?.power))
            ? units.get(s.id)![0]?.power : undefined,
          ...(storageQuantities.has(s.configurationId) ? { physicalInstances: units.get(s.id)!.map(unit => ({
            physicalId: unit.physicalId, power: unit.power,
          })) } : {}),
        }));

        const contributing = [...units.values()].flat().filter(
          (p): p is typeof p & { power: NonNullable<typeof p.power> } => p.power !== undefined && p.quantity > 0);
        const total =
          contributing.length > 0
            ? aggregatePower(
                contributing.map((p) => ({ report: p.power, quantity: p.quantity })),
              )
            : undefined;

        const missingPowerConfigurations = perConfig.filter(entry => entry.salesQuantity > 0 && units.get(entry.session)!.some(unit => !unit.power) &&
          configs.find(config => config.id === entry.session)?.product.type.toLowerCase() !== 'rack')
          .map(entry => entry.session);
        const totalPowerAvailable = total !== undefined && missingPowerConfigurations.length === 0;

        const sessionByPhysicalId = new Map<string, (typeof configs)[number]>();
        for (const session of configs) {
          sessionByPhysicalId.set(session.id, session);
          sessionByPhysicalId.set(session.configurationId, session);
        }
        if (workspace) for (const [physicalId, templateId] of storagePhysicalTemplateIds(workspace)) {
          const template = sessionByPhysicalId.get(templateId);
          if (template) sessionByPhysicalId.set(physicalId, template);
        }
        const placedBySession = new Map<string, number>();

        // Per-rack rollup counts physical placements, never sales quantity.
        const perRack = (workspace?.rackSummaries ?? [])
          .map((rack) => {
            let scopedPlacements = 0;
            const missingPowerConfigurations: string[] = [];
            const rawRack = workspace?.rackArea.find(item => item.id === rack.id);
            const placedIds = rawRack ? [...physicalIds(rawRack)].filter(id => id !== rack.id)
              : rack.items.map(item => item.id);
            const physicalEntries = placedIds.flatMap((physicalId) => {
              const session = sessionByPhysicalId.get(physicalId);
              if (!session) return [];
              scopedPlacements += 1;
              placedBySession.set(session.id, (placedBySession.get(session.id) ?? 0) + 1);
              const report = units.get(session.id)?.find(unit => unit.physicalId === physicalId)?.power ??
                (!storageQuantities.has(session.configurationId) ? extractPowerReport(session.raw) : undefined);
              if (!report && session.product.type.toLowerCase() !== 'rack') missingPowerConfigurations.push(session.id);
              return report ? [{ report, quantity: 1 }] : [];
            });
            return {
              rackId: rack.id,
              code: rack.code,
              physicallyPlacedUnits: scopedPlacements,
              powerContributors: physicalEntries.length,
              powerAvailable: physicalEntries.length > 0 && missingPowerConfigurations.length === 0,
              ...(physicalEntries.length > 0 && missingPowerConfigurations.length === 0
                ? aggregatePower(physicalEntries)
                : { missingPowerConfigurations, ...(physicalEntries.length > 0
                  ? { knownPowerSubtotal: aggregatePower(physicalEntries) } : {}) }),
            };
          })
          .filter((rack) => resolved.kind === 'workspace' || rack.physicallyPlacedUnits > 0);

        const unplacedSalesUnits = perConfig
          .filter((entry) => {
            const session = configs.find((candidate) => candidate.id === entry.session);
            return session?.product.type.toLowerCase() !== 'rack';
          })
          .map((entry) => {
            const placedUnits = placedBySession.get(entry.session) ?? 0;
            return {
              session: entry.session,
              configurationId: entry.configurationId,
              code: entry.code,
              salesQuantity: entry.salesQuantity,
              physicallyPlacedUnits: placedUnits,
              unplacedUnits: Math.max(0, entry.salesQuantity - placedUnits),
              ...(placedUnits > entry.salesQuantity
                ? {
                    warning:
                      'The validated rack layout contains more physical instances than the sales quantity.',
                  }
                : {}),
            };
          })
          .filter((entry) => entry.unplacedUnits > 0 || entry.warning !== undefined);

        const voltages = [
          ...new Set(contributing.map((p) => p.power.operatingVoltage).filter(Boolean)),
        ];

        return {
          session: args.session,
          currency:
            resolved.kind === 'workspace'
              ? resolved.workspace.locale.currency
              : resolved.session.locale.currency,
          perConfiguration: perConfig,
          totalPowerAvailable,
          ...(totalPowerAvailable
            ? { total, totalScope: 'sales quantities across the selected scope' }
            : { missingPowerConfigurations, ...(total ? { knownPowerSubtotal: total } : {}),
              powerAvailabilityReason: 'DCSC did not supply a complete numeric power report for every included powered configuration.' }),
          ...(perRack.length > 0 ? { perRack } : {}),
          unplacedSalesUnits,
          operatingVoltage: voltages.length === 1 ? voltages[0] : voltages,
          ...(voltages.length > 1
            ? {
                voltageWarning:
                  'Configurations run at different voltages, so the summed current figure is not meaningful. ' +
                  'Compare power (W) instead.',
              }
            : {}),
          note:
            'idle / expected / max / worst are DCSC\'s own bands. "expected" applies the configured ' +
            'load factor and is the figure to size a room against; "worst" is what a breaker must survive.',
        };
      }),
  );

  server.registerTool(
    'dcsc_fabric_options',
    {
      title: 'Browse fabric devices, topologies, cables and storage preferences',
      description: 'Browses the complete fetched fabric catalog with stable option IDs and true totals. Choose a collection to enumerate devices, network types, cables, services, roles, storage switches or controllers. Continuations retain context and advance by the actual number returned. Use optionId for one complete option; fields can limit large details.',
      inputSchema: {
        solutionMode: z.string().optional(),
        session: z.string().optional().describe('Use the locale and solution of this workspace/configuration.'),
        collection: z.enum(['topologies', 'networkDevices', 'networkTypes', 'cables', 'selectedServices', 'nodeRoles', 'storageSwitches', 'storageControllers', 'leafNodeCabling']).default('topologies'),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        optionId: z.string().optional(),
        fields: z.array(z.string()).optional().describe('Return these top-level fields, plus id.'),
        path: z.array(z.string()).optional().describe('Lossless detail path from a returned continuation.'),
        expectedCatalogFingerprint: z.string().optional().describe('Returned continuation fingerprint; rejects changed fabric catalog or context.'),
      },
    },
    async (args) => guard(async () => {
      const workspace = args.session ? service.sessions.getWorkspace(args.session) : undefined;
      if (args.session && !workspace) throw new Error('Workspace not found.');
      const ctx = service.newCtx(workspace ? { locale: workspace.locale, solution: workspace.solution } : {});
      const solution = workspace?.solution ?? await service.resolveSolution(ctx, args.solutionMode);
      const catalog = await service.fabricOptions(ctx, solution);
      const fabric = { ...catalog, leafNodeCabling: listNetworkLeafCablingChoices(catalog),
        ...(workspace ? { networkTypes: workspaceNetworkTypes(catalog, workspace.serverState) } : {}) };
      const all = args.collection === 'storageControllers'
        ? fabric.storageControllers.map(controller => ({ ...controller,
          expansions: listStorageExpansions(controller).map(({ raw, ...choice }) => ({ ...raw, ...choice })),
        }))
        : fabric[args.collection] ?? [];
      const selected = args.optionId ? all.filter((item) => item.id === args.optionId) : all;
      if (args.optionId && selected.length === 0) throw new Error('Unknown optionId in this fabric collection.');
      const items: Record<string, unknown>[] = selected.map((item) => args.fields
        ? Object.fromEntries(Object.entries(item).filter(([key]) => key === 'id' || args.fields!.includes(key)))
        : { ...item });
      return projectCatalogPage({
        tool: 'dcsc_fabric_options', collection: 'items', context: ctx.locale,
        arguments: { session: args.session, solutionMode: solution.solutionMode,
          collection: args.collection, optionId: args.optionId, fields: args.fields },
        offset: args.optionId && args.path === undefined ? 0 : args.offset, limit: args.limit, path: args.path,
        expectedCatalogFingerprint: args.expectedCatalogFingerprint, items,
        base: { solutionMode: solution.solutionMode, currency: ctx.locale.currency,
          collection: args.collection, total: all.length, offset: args.offset, limit: args.limit,
          collections: Object.fromEntries(Object.entries(fabric).map(([key, values]) => [key, values?.length ?? 0])) },
      });
    }),
  );

  server.registerTool(
    'dcsc_set_node_role',
    {
      title: 'Set a configuration\'s role in the cluster',
      description:
        'Tags a configuration as Compute, Storage or Management. The role travels with the configuration ' +
        'into the export and is what lets DCSC and downstream tools tell a compute node from a storage node ' +
        'in a multi-node solution.',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected configuration revision.'),
        session: z.string(),
        role: z.string().describe('Role from dcsc_fabric_options, e.g. "Compute".'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);
        const ctx = service.newCtx({ locale: session.locale, solution: session.solution });
        const roles = await service.fabricOptions(ctx, session.solution);
        const match = roles.nodeRoles.find(
          (r) => r.role.toLowerCase() === args.role.toLowerCase(),
        );
        if (!match) {
          throw new Error(
            `Unknown node role "${args.role}". Valid roles: ${roles.nodeRoles.map((r) => r.role).join(', ')}.`,
          );
        }
        await service.sessions.transact(session.id, { expectedRevision: args.expectedRevision }, (workspace, draft) => {
          if (!draft) throw new Error(`Configuration session ${session.id} no longer exists.`);
          if (draft.raw.nodeRole !== match.role) {
            invalidateConnectionGraph(workspace.serverState, 'Node role changed. Regenerate connections.');
          }
          draft.raw.nodeRole = match.role;
        });
        const updated = requireSession(service, session.id);
        const workspace = service.sessions.getWorkspace(updated.id)!;
        const connectionGraphStale = workspace.serverState.connectionGraphInvalidation !== undefined;
        return { session: updated.id, revision: updated.revision, nodeRole: match.role,
          workspace: workspace.id, workspaceRevision: workspace.revision, connectionGraphStale,
          ...(connectionGraphStale ? { regenerateConnections: { tool: 'dcsc_add_cabling', arguments: {
            session: workspace.id, mode: 'auto', expectedRevision: workspace.revision,
          } } } : {}) };
      }),
  );

  server.registerTool(
    'dcsc_set_topology',
    {
      title: 'Apply a network topology to a configuration',
      description:
        'Selects a fabric topology shortName (from dcsc_fabric_options, e.g. IB_XDR, 400GbE_Fiber) on a configuration. ' +
        'The selection is stored on the configuration the way the SPA stores selectedTopologies. ' +
        'When the workspace has racks, auto-connect is run so DCSC can recompute connections for the fabric.',
      inputSchema: {
        session: z.string().describe('Configuration session ID.'),
        topology: z.string().describe('Topology shortName from dcsc_fabric_options, e.g. "IB_XDR".'),
        networkName: z.string().optional().describe('Network name or stable networkType ID. For storage, use the exact existing storage network name already assigned to this configuration. Required when topology does not uniquely identify a network.'),
        connectorIds: z.array(z.string()).optional().describe('Connector IDs to select. An explicitly empty selection clears ports for this network.'),
        ports: z.array(z.string()).optional().describe('Exact port selectors; ambiguous choices are rejected. Pass [] to clear this network’s ports; omit selectors to choose a sole compatible connector.'),
        expectedRevision: z.number().int().min(1).optional(),
        autoConnect: z
          .boolean()
          .optional()
          .default(true)
          .describe('If true (default) and the workspace has racks, run DCSC auto-connect after selecting.'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);
        const ctx = service.newCtx({ locale: session.locale, solution: session.solution });
        const result = await service.applyTopology({
          sessionHandle: session.id,
          topology: args.topology, networkName: args.networkName, connectorIds: args.connectorIds, ports: args.ports,
          expectedRevision: args.expectedRevision,
          autoConnect: args.autoConnect ?? true,
          ctx,
        });
        const workspace = service.sessions.getWorkspace(session.id)!;
        const connectionGraphStale = workspace.serverState.connectionGraphInvalidation !== undefined;
        return {
          session: result.session,
          revision: requireSession(service, session.id).revision,
          workspace: workspace.id, workspaceRevision: workspace.revision, connectionGraphStale,
          ...(connectionGraphStale ? { regenerateConnections: { tool: 'dcsc_add_cabling', arguments: {
            session: workspace.id, mode: 'auto', expectedRevision: workspace.revision,
          } } } : {}),
          topology: result.topology,
          selectedTopologies: result.selectedTopologies,
          autoConnect: result.autoConnect
            ? {
                connectionCount: result.autoConnect.connections.length,
                messages: result.autoConnect.messages,
              }
            : undefined,
          next:
            result.autoConnect && result.autoConnect.connections.length === 0
              ? 'No connections yet — add switches/nodes or re-run dcsc_add_cabling(mode: "auto").'
              : 'dcsc_add_cabling(mode: "auto") or dcsc_workspace_layout to inspect cabling.',
        };
      }),
  );

  server.registerTool('dcsc_network_connectors', {
    title: 'List compatible network connector IDs',
    description: 'Finds actual configuration connectors for a topology. Use the returned IDs with dcsc_set_topology.',
    inputSchema: { session: z.string(), topology: z.string(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(10) },
  }, async (args) => guard(async () => {
    const session = requireSession(service, args.session);
    const ctx = service.newCtx({ locale: session.locale, solution: session.solution });
    const fabric = await service.fabricOptions(ctx, session.solution);
    const choices = listTopologyConnectors(session.raw, fabric, args.topology);
    const items = choices.slice(args.offset, args.offset + args.limit).map(({ raw: _raw, ...choice }) => choice);
    return { session: session.id, topology: args.topology, total: choices.length, items,
      next: args.offset + items.length < choices.length ? { tool: 'dcsc_network_connectors', arguments: { ...args, offset: args.offset + items.length } } : undefined };
  }));

  server.registerTool('dcsc_set_network_preferences', {
    title: 'Select workspace network devices and cables',
    description: 'Updates named network preferences using stable catalog IDs, preserving other networks. Validates device/topology/cable compatibility. When automatic switch creation is enabled, provisions required switches for the current HPC rack layout. Optional auto-connect also regenerates P2P connections. All changes are one transaction; a failure discards the edit.',
    inputSchema: {
      session: z.string(),
      selections: z.array(z.object({ networkTypeId: z.string(), topology: z.string().optional(),
        layout: z.enum(['Centralized', 'Distributed']).optional(),
        mainDeviceId: z.string().optional().describe('Catalog device ID or existing-customer-switch to clear the managed main switch.'),
        leafDeviceId: z.string().optional().describe('Catalog device ID or existing-customer-switch to clear the managed leaf switch.'),
        mainTrunks: z.number().int().min(0).optional().describe('Trunk count, bounded by the selected switch topology capacity.'),
        leafTrunks: z.number().int().min(0).optional(),
        leafCabling: z.string().optional().describe('Exact description from dcsc_fabric_options collection=leafNodeCabling.'),
        vlanNetworkTypeIds: z.array(z.string()).optional().describe('Stable IDs of peer networks sharing the main switch; empty array clears VLAN joins.'),
        customCableId: z.string().optional().describe('Custom cable catalog ID with an existing customer main switch; manual-cable clears the fixed cable part.'),
        cableId: z.string().optional(), leafCableId: z.string().optional(),
        cableColor: z.string().optional().describe('Catalog cable color; empty string clears the preference. Cable ID chooses its category, not a fixed length/part.'),
        leafCableColor: z.string().optional().describe('Leaf cable color; empty string clears the preference.') })).min(1),
      expectedRevision: z.number().int().min(1).optional(), autoConnect: z.boolean().default(false),
    },
  }, async (args) => guard(async () => {
    const workspace = service.sessions.getWorkspace(args.session);
    if (!workspace) throw new Error('Workspace not found.');
    const result = await service.setNetworkPreferences(workspace.id, { selections: args.selections,
      expectedRevision: args.expectedRevision, autoConnect: args.autoConnect,
      ctx: service.newCtx({ locale: workspace.locale, solution: workspace.solution }) });
    return { ...result, ...(result.autoConnectRequired ? {
      regenerateConnections: { tool: 'dcsc_add_cabling', arguments: {
        session: workspace.id, mode: 'auto', expectedRevision: result.revision,
      } },
    } : {}) };
  }));

  // -------------------------------------------------------------------------
  // Ops
  // -------------------------------------------------------------------------

  server.registerTool(
    'dcsc_health',
    {
      title: 'DCSC client health',
      description:
        'Reports the circuit breaker state, WAF cooldown and effective configuration. ' +
        'Check this first if DCSC calls are failing or appear paused.',
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
      })),
  );
}

function requireSession(service: DcscService, id: string) {
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

function positiveQuantity(quantity: number | null | undefined): number {
  return typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}
