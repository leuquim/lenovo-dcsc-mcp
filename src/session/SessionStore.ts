import { hardwareModeFamily } from '../domain/modeFamily.js';
import { ulid } from 'ulid';
import { isDeepStrictEqual } from 'node:util';

import type { ConfigMode } from '../config/constants.js';
import {
  LocaleSchema,
  SolutionContextSchema,
  type Locale,
  type SolutionContext,
} from '../config/schema.js';
import { reduceConfiguration, type ReducedConfiguration } from '../domain/reduce.js';
import { hasUnrepairedRecoveryData } from '../domain/workspaceIntegrity.js';
import { appendActionHistory, type ActionHistoryFactory } from '../domain/actionHistory.js';
import {
  reconcileImportedCloneOwnership,
  type CloneDependency,
} from '../domain/importCloneOwnership.js';
import { detachedNestedNodeIds } from '../domain/nestedPhysical.js';
import {
  canonicalWorkspaceHash,
  RECONCILIATION_HISTORY_STATE_KEY,
  RECONCILIATION_PROPOSALS_STATE_KEY,
  type ReconciliationProposal,
} from '../domain/reconciliation.js';
import type { RackObject, RackSummary } from '../domain/rack.js';
import { managedStorageComponentIds, storagePhysicalTemplateIds } from '../domain/storagePreferences.js';
import {
  saveValidationJob,
  VALIDATION_JOBS_STATE_KEY,
  type ValidationJob,
} from '../domain/validationJobs.js';
import { buildIndex, type ConfigIndex } from '../model/index.js';
import type { RawConfiguration } from '../model/types.js';
import {
  asSessionPersistenceError,
  type PersistenceFailureContext,
} from './persistenceError.js';

export interface ConfigIntent {
  at: number;
  changes: Array<{ section: string; code: string; quantity: number }>;
}

export interface ConfigSession {
  id: string;
  workspaceId: string;
  label?: string | undefined;
  locale: Locale;
  solution: SolutionContext;
  product: { code: string; description: string; type: string };
  mode: ConfigMode;
  validationMode: 'guided' | 'expert';
  /** Independent from guided/expert mode, matching the website checkbox. */
  autoCorrect: boolean;

  raw: RawConfiguration;
  configurationId: string;
  reduced: ReducedConfiguration;
  primed: boolean;
  /** False for preconfigured models: the tree has no sections to change. */
  configurable: boolean;
  index: ConfigIndex;
  revision: number;
  intents: ConfigIntent[];
  snapshots: Array<{ revision: number; raw: RawConfiguration; reduced: ReducedConfiguration }>;
  createdAt: number;
  lastAccessAt: number;
  pricedAt: number;
}

/**
 * Kept for the export payload's benefit only.
 *
 * The authoritative rack state is `WorkspaceSession.rackArea`, which holds the
 * objects DCSC itself returned — see domain/rack.ts for why the layout cannot
 * be modelled locally.
 */
export interface RackPlacement {
  id: string;
  code: string;
  description: string;
  uheight: number;
  position: number;
  items: Array<{
    configId: string;
    code: string;
    position: number;
    height: number;
  }>;
}

export interface CableLink {
  id: string;
  fromConfigId: string;
  fromPort: string;
  toConfigId: string;
  toPort: string;
  cableCode?: string;
  description?: string;
}

export interface FloorItem {
  id: string;
  rackId: string;
  x: number;
  y: number;
}

export interface PduSelection {
  rackId: string;
  pduCode?: string | undefined;
  cordCode?: string | undefined;
  voltage?: string | undefined;
}

export interface WorkspaceHistoryEntry {
  revision: number;
  /** JSON-safe canonical workspace state; derived configuration views are omitted. */
  state: Record<string, unknown>;
}

export interface WorkspaceHistory {
  undo: WorkspaceHistoryEntry[];
  redo: WorkspaceHistoryEntry[];
}

export interface WorkspaceSession {
  id: string;
  label?: string | undefined;
  locale: Locale;
  solution: SolutionContext;
  validationMode: 'guided' | 'expert';
  configurations: Map<string, ConfigSession>;
  racks: Map<string, RackPlacement>;
  /** DCSC's own rackArea objects, re-posted verbatim on every mutation. */
  rackArea: RackObject[];
  /** DCSC objects currently outside a physical rack. */
  nonRackArea: RackObject[];
  /** Lossless original import/export envelope and client-held workspace metadata. */
  serverState: Record<string, unknown>;
  /** Reduced view of the last layout DCSC validated. */
  rackSummaries: RackSummary[];
  cables: CableLink[];
  floorItems: FloorItem[];
  powerSelections: PduSelection[];
  integrity: 'verified' | 'legacy-unverified' | 'damaged';
  integrityWarnings: string[];
  recoveryData?: unknown[] | undefined;
  history?: WorkspaceHistory | undefined;
  revision: number;
  createdAt: number;
  lastAccessAt: number;
  pricedAt: number;
}

/** Serialises work per session/workspace; concurrent mutations would silently lose one. */
class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Resolves after every operation that was queued before this call. */
  drain(): Promise<void> {
    return this.#tail.then(() => undefined);
  }
}

export interface CreateSessionInput {
  locale: Locale;
  solution: SolutionContext;
  mode: ConfigMode;
  validationMode?: 'guided' | 'expert';
  autoCorrect?: boolean | undefined;
  raw: RawConfiguration;
  configurationId: string;
  reduced: ReducedConfiguration;
  primed: boolean;
  configurable?: boolean | undefined;
  label?: string | undefined;
  workspaceId?: string | undefined;
}

export interface WorkspaceStateInput {
  label?: string | undefined;
  validationMode?: 'guided' | 'expert' | undefined;
  racks?: ReadonlyMap<string, RackPlacement> | undefined;
  rackArea?: RackObject[] | undefined;
  nonRackArea?: RackObject[] | undefined;
  serverState?: Record<string, unknown> | undefined;
  rackSummaries?: RackSummary[] | undefined;
  cables?: CableLink[] | undefined;
  floorItems?: FloorItem[] | undefined;
  powerSelections?: PduSelection[] | undefined;
  integrity?: WorkspaceSession['integrity'] | undefined;
  integrityWarnings?: string[] | undefined;
  recoveryData?: unknown[] | undefined;
}

export interface AtomicCreateOptions {
  /** Native edit records derived from the accepted detached candidate. */
  actionHistory?: ActionHistoryFactory | undefined;
  /** Existing workspace or configuration handle to join. */
  workspaceHandle?: string | undefined;
  /** Optional stable handle for a new workspace. Invalid with workspaceHandle. */
  newWorkspaceId?: string | undefined;
  expectedRevision?: number | undefined;
  /** Set after an upstream side effect has succeeded but before local commit. */
  remoteApplied?: boolean | undefined;
  /** Diagnostics to attach if durable publication fails after prepare succeeds. */
  persistenceFailure?: Omit<PersistenceFailureContext, 'remoteApplied'> | undefined;
  /** Required when creating a new workspace without configuration products. */
  workspaceContext?: {
    locale: Locale;
    solution: SolutionContext;
    validationMode?: 'guided' | 'expert' | undefined;
    label?: string | undefined;
  } | undefined;
  workspaceState?: WorkspaceStateInput | undefined;
  /** Runs against the detached complete candidate before validation/persistence. */
  prepare?: (
    draftWorkspace: WorkspaceSession,
    createdSessions: ConfigSession[],
  ) => void | Promise<void>;
}

export interface AtomicCreateResult {
  workspace: WorkspaceSession;
  sessions: ConfigSession[];
}

export interface TransactionOptions {
  /** Native edit records for a committed action; incompatible with history restoration. */
  actionHistory?: ActionHistoryFactory | undefined;
  /** Configuration revision for configuration handles; workspace revision otherwise. */
  expectedRevision?: number | undefined;
  /** `restore` preserves history edited by undo/redo callbacks. */
  history?: 'record' | 'restore' | undefined;
  /** Retains an empty workspace for standalone state or workspace undo/redo. */
  keepEmptyWorkspace?: boolean | undefined;
  /** Set when the callback's upstream side effect succeeded before local commit. */
  remoteApplied?: boolean | undefined;
  /** Diagnostics to attach if durable publication fails after the callback succeeds. */
  persistenceFailure?: Omit<PersistenceFailureContext, 'remoteApplied'> | undefined;
}

export type PersistenceWriter = (
  candidateWorkspaces: readonly WorkspaceSession[],
) => void | Promise<void>;

export class SessionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
    readonly scope: 'configuration' | 'workspace',
  ) {
    super(
      `Revision conflict for ${scope}: expected ${expectedRevision}, current ${actualRevision}`,
    );
    this.name = 'SessionConflictError';
  }
}

export interface RestoreReport {
  restored: number;
  warnings: string[];
  quarantined: unknown[];
  /** Workspaces dropped to enforce the configured in-memory capacity. */
  evictedWorkspaceIds: string[];
  /** True when this load discarded or rewrote source records. */
  normalizationRequired: boolean;
  /** Lossless canonical migrations that are safe to archive and rewrite durably. */
  canonicalRewriteReasons: string[];
  /** Immutable byte-for-byte source snapshots retained for manual recovery. */
  recoveryArchives: RestoreRecoveryArchive[];
}

export interface RestoreRecoveryArchive {
  /** Opaque identifier accepted by the persistence recovery reader. */
  id: string;
  sha256: string;
  bytes: number;
  createdAt: number;
  reason: string;
}

export interface RestoreDiagnostics {
  warnings?: string[] | undefined;
  quarantined?: unknown[] | undefined;
  recoveryArchives?: RestoreRecoveryArchive[] | undefined;
}

export const CLONE_OWNERSHIP_RECOVERY_STATE_KEY = 'unresolvedCloneOwnership';

