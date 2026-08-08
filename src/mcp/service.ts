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
import { parseCfxml } from '../domain/import.js';
import {
  buildRackItem,
  buildRackObject,
  customizeLayout,
  fetchEnvelopes,
  fetchRackCabinets,
  type CustomizeOptions,
  type LayoutResult,
  type RackCabinet,
  type RackObject,
  type RackSummary,
} from '../domain/rack.js';
import { fetchFabricOptions, type FabricOptions } from '../domain/fabric.js';
import { aggregatePower, extractPowerReport, type AggregatedPower, type PowerReport } from '../domain/power.js';
import { autoConnect, type AutoConnectResult } from '../domain/cabling.js';
import { placeRackOnFloor, type FloorPlacementResult } from '../domain/floor.js';
import {
  listPduCatalog,
  resolvePowerChange,
  selectedPowerLines,
  type PduCatalog,
} from '../domain/pdu.js';
import { diffConfigurations } from '../model/diff.js';
import { projectSummary } from '../model/project.js';
import { DcscHttpClient, RequestBudget, type RequestCtx } from '../http/request.js';
import { logger, newCorrId } from '../http/trace.js';
import type { RawConfiguration } from '../model/types.js';
import {
  SessionStore,
  type ConfigSession,
  type CableLink,
  type PduSelection,
  type WorkspaceSession,
} from '../session/SessionStore.js';
import { loadSessions, saveSessions } from '../session/persist.js';
import { ulid } from 'ulid';

/** Reduces a raw rackArea the same way customizeLayout does, without a round trip. */
function summariseRackArea(rackArea: RackObject[]): RackSummary[] {
  return rackArea.map((r) => {
    const items = ((r['rackItems'] as RackObject[] | undefined) ?? []).map((it) => {
      const sizeU = typeof it['size'] === 'number' ? it['size'] : Number(it['size']) || 1;
      const position =
        typeof it['position'] === 'number' ? it['position'] : Number(it['position']) || 0;
      return {
        id: String(it['id'] ?? ''),
        code: String(it['code'] ?? ''),
        description: typeof it['description'] === 'string' ? it['description'] : undefined,
        position,
        endPosition:
          typeof it['endPosition'] === 'number'
            ? it['endPosition']
            : position + sizeU - 1,
        sizeU,
      };
    });
    const sizeU = typeof r['size'] === 'number' ? r['size'] : Number(r['size']) || 0;
    const usedU = items.reduce((acc, i) => acc + i.sizeU, 0);
    const errors = Array.isArray(r['errors'])
      ? (r['errors'] as unknown[])
          .map((e) => {
            if (typeof e === 'string') return { message: e };
            if (typeof e === 'object' && e !== null) {
              const o = e as Record<string, unknown>;
              return {
                ...(typeof o['code'] === 'string' ? { code: o['code'] } : {}),
                message: String(o['message'] ?? o['code'] ?? 'error'),
              };
            }
            return { message: String(e) };
          })
          .filter((e) => e.message)
      : [];
    return {
      id: String(r['id'] ?? ''),
      code: String(r['code'] ?? ''),
      description: typeof r['description'] === 'string' ? r['description'] : undefined,
      sizeU,
      usedU,
      freeU: Math.max(0, sizeU - usedU),
      emptyWeightKg: typeof r['emptyRackWeight'] === 'number' ? r['emptyRackWeight'] : undefined,
      totalWeightKg: typeof r['totalWeight'] === 'number' ? r['totalWeight'] : undefined,
      stableStatus: typeof r['stableStatus'] === 'string' ? r['stableStatus'] : undefined,
      items,
      errors,
    };
  });
}

const SOLUTION_MODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** A part DCSC could not carry across an import, as it reports it. */
export interface ImportPart {
  productCode: string;
  description?: string;
  quantity?: number;
}

export interface ImportDiagnostics {
  /** Parts in the file that DCSC could not resolve at all. */
  missingParts: ImportPart[];
  /** Parts dropped because of rule changes or withdrawal. */
  removedParts: ImportPart[];
  /** Parts DCSC substituted for a successor. */
  replacedParts: ImportPart[];
  /** DCSC flagged one or more parts as export-controlled. Informational. */
  eccnRestricted: boolean;
}

