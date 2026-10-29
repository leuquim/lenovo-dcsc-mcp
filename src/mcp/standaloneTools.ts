import { reconcileImportedSoftwareCatalog, SERVICE_METADATA_REFRESH_WARNING } from '../domain/importStandalone.js';
import { renderRackImage } from '../domain/rackImage.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  buildExportData,
  buildExportForm,
  buildGroups,
  DEFAULT_EXPORT_TYPES,
  type ExportFileType,
} from '../domain/reduce.js';
import {
  browseStandaloneSoftware,
  buildProductServiceExportEnvelope,
  buildStandaloneSoftwareExportEnvelope,
  findParts,
  launchProductServices,
  refreshProductServiceCatalog,
  launchStandaloneSoftware,
  removeProductService,
  removeStandaloneSoftware,
  selectProductService,
  selectStandaloneSoftware,
  setStandaloneSoftwareQuantity,
  summariseProductServices,
  type ProductServiceState,
  type SoftwareCatalogPath,
  type StandaloneSoftwareState,
} from '../domain/standalone.js';
import {
  emptyStandaloneHardware,
  lookupStandaloneHardwarePart,
  removeStandaloneHardware,
  selectStandaloneHardware,
  setStandaloneHardwareQuantity,
  standaloneHardwareExportItem,
  standaloneHardwareGroupProduct,
  standaloneHardwareTotal,
  type StandaloneHardwareState,
} from '../domain/standaloneHardware.js';
import { sanitiseFileName, writeExportBundle, type ExportBundle } from '../files/artifactStore.js';
import { toToolError } from '../http/errors.js';
import { logger } from '../http/trace.js';
import type { WorkspaceSession } from '../session/SessionStore.js';
import type { DcscService } from './service.js';
import { projectCatalogPage } from '../model/catalogPage.js';

const SOFTWARE_STATE = 'standaloneSoftwareState';
const SERVICE_STATE = 'standaloneServiceState';
export const HARDWARE_STATE = 'standaloneHardwareState';
const MAX_PAGE = 50;
const PART_LOOKUP_SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const MAX_PART_LOOKUP_SNAPSHOTS = 4;
/** Captured default choices in the standalone software export dialog. */
export const SOFTWARE_EXPORT_TYPES: ExportFileType[] = ['XML', 'QUOTE', 'QUOTE_SUPPLYINFO', 'QUOTE_GROUP', 'SUMMARY', 'POWER_REPORT', 'QUOTE_CSV', 'EPRICE_CSV'];

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean | undefined;
};

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  logger().error(
    { err: error instanceof Error ? error.message : String(error) },
    'Standalone tool failed',
  );
  return {
    content: [{ type: 'text', text: JSON.stringify(toToolError(error), null, 2) }],
    isError: true,
  };
}

async function guard(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    return fail(error);
  }
}

