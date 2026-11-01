import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  CATEGORY_KINDS,
  SEARCH_KINDS,
  categoryInfo,
  searchCatalog,
  settingsGet,
  settingsSet,
} from '../app/catalog.js';
import type { DcscService } from './service.js';
import { guard } from './toolSupport.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

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
        'Finds products, parts, preconfigured codes, SIDs and specialty catalog entries. Pick kind: products (configurable systems by name or code), tree (category browsing), parts (hardware, software and services part numbers), preconfigured (CTO/LFO codes), sids (preconfigured solutions in a category), specialty (LVR, converged, promotion). Follow returned continuations unchanged.',
      inputSchema: {
        kind: z.enum(SEARCH_KINDS),
        query: z.string().optional().describe('products/parts: name, model or part number (required). sids: SID number. specialty: text filter.'),
        type: z.enum(['CTO', 'LFO']).optional().describe('products: configure-to-order or preconfigured only.'),
        includeWithdrawn: z.boolean().optional().describe('products/tree: include withdrawn entries.'),
        categoryPath: z.array(z.string()).optional().describe('tree: breadcrumb, e.g. ["Servers", "Rack Server"]; omit for the top level.'),
        categoryOffset: z.number().int().min(0).optional().describe('tree: category cursor from a continuation.'),
        detailPath: z.array(z.string()).optional().describe('tree: detail path from a continuation.'),
        types: z.array(z.enum(['SOFTWARE', 'SERVICE', 'HARDWARE'])).min(1).optional().describe('parts: restrict part types.'),
        mode: z.enum(['CTO', 'LFO']).optional().describe('parts: lookup mode, default CTO.'),
        includeSupplyStatus: z.boolean().optional().describe('parts: add shipping lead times for the first match.'),
        supplyStatusType: z.string().optional().describe('parts: supply status type (Option, CTO, LFO); default Option.'),
        categoryId: z.string().optional().describe('sids: category id (required). specialty: converged category or promotion filter.'),
        tceFlag: z.boolean().optional().describe('sids: TCE filter.'),
        catalog: z.enum(['lvr', 'converged', 'promotion']).optional().describe('specialty: catalog, default lvr.'),
        subType: z.enum(['hierarchies', 'sid', 'lfo', 'option']).optional().describe('specialty promotion: sub-type.'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(1000).optional().describe('Rows per page (capped at 50), or characters on a detail page.'),
        path: z.array(z.string()).optional().describe('Detail path from a continuation.'),
        expectedCatalogFingerprint: z.string().optional().describe('Fingerprint from a continuation; rejects changed catalogs.'),
        solutionMode: z.string().optional(),
      },
    },
    async (args) => guard(() => searchCatalog(service, args), 'dcsc_search failed'),
  );

  server.registerTool(
    'dcsc_category',
    {
      annotations: READ_ONLY,
      title: 'Open a DCSC category page',
      description:
        'Reads a category page. kind: detail (sub-categories and products of a category), services (Services portal categories), conditions (sub-category filters), products (filtered product list), caseStudies, topChoiceCountry, productFunctions, displayOrders, staticFeatures.',
      inputSchema: {
        kind: z.enum(CATEGORY_KINDS),
        categoryId: z.string().optional().describe('e.g. "STG@Servers@Rack Server". Required for detail; used by conditions and products.'),
        isTruScale: z.boolean().optional().describe('detail: use TruScale reference solution routing.'),
        limit: z.number().int().min(1).max(50).optional().describe('detail: maximum children to return.'),
        ctoCode: z.string().optional().describe('productFunctions, displayOrders, staticFeatures: product code.'),
        caseStudyId: z.string().optional().describe('caseStudies: case study id; default all.'),
        tab: z.string().optional().describe('staticFeatures: tab name.'),
        conditions: z.string().optional().describe('products: filter conditions as the JSON string from conditions.'),
        pageNumber: z.number().int().min(1).optional().describe('products: 1-based page.'),
        pageSize: z.number().int().min(1).max(50).optional().describe('products: page size.'),
        topChoice: z.boolean().optional().describe('products: top choices only.'),
        solutionMode: z.string().optional(),
      },
    },
    async (args) => guard(() => categoryInfo(service, args), 'dcsc_category failed'),
  );
}
