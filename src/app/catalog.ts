import { browseCatalog, searchCatalogPage } from '../domain/catalog.js';
import { querySids } from '../domain/configId.js';
import { queryDiscoveryHelper, type DiscoveryAction } from '../domain/discoveryHelpers.js';
import { fetchUpstreamFeatureDetails, summarizeFeatureSpec } from '../domain/featureDetails.js';
import { fetchLocales } from '../domain/locale.js';
import {
  fetchSmartLfoRecommendation,
  fetchSubTabRecommendations,
  fetchSummaryRecommendations,
  type SummaryRecommendationPayload,
} from '../domain/recommendations.js';
import { fetchServicePortalCategories } from '../domain/services-catalog.js';
import {
  fetchCategoryDetail,
  fetchConvergedCatalog,
  fetchConvergedCategoryDetail,
  fetchLfoCodes,
  fetchLvrCatalog,
  fetchSpecialtyCatalog,
} from '../domain/specialtyCatalog.js';
import { projectCatalogBrowsePage } from '../model/catalogBrowsePage.js';
import { projectCatalogPage } from '../model/catalogPage.js';
import { lookupParts, partSupplyStatus, pricingContext } from './standalone.js';
import { modesContaining } from './launch.js';
import type { Runtime } from './runtime.js';

const LOCALE_LIST_DEFAULT_LIMIT = 20;
const SERVICE_PORTAL_CHILD_PREVIEW = 12;

