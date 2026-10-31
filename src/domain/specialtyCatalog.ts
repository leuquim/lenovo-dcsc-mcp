import { z } from 'zod';
import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import { CategoryHierarchySchema } from '../schemas/catalog.js';
import { parseResponse } from '../schemas/parse.js';
import { flatten, type Catalog, type CatalogEntry } from './catalog.js';

export type SpecialtyCatalogKind = 'lvr' | 'converged' | 'promotion';

export interface ConvergedCategoryDetail {
  categoryId: string;
  overview?: string | undefined;
  marketInfo?: string | undefined;
  language?: string | undefined;
  description?: string | undefined;
  image?: string | undefined;
  imageFront?: string | undefined;
  imageRear?: string | undefined;
  datasheet?: string | undefined;
  productGuide?: string | undefined;
  productVideo?: string | undefined;
  threeDimension?: string | undefined;
  learnMore?: string | undefined;
  title?: string | undefined;
  sequence?: number | undefined;
  shipStatus?: number | undefined;
  vcPage?: boolean | undefined;
  children?: unknown[] | undefined;
  products?: unknown[] | undefined;
  categories?: unknown[] | undefined;
  lvrInventories?: unknown[] | undefined;
  [key: string]: unknown;
}

export interface PromotionHierarchy {
  id: string | null;
  title: string | null;
  categoryId: string | null;
  category: string | null;
  description: string | null;
  image: string | null;
  children: unknown[];
  promotionLfos?: { id: string | null; children: unknown[] } | undefined;
  promotionOptions?: { id: string | null; children: unknown[] } | undefined;
  promotionSIDs?: { id: string | null; children: unknown[] } | undefined;
  parentId?: string | null | undefined;
  chiocePromotion?: string | undefined;
  [key: string]: unknown;
}

export interface SpecialtyCatalogOptions {
  type: SpecialtyCatalogKind;
  subType?: 'hierarchies' | 'sid' | 'lfo' | 'option' | undefined;
  categoryId?: string | undefined;
}

export type SpecialtyCatalogResult =
  | { type: 'lvr'; catalog: Catalog; entries: CatalogEntry[] }
  | { type: 'converged'; catalog: Catalog; entries: CatalogEntry[]; detail?: ConvergedCategoryDetail | undefined }
  | { type: 'promotion'; subType: string; data: unknown };

/**
 * Fetches Lenovo Value Recovery (LVR) / Certified Refurbished catalog tree.
 * Endpoint: GET /lvr/category_hierarchies
 */
export async function fetchLvrCatalog(
  http: DcscHttpClient,
  ctx: RequestCtx,
): Promise<Catalog> {
  const res = await http.send({
    endpoint: 'lvr_category_hierarchies',
    method: 'GET',
    path: '/lvr/category_hierarchies',
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });

  const tree = parseResponse(CategoryHierarchySchema, res.raw, {
    endpoint: 'lvr_category_hierarchies',
    corrId: ctx.corrId,
    requestId: res.requestId,
  });

  return { tree, entries: flatten(tree), fetchedAt: Date.now() };
}

/**
 * Fetches Converged / MultiProd (ThinkAgile FX / HX) catalog tree.
 * Endpoint: GET /multiprod_category_hierarchies
 */
export async function fetchConvergedCatalog(
  http: DcscHttpClient,
  ctx: RequestCtx,
): Promise<Catalog> {
  const res = await http.send({
    endpoint: 'multiprod_category_hierarchies',
    method: 'GET',
    path: '/multiprod_category_hierarchies',
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });

  const tree = parseResponse(CategoryHierarchySchema, res.raw, {
    endpoint: 'multiprod_category_hierarchies',
    corrId: ctx.corrId,
    requestId: res.requestId,
  });

  return { tree, entries: flatten(tree), fetchedAt: Date.now() };
}

/**
 * Fetches rich category detail for a converged system category.
 * Endpoint: GET /multiprod_category_detail/{id}
 */
