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
import {
  SessionStore,
  type ConfigSession,
  type RackPlacement,
  type CableLink,
} from '../session/SessionStore.js';

const SOLUTION_MODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

interface Cached<T> {
  value: T;
  at: number;
}

/**
 * Holds the pieces that outlive a single tool call: the HTTP client, the
 * long-TTL metadata caches, and the session store.
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
   * Launches a configuration and opens a session within a workspace.
   */
  async launch(opts: {
    productCode: string;
    mode: ConfigMode;
    solution: SolutionContext;
    ctx: RequestCtx;
    label?: string | undefined;
    workspaceId?: string | undefined;
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
      workspaceId: opts.workspaceId,
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
   */
  setQuantity(session: ConfigSession, quantity: number): ConfigSession {
    session.raw.quantity = quantity;
    session.reduced.quantity = quantity;
    session.revision += 1;
    session.lastAccessAt = Date.now();
    return session;
  }

  addRack(
    sessionHandle: string,
    rackCode: string,
    description = 'Rack Enclosure',
    uheight = 42,
    position = 1,
  ): RackPlacement {
    const ws = this.sessions.getWorkspace(sessionHandle);
    if (!ws) throw new Error(`Session / Workspace ${sessionHandle} not found`);
    return this.sessions.addRack(ws.id, rackCode, description, uheight, position);
  }

  placeInRack(
    sessionHandle: string,
    configId: string,
    rackId: string,
    uPosition: number,
    height = 1,
  ): boolean {
    const ws = this.sessions.getWorkspace(sessionHandle);
    if (!ws) return false;
    return this.sessions.placeInRack(ws.id, configId, rackId, uPosition, height);
  }

  addCabling(sessionHandle: string, cable: Omit<CableLink, 'id'>): CableLink {
    const ws = this.sessions.getWorkspace(sessionHandle);
    if (!ws) throw new Error(`Session / Workspace ${sessionHandle} not found`);
    return this.sessions.addCabling(ws.id, cable);
  }

  /** Streams the export ZIP to disk and returns where it landed. */
  async exportZip(
    sessionHandle: string,
    opts: { fileTypes: ExportFileType[]; fileName: string; ctx: RequestCtx },
  ): Promise<{ stream: NodeJS.ReadableStream; contentDisposition: string | undefined }> {
    const session = this.sessions.get(sessionHandle);
    const workspace = this.sessions.getWorkspace(sessionHandle);
    if (!session && !workspace) throw new Error(`Session / Workspace ${sessionHandle} not found`);

    const isWorkspaceMulti = workspace && workspace.configurations.size > 1;
    const solution = workspace?.solution ?? session!.solution;
    const validationMode = workspace?.validationMode ?? session!.validationMode;
    const isLfo = session ? session.mode !== 'cto' : false;

    const data = isWorkspaceMulti
      ? buildExportData({
          workspace,
          solution,
          fileTypes: opts.fileTypes,
          validationMode,
        })
      : buildExportData({
          raw: session!.raw,
          config: session!.reduced,
          solution,
          fileTypes: opts.fileTypes,
          validationMode,
        });

    const form = buildExportForm({
      data,
      groups: isWorkspaceMulti
        ? buildGroups(workspace!)
        : buildGroups(session!.raw, session!.configurationId),
    });

    const res = await this.http.send({
      endpoint: isLfo ? 'lfo_export_zip' : 'cto_export_zip',
      method: 'POST',
      path: isLfo ? '/lfos/export_zip' : '/ctos/export_zip',
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