export class SessionStore {
  readonly #workspaces = new Map<string, WorkspaceSession>();
  readonly #sessions = new Map<string, ConfigSession>();
  readonly #mutexes = new Map<string, Mutex>();
  readonly #persistenceMutex = new Mutex();
  #persistenceWriter: PersistenceWriter | undefined;
  #lastRestoreReport: RestoreReport = {
    restored: 0,
    warnings: [],
    quarantined: [],
    evictedWorkspaceIds: [],
    normalizationRequired: false,
    canonicalRewriteReasons: [],
    recoveryArchives: [],
  };

  constructor(private readonly maxSessions = 20) {}

  setPersistenceWriter(writer: PersistenceWriter | undefined): void {
    this.#persistenceWriter = writer;
  }

  get lastRestoreReport(): RestoreReport {
    return structuredClone(this.#lastRestoreReport);
  }

  /** Adds persistence-layer diagnostics that can occur before workspace restore. */
  recordRestoreDiagnostics(diagnostics: RestoreDiagnostics): void {
    const warnings = diagnostics.warnings ?? [];
    const quarantined = diagnostics.quarantined ?? [];
    const archives = diagnostics.recoveryArchives ?? [];
    this.#lastRestoreReport.warnings = [...new Set([
      ...this.#lastRestoreReport.warnings,
      ...warnings,
    ])];
    this.#lastRestoreReport.quarantined.push(...structuredClone(quarantined));
    const byId = new Map(
      this.#lastRestoreReport.recoveryArchives.map((archive) => [archive.id, archive]),
    );
    for (const archive of archives) byId.set(archive.id, structuredClone(archive));
    this.#lastRestoreReport.recoveryArchives = [...byId.values()].sort(
      (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
    );
  }

  create(input: CreateSessionInput): ConfigSession {
    const code = firstNonempty(
      input.reduced.lfoCode,
      input.raw.sliceCtoCode,
      input.reduced.sliceCtoCode,
    );
    if (!code) throw new Error('A non-empty product code is required');
    const configurationId = input.configurationId.trim();
    if (!configurationId) throw new Error('A non-empty configuration id is required');
    const canonicalRaw = structuredClone(input.raw);
    canonicalRaw.id = configurationId;
    const canonicalReduced = reduceConfiguration(
      canonicalRaw,
      configurationId,
      reducedMode(input.mode),
      input.solution.solutionMode,
    );
    const configId = `sess_${code}_${ulid().slice(-6).toLowerCase()}`;
    const now = Date.now();

    let workspace: WorkspaceSession;
    const existing = input.workspaceId
      ? this.#resolveHandleWithoutTouch(input.workspaceId)?.workspace
      : undefined;
    if (input.workspaceId && !existing) {
      throw new Error(`Workspace ${input.workspaceId} not found`);
    }
    if (existing) {
      if (!isDeepStrictEqual(existing.locale, input.locale)) {
        throw new Error(`Configuration locale does not match workspace ${existing.id}`);
      }
      if (!isDeepStrictEqual(existing.solution, input.solution)) {
        throw new Error(`Configuration solution does not match workspace ${existing.id}`);
      }
      workspace = existing;
    } else {
      if (this.#persistenceWriter && this.#workspaces.size >= this.maxSessions) {
        throw new Error(
          `Session capacity ${this.maxSessions} reached; use createAtomic for durable eviction`,
        );
      }
      const wsId = input.workspaceId ?? `ws_${ulid().slice(-8).toLowerCase()}`;
      workspace = {
        id: wsId,
        ...(input.label !== undefined ? { label: input.label } : {}),
        locale: input.locale,
        solution: input.solution,
        validationMode: input.validationMode ?? 'guided',
        configurations: new Map(),
        racks: new Map(),
        rackArea: [],
        nonRackArea: [],
        serverState: {},
        rackSummaries: [],
        cables: [],
        floorItems: [],
        powerSelections: [],
        integrity: 'verified',
        integrityWarnings: [],
        history: { undo: [], redo: [] },
        revision: 1,
        createdAt: now,
        lastAccessAt: now,
        pricedAt: now,
      };
      this.#workspaces.set(wsId, workspace);
    }

    const session: ConfigSession = {
      id: configId,
      workspaceId: workspace.id,
      ...(input.label !== undefined ? { label: input.label } : {}),
      locale: input.locale,
      solution: input.solution,
      product: {
        code,
        description: input.raw.description ?? '',
        type: input.raw.type ?? 'unknown',
      },
      mode: input.mode,
      validationMode: input.validationMode ?? 'guided',
      autoCorrect: input.validationMode === 'expert' ? false : input.autoCorrect ?? true,
      raw: canonicalRaw,
      configurationId,
      reduced: canonicalReduced,
      primed: input.primed,
      configurable: input.configurable ?? true,
      index: buildIndex(canonicalRaw),
      revision: 1,
      intents: [],
      snapshots: [],
      createdAt: now,
      lastAccessAt: now,
      pricedAt: now,
    };

    workspace.configurations.set(configId, session);
    workspace.lastAccessAt = now;
    this.#sessions.set(configId, session);

    this.#evictIfNeeded();
    return session;
  }

  /** Creates one session and returns its live reference only after persistence. */
  async createAtomic(input: CreateSessionInput): Promise<ConfigSession> {
    const result = await this.createManyAtomic([input], {
      ...(input.workspaceId !== undefined ? { workspaceHandle: input.workspaceId } : {}),
    });
    const session = result.sessions[0];
    if (!session) throw new Error('Atomic creation did not publish a configuration');
    return session;
  }

  /**
   * Atomically creates an imported/configured batch in a new or existing workspace.
   * The optional prepare hook can perform remote layout work against the detached
   * complete candidate; any exception discards the whole batch.
   */
  async createManyAtomic(
    inputs: readonly CreateSessionInput[],
    options: AtomicCreateOptions = {},
  ): Promise<AtomicCreateResult> {
    if (options.workspaceHandle && options.newWorkspaceId) {
      throw new Error('workspaceHandle and newWorkspaceId are mutually exclusive');
    }

    const inputHandles = new Set(
      inputs.flatMap((input) => (input.workspaceId === undefined ? [] : [input.workspaceId])),
    );
    if (inputHandles.size > 1) throw new Error('All configurations must target one workspace');
    const implicitHandle = [...inputHandles][0];
    if (
      options.workspaceHandle !== undefined &&
      implicitHandle !== undefined &&
      options.workspaceHandle !== implicitHandle
    ) {
      throw new Error('Conflicting workspace handles in atomic creation request');
    }
    const workspaceHandle = options.workspaceHandle ?? implicitHandle;

    if (workspaceHandle) {
      const createdIds: string[] = [];
      await this.transact(
        workspaceHandle,
        {
          expectedRevision: options.expectedRevision,
          keepEmptyWorkspace: true,
          remoteApplied: options.remoteApplied,
          persistenceFailure: options.persistenceFailure,
          actionHistory: options.actionHistory,
        },
        async (draft) => {
          applyWorkspaceState(draft, options.workspaceState);
          const created = inputs.map((input) => buildConfigSession(input, draft.id));
          assertBatchCanJoin(draft, created);
          for (const session of created) {
            draft.configurations.set(session.id, session);
            createdIds.push(session.id);
          }
          await options.prepare?.(draft, created);
          assertPreparedBatchPresent(draft, created);
          validateKnownReferences(draft);
        },
      );
      const workspace = this.#resolveHandleWithoutTouch(workspaceHandle)?.workspace;
      if (!workspace) throw new Error(`Workspace ${workspaceHandle} was removed during creation`);
      const sessions = createdIds.map((id) => {
        const session = this.#sessions.get(id);
        if (!session) throw new Error(`Configuration ${id} was not published`);
        return session;
      });
      return { workspace, sessions };
    }

    const workspaceId = normalizeNewWorkspaceId(options.newWorkspaceId);
    let mutex = this.#mutexes.get(workspaceId);
    if (!mutex) {
      mutex = new Mutex();
      this.#mutexes.set(workspaceId, mutex);
    }
    return mutex.run(async () => {
      if (this.#workspaces.has(workspaceId)) {
        throw new Error(`Workspace ${workspaceId} already exists`);
      }
      const context = inputs[0] ?? options.workspaceContext;
      if (!context) {
        throw new Error('workspaceContext is required for a workspace without configurations');
      }
      const now = Date.now();
      const draft = buildEmptyWorkspace(workspaceId, context, now);
      applyWorkspaceState(draft, options.workspaceState);
      const created = inputs.map((input) => buildConfigSession(input, workspaceId, now));
      assertBatchCanJoin(draft, created);
      for (const session of created) draft.configurations.set(session.id, session);
      await options.prepare?.(draft, created);
      if (draft.id !== workspaceId) throw new Error('Prepare callback cannot change workspace id');
      assertPreparedBatchPresent(draft, created);

      const emptyOriginal = buildEmptyWorkspace(workspaceId, context, now);
      emptyOriginal.revision = 0;
      if (options.actionHistory) {
        appendActionHistory(emptyOriginal, draft, options.actionHistory(emptyOriginal, draft));
      }
      this.#finalizeDraft(emptyOriginal, draft, 'restore');
      validateKnownReferences(draft);

      return this.#withAllWorkspaceLocks(workspaceId, () =>
        this.#persistenceMutex.run(async () => {
          if (this.#workspaces.has(workspaceId)) {
            throw new Error(`Workspace ${workspaceId} already exists`);
          }
          const ordered = [...this.#workspaces.values()].sort(
            (a, b) => a.lastAccessAt - b.lastAccessAt || a.id.localeCompare(b.id),
          );
          const excess = Math.max(0, ordered.length + 1 - this.maxSessions);
          const evictedIds = new Set(ordered.slice(0, excess).map((workspace) => workspace.id));
          const candidate = [
            ...ordered
              .filter((workspace) => !evictedIds.has(workspace.id))
              .map((workspace) => cloneWorkspace(workspace)),
            draft,
          ];
          await this.#persistCandidate(candidate, {
            ...options.persistenceFailure,
            remoteApplied: options.remoteApplied,
          });
          for (const evictedId of evictedIds) this.#removeWorkspaceInMemory(evictedId);
          this.#workspaces.set(workspaceId, draft);
          for (const session of created) this.#sessions.set(session.id, session);
          return { workspace: draft, sessions: created };
        }),
      );
    });
  }

  async undoWorkspace(handle: string, expectedRevision?: number): Promise<boolean> {
    return this.transact(
      handle,
      { expectedRevision, history: 'restore', keepEmptyWorkspace: true },
      (draft) => restoreWorkspaceHistory(draft, 'undo'),
    );
  }

  async redoWorkspace(handle: string, expectedRevision?: number): Promise<boolean> {
    return this.transact(
      handle,
      { expectedRevision, history: 'restore', keepEmptyWorkspace: true },
      (draft) => restoreWorkspaceHistory(draft, 'redo'),
    );
  }

  get(id: string): ConfigSession | undefined {
    const s = this.#sessions.get(id);
    if (s) {
      s.lastAccessAt = Date.now();
      const ws = this.#workspaces.get(s.workspaceId);
      if (ws) ws.lastAccessAt = Date.now();
      return s;
    }
    // If passed a workspaceId directly, return its first configuration if available
    const ws = this.#workspaces.get(id);
    if (ws) {
      ws.lastAccessAt = Date.now();
      return [...ws.configurations.values()][0];
    }
    return undefined;
  }

  /**
   * Distinguishes "the caller named a workspace" from "the caller named one
   * configuration that happens to live in a workspace".
   *
   * `get` and `getWorkspace` both accept either kind of id and quietly widen or
   * narrow, which is convenient for reads and wrong for export: asking to
   * export one node in a seven-product workspace used to export all seven.
   * Anything that acts on a scope must resolve the handle here first.
   */
  resolveHandle(
    id: string,
  ):
    | { kind: 'workspace'; workspace: WorkspaceSession; session: ConfigSession | undefined }
    | { kind: 'configuration'; session: ConfigSession; workspace: WorkspaceSession | undefined }
    | undefined {
    const ws = this.#workspaces.get(id);
    if (ws) {
      ws.lastAccessAt = Date.now();
      return { kind: 'workspace', workspace: ws, session: [...ws.configurations.values()][0] };
    }
    const s = this.#sessions.get(id);
    if (s) {
      s.lastAccessAt = Date.now();
      const parent = this.#workspaces.get(s.workspaceId);
      if (parent) parent.lastAccessAt = Date.now();
      return { kind: 'configuration', session: s, workspace: parent };
    }
    return undefined;
  }

  getWorkspace(id: string): WorkspaceSession | undefined {
    // Can lookup by workspaceId or configId
    const ws = this.#workspaces.get(id);
    if (ws) {
      ws.lastAccessAt = Date.now();
      return ws;
    }
    const s = this.#sessions.get(id);
    if (s) {
      const parent = this.#workspaces.get(s.workspaceId);
      if (parent) {
        parent.lastAccessAt = Date.now();
        return parent;
      }
    }
    return undefined;
  }

  list(): ConfigSession[] {
    return [...this.#sessions.values()].sort((a, b) => b.lastAccessAt - a.lastAccessAt);
  }

  listWorkspaces(): WorkspaceSession[] {
    return [...this.#workspaces.values()].sort((a, b) => b.lastAccessAt - a.lastAccessAt);
  }

  delete(id: string): boolean {
    this.#mutexes.delete(id);
    const s = this.#sessions.get(id);
    if (s) {
      const ws = this.#workspaces.get(s.workspaceId);
      if (ws) {
        ws.configurations.delete(id);
        if (ws.configurations.size === 0) {
          this.#workspaces.delete(ws.id);
        }
      }
      return this.#sessions.delete(id);
    }
    const ws = this.#workspaces.get(id);
    if (ws) {
      for (const configId of ws.configurations.keys()) {
        this.#sessions.delete(configId);
      }
      return this.#workspaces.delete(id);
    }
    return false;
  }

  /**
   * Durably removes an entire workspace, including every configuration handle.
   * Publication happens only after the complete replacement snapshot succeeds.
   */
  deleteWorkspace(
    handle: string,
    expectedRevision?: number,
    persistenceFailure?: PersistenceFailureContext,
  ): Promise<boolean> {
    const resolved = this.#resolveHandleWithoutTouch(handle);
    if (!resolved?.workspace) return Promise.resolve(false);
    const workspaceId = resolved.workspace.id;
    let mutex = this.#mutexes.get(workspaceId);
    if (!mutex) {
      mutex = new Mutex();
      this.#mutexes.set(workspaceId, mutex);
    }

    return mutex.run(async () => {
      const current = this.#resolveHandleWithoutTouch(handle);
      if (!current?.workspace || current.workspace.id !== workspaceId) return false;
      if (
        expectedRevision !== undefined &&
        current.workspace.revision !== expectedRevision
      ) {
        throw new SessionConflictError(
          expectedRevision,
          current.workspace.revision,
          'workspace',
        );
      }

      await this.#persistenceMutex.run(async () => {
        const candidate = [...this.#workspaces.values()]
          .filter((workspace) => workspace.id !== workspaceId)
          .map((workspace) => cloneWorkspace(workspace));
        await this.#persistCandidate(candidate, persistenceFailure);
        this.#removeWorkspaceInMemory(workspaceId);
      });
      return true;
    });
  }

  /** Waits for queued workspace mutations and complete-snapshot writes. */
  async drain(): Promise<void> {
    // Service shutdown stops admitting requests before calling this method. The
    // second pass covers a workspace operation that entered while the first
    // set of mutex tails was being collected.
    await Promise.all([...this.#mutexes.values()].map((mutex) => mutex.drain()));
    await this.#persistenceMutex.drain();
    await Promise.all([...this.#mutexes.values()].map((mutex) => mutex.drain()));
    await this.#persistenceMutex.drain();
  }

  /** All mutations for a session or workspace serialise through here. */
  withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const ws = this.getWorkspace(id);
    const lockId = ws?.id ?? id;
    let mutex = this.#mutexes.get(lockId);
    if (!mutex) {
      mutex = new Mutex();
      this.#mutexes.set(lockId, mutex);
    }
    return mutex.run(fn);
  }

  /**
   * Applies one workspace mutation atomically.
   *
   * The callback only sees detached data. A durable writer, when configured,
   * receives the complete candidate store before any live object is changed.
   * This keeps callback, validation and filesystem failures invisible to
   * readers while retaining the object references held by legacy callers.
   */
  transact<T>(
    handle: string,
    options: TransactionOptions,
    fn: (draftWorkspace: WorkspaceSession, targetSession?: ConfigSession) => T | Promise<T>,
  ): Promise<T> {
    if (options.history === 'restore' && options.actionHistory) {
      return Promise.reject(new Error('History restoration cannot append action history'));
    }
    const resolved = this.#resolveHandleWithoutTouch(handle);
    if (!resolved?.workspace) {
      return Promise.reject(new Error(`Session or workspace ${handle} not found`));
    }
    const workspaceId = resolved.workspace.id;
    let mutex = this.#mutexes.get(workspaceId);
    if (!mutex) {
      mutex = new Mutex();
      this.#mutexes.set(workspaceId, mutex);
    }

    return mutex.run(async () => {
      // Resolve again after waiting: another transaction may have deleted or
      // replaced the requested target while this caller was queued.
      const current = this.#resolveHandleWithoutTouch(handle);
      if (!current?.workspace) throw new Error(`Session or workspace ${handle} not found`);
      const liveWorkspace = current.workspace;
      if (liveWorkspace.serverState[CLONE_OWNERSHIP_RECOVERY_STATE_KEY] !== undefined) {
        throw new Error(
          'Clone ownership is unresolved in this recovered workspace. Re-import the complete source CFXML before making changes.',
        );
      }
      const revisionTarget =
        current.kind === 'configuration' ? current.session : current.workspace;
      if (
        options.expectedRevision !== undefined &&
        revisionTarget.revision !== options.expectedRevision
      ) {
        throw new SessionConflictError(
          options.expectedRevision,
          revisionTarget.revision,
          current.kind,
        );
      }

      const draft = cloneWorkspace(liveWorkspace);
      const draftTarget =
        current.kind === 'configuration' ? draft.configurations.get(current.session.id) : undefined;
      const result = await fn(draft, draftTarget);
      preserveOperationalMetadata(liveWorkspace.serverState, draft.serverState);
      if (draft.id !== liveWorkspace.id) {
        throw new Error('Transaction callback cannot change workspace id');
      }
      if (sameWorkspaceCanonicalState(liveWorkspace, draft)) return result;
      if (options.actionHistory) {
        appendActionHistory(liveWorkspace, draft, options.actionHistory(liveWorkspace, draft));
      }
      this.#finalizeDraft(liveWorkspace, draft, options.history ?? 'record');

      const keepEmptyWorkspace = options.keepEmptyWorkspace === true ||
        draft.serverState.standaloneSoftwareState !== undefined ||
        draft.serverState.standaloneServiceState !== undefined;
      await this.#persistenceMutex.run(async () => {
        const candidate = [...this.#workspaces.values()]
          .filter(
            (workspace) =>
              workspace.id !== draft.id ||
              draft.configurations.size > 0 ||
              keepEmptyWorkspace,
          )
          .map((workspace) => (workspace.id === draft.id ? draft : cloneWorkspace(workspace)));
        await this.#persistCandidate(candidate, {
          ...options.persistenceFailure,
          remoteApplied: options.remoteApplied,
        });
        this.#publishWorkspace(liveWorkspace, draft, keepEmptyWorkspace);
      });

      return result;
    });
  }

  /**
   * Durably records validation metadata without changing canonical revisions,
   * undo history, access timestamps, or configuration object identities.
   */
  recordValidationJob(
    handle: string,
    job: ValidationJob,
    persistenceFailure?: PersistenceFailureContext,
  ): Promise<void> {
    const resolved = this.#resolveHandleWithoutTouch(handle);
    if (!resolved?.workspace) {
      return Promise.reject(new Error(`Session or workspace ${handle} not found`));
    }
    const workspaceId = resolved.workspace.id;
    let mutex = this.#mutexes.get(workspaceId);
    if (!mutex) {
      mutex = new Mutex();
      this.#mutexes.set(workspaceId, mutex);
    }

    return mutex.run(async () => {
      const current = this.#resolveHandleWithoutTouch(handle);
      if (!current?.workspace || current.workspace.id !== workspaceId) {
        throw new Error(`Session or workspace ${handle} not found`);
      }
      const liveWorkspace = current.workspace;
      const nextServerState = saveValidationJob(liveWorkspace.serverState, job);
      if (isDeepStrictEqual(nextServerState, liveWorkspace.serverState)) return;
      const draft = cloneWorkspace(liveWorkspace);
      draft.serverState = nextServerState;

      await this.#persistenceMutex.run(async () => {
        const candidate = [...this.#workspaces.values()].map((workspace) =>
          workspace.id === workspaceId ? draft : cloneWorkspace(workspace),
        );
        await this.#persistCandidate(candidate, persistenceFailure);
        liveWorkspace.serverState = structuredClone(nextServerState);
      });
    });
  }

  /**
   * Durably records a bounded reconciliation proposal without changing design
   * revisions or undo history. The proposal must still match the exact source
   * after this call has acquired the workspace lock.
   */
  recordReconciliationProposal(
    handle: string,
    proposal: ReconciliationProposal,
    persistenceFailure?: PersistenceFailureContext,
  ): Promise<void> {
    const resolved = this.#resolveHandleWithoutTouch(handle);
    if (!resolved?.workspace) {
      return Promise.reject(new Error(`Session or workspace ${handle} not found`));
    }
    const workspaceId = resolved.workspace.id;
    let mutex = this.#mutexes.get(workspaceId);
    if (!mutex) {
      mutex = new Mutex();
      this.#mutexes.set(workspaceId, mutex);
    }

    return mutex.run(async () => {
      const current = this.#resolveHandleWithoutTouch(handle);
      if (!current?.workspace || current.workspace.id !== workspaceId) {
        throw new Error(`Session or workspace ${handle} not found`);
      }
      const liveWorkspace = current.workspace;
      if (
        proposal.version !== 1 ||
        typeof proposal.id !== 'string' ||
        proposal.id.trim().length === 0 ||
        !Number.isFinite(proposal.createdAt)
      ) {
        throw new Error('Reconciliation proposal envelope is invalid');
      }
      if (proposal.workspaceId !== workspaceId) {
        throw new Error(`Reconciliation proposal belongs to workspace ${proposal.workspaceId}, not ${workspaceId}`);
      }
      if (proposal.sourceRevision !== liveWorkspace.revision) {
        throw new SessionConflictError(
          proposal.sourceRevision,
          liveWorkspace.revision,
          'workspace',
        );
      }
      if (proposal.sourceHash !== canonicalWorkspaceHash(liveWorkspace)) {
        throw new Error('Reconciliation proposal source does not match the current workspace');
      }

      const nextServerState = saveReconciliationProposal(liveWorkspace.serverState, proposal);
      if (isDeepStrictEqual(nextServerState, liveWorkspace.serverState)) return;
      const draft = cloneWorkspace(liveWorkspace);
      draft.serverState = nextServerState;

      await this.#persistenceMutex.run(async () => {
        const candidate = [...this.#workspaces.values()].map((workspace) =>
          workspace.id === workspaceId ? draft : cloneWorkspace(workspace),
        );
        await this.#persistCandidate(candidate, persistenceFailure);
        liveWorkspace.serverState = structuredClone(nextServerState);
      });
    });
  }

  /** Commits a new raw payload, bumping the revision and rebuilding the index. */
  commit(
    session: ConfigSession,
    raw: RawConfiguration,
    reduced: ReducedConfiguration,
    intent?: ConfigIntent,
  ): ConfigSession {
    const MAX_SNAPSHOTS = 10;
    session.snapshots.push({
      revision: session.revision,
      raw: structuredClone(session.raw),
      reduced: structuredClone(session.reduced),
    });
    if (session.snapshots.length > MAX_SNAPSHOTS) session.snapshots.shift();

    session.raw = raw;
    session.reduced = reduced;
    session.index = buildIndex(raw);
    session.revision += 1;
    session.pricedAt = Date.now();
    session.lastAccessAt = Date.now();
    if (intent) session.intents.push(intent);

    const ws = this.#workspaces.get(session.workspaceId);
    if (ws) {
      ws.revision += 1;
      ws.pricedAt = Date.now();
      ws.lastAccessAt = Date.now();
    }

    return session;
  }

  /** Restores the previous snapshot. Returns false when there is nothing to undo. */
  undo(session: ConfigSession): boolean {
    const prev = session.snapshots.pop();
    if (!prev) return false;
    session.raw = prev.raw;
    session.reduced = prev.reduced;
    session.index = buildIndex(prev.raw);
    session.revision += 1;
    session.lastAccessAt = Date.now();
    if (session.intents.length > 0) session.intents.pop();

    const ws = this.#workspaces.get(session.workspaceId);
    if (ws) {
      ws.revision += 1;
      ws.lastAccessAt = Date.now();
    }
    return true;
  }

  addRack(
    workspaceId: string,
    rackCode: string,
    description = 'Rack Enclosure',
    uheight = 42,
    position = 1,
  ): RackPlacement {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) throw new Error(`Workspace ${workspaceId} not found`);
    const rackId = `rack_${ulid().slice(-6).toLowerCase()}`;
    const rack: RackPlacement = {
      id: rackId,
      code: rackCode,
      description,
      uheight,
      position,
      items: [],
    };
    ws.racks.set(rackId, rack);
    ws.lastAccessAt = Date.now();
    return rack;
  }

  placeInRack(
    workspaceId: string,
    configId: string,
    rackId: string,
    uPosition: number,
    height = 1,
  ): boolean {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return false;
    const rack = ws.racks.get(rackId);
    if (!rack) return false;
    const session = ws.configurations.get(configId);
    if (!session) return false;

    // Remove existing placement if any
    for (const r of ws.racks.values()) {
      r.items = r.items.filter((item) => item.configId !== configId);
    }

    rack.items.push({
      configId,
      code: session.product.code,
      position: uPosition,
      height,
    });
    ws.lastAccessAt = Date.now();
    return true;
  }

  /** Replaces the workspace cable list (used after DCSC auto-connect). */
  setCables(workspaceId: string, cables: CableLink[]): void {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) throw new Error(`Workspace ${workspaceId} not found`);
    ws.cables = cables;
    ws.lastAccessAt = Date.now();
  }

  addCabling(workspaceId: string, cable: Omit<CableLink, 'id'>): CableLink {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) throw new Error(`Workspace ${workspaceId} not found`);
    const link: CableLink = {
      id: `cable_${ulid().slice(-6).toLowerCase()}`,
      ...cable,
    };
    ws.cables.push(link);
    ws.lastAccessAt = Date.now();
    return link;
  }

  setFloorItem(workspaceId: string, item: FloorItem): FloorItem {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) throw new Error(`Workspace ${workspaceId} not found`);
    ws.floorItems = ws.floorItems.filter((f) => f.rackId !== item.rackId);
    ws.floorItems.push(item);
    ws.lastAccessAt = Date.now();
    return item;
  }

  /** @deprecated Prefer service.placeOnFloor, which validates the rack exists. */
  placeOnFloor(workspaceId: string, rackId: string, x: number, y: number): FloorItem {
    return this.setFloorItem(workspaceId, {
      id: `floor_${ulid().slice(-6).toLowerCase()}`,
      rackId,
      x,
      y,
    });
  }

  setPowerSelection(workspaceId: string, selection: PduSelection): PduSelection {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) throw new Error(`Workspace ${workspaceId} not found`);
    ws.powerSelections = ws.powerSelections.filter((ps) => ps.rackId !== selection.rackId);
    ws.powerSelections.push(selection);
    ws.lastAccessAt = Date.now();
    return selection;
  }

  /** @deprecated Prefer service.configurePdu, which selects features via DCSC. */
  configurePdu(
    workspaceId: string,
    rackId: string,
    pduSelection: Omit<PduSelection, 'rackId'>,
  ): PduSelection {
    return this.setPowerSelection(workspaceId, { rackId, ...pduSelection });
  }

  /** Finds a configuration in this workspace by DCSC configuration id. */
  findByConfigurationId(workspaceId: string, configurationId: string): ConfigSession | undefined {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return undefined;
    for (const s of ws.configurations.values()) {
      if (s.configurationId === configurationId) return s;
    }
    return undefined;
  }

  #resolveHandleWithoutTouch(
    id: string,
  ):
    | { kind: 'workspace'; workspace: WorkspaceSession }
    | { kind: 'configuration'; session: ConfigSession; workspace: WorkspaceSession | undefined }
    | undefined {
    const workspace = this.#workspaces.get(id);
    if (workspace) return { kind: 'workspace', workspace };
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    return {
      kind: 'configuration',
      session,
      workspace: this.#workspaces.get(session.workspaceId),
    };
  }

  async #persistCandidate(
    candidate: readonly WorkspaceSession[],
    context: PersistenceFailureContext = {},
  ): Promise<void> {
    if (!this.#persistenceWriter) return;
    try {
      await this.#persistenceWriter(candidate);
    } catch (error) {
      throw asSessionPersistenceError(error, context);
    }
  }

  #finalizeDraft(
    original: WorkspaceSession,
    draft: WorkspaceSession,
    history: 'record' | 'restore',
  ): void {
    const now = Date.now();
    const originalSessions = original.configurations;
    const canonicalIds = new Set<string>();
    const originalHistory = original.history ?? { undo: [], redo: [] };
    if (history === 'record') {
      const undo = [...originalHistory.undo];
      undo.push({ revision: original.revision, state: captureWorkspaceHistoryState(original) });
      draft.history = {
        undo: undo.slice(-10),
        redo: [],
      };
    } else {
      draft.history = structuredClone(draft.history ?? originalHistory);
    }

    for (const [id, session] of draft.configurations) {
      if (!id.trim() || id !== id.trim()) throw new Error('Configuration handles must be non-empty and trimmed');
      session.id = id;
      session.workspaceId = draft.id;
      if (!isDeepStrictEqual(session.locale, draft.locale)) {
        throw new Error(`Configuration ${id} locale does not match workspace ${draft.id}`);
      }
      if (!isDeepStrictEqual(session.solution, draft.solution)) {
        throw new Error(`Configuration ${id} solution does not match workspace ${draft.id}`);
      }
      const old = originalSessions.get(id);
      const canonicalRaw = structuredClone(session.raw);
      const configurationId = firstNonempty(session.configurationId);
      if (!configurationId) throw new Error(`Configuration ${id} has no canonical id`);
      if (canonicalIds.has(configurationId)) {
        throw new Error(`Duplicate canonical configuration id ${configurationId}`);
      }
      canonicalIds.add(configurationId);
      session.configurationId = configurationId;
      canonicalRaw.id = configurationId;
      const code = firstNonempty(
        session.product?.code,
        canonicalRaw.sliceCtoCode,
        session.reduced?.lfoCode,
        session.reduced?.sliceCtoCode,
      );
      if (!code) throw new Error(`Configuration ${id} has no product code`);
      session.product = { ...session.product, code };

      const canonicalChanged = old ? !sameConfigCanonicalState(old, session) : true;
      const rawChanged = old ? !isDeepStrictEqual(old.raw, canonicalRaw) : false;
      if (old && rawChanged && history === 'record') {
        session.snapshots = [
          ...old.snapshots,
          {
            revision: old.revision,
            raw: structuredClone(old.raw),
            reduced: structuredClone(old.reduced),
          },
        ].slice(-10);
      } else if (old && history === 'record') {
        session.snapshots = structuredClone(old.snapshots);
      } else {
        session.snapshots = structuredClone(session.snapshots).slice(-10);
      }

      session.raw = canonicalRaw;
      session.reduced = reduceConfiguration(
        canonicalRaw,
        session.configurationId,
        reducedMode(session.mode),
        draft.solution.solutionMode,
      );
      session.index = buildIndex(canonicalRaw);
      session.revision = old ? old.revision + (canonicalChanged ? 1 : 0) : Math.max(1, session.revision);
      session.lastAccessAt = canonicalChanged ? now : (old?.lastAccessAt ?? session.lastAccessAt);
      session.pricedAt = rawChanged ? now : (old?.pricedAt ?? session.pricedAt);
    }

    draft.revision = original.revision + 1;
    draft.createdAt = original.createdAt;
    draft.lastAccessAt = now;
    draft.pricedAt = [...draft.configurations.values()].some(
      (session) => session.pricedAt === now,
    )
      ? now
      : original.pricedAt;
  }

  #publishWorkspace(
    original: WorkspaceSession,
    draft: WorkspaceSession,
    keepEmptyWorkspace: boolean,
  ): void {
    const publishedConfigs = new Map<string, ConfigSession>();
    for (const [id, draftSession] of draft.configurations) {
      const liveSession = original.configurations.get(id);
      if (liveSession) {
        assignConfig(liveSession, draftSession);
        publishedConfigs.set(id, liveSession);
        this.#sessions.set(id, liveSession);
      } else {
        publishedConfigs.set(id, draftSession);
        this.#sessions.set(id, draftSession);
      }
    }
    for (const id of original.configurations.keys()) {
      if (!publishedConfigs.has(id)) this.#sessions.delete(id);
    }
    if (publishedConfigs.size === 0 && !keepEmptyWorkspace) {
      original.configurations = publishedConfigs;
      this.#workspaces.delete(original.id);
      this.#mutexes.delete(original.id);
      return;
    }

    original.label = draft.label;
    original.locale = structuredClone(draft.locale);
    original.solution = structuredClone(draft.solution);
    original.validationMode = draft.validationMode;
    original.configurations = publishedConfigs;
    original.racks = new Map(
      [...draft.racks].map(([id, rack]) => [id, structuredClone(rack)]),
    );
    original.rackArea = structuredClone(draft.rackArea);
    original.nonRackArea = structuredClone(draft.nonRackArea);
    original.serverState = structuredClone(draft.serverState);
    original.rackSummaries = structuredClone(draft.rackSummaries);
    original.cables = structuredClone(draft.cables);
    original.floorItems = structuredClone(draft.floorItems);
    original.powerSelections = structuredClone(draft.powerSelections);
    original.integrity = draft.integrity;
    original.integrityWarnings = [...draft.integrityWarnings];
    original.recoveryData = structuredClone(draft.recoveryData);
    original.history = structuredClone(draft.history);
    original.revision = draft.revision;
    original.createdAt = draft.createdAt;
    original.lastAccessAt = draft.lastAccessAt;
    original.pricedAt = draft.pricedAt;
  }

  /** Rebuilds canonical workspaces while retaining diagnostics for recovery. */
  restore(
    workspaces: unknown[],
    options: { provenance?: 'current' | 'legacy-unverified' } = {},
  ): number {
    const report: RestoreReport = {
      restored: 0,
      warnings: [],
      quarantined: [],
      evictedWorkspaceIds: [],
      normalizationRequired: false,
      canonicalRewriteReasons: [],
      recoveryArchives: [],
    };

    for (const [workspacePosition, entry] of workspaces.entries()) {
      if (typeof entry !== 'object' || entry === null) {
        report.warnings.push(`Workspace ${workspacePosition} is not an object and was quarantined`);
        report.quarantined.push(structuredClone(entry));
        report.normalizationRequired = true;
        continue;
      }
      const w = entry as Record<string, unknown>;
      const id = w['id'];
      const configs = w['configurations'];
      const locale = LocaleSchema.safeParse(w['locale']);
      const solution = SolutionContextSchema.safeParse(w['solution']);
      if (
        typeof id !== 'string' ||
        id.trim().length === 0 ||
        !Array.isArray(configs) ||
        !locale.success ||
        !solution.success
      ) {
        report.warnings.push(`Workspace ${workspacePosition} has an invalid envelope and was quarantined`);
        report.quarantined.push(structuredClone(entry));
        report.normalizationRequired = true;
        continue;
      }
      if (this.#workspaces.has(id.trim())) {
        report.warnings.push(`Duplicate workspace ${id.trim()} was quarantined`);
        report.quarantined.push(structuredClone(entry));
        report.normalizationRequired = true;
        continue;
      }

      const now = Date.now();
      const legacy = options.provenance === 'legacy-unverified';
      const savedIntegrity = w['integrity'];
      const priorRecoveryCount = Array.isArray(w['recoveryData']) ? w['recoveryData'].length : 0;
      const historyWarnings: string[] = [];
      const discardedHistory: unknown[] = [];
      const discardedCanonical: Array<{ warning: string; record: unknown }> = [];
      const restoredHistory = restoreWorkspaceHistoryEnvelope(
        w['history'], historyWarnings, discardedHistory,
      );
      const restoredRacks = restoreRacks(w['racks'], discardedCanonical);
      const ws: WorkspaceSession = {
        id: id.trim(),
        ...(typeof w['label'] === 'string' ? { label: w['label'] } : {}),
        locale: locale.data,
        solution: solution.data,
        validationMode: (w['validationMode'] as 'guided' | 'expert') ?? 'guided',
        configurations: new Map(),
        racks: restoredRacks,
        rackArea: restoreObjectArray<RackObject>(w['rackArea'], 'rackArea', discardedCanonical),
        nonRackArea: restoreObjectArray<RackObject>(w['nonRackArea'], 'nonRackArea', discardedCanonical),
        serverState: normalizeReconciliationProposalMetadata(
          recordOrEmpty(w['serverState']),
          id.trim(),
        ),
        rackSummaries: restoreObjectArray<RackSummary>(w['rackSummaries'], 'rackSummaries', discardedCanonical),
        cables: restoreObjectArray<CableLink>(w['cables'], 'cables', discardedCanonical),
        floorItems: restoreObjectArray<FloorItem>(w['floorItems'], 'floorItems', discardedCanonical),
        powerSelections: restoreObjectArray<PduSelection>(w['powerSelections'], 'powerSelections', discardedCanonical),
        integrity:
          savedIntegrity === 'damaged' || savedIntegrity === 'legacy-unverified'
            ? savedIntegrity
            : legacy
              ? 'legacy-unverified'
              : 'verified',
        integrityWarnings: arrayOrEmpty<string>(w['integrityWarnings']),
        ...((Array.isArray(w['recoveryData']) || discardedHistory.length > 0)
          ? { recoveryData: mergeRecoveryRecords(arrayOrEmpty(w['recoveryData']), discardedHistory) }
          : {}),
        history: restoredHistory,
        revision: typeof w['revision'] === 'number' ? w['revision'] : 1,
        createdAt: typeof w['createdAt'] === 'number' ? w['createdAt'] : now,
        lastAccessAt: typeof w['lastAccessAt'] === 'number' ? w['lastAccessAt'] : now,
        pricedAt: typeof w['pricedAt'] === 'number' ? w['pricedAt'] : now,
      };
      for (const discarded of discardedCanonical) {
        markDamaged(ws, discarded.warning, discarded.record);
      }
      for (const [configPosition, c] of configs.entries()) {
        if (typeof c !== 'object' || c === null) {
          markDamaged(
            ws,
            `Configuration ${configPosition} is not an object and was quarantined`,
            c,
          );
          continue;
        }
        const s = c as Record<string, unknown>;
        const sid = s['id'];
        const raw = s['raw'];
        if (
          typeof sid !== 'string' ||
          sid.trim().length === 0 ||
          typeof raw !== 'object' ||
          raw === null
        ) {
          markDamaged(ws, `Configuration ${configPosition} has no usable identity/raw data`, c);
          continue;
        }

        const canonicalRaw = structuredClone(raw as RawConfiguration);
        const configurationId = firstNonempty(s['configurationId'], canonicalRaw.id);
        const productRecord = recordOrEmpty(s['product']);
        const productCode = firstNonempty(
          productRecord['code'],
          canonicalRaw.lfoCode,
          canonicalRaw.sliceCtoCode,
          canonicalRaw.code,
        );
        if (!configurationId || !productCode) {
          markDamaged(
            ws,
            `Configuration ${sid} has no non-empty configuration/product identity`,
            c,
          );
          continue;
        }
        if (ws.configurations.has(sid.trim()) || this.#sessions.has(sid.trim())) {
          markDamaged(ws, `Duplicate configuration handle ${sid.trim()} was quarantined`, c);
          continue;
        }
        canonicalRaw.id = configurationId;
        const mode = (s['mode'] as ConfigMode) ?? 'cto';
        const reduced = reduceConfiguration(
          canonicalRaw,
          configurationId,
          reducedMode(mode),
          ws.solution.solutionMode,
        );

        const session: ConfigSession = {
          id: sid.trim(),
          workspaceId: ws.id,
          ...(typeof s['label'] === 'string' ? { label: s['label'] } : {}),
          locale: ws.locale,
          solution: ws.solution,
          product: {
            code: productCode,
            description: firstNonempty(productRecord['description'], canonicalRaw.description) ?? '',
            type: firstNonempty(productRecord['type'], canonicalRaw.type) ?? 'unknown',
          },
          mode,
          validationMode: (s['validationMode'] as 'guided' | 'expert') ?? 'guided',
          autoCorrect: s['validationMode'] !== 'expert' && s['autoCorrect'] !== false,
          raw: canonicalRaw,
          configurationId,
          reduced,
          primed: s['primed'] === true,
          configurable: s['configurable'] !== false,
          index: buildIndex(canonicalRaw),
          revision: typeof s['revision'] === 'number' ? s['revision'] : 1,
          intents: (s['intents'] as ConfigIntent[]) ?? [],
          snapshots: restoreSnapshots(s['snapshots'], mode, ws.solution.solutionMode, ws, sid),
          createdAt: typeof s['createdAt'] === 'number' ? s['createdAt'] : now,
          lastAccessAt: typeof s['lastAccessAt'] === 'number' ? s['lastAccessAt'] : now,
          pricedAt: typeof s['pricedAt'] === 'number' ? s['pricedAt'] : now,
        };
        ws.configurations.set(session.id, session);
        this.#sessions.set(session.id, session);
      }

      try {
        const migration = reconcileRestoredCloneOwnership(ws);
        if (migration.changed) {
          ws.serverState.cloneDependency = migration.dependency;
          ws.serverState.cloneDependencyColor = migration.colors;
          report.canonicalRewriteReasons.push(
            `Workspace ${ws.id} restored canonical imported clone ownership.`,
          );
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const warning =
          `Clone ownership could not be restored safely: ${detail} ` +
          'Re-import the complete source CFXML before making changes.';
        const record = {
          kind: 'unresolved-clone-ownership',
          warning,
          cloneDependency: structuredClone(ws.serverState.cloneDependency),
          cloneDependencyColor: structuredClone(ws.serverState.cloneDependencyColor),
          importCloneExpansion: structuredClone(ws.serverState.importCloneExpansion),
        };
        ws.serverState[CLONE_OWNERSHIP_RECOVERY_STATE_KEY] = true;
        markDamaged(ws, warning, record);
      }

      validateKnownReferences(ws);
      if (hasUnrepairedRecoveryData(ws)) {
        ws.integrity = 'damaged';
        const warning = 'Quarantined configuration or layout records require repair or complete CFXML re-import before trusted handoff.';
        if (!ws.integrityWarnings.includes(warning)) ws.integrityWarnings.push(warning);
      }
      const restoredSnapshots = discardInvalidHistorySnapshots(ws);
      historyWarnings.push(...restoredSnapshots.warnings);
      if (restoredSnapshots.migrated > 0) {
        report.canonicalRewriteReasons.push(
          `Workspace ${ws.id} restored canonical clone ownership in ${restoredSnapshots.migrated} history snapshot(s).`,
        );
      }
      ws.integrityWarnings.push(...historyWarnings);
      if ((ws.recoveryData?.length ?? 0) > priorRecoveryCount) {
        report.normalizationRequired = true;
      }

      if (configs.length > 0 && ws.configurations.size === 0) {
        report.warnings.push(`Workspace ${ws.id} contains no usable configurations and was quarantined`);
        report.quarantined.push(structuredClone(entry));
        report.normalizationRequired = true;
        continue;
      }
      if (legacy) {
        ws.integrityWarnings.push(
          'Migrated from v1: omitted state cannot be assumed to represent user intent; reconcile or re-import before quote/validation claims.',
        );
      }
      this.#workspaces.set(ws.id, ws);
      report.restored += 1;
    }

    for (const workspace of this.#workspaces.values()) {
      report.warnings.push(...workspace.integrityWarnings.map((warning) => `${workspace.id}: ${warning}`));
    }
    report.quarantined.push(
      ...[...this.#workspaces.values()].flatMap((workspace) => workspace.recoveryData ?? []),
    );
    report.evictedWorkspaceIds = this.#evictIfNeeded();
    report.restored -= report.evictedWorkspaceIds.length;
    if (report.evictedWorkspaceIds.length > 0) {
      report.normalizationRequired = true;
      report.warnings.push(
        `Evicted ${report.evictedWorkspaceIds.length} workspace(s) to enforce session capacity`,
      );
    }
    this.#lastRestoreReport = report;
    return report.restored;
  }

  #evictIfNeeded(): string[] {
    if (this.#workspaces.size <= this.maxSessions) return [];
    const sorted = [...this.#workspaces.values()].sort(
      (a, b) => a.lastAccessAt - b.lastAccessAt || a.id.localeCompare(b.id),
    );
    const excess = this.#workspaces.size - this.maxSessions;
    const evicted: string[] = [];
    for (let i = 0; i < excess; i += 1) {
      const victim = sorted[i];
      if (victim) {
        this.#removeWorkspaceInMemory(victim.id);
        evicted.push(victim.id);
      }
    }
    return evicted;
  }

  #removeWorkspaceInMemory(workspaceId: string): boolean {
    const workspace = this.#workspaces.get(workspaceId);
    if (!workspace) return false;
    for (const configId of workspace.configurations.keys()) this.#sessions.delete(configId);
    this.#workspaces.delete(workspaceId);
    this.#mutexes.delete(workspaceId);
    return true;
  }

  /**
   * Capacity commits remove existing workspaces, so they must wait for every
   * live workspace mutation before constructing and publishing the snapshot.
   */
  #withAllWorkspaceLocks<T>(excludedId: string, fn: () => Promise<T>): Promise<T> {
    const locked = new Set<string>();
    const acquireNext = (): Promise<T> => {
      const nextId = [...this.#workspaces.keys()]
        .filter((id) => id !== excludedId && !locked.has(id))
        .sort()[0];
      if (!nextId) return fn();
      locked.add(nextId);
      let mutex = this.#mutexes.get(nextId);
      if (!mutex) {
        mutex = new Mutex();
        this.#mutexes.set(nextId, mutex);
      }
      return mutex.run(acquireNext);
    };
    return acquireNext();
  }
}

