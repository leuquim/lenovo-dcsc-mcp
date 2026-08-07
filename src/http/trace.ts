import pino from 'pino';
import { ulid } from 'ulid';

/**
 * MCP stdio servers own stdout for JSON-RPC. Any write to fd 1 corrupts the
 * protocol stream, so the logger is pinned to stderr (fd 2). The `no-console`
 * ESLint rule covers the other half of this.
 */
let root = pino({ level: 'info' }, pino.destination(2));

export function configureLogger(level: string): void {
  root = pino({ level }, pino.destination(2));
}

export function logger(): pino.Logger {
  return root;
}

/**
 * A correlation id per *logical operation* (one MCP tool call), propagated
 * across retries so every attempt correlates. Distinct from DCSC's own
 * x-request-id, which is per HTTP attempt.
 */
export function newCorrId(): string {
  return ulid();
}

export interface RequestTrace {
  corrId: string;
  requestId?: string;
  traceId?: string;
  endpoint: string;
  method: string;
  attempt: number;
  status?: number;
  durationMs?: number;
}

export function childLogger(trace: RequestTrace): pino.Logger {
  return root.child(trace as unknown as Record<string, unknown>);
}