export function registerStandaloneTools(server: McpServer, service: DcscService): void {
  type PartLookupProjection = {
    code: string;
    description: string;
    type: string;
    nextAction: string;
  };
  const partLookupSnapshots = new Map<string, { at: number; items: PartLookupProjection[] }>();

  server.registerTool(
    'dcsc_find_parts',
    {
      title: 'Find Lenovo parts globally',
      description:
        'Searches DCSC global part lookup across hardware, software and services. ' +
        'The upstream endpoint exposes no verified total or cursor, so pagination is local over the fetched response.',
      inputSchema: {
        keyword: z.string().min(1),
        types: z.array(z.enum(['SOFTWARE', 'SERVICE', 'HARDWARE'])).min(1).optional(),
        mode: z.enum(['CTO', 'LFO']).optional().default('CTO'),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(1000).optional().default(20).describe('Maximum rows (capped at 50) or characters on a detail page.'),
        path: z.array(z.string()).optional().describe('Lossless detail path from a returned continuation.'),
        expectedCatalogFingerprint: z.string().optional().describe('Returned continuation fingerprint; rejects catalog or context changes.'),
        solutionMode: z.string().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const initial = service.newCtx();
        const solution = await service.resolveSolution(initial, args.solutionMode);
        const ctx = service.newCtx({ solution });
        const snapshotKey = JSON.stringify({
          keyword: args.keyword.trim(),
          types: args.types ?? ['SOFTWARE', 'SERVICE', 'HARDWARE'],
          mode: args.mode,
          locale: ctx.locale,
          solution,
        });
        const now = Date.now();
        for (const [key, snapshot] of partLookupSnapshots) {
          if (now - snapshot.at >= PART_LOOKUP_SNAPSHOT_TTL_MS) partLookupSnapshots.delete(key);
        }
        let items = args.expectedCatalogFingerprint
          ? partLookupSnapshots.get(snapshotKey)?.items
          : undefined;
        if (!items) {
          const result = await findParts(service.http, ctx, {
            keyword: args.keyword,
            mode: args.mode,
            ...(args.types !== undefined ? { types: args.types } : {}),
          });
          items = result.items.map((item) => ({ code: item.code, description: item.description,
            type: item.type, nextAction: item.nextAction }));
          partLookupSnapshots.delete(snapshotKey);
          partLookupSnapshots.set(snapshotKey, { at: now, items });
          while (partLookupSnapshots.size > MAX_PART_LOOKUP_SNAPSHOTS) {
            const oldest = partLookupSnapshots.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            partLookupSnapshots.delete(oldest);
          }
        }
        return projectCatalogPage({
          tool: 'dcsc_find_parts', collection: 'parts',
          context: ctx.locale,
          arguments: { keyword: args.keyword, types: args.types, mode: args.mode, solutionMode: solution.solutionMode },
          offset: args.offset ?? 0, limit: args.limit ?? 20, path: args.path,
          expectedCatalogFingerprint: args.expectedCatalogFingerprint,
          items,
          base: {
            query: args.keyword,
            mode: args.mode,
            solutionMode: solution.solutionMode,
            ...pricingContext(service.locale.country, service.locale.currency),
            page: {
              offset: args.offset,
              limit: args.limit,
              itemsInFetchedResponse: items.length,
              source: 'GET /api/findpart',
              upstreamCompleteness: 'unknown',
              upstreamContract: 'single-response-array',
              upstreamPagination: 'none-reported',
              continuationScope: 'local-snapshot',
            },
            scope:
              'Website-equivalent lookup: Lenovo returns one array and the website paginates it client-side. ' +
              'Lenovo reports no total or cursor, so upstream exhaustiveness is unknown. If an expected part is missing, ' +
              'retry its exact code or a narrower keyword; use dcsc_find_products for configurable systems.',
          },
        });
      }),
  );

  server.registerTool(
    'dcsc_software_launch',
    {
      title: 'Open the standalone software catalog',
      description:
        'Loads the complete standalone software portal and stores it in a durable workspace. ' +
        'Use refresh=true to update the browse catalog while preserving selected quantities and prices, or replace=true to reset the basket.',
      inputSchema: {
        workspace: z.string().optional(),
        solutionMode: z.string().optional(),
        label: z.string().optional(),
        replace: z.boolean().optional().default(false),
        refresh: z.boolean().optional().default(false),
        expectedRevision: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        if (args.replace && args.refresh) throw new Error('Choose refresh or replace, not both.');
        const existing = args.workspace ? requireWorkspace(service, args.workspace) : undefined;
        if (existing && softwareState(existing, false) && !args.replace && !args.refresh) {
          throw new Error('This workspace already has a software catalog. Use refresh=true to preserve selections or replace=true to reset it.');
        }
        const { ctx, solution } = await contextFor(service, existing, args.solutionMode);
        const state = await launchStandaloneSoftware(service.http, ctx);
        const result = await service.sessions.createManyAtomic([], {
          ...(existing ? { workspaceHandle: existing.id } : {}),
          ...(args.expectedRevision !== undefined
            ? { expectedRevision: args.expectedRevision }
            : {}),
          ...(!existing
            ? {
                workspaceContext: {
                  locale: ctx.locale,
                  solution,
                  ...(args.label !== undefined ? { label: args.label } : {}),
                },
              }
            : {}),
          prepare: (draft) => {
            if (softwareState(draft, false) && !args.replace && !args.refresh) {
              throw new Error('This workspace already has a software catalog. Use refresh=true to preserve selections or replace=true to reset it.');
            }
            if (draft.serverState[SERVICE_STATE]) throw new Error('Independent services require a separate workspace.');
            const current = softwareState(draft, false);
            draft.serverState[SOFTWARE_STATE] = current && args.refresh
              ? reconcileImportedSoftwareCatalog(current, state) : state;
          },
        });
        return {
          workspace: result.workspace.id,
          revision: result.workspace.revision,
          catalogItems: state.features.length,
          selections: softwareState(result.workspace).selections.length,
          solutionMode: result.workspace.solution.solutionMode,
          ...pricingContext(result.workspace.locale.country, result.workspace.locale.currency),
          next: {
            tool: 'dcsc_software_browse',
            arguments: { workspace: result.workspace.id, offset: 0, limit: 20 },
          },
        };
      }),
  );

  server.registerTool(
    'dcsc_software_browse',
    {
      title: 'Browse standalone software',
      description:
        'Filters and paginates the complete software catalog already fetched into a workspace. ' +
        'Prices are anonymous Lenovo list prices from the launch catalog; no repricing endpoint is implied.',
      inputSchema: {
        workspace: z.string(),
        query: z.string().optional(),
        tab: z.string().optional(),
        subTab: z.string().optional(),
        section: z.string().optional(),
        subCategory: z.string().optional(),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(1000).optional().default(20).describe('Maximum rows (capped at 50) or characters on a detail page.'),
        path: z.array(z.string()).optional().describe('Lossless detail path from a returned continuation.'),
        expectedCatalogFingerprint: z.string().optional().describe('Returned continuation fingerprint; rejects catalog or context changes.'),
      },
    },
    async (args) =>
      guard(async () => {
        const workspace = requireWorkspace(service, args.workspace);
        const path: Partial<SoftwareCatalogPath> = {
          ...(args.tab !== undefined ? { tab: args.tab } : {}),
          ...(args.subTab !== undefined ? { subTab: args.subTab } : {}),
          ...(args.section !== undefined ? { section: args.section } : {}),
          ...(args.subCategory !== undefined ? { subCategory: args.subCategory } : {}),
        };
        const page = browseStandaloneSoftware(softwareState(workspace), {
          ...(args.query !== undefined ? { query: args.query } : {}),
          ...(Object.keys(path).length > 0 ? { path } : {}),
          offset: 0,
          limit: Math.max(softwareState(workspace).features.length, 1),
        });
        return projectCatalogPage({
          tool: 'dcsc_software_browse', collection: 'software',
          context: workspace.locale,
          arguments: { workspace: workspace.id, query: args.query, ...path },
          offset: args.offset ?? 0, limit: args.limit ?? 20, path: args.path,
          expectedCatalogFingerprint: args.expectedCatalogFingerprint,
          items: page.items.map(feature => projectSoftwareFeature(feature, workspace.id, workspace.revision)),
          base: {
          workspace: workspace.id,
          revision: workspace.revision,
          ...pricingContext(workspace.locale.country, workspace.locale.currency),
          page: {
            offset: page.offset,
            limit: page.limit,
            totalInFetchedCatalog: page.totalInFetchedCatalog,
            upstreamCompleteness: page.upstreamCompleteness,
          },
          action: 'Use dcsc_software_select with this workspace and one returned code.',
          },
        });
      }),
  );

  registerSoftwareMutationTools(server, service);
  registerHardwareTools(server, service);
  registerServiceTools(server, service);
}