/** Sizing for a cluster built by replicating one designed node. */
export interface ScaleOutPlan {
  nodeCode: string;
  nodeDescription: string;
  nodeSizeU: number;
  nodeWeightKg: number;
  rackCode: string;
  rackSizeU: number;
  nodes: number;
  /** How many DCSC actually accepted per cabinet, not the arithmetic maximum. */
  nodesPerRack: number;
  racksNeeded: number;
  totalListPrice: number;
  totalWeightKg: number;
  powerPerNode?: PowerReport;
  clusterPower?: AggregatedPower;
  powerPerRack?: AggregatedPower;
}

export interface ImportResult {
  workspaceId: string;
  sessions: ConfigSession[];
  diagnostics: ImportDiagnostics;
}

/** The subset of /multiple/cfxml_import's response that we depend on. */
interface RawImportResponse {
  configuration?: RawConfiguration[] | null;
  missingParts?: unknown;
  removedParts?: unknown;
  differentPartMap?: unknown;
  eccnRestricted?: boolean | null;
}

function toImportParts(value: unknown): ImportPart[] {
  if (!Array.isArray(value)) return [];
  const out: ImportPart[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const code = e['productCode'] ?? e['code'];
    if (typeof code !== 'string' || code === '') continue;
    const description = e['description'];
    const quantity = Number(e['quantity'] ?? e['productQuantity']);
    out.push({
      productCode: code,
      ...(typeof description === 'string' ? { description } : {}),
      ...(Number.isFinite(quantity) ? { quantity } : {}),
    });
  }
  return out;
}

/**
 * `differentPartMap` is keyed by configuration id and is the only place the
 * import reports substitutions, so replacements are gathered from there.
 */
