import type { z } from 'zod';
export interface ParseContext {
    endpoint: string;
    corrId: string;
    requestId?: string | undefined;
}
/**
 * Parses a DCSC response, converting a schema failure into a loud, structured
 * error.
 *
 * Drift on a field we consume is a hard failure — returning a silently wrong
 * price or a half-parsed configuration is far worse than an explicit error.
 * The error carries the endpoint and the zod path only; never the body.
 */
export declare function parseResponse<T>(schema: z.ZodType<T>, raw: unknown, ctx: ParseContext): T;