function registerHardwareTools(server: McpServer, service: DcscService): void {
  const exportHint = 'dcsc_export(session: workspace) includes these lines with the rest of the solution.';
  server.registerTool(
    'dcsc_standalone_hardware_add',
    {
      title: 'Add a standalone hardware part',
      description:
        'Adds a hardware option part number (transceiver, cable, kit...) as a standalone item, exactly like the ' +
        "website's Part Search > Add Items. The part is resolved by exact part number through Part Search, so use the " +
        'Lenovo option PN (e.g. 4X97B05748), not a feature code. Adding a part already selected replaces its quantity. ' +
        'Omit workspace to start a standalone-only workspace; pass an existing workspace to add to a hardware solution. ' +
        'Prices are anonymous list prices.',
      inputSchema: {
        workspace: z.string().optional(),
        code: z.string().min(1).describe('Option part number, e.g. "4TC7B10008".'),
        quantity: z.number().int().min(1).max(99999).optional().default(1),
        solutionMode: z.string().optional(),
        label: z.string().optional(),
        expectedRevision: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const existing = args.workspace ? requireWorkspace(service, args.workspace) : undefined;
        if (existing?.serverState[SERVICE_STATE]) throw new Error('Independent services require a separate workspace.');
        const { ctx, solution } = await contextFor(service, existing, args.solutionMode);
        const part = await lookupStandaloneHardwarePart(service.http, ctx, args.code);
        const result = await service.sessions.createManyAtomic([], {
          ...(existing ? { workspaceHandle: existing.id } : {}),
          ...(args.expectedRevision !== undefined ? { expectedRevision: args.expectedRevision } : {}),
          ...(!existing
            ? { workspaceContext: { locale: ctx.locale, solution, ...(args.label !== undefined ? { label: args.label } : {}) } }
            : {}),
          prepare: (draft) => {
            if (draft.serverState[SERVICE_STATE]) throw new Error('Independent services require a separate workspace.');
            draft.serverState[HARDWARE_STATE] = selectStandaloneHardware(
              hardwareState(draft, false) ?? emptyStandaloneHardware(), part, args.quantity ?? 1);
          },
        });
        return projectHardwareWorkspace(result.workspace, exportHint);
      }),
  );

  server.registerTool(
    'dcsc_standalone_hardware_set_quantity',
    {
      title: 'Set standalone hardware quantity',
      description: 'Changes the quantity of a selected standalone hardware part, as the website quantity box does.',
      inputSchema: {
        workspace: z.string(),
        code: z.string().min(1),
        quantity: z.number().int().min(1).max(99999),
        expectedRevision: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        await service.sessions.transact(
          args.workspace,
          { keepEmptyWorkspace: true, ...(args.expectedRevision !== undefined ? { expectedRevision: args.expectedRevision } : {}) },
          (draft) => {
            draft.serverState[HARDWARE_STATE] = setStandaloneHardwareQuantity(hardwareState(draft), args.code, args.quantity);
          },
        );
        return projectHardwareWorkspace(requireWorkspace(service, args.workspace), exportHint);
      }),
  );

  server.registerTool(
    'dcsc_standalone_hardware_remove',
    {
      title: 'Remove standalone hardware',
      description: 'Removes one standalone hardware part from the workspace.',
      inputSchema: {
        workspace: z.string(),
        code: z.string().min(1),
        expectedRevision: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        await service.sessions.transact(
          args.workspace,
          { keepEmptyWorkspace: true, ...(args.expectedRevision !== undefined ? { expectedRevision: args.expectedRevision } : {}) },
          (draft) => {
            draft.serverState[HARDWARE_STATE] = removeStandaloneHardware(hardwareState(draft), args.code);
          },
        );
        return projectHardwareWorkspace(requireWorkspace(service, args.workspace), exportHint);
      }),
  );

  server.registerTool(
    'dcsc_standalone_hardware_inspect',
    {
      title: 'Inspect standalone hardware',
      description: 'Lists the standalone hardware parts in a workspace with unit and extended list prices.',
      inputSchema: { workspace: z.string() },
    },
    async (args) => guard(async () => projectHardwareWorkspace(requireWorkspace(service, args.workspace), exportHint)),
  );
}

function hardwareState(workspace: WorkspaceSession): StandaloneHardwareState;
function hardwareState(workspace: WorkspaceSession, required: false): StandaloneHardwareState | undefined;
function hardwareState(workspace: WorkspaceSession, required = true): StandaloneHardwareState | undefined {
  const value = workspace.serverState[HARDWARE_STATE];
  if (isRecord(value) && value['kind'] === 'standalone-hardware') return value as unknown as StandaloneHardwareState;
  if (required) throw new Error(`Workspace ${workspace.id} has no standalone hardware. Add a part with dcsc_standalone_hardware_add.`);
  return undefined;
}

function projectHardwareWorkspace(workspace: WorkspaceSession, next: string) {
  const state = hardwareState(workspace, false) ?? emptyStandaloneHardware();
  const total = standaloneHardwareTotal(state);
  return {
    workspace: workspace.id,
    revision: workspace.revision,
    ...pricingContext(workspace.locale.country, workspace.locale.currency),
    selections: state.selections.map((selection) => ({
      code: selection.code,
      featureCode: selection.featureCode,
      description: selection.description,
      quantity: selection.quantity,
      unitPrice: selection.unitPrice,
      totalPrice: selection.unitPrice !== undefined ? Math.round(selection.unitPrice * selection.quantity * 100) / 100 : undefined,
    })),
    totalListPrice: total,
    priceIncomplete: total === undefined,
    hardwareConfigurations: workspace.configurations.size,
    note: 'Standalone option prices are list prices for the part on its own and can differ from the same feature selected inside a system.',
    next,
  };
}

