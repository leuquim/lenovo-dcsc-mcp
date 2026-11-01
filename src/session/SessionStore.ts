import { isDeepStrictEqual } from 'node:util';

import type { ConfigMode } from '../config/constants.js';
import {
  LocaleSchema,
  SolutionContextSchema,
  type Locale,
  type SolutionContext,
} from '../config/schema.js';
import { appendActionHistory, type ActionHistoryFactory } from '../domain/actionHistory.js';
import type { RackObject, RackSummary } from '../domain/rack.js';
import {
  canonicalWorkspaceHash,
  type ReconciliationProposal,
} from '../domain/reconciliation.js';
import { reduceConfiguration, type ReducedConfiguration } from '../domain/reduce.js';
import {
  saveValidationJob,
  type ValidationJob,
} from '../domain/validationJobs.js';
import { hasUnrepairedRecoveryData } from '../domain/workspaceIntegrity.js';
import { buildIndex } from '../model/index.js';
import type {
  CableLink,
  ConfigIntent,
  ConfigSession,
  FloorItem,
  PduSelection,
  RackPlacement,
  WorkspaceSession,
} from '../model/session.js';
import type { RawConfiguration } from '../model/types.js';
import {
  asSessionPersistenceError,
  type PersistenceFailureContext,
} from '../http/persistenceError.js';
import {
  applyWorkspaceState,
  arrayOrEmpty,
  assertBatchCanJoin,
  assertPreparedBatchPresent,
  assignConfig,
  buildConfigSession,
  buildEmptyWorkspace,
  captureWorkspaceHistoryState,
  cloneWorkspace,
  discardInvalidHistorySnapshots,
  firstNonempty,
  markDamaged,
  mergeRecoveryRecords,
  normalizeNewWorkspaceId,
  normalizeReconciliationProposalMetadata,
  preserveOperationalMetadata,
  reconcileRestoredCloneOwnership,
  recordOrEmpty,
  reducedMode,
  restoreObjectArray,
  restoreRacks,
  restoreSnapshots,
  restoreWorkspaceHistory,
  restoreWorkspaceHistoryEnvelope,
  sameConfigCanonicalState,
  sameWorkspaceCanonicalState,
  saveReconciliationProposal,
  stageConfiguration,
  trimHistoryToBudget,
  validateKnownReferences,
  WORKSPACE_HISTORY_BYTE_BUDGET,
} from './sessionSnapshots.js';
import { errorMessage } from '../util/coerce.js';
import { newId } from './ids.js';

export { stageConfiguration, trimHistoryToBudget, WORKSPACE_HISTORY_BYTE_BUDGET };

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
    const configId = newId('sess', code);
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
      const wsId = input.workspaceId ?? newId('ws');
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
    const ws = this.#workspaces.get(id);
    if (ws) {
      ws.lastAccessAt = Date.now();
      return [...ws.configurations.values()][0];
    }
    return undefined;
  }

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

  async drain(): Promise<void> {
    await Promise.all([...this.#mutexes.values()].map((mutex) => mutex.drain()));
    await this.#persistenceMutex.drain();
    await Promise.all([...this.#mutexes.values()].map((mutex) => mutex.drain()));
    await this.#persistenceMutex.drain();
  }

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
        draft.serverState.standaloneHardwareState !== undefined ||
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
    const rackId = newId('rack');
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
      id: newId('cable'),
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
      id: newId('floor'),
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
        undo: trimHistoryToBudget(undo.slice(-10)),
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
        history: { undo: trimHistoryToBudget(restoredHistory.undo), redo: trimHistoryToBudget(restoredHistory.redo) },
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
        const detail = errorMessage(error);
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