function firstNonempty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function normalizeNewWorkspaceId(requested: string | undefined): string {
  if (requested === undefined) return `ws_${ulid().slice(-8).toLowerCase()}`;
  const id = requested.trim();
  if (!id || id !== requested) throw new Error('New workspace id must be non-empty and trimmed');
  return id;
}

function buildEmptyWorkspace(
  id: string,
  input: {
    locale: Locale;
    solution: SolutionContext;
    validationMode?: 'guided' | 'expert' | undefined;
    label?: string | undefined;
  },
  now = Date.now(),
): WorkspaceSession {
  return {
    id,
    ...(input.label !== undefined ? { label: input.label } : {}),
    locale: structuredClone(input.locale),
    solution: structuredClone(input.solution),
    validationMode: input.validationMode ?? 'guided',
    configurations: new Map(),
    racks: new Map(),
    rackArea: [],
    nonRackArea: [],
    serverState: {},
    rackSummaries: [],
    cables: [],
    floorItems: [],
    powerSelections: [],
    integrity: 'verified',
    integrityWarnings: [],
    history: { undo: [], redo: [] },
    revision: 1,
    createdAt: now,
    lastAccessAt: now,
    pricedAt: now,
  };
}

/** Adds a validated configuration to a detached transaction candidate only. */
export function stageConfiguration(workspace: WorkspaceSession, input: CreateSessionInput): ConfigSession {
  const session = buildConfigSession(input, workspace.id);
  assertBatchCanJoin(workspace, [session]);
  workspace.configurations.set(session.id, session);
  return session;
}

