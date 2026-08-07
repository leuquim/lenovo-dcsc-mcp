import type { z } from 'zod';
import { DcscContractDriftError } from '../http/errors.js';

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
export function parseResponse<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  ctx: ParseContext,
): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;

  const first = result.error.issues[0];
  const path = first ? first.path.join('.') : '(root)';
  throw new DcscContractDriftError({
    endpoint: ctx.endpoint,
    corrId: ctx.corrId,
    requestId: ctx.requestId,
    zodPath: path,
    userMessage:
      `DCSC returned an unexpected response shape for ${ctx.endpoint} (at "${path}": ${first?.message ?? 'unknown'}). ` +
      'This usually means Lenovo changed the API. The MCP server needs updating.',
    internal: result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.code} ${i.message}`)
      .join('; '),
  });
}
