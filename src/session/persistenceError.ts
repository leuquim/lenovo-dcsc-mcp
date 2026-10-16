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
export class SessionPersistenceError extends Error {
  readonly code = 'DCSC_LOCAL_NOT_COMMITTED';
  readonly localNotCommitted = true;
  readonly remoteApplied: boolean;
  readonly operation: string | undefined;
  readonly recoveryHint: string;

  constructor(cause: unknown, context: PersistenceFailureContext = {}) {
    const operation = context.operation?.trim() || undefined;
    const remoteApplied = context.remoteApplied === true;
    const recoveryHint = context.recoveryHint?.trim() || (
      remoteApplied
        ? 'The upstream operation may have succeeded. Inspect or refresh upstream state before retrying.'
        : 'The local candidate was not published. Correct persistence and retry the operation.'
    );
    super(
      remoteApplied
        ? 'Durable session commit failed after the remote operation succeeded; local state was not committed.'
        : 'Durable session commit failed; local state was not committed.',
      { cause },
    );
    this.name = 'SessionPersistenceError';
    this.remoteApplied = remoteApplied;
    this.operation = operation;
    this.recoveryHint = recoveryHint;
  }
}

/** Adds caller context without losing the filesystem error that caused failure. */
export function asSessionPersistenceError(
  error: unknown,
  context: PersistenceFailureContext = {},
): SessionPersistenceError {
  if (error instanceof SessionPersistenceError) {
    return new SessionPersistenceError(error.cause ?? error, {
      remoteApplied: context.remoteApplied ?? error.remoteApplied,
      operation: context.operation ?? error.operation,
      recoveryHint: context.recoveryHint ?? error.recoveryHint,
    });
  }
  return new SessionPersistenceError(error, context);
}