function buildConfigSession(
  input: CreateSessionInput,
  workspaceId: string,
  now = Date.now(),
): ConfigSession {
  const code = firstNonempty(
    input.reduced.lfoCode,
    input.raw.lfoCode,
    input.raw.sliceCtoCode,
    input.reduced.sliceCtoCode,
  );
  if (!code) throw new Error('A non-empty product code is required');
  const configurationId = input.configurationId.trim();
  if (!configurationId) throw new Error('A non-empty configuration id is required');
  const canonicalRaw = structuredClone(input.raw);
  canonicalRaw.id = configurationId;
  return {
    id: `sess_${code}_${ulid().slice(-6).toLowerCase()}`,
    workspaceId,
    ...(input.label !== undefined ? { label: input.label } : {}),
    locale: structuredClone(input.locale),
    solution: structuredClone(input.solution),
    product: {
      code,
      description: input.raw.description ?? '',
      type: input.raw.type ?? 'unknown',
    },
    mode: input.mode,
    validationMode: input.validationMode ?? 'guided',
    autoCorrect: input.validationMode === 'expert' ? false : input.autoCorrect ?? true,
    raw: canonicalRaw,
    configurationId,
    reduced: reduceConfiguration(
      canonicalRaw,
      configurationId,
      reducedMode(input.mode),
      input.solution.solutionMode,
    ),
    primed: input.primed,
    configurable: input.configurable ?? true,
    index: buildIndex(canonicalRaw),
    revision: 1,
    intents: [],
    snapshots: [],
    createdAt: now,
    lastAccessAt: now,
    pricedAt: now,
  };
}

