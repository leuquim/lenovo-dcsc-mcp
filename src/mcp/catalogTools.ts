import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  categoryInfo,
  searchCatalog,
  settingsGet,
  settingsSet,
} from '../app/catalog.js';
import type { DcscService } from './service.js';
import { guard } from './toolSupport.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const solutionMode = z.string().optional();
const fingerprint = z.string().optional().describe('From a continuation.');
const pageOffset = z.number().int().min(0).optional();
const rowLimit = z.number().int().min(1).max(50).optional();
const detailPath = z.array(z.string()).optional().describe('From a continuation.');
/** Offset, limit and path that page a large raw result; continuations carry them. */
const rawPaging = { offset: pageOffset, limit: z.number().int().min(1).max(50).optional(), path: detailPath };

const searchSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('products'),
    query: z.string().min(1).describe('Name, model or part number.'),
    type: z.enum(['CTO', 'LFO']).optional().describe('Configure-to-order or preconfigured only.'),
    includeWithdrawn: z.boolean().optional(),
    solutionMode, offset: pageOffset, limit: rowLimit, path: detailPath, expectedCatalogFingerprint: fingerprint,
  }),
  z.object({
    kind: z.literal('tree'),
    categoryPath: z.array(z.string()).optional().describe('Breadcrumb, e.g. ["Servers", "Rack Server"]; omit for the top level.'),
    includeWithdrawn: z.boolean().optional(),
    categoryOffset: pageOffset.describe('Category cursor from a continuation.'),
    detailPath,
    solutionMode, offset: pageOffset, limit: rowLimit, expectedCatalogFingerprint: fingerprint,
  }),
  z.object({
    kind: z.literal('parts'),
    query: z.string().min(1).describe('Part number or keyword.'),
    types: z.array(z.enum(['SOFTWARE', 'SERVICE', 'HARDWARE'])).min(1).optional().describe('Restrict part types.'),
    mode: z.enum(['CTO', 'LFO']).optional().describe('Lookup mode, default CTO.'),
    includeSupplyStatus: z.boolean().optional().describe('Add shipping lead times for the first match.'),
    supplyStatusType: z.string().optional().describe('Option (default), CTO or LFO.'),
    solutionMode, offset: pageOffset, limit: rowLimit, path: detailPath, expectedCatalogFingerprint: fingerprint,
  }),
  z.object({ kind: z.literal('preconfigured'), offset: pageOffset, limit: rowLimit, path: detailPath, expectedCatalogFingerprint: fingerprint }),
  z.object({
    kind: z.literal('sids'),
    categoryId: z.string().min(1).describe('SID category id.'),
    query: z.string().optional().describe('SID number.'),
    tceFlag: z.boolean().optional(),
    offset: pageOffset, limit: z.number().int().min(1).max(25).optional().describe('Rows per page (default 10).'),
  }),
  z.object({
    kind: z.literal('specialty'),
    catalog: z.enum(['lvr', 'converged', 'promotion']).optional().describe('Default lvr.'),
    categoryId: z.string().optional().describe('converged: category detail. promotion: filter.'),
    subType: z.enum(['hierarchies', 'sid', 'lfo', 'option']).optional().describe('promotion only.'),
    query: z.string().optional().describe('Text filter for lvr and converged lists.'),
    solutionMode, ...rawPaging,
  }),
]);

const categoryId = z.string().min(1).describe('e.g. "STG@Servers@Rack Server".');
const ctoCode = z.string().min(1).describe('Product code.');

const categorySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('detail'), categoryId,
    isTruScale: z.boolean().optional().describe('Use TruScale reference solution routing.'),
    offset: pageOffset, limit: z.number().int().min(1).max(50).optional().describe('Maximum children, products or categories to return.'), path: detailPath,
  }),
  z.object({ kind: z.literal('services'), solutionMode, ...rawPaging }),
  z.object({ kind: z.literal('caseStudies'), caseStudyId: z.string().optional().describe('Default all.'), ...rawPaging }),
  z.object({ kind: z.literal('conditions'), categoryId, ...rawPaging }),
  z.object({
    kind: z.literal('products'), categoryId,
    conditions: z.string().optional().describe('Filter conditions as the JSON string from kind conditions.'),
    pageNumber: z.number().int().min(1).optional().describe('1-based upstream page.'),
    pageSize: z.number().int().min(1).max(50).optional().describe('Upstream page size.'),
    topChoice: z.boolean().optional().describe('Top choices only.'),
    ...rawPaging,
  }),
  z.object({ kind: z.literal('topChoiceCountry'), ...rawPaging }),
  z.object({ kind: z.literal('productFunctions'), ctoCode, ...rawPaging }),
  z.object({ kind: z.literal('displayOrders'), ctoCode, ...rawPaging }),
  z.object({ kind: z.literal('staticFeatures'), ctoCode, tab: z.string().min(1).describe('Tab name.'), ...rawPaging }),
]);

/** Continuations built by the app functions carry flat arguments; the tools take them under one property. */
function nestContinuations(value: unknown, tool: string, property: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => nestContinuations(entry, tool, property));
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record['tool'] === tool && typeof record['arguments'] === 'object' && record['arguments'] !== null) {
    return { ...record, arguments: { [property]: record['arguments'] } };
  }
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, nestContinuations(entry, tool, property)]));
}

export function registerCatalogTools(server: McpServer, service: DcscService): void {

  server.registerTool(
    'dcsc_settings_get',
    {
      annotations: READ_ONLY,
      title: 'Get DCSC settings',
      description:
        'Returns the current country/language/currency and the available solution modes. Pass localeQuery (a country name, code or currency; empty for all) to list countries you can switch to.',
      inputSchema: {
        localeQuery: z.string().optional().describe('Filter countries, e.g. "Germany" or "EUR"; "" lists all.'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum countries to list (default 20).'),
      },
    },
    async (args) => guard(() => settingsGet(service, args), 'dcsc_settings_get failed'),
  );

  server.registerTool(
    'dcsc_settings_set',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: 'Set DCSC country and language',
      description:
        'Sets the default country, language and currency for later launches and searches. Existing workspaces keep their own locale.',
      inputSchema: {
        country: z.string().describe('ISO country code, e.g. "US", "DE".'),
        language: z.string().optional().describe('Language code; defaults to the country default.'),
      },
    },
    async (args) => guard(() => settingsSet(service, args), 'dcsc_settings_set failed'),
  );

  server.registerTool(
    'dcsc_search',
    {
      annotations: READ_ONLY,
      title: 'Search the DCSC catalog',
      description:
        'Finds products, parts, preconfigured codes, SIDs and specialty catalog entries. Pick the kind: products (configurable systems), tree (category browsing), parts, preconfigured (CTO/LFO codes), sids (preconfigured solutions in a category), specialty (LVR, converged, promotion). Follow returned continuations unchanged.',
      inputSchema: { search: searchSchema },
    },
    async (args) => guard(async () => nestContinuations(await searchCatalog(service, args.search), 'dcsc_search', 'search'), 'dcsc_search failed'),
  );

  server.registerTool(
    'dcsc_category',
    {
      annotations: READ_ONLY,
      title: 'Open a DCSC category page',
      description:
        'Reads a category page. Pick the kind: detail (sub-categories and products of a category), services (Services portal categories), conditions (sub-category filters), products (filtered product list), caseStudies, topChoiceCountry, productFunctions, displayOrders, staticFeatures. Follow returned continuations unchanged.',
      inputSchema: { category: categorySchema },
    },
    async (args) => guard(async () => nestContinuations(await categoryInfo(service, args.category), 'dcsc_category', 'category'), 'dcsc_category failed'),
  );
}