function collectReplacedParts(value: unknown): ImportPart[] {
  if (typeof value !== 'object' || value === null) return [];
  const out: ImportPart[] = [];
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    out.push(...toImportParts((entry as Record<string, unknown>)['replacedParts']));
  }
  return out;
}

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
  #fabric = new Map<string, Cached<FabricOptions>>();

  #persistTimer: NodeJS.Timeout | undefined;

  constructor(readonly config: Config) {
    this.http = new DcscHttpClient(config);
    const restored = loadSessions(this.sessions, config);
    if (restored > 0) {
      logger().info({ workspaces: restored }, 'Restored persisted workspaces');
    }
  }

  /**
   * Snapshots the session store shortly after a mutation.
   *
   * Debounced because a single tool call can mutate several times (placing a
   * node touches the layout and the workspace revision), and the snapshot
   * carries the full configuration trees.
   */
  persist(): void {
    if (!this.config.files.persistSessions) return;
    if (this.#persistTimer) clearTimeout(this.#persistTimer);
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = undefined;
      saveSessions(this.sessions, this.config);
    }, 250);
    this.#persistTimer.unref?.();
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

  /**
   * Which solution modes' catalogs contain each of these product codes.
   *
   * DCSC resolves a product against the catalog of whichever mode it is asked
   * about, and launch does not enforce membership — so a model can launch and
   * price cleanly under a mode it is not in, then be rejected outright on
   * import. SR685a V3 (7DHCCTO1WW) is General Purpose only and behaves exactly
   * that way. Knowing where a model actually lives makes that visible up front
   * instead of three steps later.
   *
   * Costs at most one request per mode per day thanks to the catalog cache.
   */
  async modesContaining(ctx: RequestCtx, codes: string[]): Promise<Map<string, string[]>> {
    const wanted = new Set(codes.map((c) => c.toUpperCase()));
    const out = new Map<string, string[]>();
    for (const code of wanted) out.set(code, []);
    if (wanted.size === 0) return out;

    for (const info of await this.solutionModes(ctx)) {
      const solution = await this.resolveSolution(ctx, info.mode);
      const catalog = await this.catalog(ctx, solution);
      for (const entry of catalog.entries) {
        const code = entry.code.toUpperCase();
        if (wanted.has(code)) {
          const modes = out.get(code)!;
          if (!modes.includes(info.mode)) modes.push(info.mode);
        }
      }
    }
    return out;
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
      query: { serviceCto: true, serviceType: 'servicecto', controlExpressModal: true },
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
    let reduced = reduceConfiguration(raw, configurationId, reduceMode, solution.solutionMode);

    let primed = false;
    try {
      const derived = await this.#autoDerive(reduced, {
        ctx,
        solution,
        mode,
        validationMode: 'guided',
      });
      if (derived) {
        raw = {
          ...derived,
          hipoDerivedItems: derived.hipoDerivedItems ?? raw.hipoDerivedItems,
          hipoServiceCtoServices: derived.hipoServiceCtoServices ?? raw.hipoServiceCtoServices,
        };
        reduced = reduceConfiguration(raw, configurationId, reduceMode, solution.solutionMode);
        primed = true;
      }
    } catch (err) {
      logger().warn(
        { productCode, mode, err: err instanceof Error ? err.message : String(err) },
        'Priming autoDerive failed; session is read-only until it succeeds',
      );
    }

    const created = this.sessions.create({
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
    this.persist();
    return created;
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
      const mergedUpdated = {
        ...updated,
        hipoDerivedItems: updated.hipoDerivedItems ?? session.raw.hipoDerivedItems,
        hipoServiceCtoServices: updated.hipoServiceCtoServices ?? session.raw.hipoServiceCtoServices,
      };
      const reduceMode = session.mode === 'cto' ? 'cto' : 'lfo';
      const committed = this.sessions.commit(
        session,
        mergedUpdated,
        reduceConfiguration(mergedUpdated, session.configurationId, reduceMode, session.solution.solutionMode),
        { at: Date.now(), changes },
      );
      this.persist();
      return committed;
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

  /** Rack cabinets available in the workspace's solution mode. */
  async rackCabinets(ctx: RequestCtx, solution: SolutionContext): Promise<RackCabinet[]> {
    return fetchRackCabinets(this.http, { ...ctx, solution });
  }

  /**
   * Sizes a cluster built from one designed node.
   *
   * Rack capacity is established empirically rather than by dividing U heights:
   * DCSC enforces per-product position rules (an SR680a V3 may only occupy U3
   * to U35 of a 42U cabinet), so the usable slot count is always lower than the
   * arithmetic suggests. Nodes are placed one at a time until DCSC refuses,
   * and that refusal is the answer.
   *
   * This sizes and prices the cluster; it does not materialise every node as a
   * separate configuration.
   */
  async scaleOut(opts: {
    sessionHandle: string;
    nodes: number;
    rackCode: string;
    ctx: RequestCtx;
  }): Promise<ScaleOutPlan> {
    const ws = this.sessions.getWorkspace(opts.sessionHandle);
    const node = this.sessions.get(opts.sessionHandle);
    if (!ws || !node) throw new Error(`Session / Workspace ${opts.sessionHandle} not found`);

    const rctx = { ...opts.ctx, solution: ws.solution };
    const envelopes = await fetchEnvelopes(this.http, rctx, [
      { code: opts.rackCode, type: 'rack' },
      { code: node.reduced.sliceCtoCode, type: 'server' },
    ]);
    const rackEnv = envelopes.get(opts.rackCode.toUpperCase());
    const nodeEnv = envelopes.get(node.reduced.sliceCtoCode.toUpperCase());
    if (!rackEnv || !nodeEnv) {
      throw new Error('DCSC returned no physical data for the rack or the node.');
    }

    // Probe one empty rack to find how many of this node DCSC will accept.
    //
    // Each round appends one node immediately above the highest slot DCSC
    // actually accepted last time, so the search follows the server's own
    // layout instead of a guess. /racks/customize/non_rack reports size 0 for
    // cabinets, so the usable height also has to come back from customize.
    const probeRackId = newConfigurationId(ws.locale.country);
    let placed: RackObject[] = [];
    let perRack = 0;
    let rackSizeU = rackEnv.sizeU;
    let probeEmptyWeightKg: number | undefined;
    let nextPosition = 1;

    const maxRounds = 64;
    for (let round = 0; round < maxRounds; round += 1) {
      const candidate = [
        ...placed,
        buildRackItem(nodeEnv, `${probeRackId}#${round}`, nextPosition),
      ];
      const result = await customizeLayout(
        this.http,
        rctx,
        { rackArea: [buildRackObject(rackEnv, probeRackId, candidate)], nonRackArea: [] },
        { autoArrange: true },
      );

      const rack = result.racks[0];
      if (rack?.sizeU) rackSizeU = rack.sizeU;
      if (probeEmptyWeightKg === undefined && rack?.emptyWeightKg !== undefined) {
        probeEmptyWeightKg = rack.emptyWeightKg;
      }
      const accepted = rack?.items.length ?? 0;
      if (accepted <= perRack) break;

      perRack = accepted;
      // Rebuild from what DCSC accepted, so rejected slots are never retried.
      placed = (rack?.items ?? []).map((it) => buildRackItem(nodeEnv, it.id, it.position));
      const highest = Math.max(...(rack?.items ?? []).map((it) => it.endPosition), 0);
      nextPosition = highest + 1;
      if (rackSizeU > 0 && nextPosition + nodeEnv.sizeU - 1 > rackSizeU) break;
    }

    if (perRack === 0) {
      throw new Error(
        `DCSC would not place ${node.reduced.sliceCtoCode} in ${opts.rackCode} at all. ` +
          'Try a different rack cabinet from dcsc_list_racks.',
      );
    }

    const racksNeeded = Math.ceil(opts.nodes / perRack);
    // The cabinet's own mass; non_rack does not report it, customize does.
    const emptyRackWeightKg = probeEmptyWeightKg ?? rackEnv.weightKg;
    const power = extractPowerReport(node.raw);
    const unitPrice = node.raw.totalPrice ?? 0;

    return {
      nodeCode: node.reduced.sliceCtoCode,
      nodeDescription: node.product.description,
      nodeSizeU: nodeEnv.sizeU,
      nodeWeightKg: nodeEnv.weightKg,
      rackCode: opts.rackCode,
      rackSizeU,
      nodes: opts.nodes,
      nodesPerRack: perRack,
      racksNeeded,
      totalListPrice: unitPrice * opts.nodes,
      totalWeightKg:
        Math.round((nodeEnv.weightKg * opts.nodes + emptyRackWeightKg * racksNeeded) * 10) / 10,
      ...(power
        ? {
            powerPerNode: power,
            clusterPower: aggregatePower([{ report: power, quantity: opts.nodes }]),
            powerPerRack: aggregatePower([{ report: power, quantity: perRack }]),
          }
        : {}),
    };
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

  /**
   * Re-validates the workspace's layout and stores DCSC's corrected version.
   *
   * Every rack mutation funnels through here: DCSC may move items, reject
   * placements or push them out of the rack entirely, and its answer replaces
   * ours rather than merging with it.
   */
  async #syncLayout(
    ws: WorkspaceSession,
    rackArea: RackObject[],
    ctx: RequestCtx,
    opts: CustomizeOptions = {},
  ): Promise<LayoutResult> {
    const result = await customizeLayout(
      this.http,
      { ...ctx, solution: ws.solution },
      { rackArea, nonRackArea: [] },
      opts,
    );
    ws.rackArea = result.rawRackArea;
    ws.rackSummaries = result.racks;
    ws.revision += 1;
    ws.lastAccessAt = Date.now();
    this.persist();
    return result;
  }

  /**
   * Adds a rack cabinet and returns DCSC's validated layout.
   *
   * A rack is a configurable product in its own right, not just a container:
   * it is launched as a configuration in the workspace so that it carries its
   * own price, PDUs and rails. Exports reference racks by configuration id, and
   * a rackArea entry pointing at an id with no matching configuration makes the
   * export endpoint fail with "Index 0 out of bounds for length 0".
   */
  async addRack(sessionHandle: string, rackCode: string, ctx: RequestCtx): Promise<LayoutResult> {
    const ws = this.sessions.getWorkspace(sessionHandle);
    if (!ws) throw new Error(`Session / Workspace ${sessionHandle} not found`);

    const rackSession = await this.launch({
      productCode: rackCode,
      mode: 'cto',
      solution: ws.solution,
      ctx,
      workspaceId: ws.id,
    });

    const envelopes = await fetchEnvelopes(
      this.http,
      { ...ctx, solution: ws.solution },
      [{ code: rackCode, type: 'rack' }],
    );
    const envelope = envelopes.get(rackCode.toUpperCase());
    if (!envelope) {
      throw new Error(
        `DCSC returned no physical data for rack ${rackCode}. Use dcsc_list_racks for valid codes.`,
      );
    }

    const next = [...ws.rackArea, buildRackObject(envelope, rackSession.configurationId)];
    return this.#syncLayout(ws, next, ctx);
  }

  /**
   * Places a configured product into a rack at a given U position.
   *
   * Omit `position` to let DCSC arrange it — the placement rules are per
   * product and per rack (a SR680a V3 cannot sit below U3 in a 42U cabinet),
   * so guessing a slot client-side mostly produces rejections.
   */
  async placeInRack(
    sessionHandle: string,
    opts: { rackId: string; sessionId: string; position?: number | undefined; ctx: RequestCtx },
  ): Promise<LayoutResult> {
    const ws = this.sessions.getWorkspace(sessionHandle);
    if (!ws) throw new Error(`Session / Workspace ${sessionHandle} not found`);

    const target = this.sessions.get(opts.sessionId);
    if (!target) throw new Error(`Session ${opts.sessionId} not found`);

    const productCode = target.reduced.sliceCtoCode;
    const envelopes = await fetchEnvelopes(
      this.http,
      { ...opts.ctx, solution: ws.solution },
      [{ code: productCode, type: 'server' }],
    );
    const envelope = envelopes.get(productCode.toUpperCase());
    if (!envelope) {
      throw new Error(`DCSC returned no physical data for ${productCode}.`);
    }

    const rackIndex = ws.rackArea.findIndex((r) => String(r['id']) === opts.rackId);
    if (rackIndex < 0) {
      throw new Error(`Rack ${opts.rackId} not found in this workspace. Add one with dcsc_add_rack.`);
    }

    const rack = ws.rackArea[rackIndex]!;
    const existing = (rack['rackItems'] as RackObject[] | undefined) ?? [];
    // Position 1 is a common default that most products reject; when the
    // caller does not care, hand the decision to DCSC's arranger.
    const position = opts.position ?? 1;
    const item = buildRackItem(envelope, target.configurationId, position, target.raw.quantity ?? 1);

    const nextRack = { ...rack, rackItems: [...existing, item] };
    const next = [...ws.rackArea];
    next[rackIndex] = nextRack;

    return this.#syncLayout(ws, next, opts.ctx, {
      autoArrange: opts.position === undefined,
    });
  }

  /**
   * Runs DCSC auto-connect and replaces the workspace cable list with the
   * server's connections. Manual port maps are not invented here.
   */
  async runAutoConnect(sessionHandle: string, ctx: RequestCtx): Promise<AutoConnectResult> {
    const ws = this.sessions.getWorkspace(sessionHandle);
    if (!ws) throw new Error(`Session / Workspace ${sessionHandle} not found`);

    const configurations = [...ws.configurations.values()].map((s) => s.raw);
    const result = await autoConnect(
      this.http,
      { ...ctx, solution: ws.solution },
      {
        rackArea: ws.rackArea,
        nonRackArea: [],
        configurations,
        floorItems: ws.floorItems.map((f) => ({
          id: f.id,
          rackId: f.rackId,
          x: f.x,
          y: f.y,
        })),
      },
    );

    // auto_connect's rackArea is authoritative (SPA replaces its store with it).
    ws.rackArea = result.rawRackArea;
    ws.rackSummaries = summariseRackArea(result.rawRackArea);
    this.sessions.setCables(ws.id, result.cables);
    ws.revision += 1;
    ws.lastAccessAt = Date.now();
    this.persist();
    return result;
  }

  /**
   * Records a manual cable. This is SPA-local state — DCSC does not validate
   * individual port maps. Prefer runAutoConnect for server-authored cabling.
   */
  addManualCabling(sessionHandle: string, cable: Omit<CableLink, 'id'>): CableLink {
    const ws = this.sessions.getWorkspace(sessionHandle);
    if (!ws) throw new Error(`Session / Workspace ${sessionHandle} not found`);
    const configs = new Set(
      [...ws.configurations.values()].map((s) => s.configurationId),
    );
    if (cable.fromConfigId && !configs.has(cable.fromConfigId)) {
      throw new Error(
        `fromConfigId ${cable.fromConfigId} is not in this workspace. Use a configuration id from dcsc_session_list.`,
      );
    }
    if (cable.toConfigId && !configs.has(cable.toConfigId)) {
      throw new Error(
        `toConfigId ${cable.toConfigId} is not in this workspace. Use a configuration id from dcsc_session_list.`,
      );
    }
    return this.sessions.addCabling(ws.id, cable);
  }

  /** @deprecated Use runAutoConnect or addManualCabling. */
  addCabling(sessionHandle: string, cable: Omit<CableLink, 'id'>): CableLink {
    return this.addManualCabling(sessionHandle, cable);
  }

  /**
   * Places a rack on the floor grid.
   *
   * Client-side only — see domain/floor.ts. Validates the rack exists in the
   * workspace and that the tile is free; does not invent DCSC validation.
   */
  placeOnFloor(
    sessionHandle: string,
    rackId: string,
    x: number,
    y: number,
  ): FloorPlacementResult {
    const ws = this.sessions.getWorkspace(sessionHandle);
    if (!ws) throw new Error(`Session / Workspace ${sessionHandle} not found`);
    const result = placeRackOnFloor({
      rackArea: ws.rackArea,
      rackId,
      x,
      y,
      existing: ws.floorItems,
      newId: `floor_${ulid().slice(-6).toLowerCase()}`,
    });
    this.sessions.setFloorItem(ws.id, result.item);
    this.persist();
    return result;
  }

  /**
   * Lists orderable PDUs / power cords for a rack, from its configuration tree
   * and the last customize placement rules.
   */
  pduCatalog(sessionHandle: string, rackId: string): { catalog: PduCatalog; rackSession: ConfigSession } {
    const ws = this.sessions.getWorkspace(sessionHandle);
    if (!ws) throw new Error(`Session / Workspace ${sessionHandle} not found`);
    const rackSession = this.sessions.findByConfigurationId(ws.id, rackId);
    if (!rackSession) {
      throw new Error(
        `Rack ${rackId} has no configuration session. Racks from dcsc_add_rack are launched as configurations; ` +
          'pass the rackId returned by dcsc_add_rack / dcsc_workspace_layout.',
      );
    }
    const rackObject = ws.rackArea.find((r) => String(r['id']) === rackId);
    return {
      catalog: listPduCatalog({ index: rackSession.index, rackObject }),
      rackSession,
    };
  }

  /**
   * Selects a PDU / power cord on a rack via DCSC autoDerive.
   *
   * The accepted quantities and price come from the server response — we do
   * not store a local selection unless DCSC confirmed it.
   */
  async configurePdu(
    sessionHandle: string,
    rackId: string,
    opts: {
      pduCode?: string | undefined;
      cordCode?: string | undefined;
      quantity?: number | undefined;
      ctx: RequestCtx;
    },
  ): Promise<{
    rackId: string;
    rackSessionId: string;
    selection: PduSelection;
    selected: ReturnType<typeof selectedPowerLines>;
    totalPrice: number;
    catalog?: PduCatalog | undefined;
  }> {
    const ws = this.sessions.getWorkspace(sessionHandle);
    if (!ws) throw new Error(`Session / Workspace ${sessionHandle} not found`);
    const rackSession = this.sessions.findByConfigurationId(ws.id, rackId);
    if (!rackSession) {
      throw new Error(
        `Rack ${rackId} has no configuration session. Add the rack with dcsc_add_rack first.`,
      );
    }

    const qty = opts.quantity ?? 1;
    const changes: Array<{ section: string; code: string; quantity: number }> = [];
    if (opts.pduCode) {
      changes.push(resolvePowerChange(rackSession.index, opts.pduCode, qty));
    }
    if (opts.cordCode) {
      changes.push(resolvePowerChange(rackSession.index, opts.cordCode, qty));
    }

    if (changes.length === 0) {
      const { catalog } = this.pduCatalog(sessionHandle, rackId);
      return {
        rackId,
        rackSessionId: rackSession.id,
        selection: { rackId },
        selected: selectedPowerLines(rackSession.index),
        totalPrice: rackSession.raw.totalPrice ?? 0,
        catalog,
      };
    }

    const updated = await this.configure(rackSession, changes, opts.ctx);
    const selected = selectedPowerLines(updated.index);
    const pduLine = selected.find((s) => s.section.toUpperCase() === 'PDU');
    const cordLine = selected.find(
      (s) =>
        s.section.toUpperCase() === 'LINECORD' || s.section.toUpperCase() === 'RACK_POWERCABLE',
    );
    const selection = this.sessions.setPowerSelection(ws.id, {
      rackId,
      ...(pduLine ? { pduCode: pduLine.code } : opts.pduCode ? { pduCode: opts.pduCode } : {}),
      ...(cordLine ? { cordCode: cordLine.code } : opts.cordCode ? { cordCode: opts.cordCode } : {}),
    });
    this.persist();

    // Did DCSC actually take the request?
    for (const ch of changes) {
      if (ch.quantity <= 0) continue;
      const got = updated.index.selected.get(ch.code) ?? 0;
      if (got < ch.quantity) {
        throw new Error(
          `DCSC did not accept ${ch.code} x${ch.quantity} on the rack (selected quantity is ${got}). ` +
            'Check min/max with dcsc_configure_pdu without a code, or dcsc_list_options on the rack session.',
        );
      }
    }

    return {
      rackId,
      rackSessionId: updated.id,
      selection,
      selected,
      totalPrice: updated.raw.totalPrice ?? 0,
    };
  }

  /**
   * Imports a CFXML through DCSC's own import endpoint.
   *
   * This deliberately posts the file to /multiple/cfxml_import rather than
   * parsing it locally and re-launching each product code. Launch does not
   * enforce slice membership, so a local replay happily "imports" a CFXML that
   * the real DCSC rejects — a config whose declared solution mode does not
   * contain the model comes back from launch fully priced, while the genuine
   * import drops it as a missing part. Only the server can tell us that, so we
   * ask it, and surface whatever it reports.
   *
   * Whether a model imports at all is decided by the solution mode of *this
   * request*, not by the file: DCSC resolves each product against the mode's
   * catalog. The same CFXML for a General-Purpose-only model (SR685a V3, say)
   * imports cleanly under "General Purpose" and is rejected outright under
   * "HPC and AI - Systems". Callers who know better can override the mode.
   */
  async importConfig(opts: {
    content: string;
    ctx: RequestCtx;
    mode?: ConfigMode;
    workspaceId?: string;
    fileName?: string;
    solutionMode?: string;
  }): Promise<ImportResult> {
    // Parsed locally only to recover the declared solution mode for the query
    // preamble, and to fail fast on a file that is not CFXML at all. Note that
    // DCSC stamps "General Purpose" into every export's Configuration Type
    // regardless of the mode it was built in, so this is a weak default.
    const parsed = parseCfxml(opts.content);
    const solution = await this.resolveSolution(opts.ctx, opts.solutionMode ?? parsed.solutionMode);

    const res = await this.http.send({
      endpoint: 'cfxml_import',
      method: 'POST',
      path: '/multiple/cfxml_import',
      query: { entranceFlag: 'homePage', serviceCto: true, controlExpressModal: true },
      body: {
        kind: 'multipart',
        parts: [
          {
            name: 'cfxmlFile',
            filename: opts.fileName ?? 'configuration.xml',
            contentType: 'text/xml',
            content: opts.content,
          },
        ],
      },
      responseKind: 'json',
      timeoutClass: 'heavy',
      ctx: { ...opts.ctx, solution },
    });

    // The endpoint answers with a single-element array in every case we have
    // observed, but tolerate a bare object.
    const payload = (Array.isArray(res.raw) ? res.raw[0] : res.raw) as RawImportResponse | undefined;
    if (!payload || typeof payload !== 'object') {
      throw new Error('DCSC returned an unrecognised response to the CFXML import.');
    }

    const diagnostics: ImportDiagnostics = {
      missingParts: toImportParts(payload.missingParts),
      removedParts: toImportParts(payload.removedParts),
      replacedParts: collectReplacedParts(payload.differentPartMap),
      eccnRestricted: payload.eccnRestricted === true,
    };

    const configurations = Array.isArray(payload.configuration) ? payload.configuration : [];

    if (configurations.length === 0) {
      const missing = diagnostics.missingParts.map((p) => p.productCode).join(', ');
      const others = (await this.solutionModes(opts.ctx))
        .map((m) => m.mode)
        .filter((m) => m !== solution.solutionMode);
      throw new Error(
        `DCSC rejected every product in this CFXML${missing ? ` (missing: ${missing})` : ''}. ` +
          `The import ran in solution mode "${solution.solutionMode}"; a model that is not in ` +
          'that mode\'s catalog is dropped even though the file itself is valid. ' +
          (others.length > 0
            ? `Retry with solutionMode set to one of: ${others.join(', ')}.`
            : 'Check that the model is available in this mode.'),
      );
    }

    const reduceMode = (opts.mode ?? 'cto') === 'cto' ? 'cto' : 'lfo';
    const sessions: ConfigSession[] = [];
    let wsId = opts.workspaceId;

    for (const raw of configurations) {
      // DCSC has already assigned the configuration id and fully derived the
      // tree, so no priming round-trip is needed.
      const configurationId = raw.id ?? newConfigurationId(opts.ctx.locale.country);
      const reduced = reduceConfiguration(raw, configurationId, reduceMode, solution.solutionMode);

      const session = this.sessions.create({
        primed: true,
        locale: opts.ctx.locale,
        solution,
        mode: opts.mode ?? 'cto',
        raw,
        configurationId,
        reduced,
        workspaceId: wsId,
      });
      wsId = session.workspaceId;
      sessions.push(session);
    }

    this.persist();
    return { workspaceId: wsId!, sessions, diagnostics };
  }

  validate(sessionHandle: string) {
    const session = this.sessions.get(sessionHandle);
    const workspace = this.sessions.getWorkspace(sessionHandle);
    if (!session && !workspace) throw new Error(`Session / Workspace ${sessionHandle} not found`);

    const targets = workspace ? [...workspace.configurations.values()] : [session!];
    const errors: Array<{ code?: string; message: string; section?: string }> = [];
    const warnings: Array<{ code?: string; message: string; section?: string }> = [];
    const info: Array<{ code?: string; message: string; section?: string }> = [];

    for (const s of targets) {
      const msgs = (s.raw as { expansionMessages?: Array<{ type?: string; text?: string; code?: string; sectionName?: string }> }).expansionMessages ?? [];
      for (const m of msgs) {
        const entry = {
          ...(m.code !== undefined ? { code: m.code } : {}),
          message: m.text ?? String(m),
          ...(m.sectionName !== undefined ? { section: m.sectionName } : {}),
        };
        if (m.type === 'error' || m.type === 'err') errors.push(entry);
        else if (m.type === 'warn' || m.type === 'warning') warnings.push(entry);
        else info.push(entry);
      }
    }

    const headroom = targets.flatMap((s) => projectSummary({
      sessionId: s.id,
      revision: s.revision,
      raw: s.raw,
      index: s.index,
      currency: s.locale.currency,
      country: s.locale.country,
      pricedAt: s.pricedAt,
    }).constraints);

    return {
      sessionHandle,
      workspaceId: workspace?.id ?? session?.workspaceId,
      isValid: errors.length === 0,
      report: {
        errorCount: errors.length,
        warningCount: warnings.length,
        infoCount: info.length,
        errors,
        warnings,
        info,
      },
      headroom,
    };
  }

  diffSessions(sessionHandleA: string, sessionHandleB: string) {
    const sA = this.sessions.get(sessionHandleA);
    const sB = this.sessions.get(sessionHandleB);
    if (!sA || !sB) {
      throw new Error(
        `Both sessions must exist to compare. Found: A (${sA ? 'ok' : 'missing'}), B (${sB ? 'ok' : 'missing'}).`,
      );
    }

    const diff = diffConfigurations({
      beforeIndex: sA.index,
      afterIndex: sB.index,
      beforeRaw: sA.raw,
      afterRaw: sB.raw,
      currency: sA.locale.currency,
      requested: new Set<string>(),
    });

    return {
      sessionA: sA.id,
      sessionB: sB.id,
      productA: sA.product,
      productB: sB.product,
      ...diff,
    };
  }

  /** Streams the export ZIP to disk and returns where it landed. */
  async exportZip(
    sessionHandle: string,
    opts: { fileTypes: ExportFileType[]; fileName: string; ctx: RequestCtx },
  ): Promise<{
    stream: NodeJS.ReadableStream;
    contentDisposition: string | undefined;
    rackDataOmitted: boolean;
  }> {
    const session = this.sessions.get(sessionHandle);
    const workspace = this.sessions.getWorkspace(sessionHandle);
    if (!session && !workspace) throw new Error(`Session / Workspace ${sessionHandle} not found`);

    const solution = workspace?.solution ?? session!.solution;
    const validationMode = workspace?.validationMode ?? session!.validationMode;
    const isLfo = session ? session.mode !== 'cto' : false;

    const attempt = async (
      includeRacks: boolean,
    ): Promise<{ stream: NodeJS.ReadableStream; contentDisposition: string | undefined }> => {
      // A single configuration sitting in a rack still needs the workspace
      // payload; the single-config form carries no rack data at all.
      const useWorkspace =
        workspace && (workspace.configurations.size > 1 || (includeRacks && workspace.rackArea.length > 0));

      const stripped =
        workspace && !includeRacks ? ({ ...workspace, rackArea: [] } as WorkspaceSession) : workspace;

      const data = useWorkspace
        ? buildExportData({
            workspace: stripped!,
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
        groups: useWorkspace
          ? buildGroups(stripped!)
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
        ctx: { ...opts.ctx, solution },
      });
      return { stream: res.stream, contentDisposition: res.contentDisposition };
    };

    const hasRacks = (workspace?.rackArea.length ?? 0) > 0;
    if (!hasRacks) {
      return { ...(await attempt(false)), rackDataOmitted: false };
    }

    // The export endpoint's rack payload shape is not the one /racks/customize
    // returns, and sending the latter makes it fail outright. Rather than lose
    // the export, fall back to the rack-free payload and say so. The rack
    // layout itself is still valid and readable via dcsc_session_info.
    try {
      return { ...(await attempt(true)), rackDataOmitted: false };
    } catch (err) {
      logger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Export with rack data was rejected; retrying without it',
      );
      return { ...(await attempt(false)), rackDataOmitted: true };
    }
  }

  async close(): Promise<void> {
    await this.http.close();
  }
}