function assertBatchCanJoin(workspace: WorkspaceSession, sessions: ConfigSession[]): void {
  const handles = new Set(workspace.configurations.keys());
  const canonicalIds = new Set(
    [...workspace.configurations.values()].map((session) => session.configurationId),
  );
  for (const session of sessions) {
    if (!isDeepStrictEqual(workspace.locale, session.locale)) {
      throw new Error(`Configuration ${session.id} locale does not match workspace ${workspace.id}`);
    }
    if (!isDeepStrictEqual(workspace.solution, session.solution)) {
      throw new Error(`Configuration ${session.id} solution does not match workspace ${workspace.id}`);
    }
    if (handles.has(session.id)) throw new Error(`Duplicate configuration handle ${session.id}`);
    if (canonicalIds.has(session.configurationId)) {
      throw new Error(`Duplicate canonical configuration id ${session.configurationId}`);
    }
    handles.add(session.id);
    canonicalIds.add(session.configurationId);
  }
}

function assertPreparedBatchPresent(
  workspace: WorkspaceSession,
  sessions: readonly ConfigSession[],
): void {
  for (const session of sessions) {
    if (workspace.configurations.get(session.id) !== session) {
      throw new Error(`Prepare callback removed or replaced configuration ${session.id}`);
    }
  }
}

