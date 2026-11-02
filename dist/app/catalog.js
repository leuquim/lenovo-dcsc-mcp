import { browseCatalog, searchCatalogPage } from '../domain/catalog.js';
import { querySids } from '../domain/configId.js';
import { queryDiscoveryHelper } from '../domain/discoveryHelpers.js';
import { fetchUpstreamFeatureDetails, summarizeFeatureSpec } from '../domain/featureDetails.js';
import { fetchLocales } from '../domain/locale.js';
import { fetchSmartLfoRecommendation, fetchSubTabRecommendations, fetchSummaryRecommendations, } from '../domain/recommendations.js';
import { fetchServicePortalCategories } from '../domain/services-catalog.js';
import { fetchCategoryDetail, fetchConvergedCatalog, fetchConvergedCategoryDetail, fetchLfoCodes, fetchLvrCatalog, fetchSpecialtyCatalog, } from '../domain/specialtyCatalog.js';
import { projectCatalogBrowsePage } from '../model/catalogBrowsePage.js';
import { projectCatalogPage } from '../model/catalogPage.js';
import { projectJsonPage } from '../model/pagedJson.js';
import { PAGE_BYTE_BUDGET } from '../config/constants.js';
import { jsonBytes } from '../util/jsonBytes.js';
import { searchServiceProducts, searchSoftwareForProduct } from '../domain/standalone.js';
import { lookupParts, partSupplyStatus, pricingContext } from './standalone.js';
import { modesContaining } from './launch.js';
const LOCALE_LIST_DEFAULT_LIMIT = 20;
const SID_PAGE_DEFAULT = 10;
const RAW_PAGE_DEFAULT = 20;
const SPECIALTY_ROWS_MAX = 50;
const SERVICE_PORTAL_CHILD_PREVIEW = 12;
export const CATEGORY_KINDS = [
    'detail', 'services', 'caseStudies', 'conditions', 'products', 'topChoiceCountry',
    'productFunctions', 'displayOrders', 'staticFeatures',
];
export async function settingsGet(rt, args) {
    const ctx = rt.newCtx();
    const modes = await rt.solutionModes(ctx);
    let locales;
    if (args.localeQuery !== undefined) {
        const needle = args.localeQuery.toLowerCase();
        const matches = (await fetchLocales(rt.http, ctx)).filter((l) => !l.countryInvalid && (!needle ||
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
    return { locale: rt.locale, withdrawnSince: rt.withdrawnSince ?? null, solutionModes: modes, ...(locales ? { locales } : {}) };
}
const WITHDRAWN_SINCE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
export async function settingsSet(rt, args) {
    if (args.country === undefined && args.language !== undefined)
        throw new Error('language requires country.');
    if (args.withdrawnSince !== undefined && args.withdrawnSince !== '' && !WITHDRAWN_SINCE_FORMAT.test(args.withdrawnSince)) {
        throw new Error('withdrawnSince must be YYYY-MM-DD, or "" for available products only.');
    }
    const locale = args.country === undefined ? undefined : await rt.resolveLocale(rt.newCtx(), args.country, args.language);
    if (locale)
        rt.setLocale(locale);
    if (args.withdrawnSince !== undefined)
        rt.setWithdrawnSince(args.withdrawnSince || undefined);
    return {
        locale: rt.locale,
        withdrawnSince: rt.withdrawnSince ?? null,
        scope: 'process-default',
        persisted: false,
        priceType: 'LIST',
        note: 'Prices are anonymous LIST prices for the configured country/currency, not a quote.',
    };
}
function requireArg(value, name, kind) {
    if (value === undefined || value === '')
        throw new Error(`${name} is required for kind "${kind}".`);
    return value;
}
export async function searchCatalog(rt, args) {
    switch (args.kind) {
        case 'products': return searchProducts(rt, args);
        case 'tree': return browseTree(rt, args);
        case 'parts': return searchParts(rt, args);
        case 'preconfigured': return preconfiguredCodes(rt, args);
        case 'sids': return searchSids(rt, args);
        case 'specialty': return searchSpecialty(rt, args);
        case 'serviceProducts': return searchServices(rt, args);
        case 'software': return searchSoftware(rt, args);
    }
}
async function searchServices(rt, args) {
    const ctx = rt.newCtx();
    const solution = await rt.resolveSolution(ctx, args.solutionMode);
    const products = await searchServiceProducts(rt.http, { ...ctx, solution }, args.query);
    return projectCatalogPage({
        tool: 'dcsc_search', collection: 'products', context: ctx.locale,
        arguments: { kind: 'serviceProducts', query: args.query, solutionMode: solution.solutionMode },
        offset: args.offset ?? 0, limit: args.limit ?? 15, path: args.path,
        expectedCatalogFingerprint: args.expectedCatalogFingerprint,
        items: products.map(({ withdrawn, ...product }) => ({ ...product, ...(withdrawn ? { withdrawn } : {}) })),
        base: { solutionMode: solution.solutionMode, total: products.length, page: { total: products.length } },
    });
}
async function searchSoftware(rt, args) {
    const productCode = requireArg(args.productCode, 'productCode', 'software');
    const mode = args.mode ?? 'CTO';
    const ctx = rt.newCtx();
    const solution = await rt.resolveSolution(ctx, args.solutionMode);
    const features = await searchSoftwareForProduct(rt.http, { ...ctx, solution }, productCode, mode);
    return projectCatalogPage({
        tool: 'dcsc_search', collection: 'software', context: ctx.locale,
        arguments: { kind: 'software', productCode, mode, solutionMode: solution.solutionMode },
        offset: args.offset ?? 0, limit: args.limit ?? 15, path: args.path,
        expectedCatalogFingerprint: args.expectedCatalogFingerprint,
        items: features.map(feature => ({
            code: feature.code, description: feature.description, path: feature.path, unitPrice: feature.unitPrice,
        })),
        base: { productCode, mode, solutionMode: solution.solutionMode,
            ...pricingContext(ctx.locale.country, ctx.locale.currency), total: features.length, page: { total: features.length } },
    });
}
async function searchProducts(rt, args) {
    const query = requireArg(args.query, 'query', 'products');
    const ctx = rt.newCtx();
    const includeWithdrawn = ctx.withdrawnSince !== undefined;
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
        tool: 'dcsc_search', collection: 'products', context: { ...ctx.locale, withdrawnSince: ctx.withdrawnSince },
        arguments: { kind: 'products', query, type: args.type, solutionMode: solution.solutionMode },
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
async function browseTree(rt, args) {
    const ctx = rt.newCtx();
    const includeWithdrawn = ctx.withdrawnSince !== undefined;
    const solution = await rt.resolveSolution(ctx, args.solutionMode);
    const catalog = await rt.catalog(ctx, solution);
    const result = browseCatalog(catalog, args.categoryPath ?? [], {
        offset: 0, limit: Math.max(catalog.entries.length, 1), includeWithdrawn,
    });
    return projectCatalogBrowsePage({
        tool: 'dcsc_search', context: { ...ctx.locale, withdrawnSince: ctx.withdrawnSince }, path: result.path,
        arguments: { kind: 'tree', categoryPath: result.path, solutionMode: solution.solutionMode },
        categories: result.children,
        products: result.products.map((p) => ({ code: p.code, type: p.type, description: p.description })),
        categoryOffset: args.categoryOffset ?? 0, productOffset: args.offset ?? 0, limit: args.limit ?? 25,
        detailPath: args.detailPath,
        expectedCatalogFingerprint: args.expectedCatalogFingerprint,
    });
}
async function searchParts(rt, args) {
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
            scope: 'Website-equivalent lookup: Lenovo returns one array and the website paginates it client-side. ' +
                'Lenovo reports no total or cursor, so upstream exhaustiveness is unknown. If an expected part is missing, ' +
                'retry its exact code or a narrower keyword; use kind "products" for configurable systems.',
        },
    });
    if (!args.includeSupplyStatus)
        return projected;
    const targetCode = items[0]?.code ?? keyword.trim();
    return { ...projected, supplyStatus: await partSupplyStatus(rt, ctx, targetCode, args.supplyStatusType ?? 'Option') };
}
async function preconfiguredCodes(rt, args) {
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
async function searchSids(rt, args) {
    const categoryId = requireArg(args.categoryId, 'categoryId', 'sids');
    const pageSize = args.limit ?? SID_PAGE_DEFAULT;
    const offset = args.offset ?? 0;
    const pageIndex = Math.floor(offset / pageSize) + 1;
    const skip = offset - (pageIndex - 1) * pageSize;
    const result = await querySids(rt.http, {
        categoryId, pageIndex, pageSize, sidNumber: args.query, tceFlag: args.tceFlag,
    }, rt.newCtx());
    const continuation = (returned) => ({ tool: 'dcsc_search', arguments: {
            kind: 'sids', categoryId, query: args.query, tceFlag: args.tceFlag, offset: offset + returned, limit: pageSize
        } });
    const content = fitRows(result.content.slice(skip), (rows) => ({
        categoryId, pageIndex: result.number, totalElements: result.totalElements, returned: rows.length, content: rows,
        ...(offset + rows.length < result.totalElements ? { next: continuation(rows.length) } : {}),
    }));
    return content;
}
/** Keeps the longest prefix of rows whose projection fits one page. */
function fitRows(rows, project) {
    const kept = [...rows];
    while (kept.length > 1 && jsonBytes(project(kept)) > PAGE_BYTE_BUDGET)
        kept.pop();
    if (jsonBytes(project(kept)) > PAGE_BYTE_BUDGET)
        throw new Error('A single result row exceeds the response budget.');
    return project(kept);
}
/** Returns a raw upstream value whole when it fits one page, otherwise pages it by path, offset and limit. */
function boundedRaw(tool, args, value, paging) {
    if (paging.path === undefined && jsonBytes(value) <= PAGE_BYTE_BUDGET)
        return value;
    return projectJsonPage(value, { tool, arguments: args, path: paging.path ?? [], offset: paging.offset ?? 0, limit: paging.limit ?? RAW_PAGE_DEFAULT });
}
async function searchSpecialty(rt, args) {
    const catalogKind = args.catalog ?? 'lvr';
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 15;
    const ctx = rt.newCtx();
    const solution = await rt.resolveSolution(ctx, args.solutionMode);
    const resolvedCtx = { ...ctx, solution };
    const { path: _path, offset: _offset, limit: _limit, ...query } = args;
    const rawArguments = { ...query, solutionMode: solution.solutionMode };
    if (catalogKind === 'promotion') {
        const promo = await fetchSpecialtyCatalog(rt.http, resolvedCtx, {
            type: 'promotion', subType: args.subType, categoryId: args.categoryId,
        });
        return boundedRaw('dcsc_search', rawArguments, {
            catalog: 'promotion',
            subType: promo.type === 'promotion' ? promo.subType : 'hierarchies',
            data: promo.data,
        }, args);
    }
    if (catalogKind === 'converged' && args.categoryId) {
        return boundedRaw('dcsc_search', rawArguments, {
            catalog: 'converged',
            categoryId: args.categoryId,
            detail: await fetchConvergedCategoryDetail(rt.http, resolvedCtx, args.categoryId),
        }, args);
    }
    const catalog = catalogKind === 'lvr'
        ? await fetchLvrCatalog(rt.http, resolvedCtx)
        : await fetchConvergedCatalog(rt.http, resolvedCtx);
    const matches = args.query ? searchCatalogPage(catalog, { query: args.query, offset: 0, limit: Math.max(catalog.entries.length, 1) }).items
        : catalog.entries;
    const window = matches.slice(offset, offset + Math.min(limit, SPECIALTY_ROWS_MAX));
    return fitRows(window, (entries) => ({
        catalog: catalogKind, total: matches.length, offset, limit, entries,
        ...(offset + entries.length < matches.length ? { next: { tool: 'dcsc_search', arguments: {
                    ...rawArguments, offset: offset + entries.length, limit
                } } } : {}),
    }));
}
const DISCOVERY_ACTIONS = {
    caseStudies: 'caseStudies',
    conditions: 'subCategoryConditions',
    products: 'productListBySubCategory',
    topChoiceCountry: 'topChoiceCountry',
    productFunctions: 'productFunctions',
    displayOrders: 'displayOrders',
    staticFeatures: 'staticFeatures',
};
export async function categoryInfo(rt, args) {
    const { path, offset, limit, ...query } = args;
    const paging = { path, offset, limit };
    if (args.kind === 'services')
        return boundedRaw('dcsc_category', query, await servicePortalCategories(rt, args.solutionMode), paging);
    if (args.kind === 'detail') {
        const categoryId = requireArg(args.categoryId, 'categoryId', 'detail');
        const result = await fetchCategoryDetail(rt.http, await rt.ctxWithSolution(), { categoryId, isTruScale: args.isTruScale });
        const trimmed = limit === undefined ? result : {
            ...result,
            ...(Array.isArray(result.children) ? { children: result.children.slice(0, limit), totalChildren: result.children.length } : {}),
            ...(Array.isArray(result.products) ? { products: result.products.slice(0, limit), totalProducts: result.products.length } : {}),
            ...(Array.isArray(result.categories) ? { categories: result.categories.slice(0, limit), totalCategories: result.categories.length } : {}),
        };
        return boundedRaw('dcsc_category', { ...query, ...(limit !== undefined ? { limit } : {}) }, trimmed, paging);
    }
    const params = {
        ...('categoryId' in args ? { categoryId: args.categoryId } : {}),
        ...('ctoCode' in args ? { ctoCode: args.ctoCode } : {}),
        ...('caseStudyId' in args && args.caseStudyId !== undefined ? { id: args.caseStudyId } : {}),
        ...('tab' in args && args.tab !== undefined ? { tab: args.tab } : {}),
        ...('conditions' in args && args.conditions !== undefined ? { conditions: args.conditions } : {}),
        ...('pageNumber' in args && args.pageNumber !== undefined ? { pageNumber: args.pageNumber } : {}),
        ...('pageSize' in args && args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
        ...('topChoice' in args && args.topChoice !== undefined ? { topChoice: args.topChoice } : {}),
    };
    const raw = await queryDiscoveryHelper(rt.http, await rt.ctxEnsuringSolution(), { action: DISCOVERY_ACTIONS[args.kind], params });
    return boundedRaw('dcsc_category', query, raw, paging);
}
async function servicePortalCategories(rt, solutionMode) {
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
function productCodeOf(rt, handle) {
    const session = handle ? rt.sessions.get(handle) : undefined;
    const raw = session?.raw.code;
    if (typeof raw === 'string' && raw)
        return raw;
    return session?.product.code || undefined;
}
/** A configuration's own locale and solution when a session is given, else the process defaults. */
async function recommendationCtx(rt, handle, solutionMode) {
    const session = handle ? rt.sessions.get(handle) : undefined;
    if (session)
        return rt.newCtx({ locale: session.locale, solution: session.solution });
    const ctx = rt.newCtx();
    return { ...ctx, solution: await rt.resolveSolution(ctx, solutionMode) };
}
export async function subTabRecommendations(rt, args) {
    const code = args.productCode?.trim() || productCodeOf(rt, args.session);
    if (!code)
        throw new Error('Provide either a valid productCode or an active session.');
    const recommendations = await fetchSubTabRecommendations(rt.http, await recommendationCtx(rt, args.session, args.solutionMode), args.mode ?? 'CTO', code);
    return { productCode: code, count: recommendations.length, recommendations };
}
export async function featureSpecs(rt, args) {
    const session = args.session ? rt.sessions.get(args.session) : undefined;
    const cto = args.ctoCode?.trim() || productCodeOf(rt, args.session);
    if (!cto)
        throw new Error('Provide either ctoCode or an active session.');
    const raw = await fetchUpstreamFeatureDetails(rt.http, await recommendationCtx(rt, args.session, args.solutionMode), cto, session?.id ?? args.session ?? 'anon', args.codes);
    const specs = raw.map(summarizeFeatureSpec);
    return { ctoCode: cto, count: specs.length, features: specs };
}
export async function smartRecommendations(rt, args) {
    const resolvedCtx = await recommendationCtx(rt, args.session, args.solutionMode);
    if (args.type === 'smart-lfo') {
        const country = (args.country ?? resolvedCtx.locale.country ?? 'US').toUpperCase();
        const cto = args.ctoCode?.trim() || productCodeOf(rt, args.session);
        if (!cto)
            throw new Error('Provide either ctoCode or an active session for smart LFO recommendations.');
        return { type: 'smart-lfo', country, ctoCode: cto, result: await fetchSmartLfoRecommendation(rt.http, resolvedCtx, country, cto) };
    }
    let cto = args.ctoCode?.trim();
    let payload = { selectedProductDataLists: [] };
    const session = args.session ? rt.sessions.get(args.session) : undefined;
    if (session) {
        cto ||= productCodeOf(rt, args.session);
        const features = [];
        for (const tab of session.raw.tabs ?? []) {
            for (const subTab of tab.subTabs ?? []) {
                for (const sec of subTab.sections ?? []) {
                    for (const res of sec.results ?? []) {
                        if (res.code)
                            features.push({ code: res.code, quantity: res.quantity ?? 1 });
                    }
                }
            }
        }
        payload = { selectedProductDataLists: [[{
                        code: cto ?? 'CTO', id: session.id, quantity: session.raw.quantity ?? 1, features,
                    }]] };
    }
    else if (!args.session && cto) {
        payload = { selectedProductDataLists: [[{ code: cto, quantity: 1 }]] };
    }
    return { type: 'summary', ctoCode: cto, result: await fetchSummaryRecommendations(rt.http, resolvedCtx, payload) };
}
//# sourceMappingURL=catalog.js.map