type Obj = Record<string, unknown>;
/**
 * CFXML imports compress identical loose products into one configuration and an
 * originalIds list. The captured SPA expands those IDs into physical instances
 * before customization. A group quantity alone is not enough to invent IDs.
 */
export declare function expandImportedClones<T extends Obj>(source: T): T;
export {};
