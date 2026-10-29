/** Preserve complete catalog rows behind byte-bounded, query-bound continuations. */
export declare function projectCatalogPage(options: {
    tool: string;
    arguments: Record<string, unknown>;
    base: Record<string, unknown>;
    context?: unknown;
    collection: string;
    items: Array<Record<string, unknown>>;
    offset: number;
    limit: number;
    path?: string[] | undefined;
    expectedCatalogFingerprint?: string | undefined;
}): Record<string, unknown>;