export const SEARCH_KINDS = ['products', 'tree', 'parts', 'preconfigured', 'sids', 'specialty'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const CATEGORY_KINDS = [
  'detail', 'services', 'caseStudies', 'conditions', 'products', 'topChoiceCountry',
  'productFunctions', 'displayOrders', 'staticFeatures',
] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export async function settingsGet(rt: Runtime, args: { localeQuery?: string | undefined; limit?: number | undefined }) {
  const ctx = rt.newCtx();
  const modes = await rt.solutionModes(ctx);
  let locales: Record<string, unknown> | undefined;
  if (args.localeQuery !== undefined) {
    const needle = args.localeQuery.toLowerCase();
    const matches = (await fetchLocales(rt.http, ctx)).filter((l) => !l.countryInvalid && (
      !needle ||
      l.countryCode.toLowerCase().includes(needle) ||
      l.countryName.toLowerCase().includes(needle) ||
      l.currency.toLowerCase().includes(needle)));
    locales = {
      count: matches.length,
      items: matches.slice(0, args.limit ?? LOCALE_LIST_DEFAULT_LIMIT).map((l) => ({
        country: l.countryCode,
        name: l.countryName,
        currency: l.currency,
        geo: l.region,
        languages: l.languages.map((x) => x.languageCode),
        defaultLanguage: l.languages.find((x) => x.defaulted)?.languageCode ?? l.languages[0]?.languageCode,
      })),
    };
  }
  return { locale: rt.locale, solutionModes: modes, ...(locales ? { locales } : {}) };
}

export async function settingsSet(rt: Runtime, args: { country: string; language?: string | undefined }) {
  const locale = await rt.resolveLocale(rt.newCtx(), args.country, args.language);
  rt.setLocale(locale);
  return {
    locale,
    scope: 'process-default',
    persisted: false,
    priceType: 'LIST',
    note: 'Prices are anonymous LIST prices for the configured country/currency, not a quote.',
  };
}

export interface SearchArgs {
  kind: SearchKind;
  query?: string | undefined;
  type?: 'CTO' | 'LFO' | undefined;
  includeWithdrawn?: boolean | undefined;
  categoryPath?: string[] | undefined;
  categoryOffset?: number | undefined;
  detailPath?: string[] | undefined;
  types?: Array<'SOFTWARE' | 'SERVICE' | 'HARDWARE'> | undefined;
  mode?: 'CTO' | 'LFO' | undefined;
  includeSupplyStatus?: boolean | undefined;
  supplyStatusType?: string | undefined;
  categoryId?: string | undefined;
  tceFlag?: boolean | undefined;
  catalog?: 'lvr' | 'converged' | 'promotion' | undefined;
  subType?: 'hierarchies' | 'sid' | 'lfo' | 'option' | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
  path?: string[] | undefined;
  expectedCatalogFingerprint?: string | undefined;
  solutionMode?: string | undefined;
}

function requireArg<T>(value: T | undefined, name: string, kind: string): T {
  if (value === undefined || value === '') throw new Error(`${name} is required for kind "${kind}".`);
  return value;
}

export async function searchCatalog(rt: Runtime, args: SearchArgs): Promise<unknown> {
  switch (args.kind) {
    case 'products': return searchProducts(rt, args);
    case 'tree': return browseTree(rt, args);
    case 'parts': return searchParts(rt, args);
    case 'preconfigured': return preconfiguredCodes(rt, args);
    case 'sids': return searchSids(rt, args);
    case 'specialty': return searchSpecialty(rt, args);
  }
}

async function searchProducts(rt: Runtime, args: SearchArgs) {
  const query = requireArg(args.query, 'query', 'products');
  const includeWithdrawn = args.includeWithdrawn ?? false;
  const ctx = rt.newCtx();
  const solution = await rt.resolveSolution(ctx, args.solutionMode);
  const catalog = await rt.catalog(ctx, solution);
  const page = searchCatalogPage(catalog, {
    query,
    ...(args.type !== undefined ? { type: args.type } : {}),
    includeWithdrawn,
    limit: Math.max(catalog.entries.length, 1),
    offset: 0,
  });
  const availability = await modesContaining(rt, ctx, page.items.map((h) => h.code));
  return projectCatalogPage({
    tool: 'dcsc_search', collection: 'products', context: ctx.locale,
    arguments: { kind: 'products', query, type: args.type, includeWithdrawn, solutionMode: solution.solutionMode },
    offset: args.offset ?? 0, limit: args.limit ?? 15, path: args.path,
    expectedCatalogFingerprint: args.expectedCatalogFingerprint,
    items: page.items.map((h) => ({
      code: h.code,
      type: h.type,
      description: h.description,
      path: h.path.join(' > '),
      ...(h.price !== undefined ? { listPrice: h.price } : {}),
      ...(h.withdrawn ? { withdrawn: true } : {}),
      availableIn: availability.get(h.code.toUpperCase()) ?? [],
    })),
    base: { solutionMode: solution.solutionMode, currency: ctx.locale.currency, country: ctx.locale.country,
      total: page.total, page: { total: page.total } },
  });
}

async function browseTree(rt: Runtime, args: SearchArgs) {
  const includeWithdrawn = args.includeWithdrawn ?? false;
  const ctx = rt.newCtx();
  const solution = await rt.resolveSolution(ctx, args.solutionMode);
  const catalog = await rt.catalog(ctx, solution);
  const result = browseCatalog(catalog, args.categoryPath ?? [], {
    offset: 0, limit: Math.max(catalog.entries.length, 1), includeWithdrawn,
  });
  return projectCatalogBrowsePage({
    tool: 'dcsc_search', context: ctx.locale, path: result.path,
    arguments: { kind: 'tree', categoryPath: result.path, solutionMode: solution.solutionMode, includeWithdrawn },
    categories: result.children,
    products: result.products.map((p) => ({ code: p.code, type: p.type, description: p.description })),
    categoryOffset: args.categoryOffset ?? 0, productOffset: args.offset ?? 0, limit: args.limit ?? 25,
    detailPath: args.detailPath,
    expectedCatalogFingerprint: args.expectedCatalogFingerprint,
  });
}

async function searchParts(rt: Runtime, args: SearchArgs) {
  const keyword = requireArg(args.query, 'query', 'parts');
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 20;
  const mode = args.mode ?? 'CTO';
  const { ctx, solution, items } = await lookupParts(rt, {
    keyword, mode,
    ...(args.types !== undefined ? { types: args.types } : {}),
    ...(args.expectedCatalogFingerprint !== undefined ? { expectedCatalogFingerprint: args.expectedCatalogFingerprint } : {}),
    ...(args.solutionMode !== undefined ? { solutionMode: args.solutionMode } : {}),
  });
  const projected = projectCatalogPage({
    tool: 'dcsc_search', collection: 'parts', context: ctx.locale,
    arguments: { kind: 'parts', query: keyword, types: args.types, mode, solutionMode: solution.solutionMode },
    offset, limit, path: args.path,
    expectedCatalogFingerprint: args.expectedCatalogFingerprint,
    items,
    base: {
      query: keyword,
      mode,
      solutionMode: solution.solutionMode,
      ...pricingContext(rt.locale.country, rt.locale.currency),
      page: {
        offset,
        limit,
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
        'retry its exact code or a narrower keyword; use kind "products" for configurable systems.',
    },
  });
  if (!args.includeSupplyStatus) return projected;
  const targetCode = items[0]?.code ?? keyword.trim();
  return { ...projected, supplyStatus: await partSupplyStatus(rt, ctx, targetCode, args.supplyStatusType ?? 'Option') };
}

async function preconfiguredCodes(rt: Runtime, args: SearchArgs) {
  const result = await fetchLfoCodes(rt.http, await rt.ctxWithSolution());
  return projectCatalogPage({
    tool: 'dcsc_search', collection: 'codes', context: rt.locale,
    arguments: { kind: 'preconfigured' },
    offset: args.offset ?? 0, limit: args.limit ?? 50, path: args.path,
    expectedCatalogFingerprint: args.expectedCatalogFingerprint,
    items: result.lfoCodes.map((code) => ({ code })),
    base: { total: result.lfoCodes.length, page: { total: result.lfoCodes.length } },
  });
}

async function searchSids(rt: Runtime, args: SearchArgs) {
  const categoryId = requireArg(args.categoryId, 'categoryId', 'sids');
  const pageSize = args.limit ?? 10;
  const result = await querySids(rt.http, {
    categoryId,
    pageIndex: Math.floor((args.offset ?? 0) / pageSize) + 1,
    pageSize,
    sidNumber: args.query,
    tceFlag: args.tceFlag,
  }, rt.newCtx());
  return {
    categoryId,
    pageIndex: result.number,
    totalElements: result.totalElements,
    returned: result.content.length,
    content: result.content,
  };
}

async function searchSpecialty(rt: Runtime, args: SearchArgs) {
  const catalogKind = args.catalog ?? 'lvr';
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 15;
  const ctx = rt.newCtx();
  const solution = await rt.resolveSolution(ctx, args.solutionMode);
  const resolvedCtx = { ...ctx, solution };

  if (catalogKind === 'promotion') {
    const promo = await fetchSpecialtyCatalog(rt.http, resolvedCtx, {
      type: 'promotion', subType: args.subType, categoryId: args.categoryId,
    });
    return {
      catalog: 'promotion',
      subType: promo.type === 'promotion' ? promo.subType : 'hierarchies',
      data: (promo as { data: unknown }).data,
    };
  }
  if (catalogKind === 'converged' && args.categoryId) {
    return {
      catalog: 'converged',
      categoryId: args.categoryId,
      detail: await fetchConvergedCategoryDetail(rt.http, resolvedCtx, args.categoryId),
    };
  }
  const catalog = catalogKind === 'lvr'
    ? await fetchLvrCatalog(rt.http, resolvedCtx)
    : await fetchConvergedCatalog(rt.http, resolvedCtx);
  if (args.query) {
    const page = searchCatalogPage(catalog, { query: args.query, offset, limit });
    return { catalog: catalogKind, total: page.total, offset: page.offset, limit: page.limit, entries: page.items };
  }
  return {
    catalog: catalogKind,
    total: catalog.entries.length,
    offset,
    limit,
    entries: catalog.entries.slice(offset, offset + limit),
  };
}

export interface CategoryArgs {
  kind: CategoryKind;
  categoryId?: string | undefined;
  isTruScale?: boolean | undefined;
  limit?: number | undefined;
  ctoCode?: string | undefined;
  caseStudyId?: string | undefined;
  tab?: string | undefined;
  conditions?: string | undefined;
  pageNumber?: number | undefined;
  pageSize?: number | undefined;
  topChoice?: boolean | undefined;
  solutionMode?: string | undefined;
}

const DISCOVERY_ACTIONS: Partial<Record<CategoryKind, DiscoveryAction>> = {
  caseStudies: 'caseStudies',
  conditions: 'subCategoryConditions',
  products: 'productListBySubCategory',
  topChoiceCountry: 'topChoiceCountry',
  productFunctions: 'productFunctions',
  displayOrders: 'displayOrders',
  staticFeatures: 'staticFeatures',
};

export async function categoryInfo(rt: Runtime, args: CategoryArgs): Promise<unknown> {
  if (args.kind === 'services') return servicePortalCategories(rt, args.solutionMode);
  if (args.kind === 'detail') {
    const categoryId = requireArg(args.categoryId, 'categoryId', 'detail');
    const result = await fetchCategoryDetail(rt.http, await rt.ctxWithSolution(), { categoryId, isTruScale: args.isTruScale });
    if (args.limit === undefined) return result;
    return {
      ...result,
      ...(Array.isArray(result.children) ? { children: result.children.slice(0, args.limit), totalChildren: result.children.length } : {}),
      ...(Array.isArray(result.products) ? { products: result.products.slice(0, args.limit), totalProducts: result.products.length } : {}),
      ...(Array.isArray(result.categories) ? { categories: result.categories.slice(0, args.limit), totalCategories: result.categories.length } : {}),
    };
  }
  const params: Record<string, unknown> = {
    ...(args.categoryId !== undefined ? { categoryId: args.categoryId } : {}),
    ...(args.ctoCode !== undefined ? { ctoCode: args.ctoCode } : {}),
    ...(args.caseStudyId !== undefined ? { id: args.caseStudyId } : {}),
    ...(args.tab !== undefined ? { tab: args.tab } : {}),
    ...(args.conditions !== undefined ? { conditions: args.conditions } : {}),
    ...(args.pageNumber !== undefined ? { pageNumber: args.pageNumber } : {}),
    ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
    ...(args.topChoice !== undefined ? { topChoice: args.topChoice } : {}),
  };
  return queryDiscoveryHelper(rt.http, await rt.ctxEnsuringSolution(), { action: DISCOVERY_ACTIONS[args.kind]!, params });
}

async function servicePortalCategories(rt: Runtime, solutionMode: string | undefined) {
  const ctx = rt.newCtx();
  const solution = await rt.resolveSolution(ctx, solutionMode);
  const root = await fetchServicePortalCategories(rt.http, { ...ctx, solution });
  if (!root) {
    return { categories: [], warning: 'DCSC returned no services portal categories for this locale/mode.' };
  }
  return {
    root: { id: root.id, title: root.title },
    categories: root.children.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      childCount: c.children.length,
      children: c.children.slice(0, SERVICE_PORTAL_CHILD_PREVIEW).map((ch) => ({
        id: ch.id, title: ch.title, childCount: ch.children.length,
      })),
    })),
  };
}

