import { z } from 'zod';
import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import { type Catalog, type CatalogEntry } from './catalog.js';
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
    promotionLfos?: {
        id: string | null;
        children: unknown[];
    } | undefined;
    promotionOptions?: {
        id: string | null;
        children: unknown[];
    } | undefined;
    promotionSIDs?: {
        id: string | null;
        children: unknown[];
    } | undefined;
    parentId?: string | null | undefined;
    chiocePromotion?: string | undefined;
    [key: string]: unknown;
}
export interface SpecialtyCatalogOptions {
    type: SpecialtyCatalogKind;
    subType?: 'hierarchies' | 'sid' | 'lfo' | 'option' | undefined;
    categoryId?: string | undefined;
}
export type SpecialtyCatalogResult = {
    type: 'lvr';
    catalog: Catalog;
    entries: CatalogEntry[];
} | {
    type: 'converged';
    catalog: Catalog;
    entries: CatalogEntry[];
    detail?: ConvergedCategoryDetail | undefined;
} | {
    type: 'promotion';
    subType: string;
    data: unknown;
};
/**
 * Fetches Lenovo Value Recovery (LVR) / Certified Refurbished catalog tree.
 * Endpoint: GET /lvr/category_hierarchies
 */
export declare function fetchLvrCatalog(http: DcscHttpClient, ctx: RequestCtx): Promise<Catalog>;
/**
 * Fetches Converged / MultiProd (ThinkAgile FX / HX) catalog tree.
 * Endpoint: GET /multiprod_category_hierarchies
 */
export declare function fetchConvergedCatalog(http: DcscHttpClient, ctx: RequestCtx): Promise<Catalog>;
/**
 * Fetches rich category detail for a converged system category.
 * Endpoint: GET /multiprod_category_detail/{id}
 */
export declare function fetchConvergedCategoryDetail(http: DcscHttpClient, ctx: RequestCtx, categoryId: string): Promise<ConvergedCategoryDetail>;
/**
 * Fetches promotional hierarchy categories.
 * Endpoint: GET /promotion/hierarchies
 */
export declare function fetchPromotionHierarchies(http: DcscHttpClient, ctx: RequestCtx): Promise<PromotionHierarchy>;
/**
 * Fetches promotional SID configurations.
 * Endpoint: GET /promotion/sid
 */
export declare function fetchPromotionSids(http: DcscHttpClient, ctx: RequestCtx): Promise<unknown>;
/**
 * Fetches promotional preconfigured LFO models.
 * Endpoint: GET /promotion/lfo
 */
export declare function fetchPromotionLfos(http: DcscHttpClient, ctx: RequestCtx): Promise<unknown>;
/**
 * Fetches promotional standalone options.
 * Endpoint: GET /promotion/option
 */
export declare function fetchPromotionOptions(http: DcscHttpClient, ctx: RequestCtx, categoryId?: string): Promise<unknown>;
/**
 * Unified dispatch for specialty catalogs (LVR, Converged, Promotions).
 */
export declare function fetchSpecialtyCatalog(http: DcscHttpClient, ctx: RequestCtx, options: SpecialtyCatalogOptions): Promise<SpecialtyCatalogResult>;
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
export declare const CategoryDetailSchema: z.ZodObject<{
    children: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    paths: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    totalCount: z.ZodOptional<z.ZodNumber>;
}, z.core.$loose>;
export interface LfoCodesResult {
    lfoCodes: string[];
}
export declare const LfoCodesWireSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
    code: z.ZodString;
}, z.core.$strip>]>>, z.ZodObject<{
    lfoCodes: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        code: z.ZodString;
    }, z.core.$strip>]>>>;
    data: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        code: z.ZodString;
    }, z.core.$strip>]>>>;
}, z.core.$loose>]>;
/**
 * Resolves the appropriate category detail endpoint and path based on categoryId and TruScale flag.
 * - TruScale: /reference_solution/categories/truscale/{id}
 * - Converged/SDI (ThinkAgile HX/FX): /multiprod_category_detail/{normalized_prefix}
 * - Standard catalog: /category_detail/{id}
 */
export declare function resolveCategoryDetailRoute(categoryId: string, isTruScale?: boolean): {
    endpoint: string;
    path: string;
};
/**
 * Fetches sub-category detail with automatic routing between standard, converged (SDI),
 * and TruScale categories, appending signCustomize=true query parameter.
 * Endpoints:
 * - GET /category_detail/{id}
 * - GET /multiprod_category_detail/{id}
 * - GET /reference_solution/categories/truscale/{id}
 */
export declare function fetchCategoryDetail(http: DcscHttpClient, ctx: RequestCtx, categoryIdOrOptions: string | CategoryDetailOptions): Promise<CategoryDetailResult>;
/**
 * Fetches filtered LFO/CTO codes from upstream catalog filter.
 * Endpoint: GET /lfos/cto_filter_lfo
 */
export declare function fetchLfoCodes(http: DcscHttpClient, ctx: RequestCtx): Promise<LfoCodesResult>;
