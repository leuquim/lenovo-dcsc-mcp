import { redactUnknown } from './redact.js';

export type DcscErrorKind =
  | 'validation'
  | 'throttled'
  | 'server'
  | 'transport'
  | 'ambiguous_state'
  | 'contract_drift'
  | 'budget_exceeded'
  | 'unsupported'
  | 'preamble';

export interface DcscErrorContext {
  endpoint?: string | undefined;
  status?: number | undefined;
  requestId?: string | undefined;
  traceId?: string | undefined;
  corrId?: string | undefined;
  /** Safe to show a user. */
  userMessage: string;
  /** Log-only. Already redacted. */
  internal?: string | undefined;
  bodyHash?: string | undefined;
  retryable?: boolean | undefined;
}

export class DcscError extends Error {
  readonly kind: DcscErrorKind;
  readonly endpoint: string | undefined;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly traceId: string | undefined;
  readonly corrId: string | undefined;
  readonly userMessage: string;
  readonly internal: string | undefined;
  readonly bodyHash: string | undefined;
  readonly retryable: boolean;

  constructor(kind: DcscErrorKind, ctx: DcscErrorContext) {
    super(ctx.userMessage);
    this.name = new.target.name;
    this.kind = kind;
    this.endpoint = ctx.endpoint;
    this.status = ctx.status;
    this.requestId = ctx.requestId;
    this.traceId = ctx.traceId;
    this.corrId = ctx.corrId;
    this.userMessage = ctx.userMessage;
    this.internal = ctx.internal;
    this.bodyHash = ctx.bodyHash;
    this.retryable = ctx.retryable ?? false;
  }
}

/**
 * A 4xx problem+json. `detail` is short and names a parameter, so it is safe
 * to surface verbatim — and it is the engine that makes contract discovery
 * cheap.
 */
export class DcscValidationError extends DcscError {
  readonly missingParam: string | undefined;
  readonly problemKind: ProblemKind;

  constructor(
    ctx: DcscErrorContext & { missingParam?: string | undefined; problemKind: ProblemKind },
  ) {
    super('validation', ctx);
    this.missingParam = ctx.missingParam;
    this.problemKind = ctx.problemKind;
  }
}

/** HTTP 499 — the WAF verdict. Never retried, at any level. */
export class DcscThrottledError extends DcscError {
  readonly retryAfterMs: number;
  constructor(ctx: DcscErrorContext & { retryAfterMs: number }) {
    super('throttled', ctx);
    this.retryAfterMs = ctx.retryAfterMs;
  }
}

export class DcscServerError extends DcscError {
  constructor(ctx: DcscErrorContext) {
    super('server', ctx);
  }
}

export class DcscTransportError extends DcscError {
  constructor(ctx: DcscErrorContext) {
    super('transport', { retryable: true, ...ctx });
  }
}

/**
 * A 5xx on a POST. The mutation may or may not have applied, so it is never
 * retried — the domain layer must re-read state before continuing. A silent
 * duplicate mutation is worse than a visible failure.
 */
export class DcscAmbiguousStateError extends DcscError {
  constructor(ctx: DcscErrorContext) {
    super('ambiguous_state', ctx);
  }
}

export class DcscContractDriftError extends DcscError {
  readonly zodPath: string | undefined;
  constructor(ctx: DcscErrorContext & { zodPath?: string }) {
    super('contract_drift', ctx);
    this.zodPath = ctx.zodPath;
  }
}

export class DcscBudgetExceededError extends DcscError {
  constructor(ctx: DcscErrorContext) {
    super('budget_exceeded', ctx);
  }
}

export class DcscUnsupportedError extends DcscError {
  readonly capability: string;
  constructor(ctx: DcscErrorContext & { capability: string }) {
    super('unsupported', ctx);
    this.capability = ctx.capability;
  }
}

/** Thrown locally, before any request is sent, when the preamble is incomplete. */
export class DcscPreambleError extends DcscError {
  readonly missing: readonly string[];
  constructor(ctx: DcscErrorContext & { missing: readonly string[] }) {
    super('preamble', ctx);
    this.missing = ctx.missing;
  }
}

// ---------------------------------------------------------------------------
// RFC 7807 parsing — the discovery engine
// ---------------------------------------------------------------------------

export type ProblemKind =
  | 'missing_param'
  | 'missing_body'
  | 'bad_param_type'
  | 'not_found'
  | 'method_not_allowed'
  | 'unknown';

export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
}

interface ParsedProblem {
  kind: ProblemKind;
  param?: string;
}

/**
 * Ordered rules mapping DCSC's `detail` text onto a structured kind. The
 * `missing_param` case is what lets the discovery loop add one parameter at a
 * time until a call succeeds.
 */
const DETAIL_RULES: ReadonlyArray<readonly [RegExp, ProblemKind]> = [
  [/Required parameter '([^']+)' is not present/i, 'missing_param'],
  [/Required request (?:body|part) '?([^' ]*)'? is (?:not present|missing)/i, 'missing_body'],
  [/Required (?:request )?header '([^']+)' is not present/i, 'missing_param'],
  [
    /Failed to convert value of type .* to required type .*;.*'([^']+)'/i,
    'bad_param_type',
  ],
  [/No static resource ([^.]+)\./i, 'not_found'],
  [/Method Not Allowed/i, 'method_not_allowed'],
];

