import { Agent, request as undiciRequest } from 'undici';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';

import { API_PREFIX } from '../config/constants.js';
import type { Config, Locale, SolutionContext } from '../config/schema.js';
import {
  DcscBudgetExceededError,
  DcscError,
  DcscThrottledError,
  DcscServerError,
  DcscTransportError,
  buildHttpError,
} from './errors.js';
import { redactBody } from './redact.js';
import { assertPreamble, composeHeaders, composeQuery, type QueryValue } from './preamble.js';
import { CircuitBreaker } from './resilience/breaker.js';
import { RequestBudget, Semaphore, TokenBucket, sleep } from './resilience/pacer.js';
import { backoffDelay, isRetryableTransportError, shouldRetry } from './resilience/retry.js';
import { WafGate } from './resilience/waf.js';
import { childLogger, logger } from './trace.js';

export type TimeoutClass = 'fast' | 'interactive' | 'heavy' | 'export';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';

/** One part of a multipart/form-data body: either a plain field or a file. */
export type MultipartPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; content: string | Uint8Array };

export type ReqBody =
  | { kind: 'json'; value: unknown }
  /** Reproduces the SPA's hidden-iframe form POST used for exports. */
  | { kind: 'form'; fields: Record<string, string> }
  /** Reproduces the SPA's file uploads, including CFXML and binary Excel workbooks. */
  | { kind: 'multipart'; parts: MultipartPart[] };

export interface RequestCtx {
  corrId: string;
  locale: Locale;
  solution?: SolutionContext | undefined;
  signal?: AbortSignal | undefined;
  budget?: RequestBudget | undefined;
}

export interface SendInput {
  /** Stable logical id, used for logging, fixtures and fingerprints. */
  endpoint: string;
  method: HttpMethod;
  /** Path below /api, e.g. "/category_hierarchies". */
  path: string;
  query?: Record<string, QueryValue> | undefined;
  body?: ReqBody | undefined;
  /** 'json' requires a JSON body; 'text' accepts a bare string and returns it as `raw` when the body is not JSON. */
  responseKind: 'json' | 'text' | 'stream';
  timeoutClass?: TimeoutClass | undefined;
  /** Bootstrap endpoints (/locales, /currencies) do not need solution context. */
  requiresSolution?: boolean | undefined;
  ctx: RequestCtx;
}

interface BaseResponse {
  status: number;
  headers: Record<string, string>;
  requestId: string | undefined;
  traceId: string | undefined;
  durationMs: number;
}

export interface JsonResponse extends BaseResponse {
  raw: unknown;
}

export interface StreamResponse extends BaseResponse {
  stream: Readable;
  contentType: string | undefined;
  contentDisposition: string | undefined;
}

/**
 * The single chokepoint for all DCSC traffic.
 *
 * This module is the only place in the codebase permitted to import undici
 * (enforced by the no-restricted-imports rule in eslint.config.js). Everything
 * else must call send(), which is what guarantees the mandatory header and
 * query preamble is applied — omitting any part of it produces an HTTP 500
 * from DCSC, sometimes with a leaked SQL statement.
 *
 * Fixed pipeline: budget -> pace -> breaker/WAF -> send -> parse.
 */
export class DcscHttpClient {
  readonly #agent: Agent;
  readonly #bucket: TokenBucket;
  readonly #concurrency: Semaphore;
  readonly #exportConcurrency: Semaphore;
  readonly #breaker: CircuitBreaker;
  readonly #waf: WafGate;

