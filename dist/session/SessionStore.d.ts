import type { ConfigMode } from '../config/constants.js';
import { type Locale, type SolutionContext } from '../config/schema.js';
import { type ActionHistoryFactory } from '../domain/actionHistory.js';
import type { RackObject, RackSummary } from '../domain/rack.js';
import { type ReconciliationProposal } from '../domain/reconciliation.js';
import { type ReducedConfiguration } from '../domain/reduce.js';
import { type ValidationJob } from '../domain/validationJobs.js';
import type { CableLink, ConfigSession, FloorItem, PduSelection, WorkspaceSession } from '../model/session.js';
import type { RawConfiguration } from '../model/types.js';
import { type PersistenceFailureContext } from '../http/persistenceError.js';
import { stageConfiguration, trimHistoryToBudget, WORKSPACE_HISTORY_BYTE_BUDGET } from './sessionSnapshots.js';
export { stageConfiguration, trimHistoryToBudget, WORKSPACE_HISTORY_BYTE_BUDGET };
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
    prepare?: (draftWorkspace: WorkspaceSession, createdSessions: ConfigSession[]) => void | Promise<void>;
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
/** What the store needs to find a workspace and its configurations without loading it. */
export interface WorkspaceIndexEntry {
    id: string;
    lastAccessAt: number;
    configurationIds: string[];
}
/** Receives only the workspaces that changed or were removed, plus the index after the change. */
export type PersistenceWriter = (changedWorkspaces: readonly WorkspaceSession[], removedWorkspaceIds: readonly string[], indexAfterChange: readonly WorkspaceIndexEntry[]) => void | Promise<void>;
export type WorkspaceHydrator = (workspaceId: string) => void;
export declare class SessionConflictError extends Error {
    readonly expectedRevision: number;
    readonly actualRevision: number;
    readonly scope: 'configuration' | 'workspace';
    constructor(expectedRevision: number, actualRevision: number, scope: 'configuration' | 'workspace');
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
    evictedWorkspaceIds?: string[] | undefined;
}
export interface RestoreOptions {
    provenance?: 'current' | 'legacy-unverified';
}
export declare const CLONE_OWNERSHIP_RECOVERY_STATE_KEY = "unresolvedCloneOwnership";
export declare class SessionStore {
    #private;
    readonly maxSessions: number;
    constructor(maxSessions?: number);
    setPersistenceWriter(writer: PersistenceWriter | undefined): void;
    /** Registers persisted workspaces that are parsed and restored on first access. */
    registerUnloaded(entries: readonly WorkspaceIndexEntry[], hydrate: WorkspaceHydrator): void;
    /** Index of every known workspace, loaded or not. */
    workspaceIndex(): WorkspaceIndexEntry[];
    get lastRestoreReport(): RestoreReport;
    /** Adds persistence-layer diagnostics that can occur before workspace restore. */
    recordRestoreDiagnostics(diagnostics: RestoreDiagnostics): void;
    create(input: CreateSessionInput): ConfigSession;
    /** Creates one session and returns its live reference only after persistence. */
    createAtomic(input: CreateSessionInput): Promise<ConfigSession>;
    /**
     * Atomically creates an imported/configured batch in a new or existing workspace.
     * The optional prepare hook can perform remote layout work against the detached
     * complete candidate; any exception discards the whole batch.
     */
    createManyAtomic(inputs: readonly CreateSessionInput[], options?: AtomicCreateOptions): Promise<AtomicCreateResult>;
    undoWorkspace(handle: string, expectedRevision?: number): Promise<boolean>;
    redoWorkspace(handle: string, expectedRevision?: number): Promise<boolean>;
    get(id: string): ConfigSession | undefined;
    resolveHandle(id: string): {
        kind: 'workspace';
        workspace: WorkspaceSession;
        session: ConfigSession | undefined;
    } | {
        kind: 'configuration';
        session: ConfigSession;
        workspace: WorkspaceSession | undefined;
    } | undefined;
    /** Reads a loaded workspace without counting as access, so eviction order is kept. */
    peekWorkspace(id: string): WorkspaceSession | undefined;
    getWorkspace(id: string): WorkspaceSession | undefined;
    list(): ConfigSession[];
    listWorkspaces(): WorkspaceSession[];
    delete(id: string): boolean;
    deleteWorkspace(handle: string, expectedRevision?: number, persistenceFailure?: PersistenceFailureContext): Promise<boolean>;
    drain(): Promise<void>;
    transact<T>(handle: string, options: TransactionOptions, fn: (draftWorkspace: WorkspaceSession, targetSession?: ConfigSession) => T | Promise<T>): Promise<T>;
    recordValidationJob(handle: string, job: ValidationJob, persistenceFailure?: PersistenceFailureContext): Promise<void>;
    recordReconciliationProposal(handle: string, proposal: ReconciliationProposal, persistenceFailure?: PersistenceFailureContext): Promise<void>;
    findByConfigurationId(workspaceId: string, configurationId: string): ConfigSession | undefined;
    /** Rebuilds canonical workspaces while retaining diagnostics for recovery. */
    restore(workspaces: unknown[], options?: RestoreOptions): number;
    /** Restores workspaces on first access and merges the outcome into lastRestoreReport. */
    restoreLazily(workspaces: unknown[]): RestoreReport;
}