export function parseProblemDetail(detail: string | undefined): ParsedProblem {
  if (!detail) return { kind: 'unknown' };
  for (const [pattern, kind] of DETAIL_RULES) {
    const m = pattern.exec(detail);
    if (m) {
      const param = m[1];
      return param ? { kind, param } : { kind };
    }
  }
  return { kind: 'unknown' };
}

export function isProblemJson(contentType: string | undefined): boolean {
  return contentType?.toLowerCase().includes('application/problem+json') ?? false;
}

const SERVER_ERROR_TEMPLATE =
  'DCSC returned an internal error (HTTP {status}, trace {requestId}). ' +
  'This usually means a required parameter was missing or the API shape changed.';

/**
 * Builds the user-facing message for a 5xx.
 *
 * This is the absolute sanitisation rule: for status >= 500 the user sees a
 * fixed template and nothing else. The raw body never escapes.
 */
export function serverErrorMessage(status: number, requestId: string | undefined): string {
  return SERVER_ERROR_TEMPLATE.replace('{status}', String(status)).replace(
    '{requestId}',
    requestId ?? 'unknown',
  );
}

export interface BuildErrorInput {
  status: number;
  method: string;
  endpoint: string;
  contentType: string | undefined;
  body: unknown;
  requestId: string | undefined;
  traceId: string | undefined;
  corrId: string;
  retryAfterMs?: number;
  /** When true, bypasses redaction for local reverse-engineering. */
  logRawErrors: boolean;
}

/** Maps an HTTP failure response onto the right DcscError subclass. */
export function buildHttpError(input: BuildErrorInput): DcscError {
  const { status, method, endpoint, contentType, body, requestId, traceId, corrId } = input;
  const base = { endpoint, status, requestId, traceId, corrId };

  const redacted = input.logRawErrors
    ? { text: typeof body === 'string' ? body : JSON.stringify(body), hash: '' }
    : redactUnknown(body);

  if (status === 499) {
    return new DcscThrottledError({
      ...base,
      retryAfterMs: input.retryAfterMs ?? 60_000,
      userMessage:
        'DCSC is throttling this client (HTTP 499). Backing off; no requests will be sent until the cooldown expires.',
      internal: redacted.text,
      bodyHash: redacted.hash,
    });
  }

  if (status >= 400 && status < 500) {
    const problem = isProblemJson(contentType) ? (body as ProblemDetails) : undefined;
    const parsed = parseProblemDetail(problem?.detail);
    // A 4xx detail is short and names a parameter — safe to show verbatim.
    const userMessage = problem?.detail
      ? `DCSC rejected the request (HTTP ${status}): ${problem.detail}`
      : `DCSC rejected the request (HTTP ${status}).`;
    return new DcscValidationError({
      ...base,
      userMessage,
      problemKind: parsed.kind,
      ...(parsed.param !== undefined ? { missingParam: parsed.param } : {}),
      internal: redacted.text,
      bodyHash: redacted.hash,
    });
  }

  // status >= 500
  const userMessage = serverErrorMessage(status, requestId);
  if (method !== 'GET' && method !== 'HEAD') {
    return new DcscAmbiguousStateError({
      ...base,
      userMessage: `${userMessage} Because this was a ${method}, the change may or may not have been applied — re-read the configuration before continuing.`,
      internal: redacted.text,
      bodyHash: redacted.hash,
    });
  }

  // A problem+json 500 is deterministic; retrying it wastes a request.
  const retryable = !isProblemJson(contentType);
  return new DcscServerError({
    ...base,
    userMessage,
    internal: redacted.text,
    bodyHash: redacted.hash,
    retryable,
  });
}

/**
 * The MCP boundary. A tool result may contain only the user message, the
 * request id, and structured hints. Everything else is log-only.
 *
 * Never construct tool errors anywhere else.
 */
export function toToolError(err: unknown): {
  error: string;
  kind: string;
  requestId?: string;
  missingParam?: string;
  retryAfterMs?: number;
  capability?: string;
} {
  if (err instanceof DcscError) {
    return {
      error: err.userMessage,
      kind: err.kind,
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      ...(err instanceof DcscValidationError && err.missingParam !== undefined
        ? { missingParam: err.missingParam }
        : {}),
      ...(err instanceof DcscThrottledError ? { retryAfterMs: err.retryAfterMs } : {}),
      ...(err instanceof DcscUnsupportedError ? { capability: err.capability } : {}),
    };
  }
  // Errors we raise ourselves carry guidance the model needs to recover
  // ("use dcsc_session_list…"). Collapsing them into a generic string strands
  // the caller. Upstream content never reaches here — it is already wrapped in
  // a DcscError above, where the 5xx redaction rule applies.
  if (err instanceof Error && err.message.length > 0) {
    return { error: err.message, kind: 'invalid_request' };
  }
  return { error: 'An unexpected internal error occurred.', kind: 'internal' };
}
