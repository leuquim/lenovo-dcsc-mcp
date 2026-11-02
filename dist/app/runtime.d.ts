import type { Config, Locale, SolutionContext } from '../config/schema.js';
import { type Catalog } from '../domain/catalog.js';
import { type FabricOptions } from '../domain/fabric.js';
import { type ExportFileType } from '../domain/reduce.js';
import { type SolutionModeInfo } from '../domain/context.js';
import { DcscHttpClient, type RequestCtx } from '../http/request.js';
import { SessionStore } from '../session/SessionStore.js';
export declare const CATALOG_TTL_MS: number;
/** Time-boxed async cache that stores in-flight promises, so concurrent callers share one fetch and failures are not kept. */
export declare class AsyncTtlCache<T> {
    #private;
    private readonly ttlMs;
    constructor(ttlMs: number);
    get(key: string, load: () => Promise<T>): Promise<T>;
}
export interface Cached<T> {
    value: T;
    at: number;
}
/**
 * Holds the pieces that outlive a single tool call: the HTTP client, the
 * long-TTL metadata caches, and the session store.
 */
export declare class Runtime {
    #private;
    readonly config: Config;
    readonly http: DcscHttpClient;
    readonly sessions: SessionStore;
    readonly mipCatalogCache: Map<string, Cached<unknown>>;
    readonly referencesCache: AsyncTtlCache<unknown>;
    constructor(config: Config);
    get locale(): Locale;
    /** Overrides the process locale for subsequent newCtx/launch calls. */
    setLocale(locale: Locale): void;
    get withdrawnSince(): string | undefined;
    /** Sets the website's "withdrawn since" date for subsequent catalog fetches; undefined means available only. */
    setWithdrawnSince(date: string | undefined): void;
    /** A fresh request context with its own correlation id and request budget. */
    newCtx(overrides?: {
        locale?: Locale;
        solution?: SolutionContext;
    }): RequestCtx;
    /** The caller's context, or a fresh one carrying the resolved solution. */
    ctxWithSolution(ctx?: RequestCtx, preferredMode?: string): Promise<RequestCtx>;
    /** The caller's context if it already carries a solution, otherwise one that does. */
    ctxEnsuringSolution(ctx?: RequestCtx): Promise<RequestCtx>;
    solutionModes(ctx: RequestCtx): Promise<SolutionModeInfo[]>;
    /** The export types the website offers for a solution mode. */
    defaultExportTypes(solution: SolutionContext): Promise<ExportFileType[]>;
    /** Resolves the solution context, fetching modes if they are not cached. */
    resolveSolution(ctx: RequestCtx, preferred?: string): Promise<SolutionContext>;
    /**
     * Resolves a country (and optional language) against /locales into a Locale.
     * Does not mutate server config; callers pass the result into newCtx/launch.
     */
    resolveLocale(ctx: RequestCtx, countryCode: string, languageCode?: string): Promise<Locale>;
    catalog(ctx: RequestCtx, solution: SolutionContext): Promise<Catalog>;
    /**
     * The fabric vocabulary: network topologies, node roles and storage switches.
     *
     * Cached for the same reason the catalog is — these lists change on Lenovo's
     * release cadence, not within a session.
     */
    fabricOptions(ctx: RequestCtx, solution: SolutionContext): Promise<FabricOptions>;
    close(): Promise<void>;
}
/** Workspace-wide mutations compare the workspace revision even for configuration handles. */
export declare function workspaceId(rt: Runtime, handle: string): string;