function registerSoftwareMutationTools(server: McpServer, service: DcscService): void {
  server.registerTool(
    'dcsc_software_select',
    {
      title: 'Select standalone software',
      description: 'Adds or replaces one software SKU in the durable workspace basket using its launch-catalog price.',
      inputSchema: {
        workspace: z.string(),
        code: z.string().min(1),
        quantity: z.number().int().min(1).max(9999).optional().default(1),
        expectedRevision: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        await service.sessions.transact(
          args.workspace,
          {
            keepEmptyWorkspace: true,
            ...(args.expectedRevision !== undefined
              ? { expectedRevision: args.expectedRevision }
              : {}),
          },
          (draft) => {
            draft.serverState[SOFTWARE_STATE] = selectStandaloneSoftware(softwareState(draft), {
              code: args.code,
              quantity: args.quantity,
            });
          },
        );
        return projectSoftwareWorkspace(requireWorkspace(service, args.workspace));
      }),
  );

  server.registerTool(
    'dcsc_software_set_quantity',
    {
      title: 'Set standalone software quantity',
      description: 'Changes a selected software quantity locally using the captured website behavior and launch price.',
      inputSchema: {
        workspace: z.string(),
        code: z.string().min(1),
        quantity: z.number().int().min(1).max(9999),
        expectedRevision: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        await service.sessions.transact(
          args.workspace,
          {
            keepEmptyWorkspace: true,
            ...(args.expectedRevision !== undefined
              ? { expectedRevision: args.expectedRevision }
              : {}),
          },
          (draft) => {
            draft.serverState[SOFTWARE_STATE] = setStandaloneSoftwareQuantity(
              softwareState(draft),
              args.code,
              args.quantity,
            );
          },
        );
        return projectSoftwareWorkspace(requireWorkspace(service, args.workspace));
      }),
  );

  server.registerTool(
    'dcsc_software_remove',
    {
      title: 'Remove standalone software',
      description: 'Removes one selected standalone software SKU while retaining its fetched catalog.',
      inputSchema: {
        workspace: z.string(),
        code: z.string().min(1),
        expectedRevision: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        await service.sessions.transact(
          args.workspace,
          {
            keepEmptyWorkspace: true,
            ...(args.expectedRevision !== undefined
              ? { expectedRevision: args.expectedRevision }
              : {}),
          },
          (draft) => {
            const current = softwareState(draft);
            if (!current.selections.some((selection) => selection.code === args.code)) {
              throw new Error(`Standalone software ${args.code} is not selected.`);
            }
            draft.serverState[SOFTWARE_STATE] = removeStandaloneSoftware(current, args.code);
          },
        );
        return projectSoftwareWorkspace(requireWorkspace(service, args.workspace));
      }),
  );

  server.registerTool(
    'dcsc_software_inspect',
    {
      title: 'Inspect standalone software basket',
      description: 'Returns selected software, extended list prices and the durable workspace handle.',
      inputSchema: { workspace: z.string() },
    },
    async (args) => guard(async () => projectSoftwareWorkspace(requireWorkspace(service, args.workspace))),
  );

  server.registerTool(
    'dcsc_software_export',
    {
      title: 'Export standalone software',
      description:
        'Exports the complete workspace with standalone software using its hardware mode, or LFO for software-only baskets; streams the ZIP through the bounded artifact store and returns file paths.',
      inputSchema: {
        workspace: z.string(),
        fileName: z.string().optional(),
        fileTypes: z
          .array(
            z.enum([
              'XML',
              'QUOTE',
              'QUOTE_CSV',
              'EPRICE_CSV',
              'QUOTE_SUPPLYINFO',
              'QUOTE_GROUP',
              'SUMMARY',
              'POWER_REPORT',
              'RACK_REPORT',
              'RACK_DIAGRAM',
              'FLOOR',
              'MESSAGE_HISTORY',
              'P2P_REPORT',
            ]),
          )
          .min(1)
          .optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const workspace = requireWorkspace(service, args.workspace);
        const fileName = sanitiseFileName(args.fileName ?? `software-${Date.now()}`);
        const artifact = await exportStandaloneSoftwareArtifact(service, workspace, fileName, {
          ...(args.fileTypes ? { fileTypes: args.fileTypes as ExportFileType[] } : {}),
        });
        return {
          workspace: workspace.id,
          kind: 'standalone-software',
          ...artifact,
          ...pricingContext(workspace.locale.country, workspace.locale.currency),
          disclaimer: 'Anonymous Lenovo list prices. This export is not a quote.',
        };
      }),
  );
}