export async function fetchConvergedCategoryDetail(
  http: DcscHttpClient,
  ctx: RequestCtx,
  categoryId: string,
): Promise<ConvergedCategoryDetail> {
  if (!categoryId || typeof categoryId !== 'string' || categoryId.trim().length === 0) {
    throw new Error('A non-empty categoryId is required for converged category detail.');
  }

  const res = await http.send({
    endpoint: 'multiprod_category_detail',
    method: 'GET',
    path: `/multiprod_category_detail/${encodeURIComponent(categoryId)}`,
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });

  if (!res.raw || typeof res.raw !== 'object' || Array.isArray(res.raw)) {
    throw new Error('DCSC returned invalid converged category detail.');
  }

  return res.raw as ConvergedCategoryDetail;
}

/**
 * Fetches promotional hierarchy categories.
 * Endpoint: GET /promotion/hierarchies
 */
export async function fetchPromotionHierarchies(
  http: DcscHttpClient,
  ctx: RequestCtx,
): Promise<PromotionHierarchy> {
  const res = await http.send({
    endpoint: 'promotion_hierarchies',
    method: 'GET',
    path: '/promotion/hierarchies',
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });

  return (res.raw ?? {}) as PromotionHierarchy;
}

/**
 * Fetches promotional SID configurations.
 * Endpoint: GET /promotion/sid
 */
export async function fetchPromotionSids(
  http: DcscHttpClient,
  ctx: RequestCtx,
): Promise<unknown> {
  const res = await http.send({
    endpoint: 'promotion_sid',
    method: 'GET',
    path: '/promotion/sid',
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });

  return res.raw;
}

/**
 * Fetches promotional preconfigured LFO models.
 * Endpoint: GET /promotion/lfo
 */
export async function fetchPromotionLfos(
  http: DcscHttpClient,
  ctx: RequestCtx,
): Promise<unknown> {
  const res = await http.send({
    endpoint: 'promotion_lfo',
    method: 'GET',
    path: '/promotion/lfo',
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });

  return res.raw;
}

/**
 * Fetches promotional standalone options.
 * Endpoint: GET /promotion/option
 */
export async function fetchPromotionOptions(
  http: DcscHttpClient,
  ctx: RequestCtx,
  categoryId?: string,
): Promise<unknown> {
  const res = await http.send({
    endpoint: 'promotion_option',
    method: 'GET',
    path: '/promotion/option',
    ...(categoryId ? { query: { categoryId } } : {}),
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });

  return res.raw;
}

/**
 * Unified dispatch for specialty catalogs (LVR, Converged, Promotions).
 */
export async function fetchSpecialtyCatalog(
  http: DcscHttpClient,
  ctx: RequestCtx,
  options: SpecialtyCatalogOptions,
): Promise<SpecialtyCatalogResult> {
  switch (options.type) {
    case 'lvr': {
      const catalog = await fetchLvrCatalog(http, ctx);
      return { type: 'lvr', catalog, entries: catalog.entries };
    }
    case 'converged': {
      const catalog = await fetchConvergedCatalog(http, ctx);
      let detail: ConvergedCategoryDetail | undefined;
      if (options.categoryId) {
        detail = await fetchConvergedCategoryDetail(http, ctx, options.categoryId);
      }
      return { type: 'converged', catalog, entries: catalog.entries, detail };
    }
    case 'promotion': {
      const subType = options.subType ?? 'hierarchies';
      let data: unknown;
      if (subType === 'sid') {
        data = await fetchPromotionSids(http, ctx);
      } else if (subType === 'lfo') {
        data = await fetchPromotionLfos(http, ctx);
      } else if (subType === 'option') {
        data = await fetchPromotionOptions(http, ctx, options.categoryId);
      } else {
        data = await fetchPromotionHierarchies(http, ctx);
      }
      return { type: 'promotion', subType, data };
    }
  }
}

export interface CategoryDetailOptions {
  categoryId: string;
  isTruScale?: boolean | undefined;
}

export interface CategoryDetailResult {
  children?: unknown[] | undefined;
  paths?: unknown[] | undefined;
  totalCount?: number | undefined;
  [key: string]: unknown;
}

export const CategoryDetailSchema = z
  .object({
    children: z.array(z.unknown()).optional(),
    paths: z.array(z.unknown()).optional(),
    totalCount: z.number().optional(),
  })
  .passthrough();

export interface LfoCodesResult {
  lfoCodes: string[];
}

