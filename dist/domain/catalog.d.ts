import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import { type CategoryNode } from '../schemas/catalog.js';
export interface CatalogEntry {
    /** Product code passed to launch, e.g. "7D73CTO1WW". */
    code: string;
    description: string;
    /** Breadcrumb, e.g. ["Servers", "Rack Server", "ThinkSystem SR630 V3"]. */
    path: string[];
    categoryId: string;
    type: string;
    machineType?: string | undefined;
    model?: string | undefined;
    hardwareType?: string | undefined;
    price?: number | undefined;
    shipStatus?: number | undefined;
    withdrawn: boolean;
    /** Lowercased haystack used for matching. */
    haystack: string;
}
export interface Catalog {
    tree: CategoryNode[];
    entries: CatalogEntry[];
    fetchedAt: number;
}
export declare function fetchCatalog(http: DcscHttpClient, ctx: RequestCtx): Promise<Catalog>;
/**
 * Flattens the hierarchy into a searchable array.
 *
 * The tree is deep and repetitive; walking it per query is both slow and
 * useless to an LLM. A flat index is what makes "find SR630 V3" a single call
 * instead of a directory crawl.
 */
export declare function flatten(tree: CategoryNode[]): CatalogEntry[];
export interface SearchOptions {
    query: string;
    type?: 'CTO' | 'LFO' | undefined;
    hardwareType?: string | undefined;
    includeWithdrawn?: boolean | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
}
export interface CatalogPage<T> {
    items: T[];
    /** Total after query/filtering and before pagination. */
    total: number;
    offset: number;
    limit: number;
}
/**
 * Ranked search over the flat index.
 *
 * Exact code match always wins — an LLM that already knows "7D73CTO1WW"
 * should not have to page through fuzzy hits to confirm it.
 */
export declare function searchCatalog(catalog: Catalog, opts: SearchOptions): CatalogEntry[];
/** Ranked search with a true filtered total and an offset cursor. */
export declare function searchCatalogPage(catalog: Catalog, opts: SearchOptions): CatalogPage<CatalogEntry>;
export interface BrowseResult {
    path: string[];
    children: Array<{
        name: string;
        id: string;
        childCount: number;
        productCount: number;
    }>;
    products: CatalogEntry[];
    page: {
        offset: number;
        limit: number;
        total: number;
    };
}
export interface BrowseOptions {
    includeWithdrawn?: boolean | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
}
/** Walks one level of the tree, for the rare case structure matters. */
export declare function browseCatalog(catalog: Catalog, path?: string[], includeWithdrawnOrOptions?: boolean | BrowseOptions): BrowseResult;
