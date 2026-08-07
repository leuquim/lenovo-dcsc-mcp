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
}

/**
 * Ranked search over the flat index.
 *
 * Exact code match always wins — an LLM that already knows "7D73CTO1WW"
 * should not have to page through fuzzy hits to confirm it.
 */
export function searchCatalog(catalog: Catalog, opts: SearchOptions): CatalogEntry[] {
  const limit = opts.limit ?? 20;
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
  return scored.slice(0, limit).map((s) => s.entry);
}

export interface BrowseResult {
  path: string[];
  children: Array<{ name: string; id: string; childCount: number; productCount: number }>;
  products: CatalogEntry[];
}

/** Walks one level of the tree, for the rare case structure matters. */
export function browseCatalog(
  catalog: Catalog,
  path: string[] = [],
  includeWithdrawn = false,
): BrowseResult {
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

  const products = catalog.entries.filter(
    (e) =>
      e.path.length === walked.length + 1 &&
      walked.every((seg, i) => e.path[i] === seg) &&
      (includeWithdrawn || !e.withdrawn),
  );

  return {
    path: walked,
    children: nodes.map((n) => ({
      name: n.name ?? n.id,
      id: n.id,
      childCount: n.children?.length ?? 0,
      productCount: n.products?.length ?? 0,
    })),
    products,
  };
}
