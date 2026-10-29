import type { ConfigMode } from '../config/constants.js';
import { type Locale, type SolutionContext } from '../config/schema.js';
import { type ReducedConfiguration } from '../domain/reduce.js';
import { type ActionHistoryFactory } from '../domain/actionHistory.js';
import { type ReconciliationProposal } from '../domain/reconciliation.js';
import type { RackObject, RackSummary } from '../domain/rack.js';
import { type ValidationJob } from '../domain/validationJobs.js';
import { type ConfigIndex } from '../model/index.js';
import type { RawConfiguration } from '../model/types.js';
import { type PersistenceFailureContext } from './persistenceError.js';
export interface ConfigIntent {
    at: number;
    changes: Array<{
        section: string;
        code: string;
        quantity: number;
    }>;
}
export interface ConfigSession {
    id: string;
    workspaceId: string;
    label?: string | undefined;
    locale: Locale;
    solution: SolutionContext;
    product: {
        code: string;
        description: string;
        type: string;
    };
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
    snapshots: Array<{
        revision: number;
        raw: RawConfiguration;
        reduced: ReducedConfiguration;
    }>;
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
export type PersistenceWriter = (candidateWorkspaces: readonly WorkspaceSession[]) => void | Promise<void>;
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
}
export declare const CLONE_OWNERSHIP_RECOVERY_STATE_KEY = "unresolvedCloneOwnership";
export declare class SessionStore {
    #private;
    private readonly maxSessions;
    constructor(maxSessions?: number);
    setPersistenceWriter(writer: PersistenceWriter | undefined): void;
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
    /**
     * Distinguishes "the caller named a workspace" from "the caller named one
     * configuration that happens to live in a workspace".
     *
     * `get` and `getWorkspace` both accept either kind of id and quietly widen or
     * narrow, which is convenient for reads and wrong for export: asking to
     * export one node in a seven-product workspace used to export all seven.
     * Anything that acts on a scope must resolve the handle here first.
     */
    resolveHandle(id: string): {
        kind: 'workspace';
        workspace: WorkspaceSession;
        session: ConfigSession | undefined;
    } | {
        kind: 'configuration';
        session: ConfigSession;
        workspace: WorkspaceSession | undefined;
    } | undefined;
    getWorkspace(id: string): WorkspaceSession | undefined;
    list(): ConfigSession[];
    listWorkspaces(): WorkspaceSession[];
    delete(id: string): boolean;
    /**
     * Durably removes an entire workspace, including every configuration handle.
     * Publication happens only after the complete replacement snapshot succeeds.
     */
    deleteWorkspace(handle: string, expectedRevision?: number, persistenceFailure?: PersistenceFailureContext): Promise<boolean>;
    /** Waits for queued workspace mutations and complete-snapshot writes. */
    drain(): Promise<void>;
    /** All mutations for a session or workspace serialise through here. */
    withLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
    /**
     * Applies one workspace mutation atomically.
     *
     * The callback only sees detached data. A durable writer, when configured,
     * receives the complete candidate store before any live object is changed.
     * This keeps callback, validation and filesystem failures invisible to
     * readers while retaining the object references held by legacy callers.
     */
    transact<T>(handle: string, options: TransactionOptions, fn: (draftWorkspace: WorkspaceSession, targetSession?: ConfigSession) => T | Promise<T>): Promise<T>;
    /**
     * Durably records validation metadata without changing canonical revisions,
     * undo history, access timestamps, or configuration object identities.
     */
    recordValidationJob(handle: string, job: ValidationJob, persistenceFailure?: PersistenceFailureContext): Promise<void>;
    /**
     * Durably records a bounded reconciliation proposal without changing design
     * revisions or undo history. The proposal must still match the exact source
     * after this call has acquired the workspace lock.
     */
    recordReconciliationProposal(handle: string, proposal: ReconciliationProposal, persistenceFailure?: PersistenceFailureContext): Promise<void>;
    /** Commits a new raw payload, bumping the revision and rebuilding the index. */
    commit(session: ConfigSession, raw: RawConfiguration, reduced: ReducedConfiguration, intent?: ConfigIntent): ConfigSession;
    /** Restores the previous snapshot. Returns false when there is nothing to undo. */
    undo(session: ConfigSession): boolean;
    addRack(workspaceId: string, rackCode: string, description?: string, uheight?: number, position?: number): RackPlacement;
    placeInRack(workspaceId: string, configId: string, rackId: string, uPosition: number, height?: number): boolean;
    /** Replaces the workspace cable list (used after DCSC auto-connect). */
    setCables(workspaceId: string, cables: CableLink[]): void;
    addCabling(workspaceId: string, cable: Omit<CableLink, 'id'>): CableLink;
    setFloorItem(workspaceId: string, item: FloorItem): FloorItem;
    /** @deprecated Prefer service.placeOnFloor, which validates the rack exists. */
    placeOnFloor(workspaceId: string, rackId: string, x: number, y: number): FloorItem;
    setPowerSelection(workspaceId: string, selection: PduSelection): PduSelection;
    /** @deprecated Prefer service.configurePdu, which selects features via DCSC. */
    configurePdu(workspaceId: string, rackId: string, pduSelection: Omit<PduSelection, 'rackId'>): PduSelection;
    /** Finds a configuration in this workspace by DCSC configuration id. */
    findByConfigurationId(workspaceId: string, configurationId: string): ConfigSession | undefined;
    /** Rebuilds canonical workspaces while retaining diagnostics for recovery. */
    restore(workspaces: unknown[], options?: {
        provenance?: 'current' | 'legacy-unverified';
    }): number;
}
/** Adds a validated configuration to a detached transaction candidate only. */
export declare function stageConfiguration(workspace: WorkspaceSession, input: CreateSessionInput): ConfigSession;
