import type { ConfigMode } from '../config/constants.js';
import { type Locale, type SolutionContext } from '../config/schema.js';
import { type CloneDependency } from '../domain/importCloneOwnership.js';
import { type ReconciliationProposal } from '../domain/reconciliation.js';
import type { CreateSessionInput, WorkspaceStateInput } from './SessionStore.js';
import type { ConfigSession, WorkspaceHistory, WorkspaceHistoryEntry, WorkspaceSession } from '../model/session.js';
export declare function firstNonempty(...values: unknown[]): string | undefined;
export declare function normalizeNewWorkspaceId(requested: string | undefined): string;
export declare function buildEmptyWorkspace(id: string, input: {
    locale: Locale;
    solution: SolutionContext;
    validationMode?: 'guided' | 'expert' | undefined;
    label?: string | undefined;
}, now?: number): WorkspaceSession;
/** Adds a validated configuration to a detached transaction candidate only. */
export declare function stageConfiguration(workspace: WorkspaceSession, input: CreateSessionInput): ConfigSession;
export declare function buildConfigSession(input: CreateSessionInput, workspaceId: string, now?: number): ConfigSession;
export declare function assertBatchCanJoin(workspace: WorkspaceSession, sessions: ConfigSession[]): void;
export declare function assertPreparedBatchPresent(workspace: WorkspaceSession, sessions: readonly ConfigSession[]): void;
export declare function applyWorkspaceState(workspace: WorkspaceSession, state: WorkspaceStateInput | undefined): void;
/**
 * Each undo entry is a full workspace snapshot, so ten of them on a solution
 * with dozens of configurations reached ~400 MB and the persisted session file
 * could no longer be loaded. Keep the newest entries that fit the budget, and
 * always at least one so a single undo still works.
 */
export declare const WORKSPACE_HISTORY_BYTE_BUDGET: number;
export declare function trimHistoryToBudget(entries: WorkspaceHistoryEntry[], budget?: number): WorkspaceHistoryEntry[];
/** Entries share the workspace's immutable values; nothing is copied. */
export declare function captureWorkspaceHistoryState(workspace: WorkspaceSession): Record<string, unknown>;
export declare function restoreWorkspaceHistory(workspace: WorkspaceSession, direction: 'undo' | 'redo'): boolean;
export declare function applyWorkspaceHistoryState(workspace: WorkspaceSession, state: Record<string, unknown>): void;
export declare function restoreWorkspaceHistoryEnvelope(value: unknown, warnings?: string[], discarded?: unknown[]): WorkspaceHistory;
export interface RestoredCloneOwnership {
    dependency: CloneDependency;
    colors: Record<string, unknown>;
    changed: boolean;
}
/** Returns a detached canonical graph; callers publish it only after every check succeeds. */
export declare function reconcileRestoredCloneOwnership(workspace: WorkspaceSession): RestoredCloneOwnership;
/** Removes snapshots that are structurally plausible but cannot be restored safely. */
export declare function discardInvalidHistorySnapshots(workspace: WorkspaceSession): {
    warnings: string[];
    migrated: number;
};
export declare function mergeRecoveryRecords(existing: unknown[], added: unknown[]): unknown[];
export declare function isConfigMode(value: unknown): value is ConfigMode;
/** Entries are immutable once recorded, so copies share them and only own the lists. */
export declare function copyHistory(history: WorkspaceHistory | undefined): WorkspaceHistory | undefined;
export declare function cloneWorkspace(workspace: WorkspaceSession): WorkspaceSession;
export declare function cloneConfig(session: ConfigSession): ConfigSession;
export declare function sameConfigCanonicalState(left: ConfigSession, right: ConfigSession): boolean;
export declare function sameWorkspaceCanonicalState(left: WorkspaceSession, right: WorkspaceSession): boolean;
/** An unchanged draft value becomes the original's own object, so history entries keep sharing it. */
export declare function shareUnchangedValues(original: WorkspaceSession, draft: WorkspaceSession): void;
/** The draft is discarded after publication, so its values move to the live session uncopied. */
export declare function assignConfig(target: ConfigSession, source: ConfigSession): void;
export declare function preserveOperationalMetadata(source: Record<string, unknown>, target: Record<string, unknown>): void;
export declare function withoutOperationalMetadata(state: Record<string, unknown>): Record<string, unknown>;
export declare function saveReconciliationProposal(serverState: Record<string, unknown>, proposal: ReconciliationProposal): Record<string, unknown>;
export declare function normalizeReconciliationProposalMetadata(serverState: Record<string, unknown>, workspaceId: string): Record<string, unknown>;
export declare function arrayOrEmpty<T>(value: unknown): T[];
export declare function recordOrEmpty(value: unknown): Record<string, unknown>;
export declare function markDamaged(workspace: WorkspaceSession, warning: string, value: unknown, historyOnly?: boolean): void;
export declare function restoreSnapshots(value: unknown, mode: ConfigMode, solutionMode: string, workspace: WorkspaceSession, sessionId: string): ConfigSession['snapshots'];
export declare function restoreObjectArray<T>(value: unknown, name: string, discarded: Array<{
    warning: string;
    record: unknown;
}>): T[];
export declare function validateKnownReferences(workspace: WorkspaceSession): void;
export declare function reducedMode(mode: ConfigMode): 'cto' | 'lfo';
