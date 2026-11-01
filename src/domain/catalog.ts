import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import {
  CategoryHierarchySchema,
  type CategoryNode,
  type Product,
} from '../schemas/catalog.js';
import { parseResponse } from '../schemas/parse.js';

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

export async function fetchCatalog(
  http: DcscHttpClient,
  ctx: RequestCtx,
): Promise<Catalog> {
  const res = await http.send({
    endpoint: 'category_hierarchies',
    method: 'GET',
    path: '/category_hierarchies',
    query: { serviceCto: true },
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });

  const tree = parseResponse(CategoryHierarchySchema, res.raw, {
    endpoint: 'category_hierarchies',
    corrId: ctx.corrId,
    requestId: res.requestId,
  });

  return { tree, entries: flatten(tree), fetchedAt: Date.now() };
}

const FAR_FUTURE = '2999';

function isWithdrawn(p: Product): boolean {
  const wd = p.withdrawnDate;
  if (!wd || wd.startsWith(FAR_FUTURE)) return false;
  return new Date(wd).getTime() < Date.now();
}

/**
 * Flattens the hierarchy into a searchable array.
 *
 * The tree is deep and repetitive; walking it per query is both slow and
 * useless to an LLM. A flat index is what makes "find SR630 V3" a single call
 * instead of a directory crawl.
 */
export function flatten(tree: CategoryNode[]): CatalogEntry[] {
  const out: CatalogEntry[] = [];

  const walk = (nodes: CategoryNode[], path: string[]): void => {
    for (const node of nodes) {
      const name = node.name ?? node.id;
      const nextPath = [...path, name];

      for (const product of node.products ?? []) {
        const description = product.description ?? '';
        out.push({
          code: product.code,
          description,
          path: nextPath,
          categoryId: node.id,
          type: String(product.type ?? (product.cto ? 'CTO' : 'LFO')),
          ...(product.machineType != null ? { machineType: product.machineType } : {}),
          ...(product.model != null ? { model: product.model } : {}),
          ...(product.hardwareType != null ? { hardwareType: product.hardwareType } : {}),
          ...(product.price != null ? { price: product.price } : {}),
          ...(product.shipStatus != null ? { shipStatus: product.shipStatus } : {}),
          withdrawn: isWithdrawn(product),
          haystack: `${product.code} ${description} ${nextPath.join(' ')}`.toLowerCase(),
        });
      }

      if (node.children?.length) walk(node.children, nextPath);
    }
  };

  walk(tree, []);
  return out;
}

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
export function searchCatalog(catalog: Catalog, opts: SearchOptions): CatalogEntry[] {
  return searchCatalogPage(catalog, opts).items;
}

/** Ranked search with a true filtered total and an offset cursor. */
export function searchCatalogPage(
  catalog: Catalog,
  opts: SearchOptions,
): CatalogPage<CatalogEntry> {
  const { offset, limit } = pagination(opts.offset, opts.limit, 20);
  const needle = opts.query.trim().toLowerCase();
  const tokens = needle.split(/\s+/).filter(Boolean);

  const scored: Array<{ entry: CatalogEntry; score: number }> = [];

  for (const entry of catalog.entries) {
    if (!opts.includeWithdrawn && entry.withdrawn) continue;
    if (opts.type && entry.type !== opts.type) continue;
    if (opts.hardwareType && entry.hardwareType !== opts.hardwareType) continue;

    let score = 0;
    if (entry.code.toLowerCase() === needle) score += 1000;
    else if (entry.code.toLowerCase().includes(needle)) score += 200;

    if (tokens.length > 0) {
      let matched = 0;
      for (const token of tokens) {
        if (entry.haystack.includes(token)) matched += 1;
      }
      if (matched === 0 && score === 0) continue;
      score += (matched / tokens.length) * 100;
      // Prefer a contiguous phrase match over scattered tokens.
      if (entry.haystack.includes(needle)) score += 50;
    }

    if (score > 0) scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score || a.entry.code.localeCompare(b.entry.code));
  return {
    items: scored.slice(offset, offset + limit).map((s) => s.entry),
    total: scored.length,
    offset,
    limit,
  };
}

export interface BrowseResult {
  path: string[];
  children: Array<{ name: string; id: string; childCount: number; productCount: number }>;
  products: CatalogEntry[];
  page: { offset: number; limit: number; total: number };
}

export interface BrowseOptions {
  includeWithdrawn?: boolean | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

/** Walks one level of the tree, for the rare case structure matters. */
export function browseCatalog(
  catalog: Catalog,
  path: string[] = [],
  includeWithdrawnOrOptions: boolean | BrowseOptions = false,
): BrowseResult {
  const options =
    typeof includeWithdrawnOrOptions === 'boolean'
      ? { includeWithdrawn: includeWithdrawnOrOptions }
      : includeWithdrawnOrOptions;
  let nodes: CategoryNode[] = catalog.tree;
  const walked: string[] = [];

  for (const segment of path) {
    const match = nodes.find(
      (n) => (n.name ?? n.id).toLowerCase() === segment.toLowerCase() || n.id === segment,
    );
    if (!match) break;
    walked.push(match.name ?? match.id);
    nodes = match.children ?? [];
  }

  const allProducts = catalog.entries.filter(
    (e) =>
      // A non-empty path names the category whose direct products are being
      // browsed. At the root there is no selected category, so retain the old
      // behavior of showing products attached to top-level categories.
      e.path.length === walked.length + (walked.length === 0 ? 1 : 0) &&
      walked.every((seg, i) => e.path[i] === seg) &&
      (options.includeWithdrawn || !e.withdrawn),
  );
  const { offset, limit } = pagination(
    options.offset,
    options.limit,
    Math.max(1, allProducts.length),
  );

  return {
    path: walked,
    children: nodes.map((n) => ({
      name: n.name ?? n.id,
      id: n.id,
      childCount: n.children?.length ?? 0,
      productCount: n.products?.length ?? 0,
    })),
    products: allProducts.slice(offset, offset + limit),
    page: { offset, limit, total: allProducts.length },
  };
}

function pagination(
  requestedOffset: number | undefined,
  requestedLimit: number | undefined,
  defaultLimit: number,
): { offset: number; limit: number } {
  const offset = requestedOffset ?? 0;
  const limit = requestedLimit ?? defaultLimit;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError('Catalog offset must be a non-negative integer.');
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('Catalog limit must be a positive integer.');
  }
  return { offset, limit };
}

/** The raw catalog product, exactly as the website posts it when it picks one. */
export function findCatalogProduct(catalog: Catalog, code: string): Product | undefined {
  const wanted = code.toUpperCase();
  const walk = (nodes: CategoryNode[]): Product | undefined => {
    for (const node of nodes) {
      const found = node.products?.find(product => product.code.toUpperCase() === wanted) ?? walk(node.children ?? []);
      if (found) return found;
    }
    return undefined;
  };
  return walk(catalog.tree);
}