function productCodeOf(rt: Runtime, handle: string | undefined): string | undefined {
  const raw = handle ? rt.sessions.get(handle)?.raw.code : undefined;
  return typeof raw === 'string' ? raw : undefined;
}

export async function subTabRecommendations(rt: Runtime, args: {
  session?: string | undefined; productCode?: string | undefined; mode?: string | undefined; solutionMode?: string | undefined;
}) {
  const code = args.productCode?.trim() || productCodeOf(rt, args.session);
  if (!code) throw new Error('Provide either a valid productCode or an active session.');
  const ctx = rt.newCtx();
  const solution = await rt.resolveSolution(ctx, args.solutionMode);
  const recommendations = await fetchSubTabRecommendations(rt.http, { ...ctx, solution }, args.mode ?? 'CTO', code);
  return { productCode: code, count: recommendations.length, recommendations };
}

export async function featureSpecs(rt: Runtime, args: {
  session?: string | undefined; ctoCode?: string | undefined; codes: string[]; solutionMode?: string | undefined;
}) {
  const session = args.session ? rt.sessions.get(args.session) : undefined;
  const cto = args.ctoCode?.trim() || productCodeOf(rt, args.session);
  if (!cto) throw new Error('Provide either ctoCode or an active session.');
  const ctx = rt.newCtx();
  const solution = await rt.resolveSolution(ctx, args.solutionMode);
  const raw = await fetchUpstreamFeatureDetails(rt.http, { ...ctx, solution }, cto, session?.id ?? args.session ?? 'anon', args.codes);
  const specs = raw.map(summarizeFeatureSpec);
  return { ctoCode: cto, count: specs.length, features: specs };
}

