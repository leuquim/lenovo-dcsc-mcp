export interface PersistenceFailureContext {
    /** True when the transaction callback completed an upstream side effect. */
    remoteApplied?: boolean | undefined;
    /** Stable caller-facing name for the operation whose local commit failed. */
    operation?: string | undefined;
    /** Optional operation-specific recovery advice. */
    recoveryHint?: string | undefined;
}
/**
 * A candidate was accepted by the transaction callback but could not be
 * durably committed. The live in-memory store has not published the candidate.
 */
export declare class SessionPersistenceError extends Error {
    readonly code = "DCSC_LOCAL_NOT_COMMITTED";
    readonly localNotCommitted = true;
    readonly remoteApplied: boolean;
    readonly operation: string | undefined;
    readonly recoveryHint: string;
    constructor(cause: unknown, context?: PersistenceFailureContext);
}
/** Adds caller context without losing the filesystem error that caused failure. */
export declare function asSessionPersistenceError(error: unknown, context?: PersistenceFailureContext): SessionPersistenceError;
