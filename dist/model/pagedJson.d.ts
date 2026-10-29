/** Lossless, bounded navigation for retained upstream reports and recovery state. */
export declare function projectJsonPage(source: unknown, options: {
    tool: string;
    arguments: Record<string, unknown>;
    path: string[];
    offset: number;
    limit: number;
    /** Input property carrying the detail traversal path when `path` has another meaning. */
    pathArgument?: string | undefined;
}): Record<string, unknown>;
