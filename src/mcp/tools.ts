import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { CONFIG_MODES } from '../config/constants.js';
import { redactConfig } from '../config/schema.js';
import { browseCatalog, searchCatalog } from '../domain/catalog.js';
import { toToolError } from '../http/errors.js';
import { logger } from '../http/trace.js';
import type { ExportFileType } from '../domain/reduce.js';
import { sanitiseFileName, writeExportBundle } from '../files/artifactStore.js';
import { diffConfigurations } from '../model/diff.js';
import { searchFeatures } from '../model/index.js';
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
        return {
          solutionMode: solution.solutionMode,
          currency: service.locale.currency,
          country: service.locale.country,
          total: hits.length,
          products: hits.map((h) => ({
            code: h.code,
            type: h.type,
            description: h.description,
            path: h.path.join(' > '),
            ...(h.price !== undefined ? { listPrice: h.price } : {}),
            ...(h.withdrawn ? { withdrawn: true } : {}),
          })),
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
  // Session lifecycle
  // -------------------------------------------------------------------------

  server.registerTool(
    'dcsc_launch',
    {
      title: 'Start configuring a DCSC product',
      description:
        'Launches a configuration session for a product code and returns a compact summary (tabs, price, constraints). ' +
        'Returns a session handle used by all other configuration tools. ' +
        'The full option tree is large and is never returned — use dcsc_list_options to explore it.',
      inputSchema: {
        productCode: z.string().describe('Product code from dcsc_find_products, e.g. "7D73CTO1WW".'),
        mode: z
          .enum(CONFIG_MODES)
          .optional()
          .default('cto')
          .describe('cto for configure-to-order, lfo for a preconfigured model.'),
        label: z.string().optional().describe('Optional friendly name for this session.'),
        solutionMode: z.string().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const solution = await service.resolveSolution(ctx, args.solutionMode);
        const session = await service.launch({
          productCode: args.productCode,
          mode: args.mode,
          solution,
          ctx,
          ...(args.label !== undefined ? { label: args.label } : {}),
        });
        return {
          ...projectSummary({
            sessionId: session.id,
            revision: session.revision,
            raw: session.raw,
            index: session.index,
            currency: session.locale.currency,
            country: session.locale.country,
            pricedAt: session.pricedAt,
          }),
          next: 'dcsc_list_options(session, tab: "<tab title>") or dcsc_list_options(session, query: "...")',
        };
      }),
  );

  server.registerTool(
    'dcsc_session_list',
    {
      title: 'List open DCSC configuration sessions',
      description: 'Lists the configuration sessions currently open in this server.',
      inputSchema: {},
    },
    async () =>
      guard(async () =>
        service.sessions.list().map((s) => ({
          session: s.id,
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
      description: 'Discards a configuration session and frees its memory.',
      inputSchema: { session: z.string() },
    },
    async (args) => guard(async () => ({ closed: service.sessions.delete(args.session) })),
  );

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  server.registerTool(
    'dcsc_session_info',
    {
      title: 'Summarise a DCSC configuration',
      description:
        'Returns the compact summary of a configuration: product, quantity, list price, tabs and resource constraints.',
      inputSchema: { session: z.string() },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);
        return {
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

        // Tab view (L1): sections only, no feature lists.
        if (args.tab && !args.query && !args.section) {
          return projectTab({
            sessionId: session.id,
            revision: session.revision,
            index: session.index,
            tab: args.tab,
            currency: session.locale.currency,
          });
        }

        // Search or section view (L2).
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
      title: 'Export a configuration as XML + Excel',
      description:
        'Exports the configuration to a ZIP on disk and returns the file paths.\n' +
        'The XML is Lenovo CFXML — it re-imports into DCSC and is the file used to raise a bid or quote ' +
        'in Lenovo Bid Portal. The XLSX is the quote spreadsheet.\n' +
        'Returns paths, never file contents. Note that a configuration containing errors can be exported ' +
        'but will NOT import into Lenovo quoting tools.',
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
            ]),
          )
          .optional()
          .describe('Defaults to XML + QUOTE + SUMMARY.'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);
        const fileName = sanitiseFileName(
          args.fileName ?? `${session.product.code}-${Date.now()}`,
        );
        const ctx = service.newCtx({ locale: session.locale, solution: session.solution });

        const { stream, contentDisposition } = await service.exportZip(session, {
          fileTypes: (args.fileTypes ?? ['XML', 'QUOTE', 'SUMMARY']) as ExportFileType[],
          fileName,
          ctx,
        });

        const bundle = await writeExportBundle(stream, fileName, service.config);

        return {
          session: session.id,
          revision: session.revision,
          contentDisposition,
          ...bundle,
          priceType: 'LIST',
          disclaimer:
            'List prices for the configured country and currency. Not a quote. ' +
            'A configuration containing errors cannot be imported into Lenovo quoting tools.',
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
