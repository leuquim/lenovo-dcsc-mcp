import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  browseStandaloneSoftware,
  type SoftwareCatalogPath,
  type StandaloneSoftwareState,
} from '../domain/standalone.js';
import {
  emptyStandaloneHardware,
  standaloneHardwareTotal,
} from '../domain/standaloneHardware.js';
import {
  addHardware,
  exportProductServiceArtifact,
  exportStandaloneSoftwareArtifact,
  hardwareState,
  launchServices,
  launchSoftware,
  lookupParts,
  partSupplyStatus,
  removeHardware,
  removeService,
  removeSoftware,
  requireWorkspace,
  selectService,
  selectSoftware,
  serviceState,
  setHardwareQuantity,
  setServiceProductQuantity,
  setServiceQuantity,
  setSoftwareQuantity,
  softwareState,
} from '../app/standalone.js';
import type { ExportFileType } from '../domain/reduce.js';
import { sanitiseFileName } from '../files/artifactStore.js';
import type { WorkspaceSession } from '../model/session.js';
import type { DcscService } from './service.js';
import { projectCatalogPage } from '../model/catalogPage.js';
import { guard, withToolSupport } from './toolSupport.js';
import { isObject } from '../util/coerce.js';

const MAX_PAGE = 50;

export function registerStandaloneTools(rawServer: McpServer, service: DcscService): void {
  const server = withToolSupport(rawServer);

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
        includeSupplyStatus: z.boolean().optional().describe('Fetch supply status and shipping lead-times for matched parts.'),
        supplyStatusType: z.string().optional().describe('Type for supply status query (e.g. Option, CTO, LFO). Defaults to Option.'),
      },
    },
    async (args) =>
      guard(async () => {
        const { ctx, solution, items } = await lookupParts(service, args);
        const projected = projectCatalogPage({
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

        if (args.includeSupplyStatus) {
          const targetCode = items[0]?.code ?? args.keyword.trim();
          return {
            ...projected,
            supplyStatus: await partSupplyStatus(service, ctx, targetCode, args.supplyStatusType ?? 'Option'),
          };
        }

        return projected;
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
        const { workspace, state } = await launchSoftware(service, args);
        return {
          workspace: workspace.id,
          revision: workspace.revision,
          catalogItems: state.features.length,
          selections: softwareState(workspace).selections.length,
          solutionMode: workspace.solution.solutionMode,
          ...pricingContext(workspace.locale.country, workspace.locale.currency),
          next: {
            tool: 'dcsc_software_browse',
            arguments: { workspace: workspace.id, offset: 0, limit: 20 },
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
        'Adds an exact Lenovo hardware option PN (transceiver, cable, kit) as a standalone item via Part Search, replacing quantity if already selected. Omit workspace to create a standalone workspace.',
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
        const workspace = await addHardware(service, { ...args, quantity: args.quantity ?? 1 });
        return projectHardwareWorkspace(workspace, exportHint);
      }, 'dcsc_standalone_hardware_add failed'),
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
        const workspace = await setHardwareQuantity(service, args);
        return projectHardwareWorkspace(workspace, exportHint);
      }, 'dcsc_standalone_hardware_set_quantity failed'),
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
        const workspace = await removeHardware(service, args);
        return projectHardwareWorkspace(workspace, exportHint);
      }, 'dcsc_standalone_hardware_remove failed'),
  );

  server.registerTool(
    'dcsc_standalone_hardware_inspect',
    {
      title: 'Inspect standalone hardware',
      description: 'Lists the standalone hardware parts in a workspace with unit and extended list prices.',
      inputSchema: { workspace: z.string() },
    },
    async (args) =>
      guard(
        async () => projectHardwareWorkspace(requireWorkspace(service, args.workspace), exportHint),
        'dcsc_standalone_hardware_inspect failed',
      ),
  );
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
        return projectSoftwareWorkspace(await selectSoftware(service, args));
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
        return projectSoftwareWorkspace(await setSoftwareQuantity(service, args));
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
        return projectSoftwareWorkspace(await removeSoftware(service, args));
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
        return projectServiceWorkspace(await launchServices(service, args), 0, 20);
      }),
  );

  server.registerTool(
    'dcsc_services_select',
    {
      title: 'Select a product service or add-on',
      description:
        'Selects an offered base service or add-on (per covered product), runs DCSC auto-derive, and refreshes summary pricing. A base package replaces any active base package; an add-on replaces only terms in the same add-on family.',
      inputSchema: {
        workspace: z.string(),
        serviceCode: z.string().min(1),
        quantity: z.number().int().min(1).max(9999).optional().default(1),
        expectedRevision: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        return projectServiceWorkspace(await selectService(service, args), 0, 20);
      }),
  );

  server.registerTool(
    'dcsc_services_set_quantity',
    {
      title: 'Set selected product-service quantity',
      description:
        'Requests a positive per-product quantity for a selected service or add-on and refreshes summary pricing. Use dcsc_services_set_product_quantity for covered-product count and dcsc_services_remove to remove a service.',
      inputSchema: {
        workspace: z.string(),
        serviceCode: z.string().min(1).optional(),
        quantity: z.number().int().min(1).max(9999),
        expectedRevision: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        return projectServiceWorkspace(await setServiceQuantity(service, args), 0, 20);
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
        return projectServiceWorkspace(await setServiceProductQuantity(service, args), 0, 20);
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
        return projectServiceWorkspace(await removeService(service, args), 0, 20);
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
      const product = isObject(item) ? item : {};
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
          const selected = isObject(item) ? item : {};
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
  const record = isObject(value) ? value : {};
  return {
    available: true,
    responseBytes: Buffer.byteLength(encoded),
    ...(record['totalPrice'] !== undefined ? { totalPrice: record['totalPrice'] } : {}),
    ...(record['currency'] !== undefined ? { currency: record['currency'] } : {}),
    truncated: true,
  };
}


function pricingContext(country: string, currency: string) {
  return { country, currency, priceType: 'LIST', account: 'anonymous' };
}

