import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { CONFIG_MODES } from '../config/constants.js';
import { redactConfig } from '../config/schema.js';
import { browseCatalog, searchCatalog } from '../domain/catalog.js';
import { toToolError } from '../http/errors.js';
import { logger } from '../http/trace.js';
import { DEFAULT_EXPORT_TYPES, type ExportFileType } from '../domain/reduce.js';
import type { LayoutResult } from '../domain/rack.js';
import { aggregatePower, extractPowerReport } from '../domain/power.js';
import { BLUEPRINTS, findBlueprint } from '../domain/blueprints.js';
import { sanitiseFileName, writeExportBundle } from '../files/artifactStore.js';
import { diffConfigurations } from '../model/diff.js';
import { buildIndex, searchFeatures } from '../model/index.js';
import {
  projectFeatureDetail,
  projectOptions,
  projectSummary,
  projectTab,
} from '../model/project.js';
import type { DcscService } from './service.js';

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
function projectLayout(layout: LayoutResult): Record<string, unknown> {
  const unstable = layout.racks.filter((r) => r.stableStatus && r.stableStatus !== 'PASSED');
  return {
    racks: layout.racks.map((r) => ({
      rackId: r.id,
      code: r.code,
      description: r.description,
      sizeU: r.sizeU,
      usedU: r.usedU,
      freeU: r.freeU,
      totalWeightKg: r.totalWeightKg,
      stability: r.stableStatus,
      items: r.items,
    })),
    unplaced: layout.unplaced,
    errors: layout.errors,
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
}

export function registerTools(server: McpServer, service: DcscService): void {
  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  server.registerTool(
    'dcsc_solution_modes',
    {
      title: 'List DCSC solution modes',
      description:
        'Lists the available DCSC solution modes (e.g. "General Purpose", "HPC and AI - Systems") and their master slices. ' +
        'Rarely needed directly — every other tool resolves the mode automatically. Use it only to discover what modes exist.',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const ctx = service.newCtx();
        const modes = await service.solutionModes(ctx);
        return { modes: modes.map((m) => ({ mode: m.mode, masterSlices: m.masterSlices })) };
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
        solutionMode: z.string().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const solution = await service.resolveSolution(ctx, args.solutionMode);
        const catalog = await service.catalog(ctx, solution);
        const hits = searchCatalog(catalog, {
          query: args.query,
          ...(args.type !== undefined ? { type: args.type } : {}),
          includeWithdrawn: args.includeWithdrawn,
          limit: args.limit,
        });
        // A model is only configurable and importable in the modes whose
        // catalog contains it, and that is not always the mode searched.
        const availability = await service.modesContaining(
          ctx,
          hits.map((h) => h.code),
        );

        return {
          solutionMode: solution.solutionMode,
          currency: service.locale.currency,
          country: service.locale.country,
          total: hits.length,
          products: hits.map((h) => {
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
          next: 'dcsc_launch(productCode) to start configuring one of these.',
        };
      }),
  );

  server.registerTool(
    'dcsc_browse_catalog',
    {
      title: 'Browse the DCSC catalog tree',
      description:
        'Walks one level of the DCSC category tree. Use only when you need to understand how the catalog is organised; ' +
        'dcsc_find_products is faster for locating a specific product.',
      inputSchema: {
        path: z
          .array(z.string())
          .optional()
          .describe('Category breadcrumb, e.g. ["Servers", "Rack Server"]. Omit for the top level.'),
        solutionMode: z.string().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const solution = await service.resolveSolution(ctx, args.solutionMode);
        const catalog = await service.catalog(ctx, solution);
        const result = browseCatalog(catalog, args.path ?? []);
        return {
          path: result.path,
          categories: result.children,
          products: result.products.slice(0, 40).map((p) => ({
            code: p.code,
            type: p.type,
            description: p.description,
          })),
        };
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
        const ctx = service.newCtx();
        const solution = await service.resolveSolution(ctx, args.solutionMode);

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
          ...(args.label !== undefined ? { label: args.label } : {}),
        });
        return {
          workspace: session.workspaceId,
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
      description: 'Lists the configuration sessions and multi-product workspaces currently open in this server.',
      inputSchema: {},
    },
    async () =>
      guard(async () =>
        service.sessions.list().map((s) => ({
          session: s.id,
          workspace: s.workspaceId,
          label: s.label,
          product: s.product.code,
          description: s.product.description,
          revision: s.revision,
          totalPrice: s.raw.totalPrice ?? 0,
          currency: s.locale.currency,
          updatedAt: new Date(s.lastAccessAt).toISOString(),
        })),
      ),
  );

  server.registerTool(
    'dcsc_session_close',
    {
      title: 'Close a DCSC configuration session',
      description: 'Discards a configuration session or workspace and frees its memory.',
      inputSchema: { session: z.string() },
    },
    async (args) => guard(async () => ({ closed: service.sessions.delete(args.session) })),
  );

  server.registerTool(
    'dcsc_list_racks',
    {
      title: 'List available rack cabinets',
      description:
        'Lists the rack cabinets that can hold configurations in this solution mode, with their product codes. ' +
        'Use this to get a rackCode for dcsc_add_rack.',
      inputSchema: { solutionMode: z.string().optional() },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const solution = await service.resolveSolution(ctx, args.solutionMode);
        const racks = await service.rackCabinets(ctx, solution);
        return {
          solutionMode: solution.solutionMode,
          total: racks.length,
          racks,
          next: 'dcsc_add_rack(session, rackCode) to add one to a workspace.',
        };
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
        session: z.string().describe('Session or workspace ID.'),
        rackCode: z.string().describe('Rack product code from dcsc_list_racks, e.g. "7D6DCTO1WW".'),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const layout = await service.addRack(args.session, args.rackCode, ctx);
        return {
          session: args.session,
          ...projectLayout(layout),
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
        'Anything DCSC refuses to place is returned in "unplaced" with the reason in "errors" — always report those.',
      inputSchema: {
        session: z.string().describe('Session or workspace ID.'),
        rackId: z.string().describe('Rack ID from dcsc_add_rack.'),
        sessionId: z.string().describe('Session ID of the configuration to place.'),
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
        const layout = await service.placeInRack(args.session, {
          rackId: args.rackId,
          sessionId: args.sessionId,
          ...(args.uPosition !== undefined ? { position: args.uPosition } : {}),
          ctx,
        });
        return {
          session: args.session,
          ...projectLayout(layout),
        };
      }),
  );

  server.registerTool(
    'dcsc_add_cabling',
    {
      title: 'Cable a solution (auto-connect or manual)',
      description:
        'Builds port-to-port cabling for a workspace.\n' +
        'Default mode is "auto": posts the current rack layout to DCSC /auto_connect and replaces ' +
        'the workspace cable list with the connections the server returns. That is the only ' +
        'server-validated path — empty connections are normal when the layout has nothing to cable ' +
        '(e.g. a single node and no switch).\n' +
        'Mode "manual" records a single port map locally for planning; DCSC does not validate ' +
        'manual links (the web UI stores them the same way). Prefer auto.',
      inputSchema: {
        session: z.string().describe('Session or workspace ID.'),
        mode: z
          .enum(['auto', 'manual'])
          .optional()
          .default('auto')
          .describe('auto = DCSC /auto_connect (default). manual = local port map only.'),
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
        if (mode === 'auto') {
          const ctx = service.newCtx();
          const result = await service.runAutoConnect(args.session, ctx);
          return {
            session: args.session,
            mode: 'auto',
            connectionCount: result.connections.length,
            connections: result.connections.map((c) => ({
              id: c.id,
              fromId: c.fromId,
              fromPort: c.fromPort,
              toId: c.toId,
              toPort: c.toPort,
              cableCode: c.cableCode,
              description: c.description,
            })),
            messages: result.messages,
            ...(result.connections.length === 0
              ? {
                  note:
                    'DCSC returned no connections. That is expected when the layout has nothing ' +
                    'to cable (no switch, single node). Add networking hardware and re-run.',
                }
              : {}),
            next: 'dcsc_workspace_layout(session) to inspect the updated racks; P2P export is still blocked (P1).',
          };
        }

        if (!args.fromConfigId || !args.fromPort || !args.toConfigId || !args.toPort) {
          throw new Error(
            'Manual mode requires fromConfigId, fromPort, toConfigId and toPort. ' +
              'Or omit them and use mode "auto" to let DCSC cable the layout.',
          );
        }
        const link = service.addManualCabling(args.session, {
          fromConfigId: args.fromConfigId,
          fromPort: args.fromPort,
          toConfigId: args.toConfigId,
          toPort: args.toPort,
          ...(args.cableCode !== undefined ? { cableCode: args.cableCode } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
        });
        return {
          session: args.session,
          mode: 'manual',
          cabling: link,
          warning:
            'Manual cabling is client-side only — DCSC does not validate port maps. ' +
            'Prefer mode "auto" (dcsc_add_cabling with mode auto) for server-authored connections.',
          next: 'dcsc_add_cabling(session, mode: "auto") to replace manual links with DCSC auto-connect.',
        };
      }),
  );

  server.registerTool(
    'dcsc_import',
    {
      title: 'Import a saved Lenovo CFXML configuration file or string',
      description:
        'Imports a saved Lenovo CFXML string or file path from Lenovo Bid Portal or DCSC into a new configuration session or workspace.',
      inputSchema: {
        content: z.string().optional().describe('XML content string of the CFXML file.'),
        filePath: z.string().optional().describe('Absolute local file path to the CFXML file.'),
        mode: z.enum(CONFIG_MODES).optional().default('cto'),
        workspace: z.string().optional().describe('Optional existing workspace ID to import into.'),
        solutionMode: z
          .string()
          .optional()
          .describe(
            'Solution mode to import under. Defaults to the mode declared in the file. ' +
              'DCSC resolves each model against this mode\'s catalog, so a model outside it ' +
              'is rejected even though the file is valid.',
          ),
      },
    },
    async (args) =>
      guard(async () => {
        let xmlContent = args.content;
        if (args.filePath) {
          const { readFileSync } = await import('node:fs');
          xmlContent = readFileSync(args.filePath, 'utf8');
        } else if (
          xmlContent &&
          (xmlContent.endsWith('.xml') || xmlContent.startsWith('/') || xmlContent.startsWith('./'))
        ) {
          const { readFileSync } = await import('node:fs');
          xmlContent = readFileSync(xmlContent, 'utf8');
        }
        if (!xmlContent) {
          throw new Error('Either content string or filePath must be provided.');
        }

        const ctx = service.newCtx();
        const res = await service.importConfig({
          content: xmlContent,
          ctx,
          mode: args.mode,
          ...(args.workspace !== undefined ? { workspaceId: args.workspace } : {}),
          ...(args.solutionMode !== undefined ? { solutionMode: args.solutionMode } : {}),
          ...(args.filePath !== undefined
            ? { fileName: args.filePath.split('/').pop() ?? 'configuration.xml' }
            : {}),
        });

        const { missingParts, removedParts, replacedParts, eccnRestricted } = res.diagnostics;
        const lostParts = missingParts.length + removedParts.length;

        return {
          workspace: res.workspaceId,
          importedConfigurations: res.sessions.length,
          sessions: res.sessions.map((s) => ({
            id: s.id,
            productCode: s.product.code,
            description: s.product.description,
            quantity: s.raw.quantity ?? 1,
            totalPrice: s.raw.totalPrice ?? 0,
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
          next: 'dcsc_session_info(session) to inspect imported configuration.',
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
        'It does not claim server validation. FLOOR export is still blocked (P1).',
      inputSchema: {
        session: z.string().describe('Session or workspace ID.'),
        rackId: z.string().describe('Rack ID from dcsc_add_rack (configuration id of the rack).'),
        x: z.number().int().min(0).describe('Floor tile X coordinate (0-based).'),
        y: z.number().int().min(0).describe('Floor tile Y coordinate (0-based).'),
      },
    },
    async (args) =>
      guard(async () => {
        const result = service.placeOnFloor(args.session, args.rackId, args.x, args.y);
        return {
          session: args.session,
          floorPlacement: result.item,
          clientSide: result.clientSide,
          warning: result.warning,
          next: 'dcsc_workspace_layout(session) to list floor items; FLOOR export is not available yet.',
        };
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
          ctx,
        });

        if (result.catalog) {
          const pdus = result.catalog.options.filter((o) => o.section.toUpperCase() === 'PDU');
          const cords = result.catalog.options.filter((o) => o.section.toUpperCase() !== 'PDU');
          return {
            session: args.session,
            rackId: result.rackId,
            rackSession: result.rackSessionId,
            listing: true,
            pduOptions: pdus.slice(0, 30).map((o) => ({
              code: o.code,
              description: o.description,
              min: o.min,
              max: o.max,
              unitPrice: o.unitPrice,
              selectedQty: o.selectedQty,
            })),
            cordOptions: cords.slice(0, 20).map((o) => ({
              code: o.code,
              description: o.description,
              section: o.section,
              min: o.min,
              max: o.max,
              unitPrice: o.unitPrice,
              selectedQty: o.selectedQty,
            })),
            placementRules: result.catalog.placementRules,
            totalCombinedSlots: result.catalog.totalCombinedSlots,
            selected: result.selected,
            totalPrice: result.totalPrice,
            priceType: 'LIST',
            next:
              'dcsc_configure_pdu(session, rackId, pduCode: "<code>", quantity: N) to select. ' +
              'Prices are anonymous LIST prices.',
          };
        }

        return {
          session: args.session,
          rackId: result.rackId,
          rackSession: result.rackSessionId,
          powerSelection: result.selection,
          selected: result.selected,
          totalPrice: result.totalPrice,
          priceType: 'LIST',
          note:
            'Selection was applied through DCSC autoDerive. totalPrice is the rack cabinet LIST price ' +
            'after the change, not a quote.',
          next: 'dcsc_session_info(rackSession) for the full rack BOM, or dcsc_workspace_layout(session).',
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
        'Returns the compact summary of a configuration or multi-product workspace: products, quantities, prices, tabs and constraints.',
      inputSchema: { session: z.string() },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);
        const workspace = service.sessions.getWorkspace(args.session);
        const isMulti = workspace && workspace.configurations.size > 1;

        if (isMulti) {
          const configs = [...workspace.configurations.values()].map((s) => ({
            id: s.id,
            productCode: s.product.code,
            description: s.product.description,
            quantity: s.raw.quantity ?? 1,
            unitPrice: s.raw.totalPrice ?? 0,
            extendedPrice: (s.raw.totalPrice ?? 0) * (s.raw.quantity ?? 1),
          }));
          const totalExt = configs.reduce((sum, c) => sum + c.extendedPrice, 0);

          return {
            workspace: workspace.id,
            isMultiProduct: true,
            totalPrice: Math.round(totalExt * 100) / 100,
            currency: session.locale.currency,
            country: session.locale.country,
            configurations: configs,
            racks: [...workspace.racks.values()],
            cables: workspace.cables,
          };
        }

        return {
          workspace: session.workspaceId,
          ...projectSummary({
            sessionId: session.id,
            revision: session.revision,
            raw: session.raw,
            index: session.index,
            currency: session.locale.currency,
            country: session.locale.country,
            pricedAt: session.pricedAt,
          }),
          mode: session.mode,
          primed: session.primed,
          ...(session.primed
            ? {}
            : {
                warning:
                  'This configuration could not be primed, so dcsc_configure may fail. Browsing, pricing and export still work.',
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

        if (args.tab && !args.query && !args.section) {
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

        const byTab = new Map<string, Array<Record<string, unknown>>>();
        for (const f of session.index.features) {
          if (f.selectedQty <= 0) continue;
          const list = byTab.get(f.tab) ?? [];
          list.push({
            code: f.code,
            qty: f.selectedQty,
            description: f.description,
            unitPrice: f.unitPrice,
            section: f.sectionTitle,
          });
          byTab.set(f.tab, list);
        }

        return {
          ...summary,
          selections: [...byTab.entries()].map(([tab, items]) => ({ tab, items })),
        };
      }),
  );

  server.registerTool(
    'dcsc_validate',
    {
      title: 'Validate a configuration with DCSC (LMC)',
      description:
        'Runs DCSC\'s manufacturing validation (/lmc_validation) using the same payload shape the web UI exports, ' +
        'and merges any expansionMessages already on the configuration tree.\n' +
        'A successful server response is an LMC handoff (buildEntityNumber, uuid, lmcURL) — not a local guess. ' +
        'isValid is false only when expansionMessages contain errors; an LMC link means DCSC accepted the request.',
      inputSchema: {
        session: z.string().describe('Session or workspace ID.'),
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
        const report = await service.validate(args.session, ctx);
        return {
          session: args.session,
          workspaceId: report.workspaceId,
          source: report.source,
          isValid: report.isValid,
          errorCount: report.errorCount,
          warningCount: report.warningCount,
          infoCount: report.infoCount,
          messages: report.messages.slice(0, 40),
          lmc: report.server
            ? {
                buildEntityNumber: report.server.buildEntityNumber,
                uuid: report.server.uuid,
                lmcURL: report.server.lmcURL,
              }
            : undefined,
          ...(report.server
            ? {}
            : {
                warning:
                  'DCSC LMC validation did not return a handoff; only local expansionMessages are shown. ' +
                  'Re-try after a successful customize/autoDerive, or check dcsc_health.',
              }),
          headroom: report.headroom,
          next: report.server?.lmcURL
            ? 'Open lmc.lmcURL for the manufacturing configurator view, or dcsc_export for deliverables.'
            : 'dcsc_list_options / dcsc_configure to clear rule issues, then re-validate.',
        };
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
        'Existing sessions keep the locale they were launched with. Prices after a locale change are still anonymous LIST prices for that country/currency.',
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
        'Lists the top of the Lenovo Services portal category tree available without login. ' +
        'Full warranty/service SKU selection on a product still uses the configuration Services tab ' +
        '(auto-attached when serviceCto applies) or may be entitlement-gated beyond this catalogue.',
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
            'This is the portal catalogue, not priced warranty lines on a CTO. ' +
            'For service features on a launched product use dcsc_list_options(session, tab: "Services").',
          next: 'dcsc_list_options(session, query: "warranty") on a launched configuration.',
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
    'dcsc_configure',
    {
      title: 'Change selections in a configuration',
      description:
        'Applies one or more option changes and returns ONLY what changed: parts added, removed or re-quantified, ' +
        'the price delta, and updated resource constraints.\n' +
        'Pass several changes together — they are applied in one round trip, so a combined edit ' +
        '(swap the CPU and bump the memory) never leaves the configuration transiently invalid.\n' +
        'DCSC reconciles dependencies itself: changing a processor may pull in a different heatsink. ' +
        'Anything DCSC decided on its own is flagged with "auto": true — always report those to the user.\n' +
        'Get the section id and feature codes from dcsc_list_options first.',
      inputSchema: {
        session: z.string(),
        changes: z
          .array(
            z.object({
              section: z
                .string()
                .describe('Section NAME from dcsc_list_options, e.g. "PROCESSOR" or "MEMORY".'),
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

        const updated = await service.configure(session, args.changes, ctx);

        const diff = diffConfigurations({
          beforeIndex,
          afterIndex: updated.index,
          beforeRaw,
          afterRaw: updated.raw,
          currency: session.locale.currency,
          requested: new Set(args.changes.map((c) => c.code)),
        });

        return {
          session: updated.id,
          revision: updated.revision,
          applied: true,
          requested: args.changes,
          ...diff,
          priceType: 'LIST',
          note:
            diff.autoChanges > 0
              ? `${diff.autoChanges} change(s) were made by DCSC's rules engine, not requested. Report these to the user.`
              : undefined,
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
        session: z.string(),
        quantity: z.number().int().min(1).max(99),
      },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);
        const before = (session.raw.totalPrice ?? 0) * (session.raw.quantity ?? 1);
        const updated = service.setQuantity(session, args.quantity);
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
            before: Math.round(before * 100) / 100,
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
        'the exact prior state rather than re-deriving it. Up to 10 steps of history are kept.',
      inputSchema: { session: z.string() },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);
        const undone = service.sessions.undo(session);
        if (!undone) {
          throw new Error('Nothing to undo — this configuration has no recorded changes.');
        }
        return {
          undone: true,
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
        'Supports rack diagrams, floor reports, P2P cabling reports, and message history.\n' +
        'Returns paths, never file contents.',
      inputSchema: {
        session: z.string(),
        fileName: z
          .string()
          .optional()
          .describe('Base name for the archive, without extension.'),
        fileTypes: z
          .array(
            z.enum([
              'XML',
              'QUOTE',
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
          .describe('Defaults to all export file types.'),
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
        const ctx = service.newCtx({ locale: service.locale, solution });

        const { stream, contentDisposition, rackDataOmitted } = await service.exportZip(args.session, {
          fileTypes: (args.fileTypes ?? DEFAULT_EXPORT_TYPES) as ExportFileType[],
          fileName,
          ctx,
        });

        const bundle = await writeExportBundle(stream, fileName, service.config);

        return {
          session: args.session,
          contentDisposition,
          ...bundle,
          priceType: 'LIST',
          ...(rackDataOmitted
            ? {
                rackDataOmitted: true,
                rackWarning:
                  'DCSC rejected every rack-bearing export payload tried (including SPA dual-shape: ' +
                  'workspace.servers 0-based + rackData.rackItems 1-based; HTTP 500 Index 0 out of bounds). ' +
                  'RACK_DIAGRAM / RACK_REPORT / FLOOR / P2P artifacts cannot be produced yet. ' +
                  'Cabinets remain priced in the BOM; use dcsc_workspace_layout for the validated layout.',
              }
            : {}),
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
        'Compares two or more configurations or workspaces on the axes an architect actually decides on: ' +
        'list price, power, heat, rack count and weight — plus derived efficiency figures like price per kW.\n' +
        'This is the tool for "B200 air-cooled versus GB300 direct water at 32 nodes".\n' +
        'Pass nodes to scale every scenario to the same node count before comparing.',
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
          const ws = service.sessions.getWorkspace(handle);
          const single = service.sessions.get(handle);
          if (!ws && !single) throw new Error(`Session / Workspace ${handle} not found`);

          const configs = ws ? [...ws.configurations.values()] : [single!];
          const entries = configs
            .map((s) => ({ report: extractPowerReport(s.raw), quantity: s.raw.quantity ?? 1 }))
            .filter(
              (e): e is { report: NonNullable<typeof e.report>; quantity: number } =>
                e.report !== undefined,
            );

          // When scaling, treat the primary configuration as the repeated unit.
          const unit = single ?? configs[0]!;
          const unitPrice = unit.raw.totalPrice ?? 0;
          const unitPower = extractPowerReport(unit.raw);
          const factor = scale ?? 1;

          const power = scale
            ? unitPower
              ? aggregatePower([{ report: unitPower, quantity: scale }])
              : undefined
            : aggregatePower(entries);

          const listPrice = scale
            ? unitPrice * scale
            : configs.reduce((acc, s) => acc + (s.raw.totalPrice ?? 0) * (s.raw.quantity ?? 1), 0);

          const racks = ws?.rackSummaries ?? [];
          return {
            session: handle,
            label: ws?.label ?? single?.label ?? unit.product.code,
            primaryProduct: unit.product.code,
            description: unit.product.description,
            configurations: configs.length,
            ...(scale ? { scaledToNodes: scale, unitListPrice: unitPrice } : {}),
            listPrice,
            ...(power
              ? {
                  expectedKW: power.expectedKW,
                  maxKW: power.maxKW,
                  heatBtuHrMax: Math.round(power.heatBtuHr.max),
                  pricePerExpectedKW:
                    power.expectedKW > 0 ? Math.round(listPrice / power.expectedKW) : undefined,
                }
              : {}),
            racks: racks.length,
            rackWeightKg: racks.reduce((acc, r) => acc + (r.totalWeightKg ?? 0), 0) * factor,
            stability: racks.map((r) => r.stableStatus).filter(Boolean),
          };
        });

        // Rank on the axes where lower is better, so the answer is readable.
        const byPrice = [...scenarios].sort((a, b) => a.listPrice - b.listPrice);
        const withPower = scenarios.filter(
          (s): s is typeof s & { expectedKW: number } => typeof s.expectedKW === 'number',
        );
        const byPower = [...withPower].sort((a, b) => a.expectedKW - b.expectedKW);

        return {
          scenarios,
          cheapest: byPrice[0]?.session,
          lowestPower: byPower[0]?.session,
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
      title: 'List verified AI factory reference configurations',
      description:
        'Lists curated starting points for AI factory designs — B200, MI300X and GB300 nodes — each verified ' +
        'to launch, price, export and re-import cleanly, with the solution mode it actually belongs to. ' +
        'Start here rather than from a blank configurator.',
      inputSchema: {},
    },
    async () =>
      guard(async () => ({
        blueprints: BLUEPRINTS,
        priceType: 'LIST',
        note:
          'Prices were verified on the stated date for US/USD and will drift. ' +
          'dcsc_start_from_blueprint(id) launches one and returns live pricing.',
      })),
  );

  server.registerTool(
    'dcsc_start_from_blueprint',
    {
      title: 'Start a configuration from a verified blueprint',
      description:
        'Launches one of the reference AI factory configurations in the correct solution mode. ' +
        'Equivalent to dcsc_launch with the right product code and mode already chosen.',
      inputSchema: {
        blueprint: z.string().describe('Blueprint id or product code from dcsc_blueprints.'),
        label: z.string().optional(),
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
        const solution = await service.resolveSolution(ctx, blueprint.solutionMode);
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
          next: 'dcsc_scale_out(session, nodes, rackCode) to size a cluster, or dcsc_list_options to adjust the node.',
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
        'This sizes and prices the cluster; it does not create N separate configurations.',
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
        return {
          ...plan,
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
        'which is what decides how many nodes fit in a room, long before price does.\n' +
        'Figures come from DCSC as configured; they are not estimates.',
      inputSchema: {
        session: z.string().describe('Session or workspace ID.'),
      },
    },
    async (args) =>
      guard(async () => {
        const workspace = service.sessions.getWorkspace(args.session);
        const single = service.sessions.get(args.session);
        if (!workspace && !single) throw new Error(`Session / Workspace ${args.session} not found`);

        const configs = workspace ? [...workspace.configurations.values()] : [single!];
        const perConfig = configs.map((s) => ({
          session: s.id,
          code: s.product.code,
          description: s.product.description,
          quantity: s.raw.quantity ?? 1,
          power: extractPowerReport(s.raw),
        }));

        const contributing = perConfig.filter(
          (p): p is typeof p & { power: NonNullable<typeof p.power> } => p.power !== undefined,
        );
        const total = aggregatePower(
          contributing.map((p) => ({ report: p.power, quantity: p.quantity })),
        );

        // Per-rack rollup, using the layout DCSC validated.
        const perRack = (workspace?.rackSummaries ?? []).map((rack) => {
          const ids = new Set(rack.items.map((i) => i.id));
          const inRack = contributing.filter((p) => {
            const cfg = configs.find((c) => c.id === p.session);
            return cfg !== undefined && ids.has(cfg.configurationId);
          });
          return {
            rackId: rack.id,
            code: rack.code,
            nodes: inRack.length,
            ...aggregatePower(inRack.map((p) => ({ report: p.power, quantity: p.quantity }))),
          };
        });

        const voltages = [
          ...new Set(contributing.map((p) => p.power.operatingVoltage).filter(Boolean)),
        ];

        return {
          session: args.session,
          perConfiguration: perConfig,
          total,
          ...(perRack.length > 0 ? { perRack } : {}),
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
      title: 'List network topologies, node roles and storage switches',
      description:
        'Lists the network fabrics DCSC can build (IB_XDR, 400GbE_Fiber, 800GbE_Copper and so on), ' +
        'the node roles a system can take (Compute, Storage, Management), and the storage switches available. ' +
        'Use this before designing the fabric of an AI factory.',
      inputSchema: { solutionMode: z.string().optional() },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const solution = await service.resolveSolution(ctx, args.solutionMode);
        const fabric = await service.fabricOptions(ctx, solution);
        return {
          solutionMode: solution.solutionMode,
          ...fabric,
          note: 'Topology and role selection is applied per configuration with dcsc_set_node_role.',
        };
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
        session: z.string(),
        role: z.string().describe('Role from dcsc_fabric_options, e.g. "Compute".'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);
        const ctx = service.newCtx();
        const roles = await service.fabricOptions(ctx, session.solution);
        const match = roles.nodeRoles.find(
          (r) => r.role.toLowerCase() === args.role.toLowerCase(),
        );
        if (!match) {
          throw new Error(
            `Unknown node role "${args.role}". Valid roles: ${roles.nodeRoles.map((r) => r.role).join(', ')}.`,
          );
        }
        session.reduced.nodeRole = match.role;
        return { session: session.id, nodeRole: match.role };
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
          topology: args.topology,
          autoConnect: args.autoConnect ?? true,
          ctx,
        });
        return {
          session: result.session,
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
        openSessions: service.sessions.list().length,
        config: redactConfig(service.config),
      })),
  );
}

function requireSession(service: DcscService, id: string) {
  const session = service.sessions.get(id);
  if (!session) {
    throw new Error(
      `No such configuration session: ${id}. Use dcsc_session_list to see open sessions, or dcsc_launch to start one.`,
    );
  }
  return session;
}