function applyWorkspaceState(
  workspace: WorkspaceSession,
  state: WorkspaceStateInput | undefined,
): void {
  if (!state) return;
  if ('label' in state) workspace.label = state.label;
  if (state.validationMode !== undefined) workspace.validationMode = state.validationMode;
  if (state.racks !== undefined) {
    workspace.racks = new Map(
      [...state.racks].map(([id, rack]) => [id, structuredClone(rack)]),
    );
  }
  if (state.rackArea !== undefined) workspace.rackArea = structuredClone(state.rackArea);
  if (state.nonRackArea !== undefined) workspace.nonRackArea = structuredClone(state.nonRackArea);
  if (state.serverState !== undefined) workspace.serverState = structuredClone(state.serverState);
  if (state.rackSummaries !== undefined) {
    workspace.rackSummaries = structuredClone(state.rackSummaries);
  }
  if (state.cables !== undefined) workspace.cables = structuredClone(state.cables);
  if (state.floorItems !== undefined) workspace.floorItems = structuredClone(state.floorItems);
  if (state.powerSelections !== undefined) {
    workspace.powerSelections = structuredClone(state.powerSelections);
  }
  if (state.integrity !== undefined) workspace.integrity = state.integrity;
  if (state.integrityWarnings !== undefined) {
    workspace.integrityWarnings = structuredClone(state.integrityWarnings);
  }
  if ('recoveryData' in state) workspace.recoveryData = structuredClone(state.recoveryData);
}

function captureWorkspaceHistoryState(workspace: WorkspaceSession): Record<string, unknown> {
  return structuredClone({
    label: workspace.label,
    locale: workspace.locale,
    solution: workspace.solution,
    validationMode: workspace.validationMode,
    configurations: [...workspace.configurations.values()].map((session) => ({
      id: session.id,
      label: session.label,
      product: session.product,
      mode: session.mode,
      validationMode: session.validationMode,
      autoCorrect: session.autoCorrect,
      raw: session.raw,
      configurationId: session.configurationId,
      primed: session.primed,
      configurable: session.configurable,
      revision: session.revision,
      intents: session.intents,
      snapshots: session.snapshots.map((snapshot) => ({
        revision: snapshot.revision,
        raw: snapshot.raw,
      })),
      createdAt: session.createdAt,
      lastAccessAt: session.lastAccessAt,
      pricedAt: session.pricedAt,
    })),
    racks: [...workspace.racks.entries()],
    rackArea: workspace.rackArea,
    nonRackArea: workspace.nonRackArea,
    serverState: withoutOperationalMetadata(workspace.serverState),
    rackSummaries: workspace.rackSummaries,
    cables: workspace.cables,
    floorItems: workspace.floorItems,
    powerSelections: workspace.powerSelections,
    integrity: workspace.integrity,
    integrityWarnings: workspace.integrityWarnings,
    recoveryData: workspace.recoveryData,
    createdAt: workspace.createdAt,
    lastAccessAt: workspace.lastAccessAt,
    pricedAt: workspace.pricedAt,
  });
}

function restoreWorkspaceHistory(
  workspace: WorkspaceSession,
  direction: 'undo' | 'redo',
): boolean {
  const history = (workspace.history ??= { undo: [], redo: [] });
  const source = history[direction];
  const entry = source.pop();
  if (!entry) return false;
  const destination = direction === 'undo' ? history.redo : history.undo;
  destination.push({
    revision: workspace.revision,
    state: captureWorkspaceHistoryState(workspace),
  });
  if (destination.length > 10) destination.shift();
  applyWorkspaceHistoryState(workspace, entry.state);
  return true;
}

function applyWorkspaceHistoryState(
  workspace: WorkspaceSession,
  state: Record<string, unknown>,
): void {
  const locale = LocaleSchema.safeParse(state['locale']);
  const solution = SolutionContextSchema.safeParse(state['solution']);
  const configurations = state['configurations'];
  if (!locale.success || !solution.success || !Array.isArray(configurations)) {
    throw new Error('Workspace history snapshot is malformed');
  }

  const restored = new Map<string, ConfigSession>();
  for (const value of configurations) {
    const session = restoreHistoryConfig(value, workspace.id, locale.data, solution.data);
    if (restored.has(session.id)) {
      throw new Error(`Workspace history contains duplicate handle ${session.id}`);
    }
    restored.set(session.id, session);
  }
  workspace.label = typeof state['label'] === 'string' ? state['label'] : undefined;
  workspace.locale = locale.data;
  workspace.solution = solution.data;
  workspace.validationMode = state['validationMode'] === 'expert' ? 'expert' : 'guided';
  workspace.configurations = restored;
  workspace.racks = restoreRacks(state['racks']);
  workspace.rackArea = arrayOrEmpty<RackObject>(state['rackArea']);
  workspace.nonRackArea = arrayOrEmpty<RackObject>(state['nonRackArea']);
  const currentServerState = workspace.serverState;
  workspace.serverState = recordOrEmpty(state['serverState']);
  preserveOperationalMetadata(currentServerState, workspace.serverState);
  workspace.rackSummaries = arrayOrEmpty<RackSummary>(state['rackSummaries']);
  workspace.cables = arrayOrEmpty<CableLink>(state['cables']);
  workspace.floorItems = arrayOrEmpty<FloorItem>(state['floorItems']);
  workspace.powerSelections = arrayOrEmpty<PduSelection>(state['powerSelections']);
  workspace.integrity =
    state['integrity'] === 'legacy-unverified' || state['integrity'] === 'damaged'
      ? state['integrity']
      : 'verified';
  workspace.integrityWarnings = arrayOrEmpty<string>(state['integrityWarnings']);
  workspace.recoveryData = Array.isArray(state['recoveryData'])
    ? structuredClone(state['recoveryData'])
    : undefined;
  validateKnownReferences(workspace);
}