function registerServiceTools(server: McpServer, service: DcscService): void {
  server.registerTool(
    'dcsc_services_launch',
    {
      title: 'Open product-bound services',
      description:
        'Loads service options for one Lenovo product and stores the complete option graph in a workspace. ' +
        'Use refresh=true with an existing workspace to load selectable metadata while preserving its quantities, selections and saved prices. The captured Point of Sale flow supports one base package plus independent add-on families.',
      inputSchema: {
        productCode: z.string().min(1).optional(),
        productQuantity: z.number().int().min(1).max(9999).optional().default(1),
        productDescription: z.string().optional(),
        subCategory: z.string().optional().default('Point of Sale'),
        workspace: z.string().optional(),
        solutionMode: z.string().optional(),
        label: z.string().optional(),
        replace: z.boolean().optional().default(false),
        refresh: z.boolean().optional().default(false),
        expectedRevision: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        if (args.replace && args.refresh) throw new Error('Choose refresh or replace, not both.');
        const existing = args.workspace ? requireWorkspace(service, args.workspace) : undefined;
        if (args.refresh) {
          if (!existing || !serviceState(existing, false)) throw new Error('Service refresh requires an existing service workspace.');
          if (args.productCode && args.productCode !== serviceState(existing).product.code) {
            throw new Error('Refresh cannot change the serviced product. Launch a new workspace for another product.');
          }
          const { ctx } = await contextFor(service, existing, args.solutionMode);
          await service.sessions.transact(existing.id, {
            expectedRevision: args.expectedRevision, keepEmptyWorkspace: true, remoteApplied: true,
          }, async (draft) => {
            draft.serverState[SERVICE_STATE] = await refreshProductServiceCatalog(service.http, ctx, serviceState(draft));
            draft.integrityWarnings = draft.integrityWarnings.filter(warning => warning !== SERVICE_METADATA_REFRESH_WARNING);
          });
          return projectServiceWorkspace(requireWorkspace(service, existing.id), 0, 20);
        }
        if (!args.productCode) throw new Error('productCode is required when opening or replacing a service workspace.');
        if (existing && serviceState(existing, false) && !args.replace) {
          throw new Error('This workspace already has a product-service graph. Use refresh=true to preserve selections or replace=true to reset it.');
        }
        if (existing && (existing.configurations.size > 0 || existing.serverState[SOFTWARE_STATE])) throw new Error('Independent services require a separate service-only workspace.');
        const { ctx, solution } = await contextFor(service, existing, args.solutionMode);
        const state = await launchProductServices(service.http, ctx, {
          productCode: args.productCode,
          productQuantity: args.productQuantity,
          subCategory: args.subCategory,
          ...(args.productDescription !== undefined
            ? { productDescription: args.productDescription }
            : {}),
        });
        const result = await service.sessions.createManyAtomic([], {
          remoteApplied: true,
          ...(existing ? { workspaceHandle: existing.id } : {}),
          ...(args.expectedRevision !== undefined
            ? { expectedRevision: args.expectedRevision }
            : {}),
          ...(!existing
            ? {
                workspaceContext: {
                  locale: ctx.locale,
                  solution,
                  ...(args.label !== undefined ? { label: args.label } : {}),
                },
              }
            : {}),
          prepare: (draft) => {
            if (serviceState(draft, false) && !args.replace) {
              throw new Error('This workspace already has a product-service graph. Use refresh=true to preserve selections or replace=true to reset it.');
            }
            if (draft.configurations.size > 0 || draft.serverState[SOFTWARE_STATE]) throw new Error('Independent services require a separate service-only workspace.');
            draft.serverState[SERVICE_STATE] = state;
          },
        });
        return projectServiceWorkspace(result.workspace, 0, 20);
      }),
  );

  server.registerTool(
    'dcsc_services_select',
    {
      title: 'Select a product service or add-on',
      description:
        'Selects a currently offered base service or add-on, runs DCSC auto-derive and retrieves authoritative summary pricing. ' +
        'The service quantity applies per covered product; the DCSC website normally selects one of each service per product. If DCSC rejects a requested quantity, this tool reports requested and accepted quantities without saving the rejected change. ' +
        'Use dcsc_services_set_product_quantity for covered-product count. A base package replaces another base package; an add-on replaces only another term in the same add-on family.',
      inputSchema: {
        workspace: z.string(),
        serviceCode: z.string().min(1),
        quantity: z.number().int().min(1).max(9999).optional().default(1),
        expectedRevision: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const workspace = requireWorkspace(service, args.workspace);
        await selectAndSummarise(
          service,
          workspace,
          args.serviceCode,
          args.quantity,
          args.expectedRevision,
        );
        return projectServiceWorkspace(requireWorkspace(service, workspace.id), 0, 20);
      }),
  );

  server.registerTool(
    'dcsc_services_set_quantity',
    {
      title: 'Set selected product-service quantity',
      description:
        'Requests a positive per-product quantity for a selected service or add-on. This is an API extension because the DCSC website exposes service selection rather than a service-line quantity editor. ' +
        'If DCSC rejects the requested quantity, this tool reports requested and accepted quantities without saving the rejected change. Use dcsc_services_set_product_quantity for covered-product count and dcsc_services_remove to remove a service. ' +
        'Supply serviceCode when more than one item is selected.',
      inputSchema: {
        workspace: z.string(),
        serviceCode: z.string().min(1).optional(),
        quantity: z.number().int().min(1).max(9999),
        expectedRevision: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const workspace = requireWorkspace(service, args.workspace);
        const selections = serviceState(workspace).selections;
        const selection = args.serviceCode
          ? selections.find((candidate) => candidate.code === args.serviceCode)
          : selections.length === 1 ? selections[0] : undefined;
        if (!selection) throw new Error(
          selections.length > 1 && !args.serviceCode
            ? 'serviceCode is required when more than one product service is selected.'
            : `Selected product service was not found${args.serviceCode ? `: ${args.serviceCode}` : '.'}`,
        );
        await selectAndSummarise(
          service,
          workspace,
          selection.code,
          args.quantity,
          args.expectedRevision,
        );
        return projectServiceWorkspace(requireWorkspace(service, workspace.id), 0, 20);
      }),
  );

  server.registerTool(
    'dcsc_services_set_product_quantity',
    {
      title: 'Set serviced-product quantity',
      description:
        'Changes the positive covered-product quantity without reselecting or normalizing saved service lines, then refreshes DCSC summary pricing.',
      inputSchema: {
        workspace: z.string(),
        quantity: z.number().int().min(1).max(9999),
        expectedRevision: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const workspace = requireWorkspace(service, args.workspace);
        const ctx = service.newCtx({ locale: workspace.locale, solution: workspace.solution });
        await service.sessions.transact(
          workspace.id,
          {
            keepEmptyWorkspace: true,
            remoteApplied: true,
            ...(args.expectedRevision !== undefined
              ? { expectedRevision: args.expectedRevision }
              : {}),
          },
          async (draft) => {
            const current = serviceState(draft);
            let next: ProductServiceState = {
              ...current,
              product: { ...current.product, quantity: args.quantity },
              summaryRaw: undefined,
            };
            if (next.selections.length > 0) {
              next = await summariseProductServices(service.http, ctx, next);
            }
            draft.serverState[SERVICE_STATE] = next;
          },
        );
        return projectServiceWorkspace(requireWorkspace(service, workspace.id), 0, 20);
      }),
  );

  server.registerTool(
    'dcsc_services_remove',
    {
      title: 'Remove a selected product service',
      description:
        'Removes one selected base service or add-on through the captured DCSC toggle contract and refreshes authoritative summary pricing. Supply serviceCode when more than one item is selected.',
      inputSchema: {
        workspace: z.string(),
        serviceCode: z.string().min(1).optional(),
        expectedRevision: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const workspace = requireWorkspace(service, args.workspace);
        const ctx = service.newCtx({ locale: workspace.locale, solution: workspace.solution });
        await service.sessions.transact(
          workspace.id,
          {
            keepEmptyWorkspace: true,
            remoteApplied: true,
            ...(args.expectedRevision !== undefined
              ? { expectedRevision: args.expectedRevision }
              : {}),
          },
          async (draft) => {
            const current = serviceState(draft);
            if (current.selections.length === 0) throw new Error('This workspace has no selected product services.');
            const selected = args.serviceCode
              ? current.selections.find((candidate) => candidate.code === args.serviceCode)
              : current.selections.length === 1 ? current.selections[0] : undefined;
            if (!selected) throw new Error(
              current.selections.length > 1 && !args.serviceCode
                ? 'serviceCode is required when more than one product service is selected.'
                : `Selected product service was not found${args.serviceCode ? `: ${args.serviceCode}` : '.'}`,
            );
            let next = await removeProductService(service.http, ctx, current, selected.code);
            if (next.selections.length > 0) next = await summariseProductServices(service.http, ctx, next);
            draft.serverState[SERVICE_STATE] = next;
          },
        );
        return projectServiceWorkspace(requireWorkspace(service, workspace.id), 0, 20);
      }),
  );

  server.registerTool(
    'dcsc_services_inspect',
    {
      title: 'Inspect product-bound services',
      description: 'Lists current base-service and add-on selections and paginates the fetched service options.',
      inputSchema: {
        workspace: z.string(),
        query: z.string().optional(),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(MAX_PAGE).optional().default(20),
      },
    },
    async (args) =>
      guard(async () => {
        const workspace = requireWorkspace(service, args.workspace);
        return projectServiceWorkspace(workspace, args.offset, args.limit, args.query);
      }),
  );

  server.registerTool(
    'dcsc_services_export',
    {
      title: 'Export product-bound services',
      description:
        'Posts the captured summary and exact selected service derive request to /service_pacs/export, then streams the ZIP through the bounded artifact store. ' +
        'The exported XML can be restored with dcsc_import into a separate service workspace.',
      inputSchema: { workspace: z.string(), fileName: z.string().optional() },
    },
    async (args) =>
      guard(async () => {
        const workspace = requireWorkspace(service, args.workspace);
        const fileName = sanitiseFileName(args.fileName ?? `services-${Date.now()}`);
        const artifact = await exportProductServiceArtifact(service, workspace, fileName);
        const hasNonUnitServiceQuantity = serviceState(workspace).selections.some(
          (selection) => selection.quantity !== 1,
        );
        return {
          workspace: workspace.id,
          kind: 'product-bound-services',
          ...artifact,
          warnings: [
            ...artifact.warnings,
            ...(hasNonUnitServiceQuantity
              ? [
                  'Lenovo website import and display preserve non-unit service quantities, but its native Save after import and a product-quantity change was observed to omit the services and return HTTP 500. Continue editing and exporting this workspace through MCP to preserve those quantities.',
                ]
              : []),
          ],
          ...pricingContext(workspace.locale.country, workspace.locale.currency),
          importSupported: true,
          importTool: 'dcsc_import',
          selectionSemantics: 'base-plus-add-ons-verified',
          disclaimer: 'Anonymous Lenovo list prices. This export is not a quote.',
        };
      }),
  );
}