  constructor(private readonly config: Config) {
    this.#agent = new Agent({
      connections: config.pacing.maxConcurrency,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 120_000,
    });
    this.#bucket = new TokenBucket(config.pacing.bucketCapacity, config.pacing.refillPerSec);
    this.#concurrency = new Semaphore(config.pacing.maxConcurrency);
    this.#exportConcurrency = new Semaphore(config.pacing.exportConcurrency);
    this.#breaker = new CircuitBreaker(config.breaker);
    this.#waf = new WafGate(
      config.waf.ladderMs,
      config.waf.decayAfterSuccesses,
      config.waf.resetAfterMs,
    );
  }

  get health(): {
    breaker: string;
    wafStrikes: number;
    wafCooldownMs: number;
    enabled: boolean;
  } {
    return {
      breaker: this.#breaker.state,
      wafStrikes: this.#waf.strikes,
      wafCooldownMs: this.#waf.remainingMs(),
      enabled: this.config.enabled,
    };
  }

  async close(): Promise<void> {
    await this.#agent.close();
  }

  #timeoutFor(cls: TimeoutClass): { overallMs: number; bodyMs: number } {
    const t = this.config.timeouts;
    switch (cls) {
      case 'fast':
        return { overallMs: t.fastMs, bodyMs: t.fastMs };
      case 'heavy':
        return { overallMs: t.heavyMs, bodyMs: t.heavyMs };
      case 'export':
        // Only the export class can distinguish "still thinking" from
        // "stream stalled", because it is the only streamed response.
        return { overallMs: t.exportMs, bodyMs: t.streamBodyMs };
      case 'interactive':
      default:
        return { overallMs: t.interactiveMs, bodyMs: t.interactiveMs };
    }
  }

  async send(input: SendInput & { responseKind: 'json' }): Promise<JsonResponse>;
  async send(input: SendInput & { responseKind: 'stream' }): Promise<StreamResponse>;
  async send(input: SendInput): Promise<JsonResponse | StreamResponse> {
    if (!this.config.enabled) {
      throw new DcscError('unsupported', {
        endpoint: input.endpoint,
        corrId: input.ctx.corrId,
        userMessage: 'DCSC access is disabled (DCSC_ENABLED=false).',
      });
    }

    const timeoutClass = input.timeoutClass ?? 'interactive';
    const gate = timeoutClass === 'export' ? this.#exportConcurrency : this.#concurrency;

    return gate.run(() => this.#attemptLoop(input, timeoutClass));
  }

  async #attemptLoop(
    input: SendInput,
    timeoutClass: TimeoutClass,
  ): Promise<JsonResponse | StreamResponse> {
    const { maxAttempts } = this.config.retry;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.#guardGates(input);

      if (input.ctx.budget && !input.ctx.budget.tryConsume()) {
        throw new DcscBudgetExceededError({
          endpoint: input.endpoint,
          corrId: input.ctx.corrId,
          userMessage:
            `This operation exceeded its budget of ${input.ctx.budget.limit} DCSC requests. ` +
            'Narrow the request, or raise DCSC_TOOL_REQUEST_BUDGET if this is expected.',
        });
      }

      await this.#bucket.take();

      try {
        const res = await this.#execute(input, timeoutClass, attempt);
        this.#breaker.recordSuccess();
        this.#waf.recordSuccess();
        return res;
      } catch (err) {
        lastError = err;
        const connectPhase = isConnectPhaseFailure(err);
        this.#recordFailure(err);

        if (!shouldRetry({ err, method: input.method, connectPhase, attempt, maxAttempts })) {
          throw err;
        }

        const delay = backoffDelay(attempt, this.config.retry);
        childLogger({
          corrId: input.ctx.corrId,
          endpoint: input.endpoint,
          method: input.method,
          attempt,
        }).warn({ delayMs: delay, err: describe(err) }, 'Retrying DCSC request');
        await sleep(delay, input.ctx.signal);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new DcscTransportError({
          endpoint: input.endpoint,
          corrId: input.ctx.corrId,
          userMessage: 'DCSC request failed after all retry attempts.',
        });
  }

  /** WAF cooldown and circuit breaker are checked before every attempt. */
  #guardGates(input: SendInput): void {
    const cooldown = this.#waf.remainingMs();
    if (cooldown > 0) {
      throw new DcscThrottledError({
        endpoint: input.endpoint,
        corrId: input.ctx.corrId,
        retryAfterMs: cooldown,
        userMessage:
          `DCSC has flagged this client and we are backing off. ` +
          `Retry in about ${Math.ceil(cooldown / 60_000)} minute(s).`,
      });
    }

    if (!this.#breaker.canPass()) {
      const wait = this.#breaker.msUntilClose();
      throw new DcscError('server', {
        endpoint: input.endpoint,
        corrId: input.ctx.corrId,
        userMessage:
          `DCSC requests are paused by the circuit breaker after repeated failures. ` +
          `Retry in about ${Math.ceil(wait / 1000)}s.`,
      });
    }
  }

  #recordFailure(err: unknown): void {
    if (err instanceof DcscThrottledError) {
      const cooldown = this.#waf.recordStrike();
      this.#breaker.forceOpen(cooldown, 'HTTP 499 (WAF)');
      return;
    }
    const status = err instanceof DcscError ? (err.status ?? 0) : 0;
    this.#breaker.recordFailure({ serverError: status >= 500 || status === 0 });
  }

  async #execute(
    input: SendInput,
    timeoutClass: TimeoutClass,
    attempt: number,
  ): Promise<JsonResponse | StreamResponse> {
    const requiresSolution = input.requiresSolution ?? true;
    const params = composeQuery({
      locale: input.ctx.locale,
      solution: input.ctx.solution,
      query: input.query,
    });
    assertPreamble(params, {
      endpoint: input.endpoint,
      corrId: input.ctx.corrId,
      requiresSolution,
    });

    const url = `https://${this.config.host}${API_PREFIX}${input.path}?${params.toString()}`;
    const headers: Record<string, string> = composeHeaders(input.ctx.locale);
    let payload: string | Buffer | undefined;

    if (input.body?.kind === 'json') {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(input.body.value);
    } else if (input.body?.kind === 'form') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(input.body.fields).toString();
    } else if (input.body?.kind === 'multipart') {
      const boundary = `----DcscFormBoundary${randomBytes(16).toString('hex')}`;
      headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
      payload = serialiseMultipart(boundary, input.body.parts);
    }

    const { overallMs, bodyMs } = this.#timeoutFor(timeoutClass);
    const started = Date.now();
    const log = childLogger({
      corrId: input.ctx.corrId,
      endpoint: input.endpoint,
      method: input.method,
      attempt,
    });
    log.debug({ url: redactUrl(url) }, 'DCSC request');

    let res;
    try {
      res = await undiciRequest(url, {
        method: input.method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        dispatcher: this.#agent,
        // Spring does not flush headers until the controller returns, so for
        // non-streaming classes headersTimeout must equal the overall budget.
        headersTimeout: overallMs,
        bodyTimeout: bodyMs,
        ...(input.ctx.signal ? { signal: input.ctx.signal } : {}),
      });
    } catch (err) {
      throw new DcscTransportError({
        endpoint: input.endpoint,
        corrId: input.ctx.corrId,
        userMessage: 'Could not reach DCSC (network error). This is usually transient.',
        internal: describe(err),
        retryable: isRetryableTransportError(err),
      });
    }

    const durationMs = Date.now() - started;
    const headerMap = flattenHeaders(res.headers);
    const requestId = headerMap['x-request-id'];
    const traceId = headerMap['x-trace-id'];
    const contentType = headerMap['content-type'];

    if (res.statusCode >= 400) {
      // Errors are always small; safe to buffer even in stream mode.
      const text = await this.#readBodyText(res, input);
      const parsed = tryParseJson(text, contentType);
      const error = buildHttpError({
        status: res.statusCode,
        method: input.method,
        endpoint: input.endpoint,
        contentType,
        body: parsed ?? text,
        requestId,
        traceId,
        corrId: input.ctx.corrId,
        logRawErrors: this.config.logRawErrors,
      });
      log.warn(
        {
          status: res.statusCode,
          durationMs,
          requestId,
          bodyHash: error.bodyHash,
          internal: error.internal,
        },
        'DCSC request failed',
      );
      throw error;
    }

    const base: BaseResponse = {
      status: res.statusCode,
      headers: headerMap,
      requestId,
      traceId,
      durationMs,
    };

    if (input.responseKind === 'stream') {
      log.info({ status: res.statusCode, durationMs, requestId }, 'DCSC stream opened');
      return {
        ...base,
        stream: res.body as unknown as Readable,
        contentType,
        contentDisposition: headerMap['content-disposition'],
      };
    }

    const text = await this.#readBodyText(res, input);
    log.info(
      { status: res.statusCode, durationMs, requestId, bytes: text.length },
      'DCSC request ok',
    );
    if (input.responseKind === 'text') return { ...base, raw: tryParseJson(text, contentType) ?? text };
    if (text === '') return { ...base, raw: text };
    try {
      return { ...base, raw: JSON.parse(text) };
    } catch {
      const redacted = redactBody(text);
      throw new DcscServerError({
        endpoint: input.endpoint,
        status: res.statusCode,
        requestId,
        traceId,
        corrId: input.ctx.corrId,
        userMessage: 'DCSC returned a response that is not valid JSON.',
        internal: redacted.text,
        bodyHash: redacted.hash,
        retryable: false,
      });
    }
  }

  async #readBodyText(res: { body: { text(): Promise<string> } }, input: SendInput): Promise<string> {
    try {
      return await res.body.text();
    } catch (err) {
      throw new DcscTransportError({
        endpoint: input.endpoint,
        corrId: input.ctx.corrId,
        userMessage: 'Could not read the DCSC response (network error). This is usually transient.',
        internal: describe(err),
        retryable: isRetryableTransportError(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Builds a multipart/form-data body byte-for-byte the way the SPA does.
 *
 * DCSC's import endpoint is strict about CRLF line endings and about the file
 * part carrying an explicit Content-Type; omitting either yields an HTTP 500.
 */
export function serialiseMultipart(boundary: string, parts: MultipartPart[]): Buffer {
  const chunks: Uint8Array[] = [];
  const append = (value: string | Uint8Array): void => {
    chunks.push(typeof value === 'string' ? Buffer.from(value, 'utf8') : value);
  };
  for (const part of parts) {
    append(`--${boundary}\r\n`);
    if ('filename' in part) {
      append(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`);
      append(`Content-Type: ${part.contentType}\r\n\r\n`);
      append(part.content);
    } else {
      append(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`);
      append(part.value);
    }
    append('\r\n');
  }
  append(`--${boundary}--\r\n`);
  return Buffer.concat(chunks);
}

function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function tryParseJson(text: string, contentType: string | undefined): unknown {
  const looksJson =
    contentType?.includes('json') ?? (text.startsWith('{') || text.startsWith('['));
  if (!looksJson) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Distinguishes failures that happened before the request body was written
 * from those that happened after. Only the former are safe to retry on a POST.
 */
function isConnectPhaseFailure(err: unknown): boolean {
  const code = extractCode(err);
  return (
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'ENOTFOUND'
  );
}

function extractCode(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const code = (err as { code?: string }).code;
  if (code !== undefined) return code;
  const internal = (err as { internal?: string }).internal;
  if (typeof internal === 'string') {
    const m = /\b(E[A-Z_]+|UND_ERR_[A-Z_]+)\b/.exec(internal);
    return m?.[1];
  }
  return undefined;
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** Query strings are not secret here, but keep logs readable. */
function redactUrl(url: string): string {
  const idx = url.indexOf('?');
  return idx === -1 ? url : `${url.slice(0, idx)}?…`;
}

export { RequestBudget, logger };