export async function smartRecommendations(rt: Runtime, args: {
  type?: 'summary' | 'smart-lfo' | undefined; session?: string | undefined; ctoCode?: string | undefined;
  country?: string | undefined; solutionMode?: string | undefined;
}) {
  const ctx = rt.newCtx();
  const solution = await rt.resolveSolution(ctx, args.solutionMode);
  const resolvedCtx = { ...ctx, solution };

  if (args.type === 'smart-lfo') {
    const country = (args.country ?? ctx.locale.country ?? 'US').toUpperCase();
    const cto = args.ctoCode?.trim() || productCodeOf(rt, args.session);
    if (!cto) throw new Error('Provide either ctoCode or an active session for smart LFO recommendations.');
    return { type: 'smart-lfo', country, ctoCode: cto, result: await fetchSmartLfoRecommendation(rt.http, resolvedCtx, country, cto) };
  }

  let cto = args.ctoCode?.trim();
  let payload: SummaryRecommendationPayload = { selectedProductDataLists: [] };
  const session = args.session ? rt.sessions.get(args.session) : undefined;
  if (session) {
    if (!cto && typeof session.raw.code === 'string') cto = session.raw.code;
    const features: Array<{ code: string; quantity?: number }> = [];
    for (const tab of session.raw.tabs ?? []) {
      for (const subTab of tab.subTabs ?? []) {
        for (const sec of subTab.sections ?? []) {
          for (const res of sec.results ?? []) {
            if (res.code) features.push({ code: res.code, quantity: res.quantity ?? 1 });
          }
        }
      }
    }
    payload = { selectedProductDataLists: [[{
      code: cto ?? 'CTO', id: session.id, quantity: session.raw.quantity ?? 1, features,
    }]] };
  } else if (!args.session && cto) {
    payload = { selectedProductDataLists: [[{ code: cto, quantity: 1 }]] };
  }
  return { type: 'summary', ctoCode: cto, result: await fetchSummaryRecommendations(rt.http, resolvedCtx, payload) };
}