function restoreHistoryConfig(
  value: unknown,
  workspaceId: string,
  locale: Locale,
  solution: SolutionContext,
): ConfigSession {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Workspace history contains a malformed configuration');
  }
  const saved = value as Record<string, unknown>;
  const id = firstNonempty(saved['id']);
  const configurationId = firstNonempty(saved['configurationId']);
  const rawValue = saved['raw'];
  if (!id || !configurationId || typeof rawValue !== 'object' || rawValue === null) {
    throw new Error('Workspace history configuration has no usable identity/raw data');
  }
  const raw = structuredClone(rawValue as RawConfiguration);
  raw.id = configurationId;
  const product = recordOrEmpty(saved['product']);
  const code = firstNonempty(product['code'], raw.lfoCode, raw.sliceCtoCode, raw.code);
  if (!code) throw new Error(`Workspace history configuration ${id} has no product code`);
  const mode = isConfigMode(saved['mode']) ? saved['mode'] : 'cto';
  const snapshots: ConfigSession['snapshots'] = [];
  if (Array.isArray(saved['snapshots'])) {
    for (const value of saved['snapshots']) {
      if (typeof value !== 'object' || value === null) continue;
      const snapshot = value as Record<string, unknown>;
      if (typeof snapshot['revision'] !== 'number') continue;
      if (typeof snapshot['raw'] !== 'object' || snapshot['raw'] === null) continue;
      const snapshotRaw = structuredClone(snapshot['raw'] as RawConfiguration);
      snapshots.push({
        revision: snapshot['revision'],
        raw: snapshotRaw,
        reduced: reduceConfiguration(
          snapshotRaw,
          firstNonempty(snapshotRaw.id, configurationId) ?? configurationId,
          reducedMode(mode),
          solution.solutionMode,
        ),
      });
    }
  }
  return {
    id,
    workspaceId,
    ...(typeof saved['label'] === 'string' ? { label: saved['label'] } : {}),
    locale: structuredClone(locale),
    solution: structuredClone(solution),
    product: {
      code,
      description: firstNonempty(product['description'], raw.description) ?? '',
      type: firstNonempty(product['type'], raw.type) ?? 'unknown',
    },
    mode,
    validationMode: saved['validationMode'] === 'expert' ? 'expert' : 'guided',
    autoCorrect: saved['validationMode'] !== 'expert' && saved['autoCorrect'] !== false,
    raw,
    configurationId,
    reduced: reduceConfiguration(raw, configurationId, reducedMode(mode), solution.solutionMode),
    primed: saved['primed'] === true,
    configurable: saved['configurable'] !== false,
    index: buildIndex(raw),
    revision: typeof saved['revision'] === 'number' ? saved['revision'] : 1,
    intents: arrayOrEmpty<ConfigIntent>(saved['intents']),
    snapshots: snapshots.slice(-10),
    createdAt: typeof saved['createdAt'] === 'number' ? saved['createdAt'] : Date.now(),
    lastAccessAt: typeof saved['lastAccessAt'] === 'number' ? saved['lastAccessAt'] : Date.now(),
    pricedAt: typeof saved['pricedAt'] === 'number' ? saved['pricedAt'] : Date.now(),
  };
}

function restoreWorkspaceHistoryEnvelope(
  value: unknown,
  warnings: string[] = [],
  discarded: unknown[] = [],
): WorkspaceHistory {
  if (value === undefined) return { undo: [], redo: [] };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    const warning = 'Malformed workspace history envelope was discarded';
    warnings.push(warning);
    recordDiscardedHistory(discarded, warning, value);
    return { undo: [], redo: [] };
  }
  const history = value as Record<string, unknown>;
  return {
    undo: restoreHistoryEntries(history['undo'], 'undo', warnings, discarded),
    redo: restoreHistoryEntries(history['redo'], 'redo', warnings, discarded),
  };
}

function restoreHistoryEntries(
  value: unknown,
  direction: 'undo' | 'redo',
  warnings: string[],
  discarded: unknown[],
): WorkspaceHistoryEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    const warning = `Malformed workspace ${direction} history was discarded`;
    warnings.push(warning);
    recordDiscardedHistory(discarded, warning, value);
    return [];
  }
  const restored = value.flatMap((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      const warning = `Malformed workspace ${direction} history entry ${index} was discarded`;
      warnings.push(warning);
      recordDiscardedHistory(discarded, warning, candidate);
      return [];
    }
    const entry = candidate as Record<string, unknown>;
    if (!Number.isSafeInteger(entry['revision']) || (entry['revision'] as number) < 0) {
      const warning = `Malformed workspace ${direction} history entry ${index} was discarded`;
      warnings.push(warning);
      recordDiscardedHistory(discarded, warning, candidate);
      return [];
    }
    if (
      typeof entry['state'] !== 'object' ||
      entry['state'] === null ||
      Array.isArray(entry['state'])
    ) {
      const warning = `Malformed workspace ${direction} history entry ${index} was discarded`;
      warnings.push(warning);
      recordDiscardedHistory(discarded, warning, candidate);
      return [];
    }
    return [
      {
        revision: entry['revision'] as number,
        state: structuredClone(entry['state'] as Record<string, unknown>),
      },
    ];
  });
  if (restored.length > 10) {
    const overflow = restored.slice(0, -10);
    const warning = `Workspace ${direction} history exceeded 10 entries; ${overflow.length} oldest entries were discarded`;
    warnings.push(warning);
    for (const entry of overflow) recordDiscardedHistory(discarded, warning, entry);
  }
  return restored.slice(-10);
}

interface RestoredCloneOwnership {
  dependency: CloneDependency;
  colors: Record<string, unknown>;
  changed: boolean;
}

function cloneOwnershipRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/** Returns a detached canonical graph; callers publish it only after every check succeeds. */
function reconcileRestoredCloneOwnership(workspace: WorkspaceSession): RestoredCloneOwnership {
  const provenance = workspace.serverState.importCloneExpansion;
  if (provenance === undefined) {
    return {
      dependency: workspace.serverState.cloneDependency as CloneDependency,
      colors: (workspace.serverState.cloneDependencyColor ?? {}) as Record<string, unknown>,
      changed: false,
    };
  }
  if (!Array.isArray(provenance)) {
    throw new Error('Imported clone expansion provenance is malformed.');
  }
  const dependency = cloneOwnershipRecord(
    workspace.serverState.cloneDependency,
    'Clone dependency',
  ) as CloneDependency;
  const colors = workspace.serverState.cloneDependencyColor === undefined
    ? {}
    : cloneOwnershipRecord(workspace.serverState.cloneDependencyColor, 'Clone dependency colors');
  const detached = detachedNestedNodeIds(workspace);
  const configurations = [...workspace.configurations.values()].map(session => ({
    configurationId: session.configurationId,
    raw: session.raw,
    mode: session.mode,
    validationMode: session.validationMode,
    autoCorrect: session.autoCorrect,
    configurable: session.configurable,
  }));
  const activeConfigurationIds = new Set(
    configurations.map(configuration => configuration.configurationId)
      .filter(configurationId => !detached.has(configurationId)),
  );
  const storageAliases = storagePhysicalTemplateIds(workspace);
  const storageRoots = new Set([
    ...managedStorageComponentIds(workspace.serverState),
    ...storageAliases.values(),
  ]);
  return reconcileImportedCloneOwnership({
    dependency,
    colors,
    provenance,
    activeConfigurationIds,
    storageRoots,
    storageAliases,
    configurations,
  });
}

/** Removes snapshots that are structurally plausible but cannot be restored safely. */
function discardInvalidHistorySnapshots(
  workspace: WorkspaceSession,
): { warnings: string[]; migrated: number } {
  const warnings: string[] = [];
  let migrated = 0;
  const history = workspace.history;
  if (!history) return { warnings, migrated };
  for (const direction of ['undo', 'redo'] as const) {
    history[direction] = history[direction].flatMap((entry, index) => {
      try {
        const probe = cloneWorkspace(workspace);
        applyWorkspaceHistoryState(probe, entry.state);
        const migration = reconcileRestoredCloneOwnership(probe);
        if (!migration.changed) return [entry];
        const next = structuredClone(entry);
        const nextServerState = cloneOwnershipRecord(
          next.state['serverState'],
          'Workspace history clone state',
        );
        nextServerState.cloneDependency = migration.dependency;
        nextServerState.cloneDependencyColor = migration.colors;
        next.state['serverState'] = nextServerState;
        migrated += 1;
        return [next];
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const warning =
          `Unrestorable workspace ${direction} history entry ${index} was discarded: ${detail}`;
        warnings.push(warning);
        workspace.recoveryData = mergeRecoveryRecords(
          workspace.recoveryData ?? [],
          [{ kind: 'discarded-history', warning, record: structuredClone(entry) }],
        );
        return [];
      }
    });
  }
  return { warnings, migrated };
}

function recordDiscardedHistory(target: unknown[], warning: string, record: unknown): void {
  const value = { kind: 'discarded-history', warning, record: structuredClone(record) };
  if (!target.some((candidate) => isDeepStrictEqual(candidate, value))) target.push(value);
}

function mergeRecoveryRecords(existing: unknown[], added: unknown[]): unknown[] {
  const merged = structuredClone(existing);
  for (const value of added) {
    if (!merged.some((candidate) => isDeepStrictEqual(candidate, value))) {
      merged.push(structuredClone(value));
    }
  }
  return merged;
}

function isConfigMode(value: unknown): value is ConfigMode {
  return value === 'cto' || value === 'lfo' || value === 'lfo-as-cto' || value === 'lfo-add-options';
}

function cloneWorkspace(workspace: WorkspaceSession): WorkspaceSession {
  return {
    ...structuredClone({
      ...workspace,
      configurations: undefined,
      racks: undefined,
    }),
    configurations: new Map(
      [...workspace.configurations].map(([id, session]) => [id, cloneConfig(session)]),
    ),
    racks: new Map(
      [...workspace.racks].map(([id, rack]) => [id, structuredClone(rack)]),
    ),
  };
}

function cloneConfig(session: ConfigSession): ConfigSession {
  return {
    ...structuredClone({ ...session, index: undefined }),
    index: buildIndex(structuredClone(session.raw)),
  };
}

function sameConfigCanonicalState(left: ConfigSession, right: ConfigSession): boolean {
  return isDeepStrictEqual(
    {
      label: left.label,
      locale: left.locale,
      solution: left.solution,
      product: left.product,
      mode: left.mode,
      validationMode: left.validationMode,
      autoCorrect: left.autoCorrect,
      raw: left.raw,
      configurationId: left.configurationId,
      primed: left.primed,
      configurable: left.configurable,
      intents: left.intents,
      snapshots: left.snapshots,
    },
    {
      label: right.label,
      locale: right.locale,
      solution: right.solution,
      product: right.product,
      mode: right.mode,
      validationMode: right.validationMode,
      autoCorrect: right.autoCorrect,
      raw: right.raw,
      configurationId: right.configurationId,
      primed: right.primed,
      configurable: right.configurable,
      intents: right.intents,
      snapshots: right.snapshots,
    },
  );
}

function sameWorkspaceCanonicalState(left: WorkspaceSession, right: WorkspaceSession): boolean {
  if (!isDeepStrictEqual([...left.configurations.keys()], [...right.configurations.keys()])) {
    return false;
  }
  for (const [id, leftSession] of left.configurations) {
    const rightSession = right.configurations.get(id);
    if (!rightSession || !sameConfigCanonicalState(leftSession, rightSession)) return false;
  }
  return isDeepStrictEqual(
    {
      label: left.label,
      locale: left.locale,
      solution: left.solution,
      validationMode: left.validationMode,
      racks: [...left.racks],
      rackArea: left.rackArea,
      nonRackArea: left.nonRackArea,
      serverState: withoutOperationalMetadata(left.serverState),
      rackSummaries: left.rackSummaries,
      cables: left.cables,
      floorItems: left.floorItems,
      powerSelections: left.powerSelections,
      integrity: left.integrity,
      integrityWarnings: left.integrityWarnings,
      recoveryData: left.recoveryData,
    },
    {
      label: right.label,
      locale: right.locale,
      solution: right.solution,
      validationMode: right.validationMode,
      racks: [...right.racks],
      rackArea: right.rackArea,
      nonRackArea: right.nonRackArea,
      serverState: withoutOperationalMetadata(right.serverState),
      rackSummaries: right.rackSummaries,
      cables: right.cables,
      floorItems: right.floorItems,
      powerSelections: right.powerSelections,
      integrity: right.integrity,
      integrityWarnings: right.integrityWarnings,
      recoveryData: right.recoveryData,
    },
  );
}

