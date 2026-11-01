import type { Config, Locale, SolutionContext } from '../config/schema.js';
import { fetchCatalog, type Catalog } from '../domain/catalog.js';
import { fetchFabricOptions, type FabricOptions } from '../domain/fabric.js';
import { fetchLocales, localeFromOption } from '../domain/locale.js';
import { fetchSolutionModes, toSolutionContext, type SolutionModeInfo } from '../domain/context.js';
import { DcscHttpClient, RequestBudget, type RequestCtx } from '../http/request.js';
import { logger, newCorrId } from '../http/trace.js';
import { createPersistenceWriter, loadSessions } from '../session/persist.js';
import { SessionStore } from '../session/SessionStore.js';

const SOLUTION_MODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export interface Cached<T> {
  value: T;
  at: number;
}

/**
 * Holds the pieces that outlive a single tool call: the HTTP client, the
 * long-TTL metadata caches, and the session store.
 */
export class Runtime {
  readonly http: DcscHttpClient;
  readonly sessions = new SessionStore();
  readonly mipCatalogCache = new Map<string, Cached<unknown>>();
  readonly referencesCache = new Map<string, Cached<unknown>>();

  #modes: Cached<SolutionModeInfo[]> | undefined;
  #catalog = new Map<string, Cached<Catalog>>();
  #fabric = new Map<string, Cached<FabricOptions>>();
  #closing: Promise<void> | undefined;
  #localeOverride: Locale | undefined;

  constructor(readonly config: Config) {
    this.http = new DcscHttpClient(config);
    const persisted = loadSessions(this.sessions, config);
    this.sessions.setPersistenceWriter(createPersistenceWriter(config));
    if (persisted > 0) {
      logger().info({ workspaces: persisted }, 'Found persisted workspaces; they load on first use');
    }
  }

  get locale(): Locale {
    return this.#localeOverride ?? this.config.locale;
  }

  /** Overrides the process locale for subsequent newCtx/launch calls. */
  setLocale(locale: Locale): void {
    this.#localeOverride = locale;
  }

  /** A fresh request context with its own correlation id and request budget. */
  newCtx(overrides: { locale?: Locale; solution?: SolutionContext } = {}): RequestCtx {
    return {
      corrId: newCorrId(),
      locale: overrides.locale ?? this.locale,
      ...(overrides.solution !== undefined ? { solution: overrides.solution } : {}),
      budget: new RequestBudget(this.config.pacing.perToolRequestBudget),
    };
  }

  /** The caller's context, or a fresh one carrying the resolved solution. */
  async ctxWithSolution(ctx?: RequestCtx, preferredMode?: string): Promise<RequestCtx> {
    return ctx ?? this.newCtx({ solution: await this.resolveSolution(this.newCtx(), preferredMode) });
  }

  /** The caller's context if it already carries a solution, otherwise one that does. */
  async ctxEnsuringSolution(ctx?: RequestCtx): Promise<RequestCtx> {
    return ctx?.solution
      ? ctx
      : this.newCtx({ ...(ctx ?? {}), solution: await this.resolveSolution(ctx ?? this.newCtx()) });
  }

  async solutionModes(ctx: RequestCtx): Promise<SolutionModeInfo[]> {
    if (this.#modes && Date.now() - this.#modes.at < SOLUTION_MODE_TTL_MS) {
      return this.#modes.value;
    }
    const value = await fetchSolutionModes(this.http, ctx);
    this.#modes = { value, at: Date.now() };
    return value;
  }

  /** Resolves the solution context, fetching modes if they are not cached. */
  async resolveSolution(ctx: RequestCtx, preferred?: string): Promise<SolutionContext> {
    const modes = await this.solutionModes(ctx);
    return toSolutionContext(modes, preferred);
  }

  /**
   * Resolves a country (and optional language) against /locales into a Locale.
   * Does not mutate server config; callers pass the result into newCtx/launch.
   */
  async resolveLocale(
    ctx: RequestCtx,
    countryCode: string,
    languageCode?: string,
  ): Promise<Locale> {
    const locales = await fetchLocales(this.http, ctx);
    const match = locales.find(
      (l) => l.countryCode.toUpperCase() === countryCode.toUpperCase() && !l.countryInvalid,
    );
    if (!match) {
      const sample = locales
        .filter((l) => !l.countryInvalid)
        .slice(0, 12)
        .map((l) => l.countryCode)
        .join(', ');
      throw new Error(
        `Unknown or invalid country "${countryCode}". Examples: ${sample}${locales.length > 12 ? ', …' : ''}.`,
      );
    }
    return localeFromOption(match, languageCode);
  }

  async catalog(ctx: RequestCtx, solution: SolutionContext): Promise<Catalog> {
    const key = `${ctx.locale.country}|${ctx.locale.language}|${ctx.locale.currency}|${solution.solutionMode}`;
    const hit = this.#catalog.get(key);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.value;

    const value = await fetchCatalog(this.http, { ...ctx, solution });
    this.#catalog.set(key, { value, at: Date.now() });
    return value;
  }

  /**
   * The fabric vocabulary: network topologies, node roles and storage switches.
   *
   * Cached for the same reason the catalog is — these lists change on Lenovo's
   * release cadence, not within a session.
   */
  async fabricOptions(ctx: RequestCtx, solution: SolutionContext): Promise<FabricOptions> {
    const key = `${ctx.locale.country}|${solution.solutionMode}`;
    const hit = this.#fabric.get(key);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.value;

    const value = await fetchFabricOptions(this.http, { ...ctx, solution });
    this.#fabric.set(key, { value, at: Date.now() });
    return value;
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      await this.sessions.drain();
      await this.http.close();
      await this.sessions.drain();
    })();
    return this.#closing;
  }
}



/** Workspace-wide mutations compare the workspace revision even for configuration handles. */
export function workspaceId(rt: Runtime, handle: string): string {
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error(`Session / Workspace ${handle} not found`);
  return workspace.id;
}