async function selectAndSummarise(
  service: DcscService,
  workspace: WorkspaceSession,
  serviceCode: string,
  quantity: number,
  expectedRevision?: number,
): Promise<void> {
  const ctx = service.newCtx({ locale: workspace.locale, solution: workspace.solution });
  await service.sessions.transact(
    workspace.id,
    {
      keepEmptyWorkspace: true,
            remoteApplied: true,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    },
    async (draft) => {
      const current = serviceState(draft);
      const existing = current.selections.find((selection) => selection.code === serviceCode);
      const selected = existing?.quantity === quantity
        ? current
        : await selectProductService(service.http, ctx, current, { serviceCode, quantity });
      const acceptedQuantity = selected.selections.find(
        (selection) => selection.code === serviceCode,
      )?.quantity ?? 0;
      if (acceptedQuantity !== quantity) {
        throw new Error(
          `DCSC rejected the requested per-product service quantity for ${serviceCode}: ` +
          `requestedQuantity=${quantity}, acceptedQuantity=${acceptedQuantity}. ` +
          'No workspace change was saved. Use dcsc_services_set_product_quantity to change the covered-product count, or dcsc_services_remove to remove this service.',
        );
      }
      draft.serverState[SERVICE_STATE] = await summariseProductServices(
        service.http,
        ctx,
        selected,
      );
    },
  );
}

export async function exportStandaloneSoftwareArtifact(
  service: DcscService,
  workspace: WorkspaceSession,
  fileName: string,
  options: {
    fileTypes?: ExportFileType[] | undefined;
    image?: string | undefined;
  } = {},
): Promise<ExportBundle & { contentDisposition: string | undefined }> {
  service.assertTrustedWorkspace(workspace.id);
  const modes = new Set([...workspace.configurations.values()].map((session) => session.mode === 'cto' ? 'ctos' : 'lfos'));
  if (modes.size > 1) throw new Error('Mixed CTO and LFO hardware requires separate workspaces.');
  if (workspace.serverState[SERVICE_STATE]) throw new Error('Independent services require a separate service-only export.');
  const fileTypes = options.fileTypes ?? (workspace.configurations.size > 0 ? DEFAULT_EXPORT_TYPES : SOFTWARE_EXPORT_TYPES);
  if (workspace.configurations.size === 0 && fileTypes.some((type) => !SOFTWARE_EXPORT_TYPES.includes(type))) {
    throw new Error(`Standalone-only workspaces support these reports: ${SOFTWARE_EXPORT_TYPES.join(', ')}. Rack and connection reports require hardware.`);
  }
  const software = softwareState(workspace, false);
  const hardware = hardwareState(workspace, false);
  const softwareSelected = (software?.selections.length ?? 0) > 0;
  const hardwareSelected = (hardware?.selections.length ?? 0) > 0;
  if (!softwareSelected && !hardwareSelected) throw new Error('Select at least one standalone software or hardware item first.');
  const base = softwareExportBase(workspace, software, fileTypes);
  const softwareEnvelope = software && softwareSelected
    ? buildStandaloneSoftwareExportEnvelope(software, base)
    : undefined;
  const hardwareRows = hardware?.selections.map(standaloneHardwareExportItem) ?? [];
  const hardwareProducts = hardware?.selections.map((selection) => standaloneHardwareGroupProduct(selection)) ?? [];
  const data = {
    ...(softwareEnvelope?.data ?? base),
    standaloneData: [...(softwareEnvelope?.data.standaloneData ?? []), ...hardwareRows],
  };
  const standaloneGroups = [{
    name: 'Config 1', parent: null, index: -1,
    products: [...(softwareEnvelope?.groups[0]?.products ?? []), ...hardwareProducts],
  }];
  const form = buildExportForm({
    data,
    groups: mergeExportGroups(buildGroups(workspace), standaloneGroups),
  });
  if (options.image !== undefined) form['image'] = options.image;
  else if (workspace.rackArea.length > 0 && fileTypes.includes('RACK_REPORT')) {
    form['image'] = renderRackImage(workspace);
  }
  const ctx = service.newCtx({ locale: workspace.locale, solution: workspace.solution });
  const response = await service.http.send({
    endpoint: 'standalone_software_export_zip',
    method: 'POST',
    path: workspace.configurations.size > 0
      ? `/${[...workspace.configurations.values()][0]!.mode === 'cto' ? 'ctos' : 'lfos'}/export_zip`
      : '/lfos/export_zip',
    query: { fileName },
    requiresSolution: false,
    body: { kind: 'form', fields: form },
    responseKind: 'stream',
    timeoutClass: 'export',
    ctx,
  });
  return {
    ...(await writeExportBundle(response.stream, fileName, service.config)),
    contentDisposition: response.contentDisposition,
  };
}