function assignConfig(target: ConfigSession, source: ConfigSession): void {
  const clone = cloneConfig(source);
  Object.assign(target, clone);
}

function preserveOperationalMetadata(source: Record<string, unknown>, target: Record<string, unknown>): void {
  if (Object.hasOwn(source, VALIDATION_JOBS_STATE_KEY)) {
    target[VALIDATION_JOBS_STATE_KEY] = structuredClone(source[VALIDATION_JOBS_STATE_KEY]);
  } else {
    delete target[VALIDATION_JOBS_STATE_KEY];
  }

  const sourceHistory = reconciliationHistory(source);
  const targetHistory = reconciliationHistory(target);
  const sourceAccepted = new Set(sourceHistory.map(reconciliationProposalId).filter(Boolean));
  const newlyAccepted = targetHistory.some((entry) => {
    const id = reconciliationProposalId(entry);
    return id !== '' && !sourceAccepted.has(id);
  });
  const mergedHistory = mergeReconciliationHistory(sourceHistory, targetHistory);
  if (mergedHistory.length > 0) {
    target[RECONCILIATION_HISTORY_STATE_KEY] = mergedHistory;
  } else {
    delete target[RECONCILIATION_HISTORY_STATE_KEY];
  }

  // A newly accepted proposal deliberately invalidates every proposal bound to
  // the old revision. Other transactions and undo/redo preserve the metadata.
  if (newlyAccepted) {
    delete target[RECONCILIATION_PROPOSALS_STATE_KEY];
  } else if (Object.hasOwn(source, RECONCILIATION_PROPOSALS_STATE_KEY)) {
    target[RECONCILIATION_PROPOSALS_STATE_KEY] = structuredClone(
      source[RECONCILIATION_PROPOSALS_STATE_KEY],
    );
  } else {
    delete target[RECONCILIATION_PROPOSALS_STATE_KEY];
  }
}

function withoutOperationalMetadata(state: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(state);
  delete copy[VALIDATION_JOBS_STATE_KEY];
  delete copy[RECONCILIATION_PROPOSALS_STATE_KEY];
  return copy;
}

function saveReconciliationProposal(
  serverState: Record<string, unknown>,
  proposal: ReconciliationProposal,
): Record<string, unknown> {
  const existing = Array.isArray(serverState[RECONCILIATION_PROPOSALS_STATE_KEY])
    ? (serverState[RECONCILIATION_PROPOSALS_STATE_KEY] as unknown[])
      .filter(isStoredReconciliationProposal)
      .filter((value) => value.id !== proposal.id)
    : [];
  const proposals = [...existing, structuredClone(proposal)]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .slice(-5);
  return {
    ...structuredClone(serverState),
    [RECONCILIATION_PROPOSALS_STATE_KEY]: proposals,
  };
}

function normalizeReconciliationProposalMetadata(
  serverState: Record<string, unknown>,
  workspaceId: string,
): Record<string, unknown> {
  if (!Object.hasOwn(serverState, RECONCILIATION_PROPOSALS_STATE_KEY)) return serverState;
  const normalized = Array.isArray(serverState[RECONCILIATION_PROPOSALS_STATE_KEY])
    ? (serverState[RECONCILIATION_PROPOSALS_STATE_KEY] as unknown[])
      .filter(isStoredReconciliationProposal)
      .filter((proposal) => proposal.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .slice(-5)
      .map((proposal) => structuredClone(proposal))
    : [];
  const copy = structuredClone(serverState);
  if (normalized.length > 0) copy[RECONCILIATION_PROPOSALS_STATE_KEY] = normalized;
  else delete copy[RECONCILIATION_PROPOSALS_STATE_KEY];
  return copy;
}

function isStoredReconciliationProposal(value: unknown): value is ReconciliationProposal {
  if (typeof value !== 'object' || value === null) return false;
  const proposal = value as Partial<ReconciliationProposal>;
  return proposal.version === 1 &&
    typeof proposal.id === 'string' && proposal.id.trim().length > 0 &&
    typeof proposal.workspaceId === 'string' && proposal.workspaceId.trim().length > 0 &&
    typeof proposal.sourceRevision === 'number' && Number.isFinite(proposal.sourceRevision) &&
    typeof proposal.sourceHash === 'string' &&
    typeof proposal.targetHash === 'string' &&
    typeof proposal.createdAt === 'number' && Number.isFinite(proposal.createdAt) &&
    typeof proposal.target === 'object' && proposal.target !== null &&
    Array.isArray(proposal.diffs) && Array.isArray(proposal.warnings);
}

function reconciliationHistory(state: Record<string, unknown>): unknown[] {
  return Array.isArray(state[RECONCILIATION_HISTORY_STATE_KEY])
    ? structuredClone(state[RECONCILIATION_HISTORY_STATE_KEY] as unknown[])
    : [];
}

function reconciliationProposalId(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const id = (value as Record<string, unknown>)['proposalId'];
  return typeof id === 'string' ? id : '';
}

function mergeReconciliationHistory(source: unknown[], target: unknown[]): unknown[] {
  const merged: unknown[] = [];
  const seen = new Set<string>();
  for (const entry of [...source, ...target]) {
    const id = reconciliationProposalId(entry);
    const key = id || JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(structuredClone(entry));
  }
  return merged.slice(-20);
}

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? structuredClone(value as T[]) : [];
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? structuredClone(value as Record<string, unknown>)
    : {};
}

function markDamaged(workspace: WorkspaceSession, warning: string, value: unknown, historyOnly = false): void {
  if (!historyOnly) workspace.integrity = 'damaged';
  workspace.integrityWarnings.push(warning);
  workspace.recoveryData = [...(workspace.recoveryData ?? []), historyOnly
    ? { kind: 'discarded-history', warning, record: structuredClone(value) }
    : structuredClone(value)];
}

function restoreSnapshots(
  value: unknown,
  mode: ConfigMode,
  solutionMode: string,
  workspace: WorkspaceSession,
  sessionId: string,
): ConfigSession['snapshots'] {
  if (!Array.isArray(value)) return [];
  const restored: ConfigSession['snapshots'] = [];
  for (const [position, candidate] of value.entries()) {
    if (typeof candidate !== 'object' || candidate === null) {
      markDamaged(workspace, `Snapshot ${position} for ${sessionId} was discarded`, candidate, true);
      continue;
    }
    const snapshot = candidate as Record<string, unknown>;
    const raw = snapshot['raw'];
    const revision = snapshot['revision'];
    if (typeof raw !== 'object' || raw === null || typeof revision !== 'number') {
      markDamaged(workspace, `Snapshot ${position} for ${sessionId} was discarded`, candidate, true);
      continue;
    }
    const canonicalRaw = structuredClone(raw as RawConfiguration);
    const configurationId = firstNonempty(canonicalRaw.id, sessionId);
    if (!configurationId) {
      markDamaged(workspace, `Snapshot ${position} for ${sessionId} has no identity`, candidate, true);
      continue;
    }
    restored.push({
      revision,
      raw: canonicalRaw,
      reduced: reduceConfiguration(canonicalRaw, configurationId, reducedMode(mode), solutionMode),
    });
  }
  return restored.slice(-10);
}

function restoreRacks(
  value: unknown,
  discarded: Array<{ warning: string; record: unknown }> = [],
): Map<string, RackPlacement> {
  if (value === undefined) return new Map();
  if (!Array.isArray(value)) {
    discarded.push({ warning: 'Malformed rack placement collection was quarantined', record: value });
    return new Map();
  }
  const entries: Array<[string, RackPlacement]> = [];
  const ids = new Set<string>();
  for (const [position, candidate] of value.entries()) {
    if (!Array.isArray(candidate) || candidate.length !== 2 || typeof candidate[0] !== 'string') {
      discarded.push({ warning: `Malformed rack placement ${position} was quarantined`, record: candidate });
      continue;
    }
    if (!isRackPlacement(candidate[1]) || ids.has(candidate[0])) {
      discarded.push({
        warning: ids.has(candidate[0])
          ? `Duplicate rack placement ${candidate[0]} was quarantined`
          : `Malformed rack placement ${candidate[0]} was quarantined`,
        record: candidate,
      });
      continue;
    }
    ids.add(candidate[0]);
    entries.push([candidate[0], structuredClone(candidate[1] as RackPlacement)]);
  }
  return new Map(entries);
}

function isRackPlacement(value: unknown): value is RackPlacement {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const rack = value as Record<string, unknown>;
  if (
    typeof rack['id'] !== 'string' || typeof rack['code'] !== 'string' ||
    typeof rack['description'] !== 'string' || !Number.isFinite(rack['uheight']) ||
    !Number.isFinite(rack['position']) || !Array.isArray(rack['items'])
  ) return false;
  return rack['items'].every((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return typeof record['configId'] === 'string' && typeof record['code'] === 'string' &&
      Number.isFinite(record['position']) && Number.isFinite(record['height']);
  });
}

function restoreObjectArray<T>(
  value: unknown,
  name: string,
  discarded: Array<{ warning: string; record: unknown }>,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    discarded.push({ warning: `Malformed ${name} collection was quarantined`, record: value });
    return [];
  }
  const restored: T[] = [];
  for (const [position, candidate] of value.entries()) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      discarded.push({ warning: `Malformed ${name} record ${position} was quarantined`, record: candidate });
      continue;
    }
    restored.push(structuredClone(candidate as T));
  }
  return restored;
}

function validateKnownReferences(workspace: WorkspaceSession): void {
  const configurationIds = new Set<string>();
  for (const session of workspace.configurations.values()) {
    configurationIds.add(session.id);
    configurationIds.add(session.configurationId);
  }

  for (const rack of workspace.racks.values()) {
    const retained: RackPlacement['items'] = [];
    for (const item of rack.items) {
      if (configurationIds.has(item.configId)) retained.push(item);
      else markDamaged(workspace, `Rack ${rack.id} references missing ${item.configId}`, item);
    }
    rack.items = retained;
  }

  const rackIds = new Set(workspace.racks.keys());
  for (const item of workspace.rackArea) {
    if (typeof item['id'] === 'string') rackIds.add(item['id']);
  }
  const cableEndpointIds = new Set(configurationIds);
  try {
    for (const [physicalId, templateId] of storagePhysicalTemplateIds(workspace)) {
      if (configurationIds.has(templateId)) cableEndpointIds.add(physicalId);
    }
  } catch (error) {
    markDamaged(workspace, `Cable endpoint ownership could not be resolved: ${String(error)}`, workspace.serverState.cloneDependency);
  }
  workspace.cables = workspace.cables.filter((cable) => {
    const valid =
      cableEndpointIds.has(cable.fromConfigId) && cableEndpointIds.has(cable.toConfigId);
    if (!valid) markDamaged(workspace, `Cable ${cable.id} has a missing endpoint`, cable);
    return valid;
  });
  workspace.floorItems = workspace.floorItems.filter((item) => {
    const valid = rackIds.has(item.rackId);
    if (!valid) markDamaged(workspace, `Floor item ${item.id} references missing rack ${item.rackId}`, item);
    return valid;
  });
  workspace.powerSelections = workspace.powerSelections.filter((item) => {
    const valid = rackIds.has(item.rackId);
    if (!valid) markDamaged(workspace, `Power selection references missing rack ${item.rackId}`, item);
    return valid;
  });
}

function reducedMode(mode: ConfigMode): 'cto' | 'lfo' {
  return hardwareModeFamily(mode);
}
