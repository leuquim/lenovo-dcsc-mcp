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
