type Row = Record<string, unknown>;
/**
 * Bound both collections returned by hierarchical catalog browsing while
 * advancing each cursor by the number that survived byte trimming.
 */
export declare function projectCatalogBrowsePage(options: {
    tool: string;
    arguments: Record<string, unknown>;
    context: unknown;
    path: string[];
    categories: Row[];
    products: Row[];
    categoryOffset: number;
    productOffset: number;
    limit: number;
    detailPath?: string[] | undefined;
    expectedCatalogFingerprint?: string | undefined;
}): Row;
export {};