export async function exportProductServiceArtifact(
  service: DcscService,
  workspace: WorkspaceSession,
  fileName: string,
): Promise<ExportBundle & { contentDisposition: string | undefined }> {
  service.assertTrustedWorkspace(workspace.id);
  const envelope = buildProductServiceExportEnvelope(serviceState(workspace));
  const ctx = service.newCtx({ locale: workspace.locale, solution: workspace.solution });
  const response = await service.http.send({
    endpoint: 'standalone_services_export',
    method: 'POST',
    path: envelope.endpoint,
    query: { fileName },
    requiresSolution: false,
    body: { kind: 'form', fields: envelope.fields },
    responseKind: 'stream',
    timeoutClass: 'export',
    ctx,
  });
  return {
    ...(await writeExportBundle(response.stream, fileName, service.config)),
    contentDisposition: response.contentDisposition,
  };
}

function requireWorkspace(service: DcscService, handle: string): WorkspaceSession {
  const workspace = service.sessions.getWorkspace(handle);
  if (!workspace) throw new Error(`Workspace ${handle} not found.`);
  return workspace;
}

function softwareState(workspace: WorkspaceSession): StandaloneSoftwareState;
function softwareState(
  workspace: WorkspaceSession,
  required: false,
): StandaloneSoftwareState | undefined;
function softwareState(
  workspace: WorkspaceSession,
  required = true,
): StandaloneSoftwareState | undefined {
  const value = workspace.serverState[SOFTWARE_STATE];
  if (isRecord(value) && value['kind'] === 'standalone-software') {
    return value as unknown as StandaloneSoftwareState;
  }
  if (required) throw new Error(`Workspace ${workspace.id} has no standalone software catalog.`);
  return undefined;
}

function serviceState(workspace: WorkspaceSession): ProductServiceState;
function serviceState(
  workspace: WorkspaceSession,
  required: false,
): ProductServiceState | undefined;
function serviceState(
  workspace: WorkspaceSession,
  required = true,
): ProductServiceState | undefined {
  const value = workspace.serverState[SERVICE_STATE];
  if (isRecord(value) && value['kind'] === 'product-bound-services') {
    return value as unknown as ProductServiceState;
  }
  if (required) throw new Error(`Workspace ${workspace.id} has no product-service graph.`);
  return undefined;
}

async function contextFor(
  service: DcscService,
  workspace: WorkspaceSession | undefined,
  requestedMode: string | undefined,
) {
  if (workspace) {
    if (requestedMode && requestedMode !== workspace.solution.solutionMode) {
      throw new Error(
        `Workspace ${workspace.id} uses solution mode ${workspace.solution.solutionMode}, not ${requestedMode}.`,
      );
    }
    return {
      solution: workspace.solution,
      ctx: service.newCtx({ locale: workspace.locale, solution: workspace.solution }),
    };
  }
  const initial = service.newCtx();
  const solution = await service.resolveSolution(initial, requestedMode);
  return { solution, ctx: service.newCtx({ solution }) };
}

function projectSoftwareFeature(
  feature: StandaloneSoftwareState['features'][number],
  workspace: string,
  expectedRevision: number,
) {
  return {
    code: feature.code,
    softwareCode: feature.softwareCode,
    description: feature.description,
    path: feature.path,
    unitPrice: feature.unitPrice,
    priceNotAvailable: feature.priceNotAvailable,
    showPrice: feature.showPrice,
    attributes: feature.attributes,
    next: {
      tool: 'dcsc_software_select',
      arguments: { workspace, code: feature.code, quantity: 1, expectedRevision },
    },
  };
}

function projectSoftwareWorkspace(workspace: WorkspaceSession) {
  const state = softwareState(workspace);
  const selections = state.selections.map((selection) => ({
    id: selection.id,
    code: selection.code,
    description: selection.feature.description,
    quantity: selection.quantity,
    unitPrice: selection.unitPrice,
    totalPrice: selection.totalPrice,
    path: selection.feature.path,
  }));
  const result = {
    workspace: workspace.id,
    revision: workspace.revision,
    catalogItems: state.features.length,
    ...pricingContext(workspace.locale.country, workspace.locale.currency),
    selections,
    totalListPrice: state.selections.reduce(
      (total, selection) => total + (selection.totalPrice ?? 0),
      0,
    ),
    priceIncomplete: state.selections.some((selection) => selection.totalPrice === undefined),
    next:
      state.selections.length > 0
        ? { tool: 'dcsc_software_export', arguments: { workspace: workspace.id } }
        : { tool: 'dcsc_software_browse', arguments: { workspace: workspace.id } },
  };
  if (Buffer.byteLength(JSON.stringify(result, null, 2)) <= 7_500) return result;
  const compactSelections = selections.map(({ id, code, quantity, unitPrice, totalPrice }) => ({
    id, code, quantity, unitPrice, totalPrice,
  }));
  const compact = {
    ...result,
    selections: compactSelections,
    selectedTotal: selections.length,
    omittedSelections: 0,
    compacted: true,
    note: 'Descriptions and catalog paths were omitted to keep this response within the tool budget.',
  };
  while (Buffer.byteLength(JSON.stringify(compact, null, 2)) > 7_500 && compactSelections.length > 1) {
    compactSelections.pop();
    compact.omittedSelections = selections.length - compactSelections.length;
  }
  return compact;
}

