import pino from 'pino';
export declare function configureLogger(level: string): void;
export declare function logger(): pino.Logger;
/**
 * A correlation id per *logical operation* (one MCP tool call), propagated
 * across retries so every attempt correlates. Distinct from DCSC's own
 * x-request-id, which is per HTTP attempt.
 */
export declare function newCorrId(): string;
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
export declare function childLogger(trace: RequestTrace): pino.Logger;