const LfoCodesArraySchema = z.array(z.union([z.string(), z.object({ code: z.string() })]));
const LfoCodesObjectSchema = z
  .object({
    lfoCodes: z.array(z.union([z.string(), z.object({ code: z.string() })])).optional(),
    data: z.array(z.union([z.string(), z.object({ code: z.string() })])).optional(),
  })
  .passthrough();

export const LfoCodesWireSchema = z.union([LfoCodesArraySchema, LfoCodesObjectSchema]);

/**
 * Resolves the appropriate category detail endpoint and path based on categoryId and TruScale flag.
 * - TruScale: /reference_solution/categories/truscale/{id}
 * - Converged/SDI (ThinkAgile HX/FX): /multiprod_category_detail/{normalized_prefix}
 * - Standard catalog: /category_detail/{id}
 */
export function resolveCategoryDetailRoute(
  categoryId: string,
  isTruScale?: boolean,
): { endpoint: string; path: string } {
  if (isTruScale || categoryId.toLowerCase().includes('truscale')) {
    return {
      endpoint: 'truscale_category_detail',
      path: `/reference_solution/categories/truscale/${encodeURIComponent(categoryId)}`,
    };
  }

  const match = new RegExp(
    '(STG)(@.+)?((@Software Defined Infrastructure|@Converged Systems)(.+)?)',
  ).exec(categoryId);
  if (match) {
    let u = (match[1] ?? '') + (match[3] ?? '');
    const parts = u.split('@');
    if (parts.length === 3) {
      u = parts.slice(0, 2).join('@');
    }
    return {
      endpoint: 'multiprod_category_detail',
      path: `/multiprod_category_detail/${encodeURIComponent(u)}`,
    };
  }

  return {
    endpoint: 'category_detail',
    path: `/category_detail/${encodeURIComponent(categoryId)}`,
  };
}

/**
 * Fetches sub-category detail with automatic routing between standard, converged (SDI),
 * and TruScale categories, appending signCustomize=true query parameter.
 * Endpoints:
 * - GET /category_detail/{id}
 * - GET /multiprod_category_detail/{id}
 * - GET /reference_solution/categories/truscale/{id}
 */
export async function fetchCategoryDetail(
  http: DcscHttpClient,
  ctx: RequestCtx,
  categoryIdOrOptions: string | CategoryDetailOptions,
): Promise<CategoryDetailResult> {
  const categoryId =
    typeof categoryIdOrOptions === 'string'
      ? categoryIdOrOptions
      : categoryIdOrOptions?.categoryId;
  const isTruScale =
    typeof categoryIdOrOptions === 'object' && Boolean(categoryIdOrOptions?.isTruScale);

  if (!categoryId || typeof categoryId !== 'string' || categoryId.trim().length === 0) {
    throw new Error('A non-empty categoryId is required for category detail.');
  }

  const { endpoint, path } = resolveCategoryDetailRoute(categoryId, isTruScale);

  const res = await http.send({
    endpoint,
    method: 'GET',
    path,
    query: { signCustomize: 'true' },
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });

  const parsed = parseResponse(CategoryDetailSchema, res.raw, {
    endpoint,
    corrId: ctx.corrId,
    requestId: res.requestId,
  });

  return parsed as CategoryDetailResult;
}

/**
 * Fetches filtered LFO/CTO codes from upstream catalog filter.
 * Endpoint: GET /lfos/cto_filter_lfo
 */
export async function fetchLfoCodes(
  http: DcscHttpClient,
  ctx: RequestCtx,
): Promise<LfoCodesResult> {
  const res = await http.send({
    endpoint: 'lfos_cto_filter_lfo',
    method: 'GET',
    path: '/lfos/cto_filter_lfo',
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });

  const parsed = parseResponse(LfoCodesWireSchema, res.raw, {
    endpoint: 'lfos_cto_filter_lfo',
    corrId: ctx.corrId,
    requestId: res.requestId,
  });

  let rawList: Array<string | { code: string }> = [];
  if (Array.isArray(parsed)) {
    rawList = parsed;
  } else if (Array.isArray(parsed.lfoCodes)) {
    rawList = parsed.lfoCodes;
  } else if (Array.isArray(parsed.data)) {
    rawList = parsed.data;
  }

  const lfoCodes = rawList
    .map((item) => (typeof item === 'string' ? item : item.code))
    .filter((code) => typeof code === 'string' && code.trim().length > 0);

  return { lfoCodes };
}

