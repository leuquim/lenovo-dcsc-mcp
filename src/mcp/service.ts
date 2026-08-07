import type { ConfigMode } from '../config/constants.js';
import type { Config, Locale, SolutionContext } from '../config/schema.js';
import { fetchCatalog, type Catalog } from '../domain/catalog.js';
import {
  fetchSolutionModes,
  toSolutionContext,
  type SolutionModeInfo,
} from '../domain/context.js';
import {
  applyChange,
  buildAutoDeriveRequest,
  buildExportData,
  buildExportForm,
  buildGroups,
  newConfigurationId,
  reduceConfiguration,
  type ExportFileType,
  type ReducedConfiguration,
} from '../domain/reduce.js';
import { DcscHttpClient, RequestBudget, type RequestCtx } from '../http/request.js';
import { logger, newCorrId } from '../http/trace.js';
import type { RawConfiguration } from '../model/types.js';
import { SessionStore, type ConfigSession } from '../session/SessionStore.js';

const SOLUTION_MODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

interface Cached<T> {
  value: T;
  at: number;
}

/**
 * Holds the pieces that outlive a single tool call: the HTTP client, the
 * long-TTL metadata caches, and the session store.
 *
 * The caches matter for politeness as much as latency — the catalog is a large
 * response and re-fetching it per tool call would be the fastest way to get
 * this client flagged.
 */
export class DcscService {
  readonly http: DcscHttpClient;
  readonly sessions = new SessionStore();

  #modes: Cached<SolutionModeInfo[]> | undefined;
  #catalog = new Map<string, Cached<Catalog>>();

  constructor(readonly config: Config) {
    this.http = new DcscHttpClient(config);
  }

  get locale(): Locale {
    return this.config.locale;
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

  async catalog(ctx: RequestCtx, solution: SolutionContext): Promise<Catalog> {
    const key = `${ctx.locale.country}|${ctx.locale.language}|${ctx.locale.currency}|${solution.solutionMode}`;
    const hit = this.#catalog.get(key);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.value;

    const value = await fetchCatalog(this.http, { ...ctx, solution });
    this.#catalog.set(key, { value, at: Date.now() });
    return value;
  }

  /**
   * Launches a configuration and opens a session.
   *
   * CTO and LFO take different endpoints; the mode is fixed at launch and the
   * path is chosen here rather than being exposed as a tool parameter.
   */
  async launch(opts: {
    productCode: string;
    mode: ConfigMode;
    solution: SolutionContext;
    ctx: RequestCtx;
    label?: string | undefined;
  }): Promise<ConfigSession> {
    const { productCode, mode, solution, ctx } = opts;
    const encoded = encodeURIComponent(productCode);

    const path =
      mode === 'lfo'
        ? `/lfos/${encoded}/as_lfo_launch`
        : mode === 'lfo-as-cto'
          ? `/lfos/${encoded}/as_cto_launch`
          : mode === 'lfo-add-options'
            ? `/lfos/${encoded}/add_options_launch`
            : `/ctos/${encoded}/launch`;

    const res = await this.http.send({
      endpoint: `${mode}_launch`,
      method: 'POST',
      path,
      query: { hardwareOnly: false, controlExpressModal: false },
      body: { kind: 'json', value: {} },
      responseKind: 'json',
      timeoutClass: 'interactive',
      ctx: { ...ctx, solution },
    });

    let raw = res.raw as RawConfiguration;
    if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.tabs)) {
      throw new Error(
        `DCSC returned no configuration tree for ${productCode}. The product code may not be configurable in this solution mode.`,
      );
    }

    const configurationId = newConfigurationId(ctx.locale.country);
    const reduceMode = mode === 'cto' ? 'cto' : 'lfo';
    let reduced = reduceConfiguration(raw, configurationId, reduceMode);