function projectServiceWorkspace(
  workspace: WorkspaceSession,
  offset: number,
  limit: number,
  query?: string,
) {
  const state = serviceState(workspace);
  const needle = query?.trim().toLowerCase() ?? '';
  const matches = state.options.filter(
    (option) =>
      !needle || `${option.code} ${option.description}`.toLowerCase().includes(needle),
  );
  const options = matches.slice(offset, offset + limit).map((option) => ({
    code: option.code,
    description: option.description,
    type: option.type,
    characterName: option.characterName,
    unitPrice: option.unitPrice,
    preSelectedQuantity: option.preSelectedQuantity,
    section: option.section,
    sectionName: option.sectionName,
    sectionDescription: option.sectionDescription,
    next: {
      tool: 'dcsc_services_select',
      arguments: {
        workspace: workspace.id,
        serviceCode: option.code,
        quantity: 1,
        expectedRevision: workspace.revision,
      },
    },
  }));
  const result = {
    workspace: workspace.id,
    revision: workspace.revision,
    product: state.product,
    subCategory: state.subCategory,
    selectionSemantics: 'base-plus-add-ons-verified',
    refresh: { tool: 'dcsc_services_launch', arguments: { workspace: workspace.id, refresh: true, expectedRevision: workspace.revision } },
    ...pricingContext(workspace.locale.country, workspace.locale.currency),
    selections: state.selections.map((selection) => ({
      code: selection.code,
      quantity: selection.quantity,
      description: selection.description,
      type: selection.type,
      characterName: selection.characterName,
      section: selection.section,
      sectionName: selection.sectionName,
    })),
    summary: projectSummary(state.summaryRaw),
    page: { offset, limit, totalInCurrentGraph: matches.length, returned: options.length },
    options,
    next: undefined as { tool: string; arguments: Record<string, unknown> } | undefined,
  };
  const continuation = () => {
    result.page = { ...result.page, returned: options.length };
    result.next = offset + options.length < matches.length
      ? {
          tool: 'dcsc_services_inspect',
          arguments: { workspace: workspace.id, query, offset: offset + options.length, limit },
        }
      : undefined;
  };
  continuation();
  while (Buffer.byteLength(JSON.stringify(result, null, 2)) > 7_500 && options.length > 1) {
    options.pop();
    continuation();
  }
  return result;
}

function projectSummary(value: unknown): unknown {
  if (value === undefined) return undefined;
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) <= 3_000) return value;
  if (Array.isArray(value)) {
    const products = value.slice(0, 20).map((item) => {
      const product = isRecord(item) ? item : {};
      const results = Array.isArray(product['results']) ? product['results'] : [];
      return {
        code: product['code'],
        description: product['description'],
        quantity: product['quantity'],
        unitPrice: product['unitPrice'],
        totalPrice: product['totalPrice'],
        priceNotCredible: product['priceNotCredible'],
        errors: product['errors'],
        services: results.slice(0, 50).map((item) => {
          const selected = isRecord(item) ? item : {};
          return {
            code: selected['code'], description: selected['description'],
            quantity: selected['quantity'], unitPrice: selected['unitPrice'],
            totalPrice: selected['totalPrice'], priceNotAvailable: selected['priceNotAvailable'],
            priceNotCredible: selected['priceNotCredible'], errors: selected['errors'],
          };
        }),
      };
    });
    return {
      available: true,
      responseBytes: Buffer.byteLength(encoded),
      products,
      omittedProducts: Math.max(0, value.length - products.length),
      totalPrice: products.reduce(
        (total, product) => total + (typeof product.totalPrice === 'number' ? product.totalPrice : 0),
        0,
      ),
      truncated: true,
    };
  }
  const record = isRecord(value) ? value : {};
  return {
    available: true,
    responseBytes: Buffer.byteLength(encoded),
    ...(record['totalPrice'] !== undefined ? { totalPrice: record['totalPrice'] } : {}),
    ...(record['currency'] !== undefined ? { currency: record['currency'] } : {}),
    truncated: true,
  };
}

function softwareExportBase(
  workspace: WorkspaceSession,
  state: StandaloneSoftwareState | undefined,
  fileTypes: ExportFileType[],
): Record<string, unknown> {
  const retained = structuredClone(workspace.serverState);
  delete retained[SOFTWARE_STATE];
  delete retained[SERVICE_STATE];
  delete retained[HARDWARE_STATE];
  // Rebuilt from the typed baskets so imported rows are never sent twice.
  delete retained['standaloneData'];
  const launch = state && isRecord(state.launchRaw) ? structuredClone(state.launchRaw) : {};
  delete launch['standaloneData'];
  const canonical = buildExportData({
    workspace,
    solution: workspace.solution,
    fileTypes,
    validationMode: workspace.validationMode,
  });
  // Import responses are not export DTOs (e.g. summary/configuration/type).
  // Preserve their provenance in state; send only the captured export fields.
  const source = { ...launch, ...retained };
  const exportFields = Object.fromEntries(Object.keys(canonical)
    .filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
  return mergeCanonical(exportFields, canonical);
}

function mergeCanonical(
  retained: Record<string, unknown>,
  canonical: Record<string, unknown>,
): Record<string, unknown> {
  const merged = structuredClone(retained);
  for (const [key, canonicalValue] of Object.entries(canonical)) {
    const retainedValue = merged[key];
    merged[key] =
      isRecord(retainedValue) && isRecord(canonicalValue)
        ? mergeCanonical(retainedValue, canonicalValue)
        : structuredClone(canonicalValue);
  }
  return merged;
}

function mergeExportGroups(
  canonical: Array<Record<string, unknown>>,
  standalone: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const merged = structuredClone(canonical);
  for (const group of standalone) {
    const existing = merged.find((candidate) => candidate['name'] === group['name']);
    if (!existing) {
      merged.push(structuredClone(group));
      continue;
    }
    const canonicalProducts = Array.isArray(existing['products']) ? existing['products'] : [];
    const standaloneProducts = Array.isArray(group['products']) ? group['products'] : [];
    existing['products'] = [...canonicalProducts, ...structuredClone(standaloneProducts)];
  }
  return merged;
}

function pricingContext(country: string, currency: string) {
  return { country, currency, priceType: 'LIST', account: 'anonymous' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