    // The SPA runs an autoDerive with no delta immediately after launch. That
    // pass materialises the derived sections (fillers, labels, voltage, service
    // and software rows) that the launch response does not contain, and the
    // first real change is rejected without it.
    //
    // Best-effort on purpose: the launch response is already valid for
    // browsing, pricing and the bill of materials, so a priming failure must
    // not sink the whole session. It is recorded and retried on first mutation.
    let primed = false;
    try {
      const derived = await this.#autoDerive(reduced, {
        ctx,
        solution,
        mode,
        validationMode: 'guided',
      });
      if (derived) {
        raw = derived;
        reduced = reduceConfiguration(derived, configurationId, reduceMode);
        primed = true;
      }
    } catch (err) {
      logger().warn(
        { productCode, mode, err: err instanceof Error ? err.message : String(err) },
        'Priming autoDerive failed; session is read-only until it succeeds',
      );
    }

    return this.sessions.create({
      primed,
      locale: ctx.locale,
      solution,
      mode,
      raw,
      configurationId,
      reduced,
      ...(opts.label !== undefined ? { label: opts.label } : {}),
    });
  }

  async #autoDerive(
    reduced: ReducedConfiguration,
    opts: {
      ctx: RequestCtx;
      solution: SolutionContext;
      mode: ConfigMode;
      validationMode: 'guided' | 'expert';
    },
  ): Promise<RawConfiguration | undefined> {
    // CTO and LFO have mirrored endpoint families; posting an LFO
    // configuration to the CTO route 404s with "Not found CTO with code".
    const isLfo = opts.mode !== 'cto';
    const res = await this.http.send({
      endpoint: isLfo ? 'lfo_autoDerive' : 'cto_autoDerive',
      method: 'POST',
      path: isLfo ? '/lfos/autoDerive' : '/ctos/autoDerive',
      query: { configurationId: reduced.id, entranceFlag: 'customize' },
      body: {
        kind: 'json',
        value: buildAutoDeriveRequest(reduced, { validationMode: opts.validationMode }),
      },
      responseKind: 'json',
      timeoutClass: 'heavy',
      ctx: { ...opts.ctx, solution: opts.solution },
    });
    const body = res.raw as { configurations?: RawConfiguration[] };
    return body.configurations?.[0];
  }

  /**
   * Applies selection changes and commits the reconciled result.
   *
   * Changes are batched into one round trip so "swap the CPU and bump the
   * memory" is atomic rather than transiently invalid. DCSC reconciles from
   * the per-change delta, which is why `previousFeatureCode` matters.
   */
  async configure(
    session: ConfigSession,
    changes: Array<{ section: string; code: string; quantity: number }>,
    ctx: RequestCtx,
  ): Promise<ConfigSession> {
    return this.sessions.withLock(session.id, async () => {
      let reduced = session.reduced;
      for (const change of changes) {
        reduced = applyChange(reduced, {
          sectionName: change.section,
          code: change.code,
          quantity: change.quantity,
        });
      }

      const updated = await this.#autoDerive(reduced, {
        ctx,
        solution: session.solution,
        mode: session.mode,
        validationMode: session.validationMode,
      });
      if (!updated) {
        throw new Error('DCSC returned no configuration after applying the change.');
      }

      session.primed = true;
      const reduceMode = session.mode === 'cto' ? 'cto' : 'lfo';
      return this.sessions.commit(
        session,
        updated,
        reduceConfiguration(updated, session.configurationId, reduceMode),
        { at: Date.now(), changes },
      );
    });
  }

  /**
   * Sets how many identical units of this configuration are wanted.
   *
   * Quantity is a property of the client-held configuration, not something the
   * rules engine reconciles, so this needs no round trip — but it does change
   * the extended price and the exported line, so it bumps the revision.
   */
  setQuantity(session: ConfigSession, quantity: number): ConfigSession {
    session.raw.quantity = quantity;
    session.reduced.quantity = quantity;
    session.revision += 1;
    session.lastAccessAt = Date.now();
    return session;
  }

  /** Streams the export ZIP to disk and returns where it landed. */
  async exportZip(
    session: ConfigSession,
    opts: { fileTypes: ExportFileType[]; fileName: string; ctx: RequestCtx },
  ): Promise<{ stream: NodeJS.ReadableStream; contentDisposition: string | undefined }> {
    const data = buildExportData({
      raw: session.raw,
      config: session.reduced,
      solution: session.solution,
      fileTypes: opts.fileTypes,
      validationMode: session.validationMode,
    });
    const form = buildExportForm({
      data,
      groups: buildGroups(session.raw, session.configurationId),
    });

    // Export mirrors the CTO/LFO split like every other endpoint family.
    const isLfo = session.mode !== 'cto';
    const res = await this.http.send({
      endpoint: isLfo ? 'lfo_export_zip' : 'cto_export_zip',
      method: 'POST',
      path: isLfo ? '/lfos/export_zip' : '/ctos/export_zip',
      // The export endpoint takes a minimal query: no geo, solutionMode or
      // masterSlices. Sending them is harmless but they are not required.
      query: { fileName: opts.fileName },
      requiresSolution: false,
      body: { kind: 'form', fields: form },
      responseKind: 'stream',
      timeoutClass: 'export',
      ctx: { ...opts.ctx, solution: undefined },
    });

    return { stream: res.stream, contentDisposition: res.contentDisposition };
  }

  async close(): Promise<void> {
    await this.http.close();
  }
}
