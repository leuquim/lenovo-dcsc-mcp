import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import { nonBlankString, type Obj } from '../util/coerce.js';

/**
 * DCSC manufacturing validation is a two-request job.
 *
 * POST /lmc_validation returns descriptor objects, not a verdict. The website
 * passes that array unchanged to POST /lmc_validation/result. Only the latter
 * response can establish success or return the manufacturing rule report.
 */

export type ValidationStatus = 'pending' | 'valid' | 'invalid' | 'unavailable' | 'unknown';

export interface ValidationRequestError {
  phase: 'start' | 'result';
  message: string;
  status?: number | undefined;
  retryable?: boolean | undefined;
}

export interface LmcValidationStart {
  buildEntityNumber?: string | undefined;
  uuid?: string | undefined;
  lmcURL?: string | undefined;
  /** Exact response from /lmc_validation. */
  raw: unknown;
  /** Descriptor array posted unchanged to /lmc_validation/result. */
  descriptors: unknown[];
}

export interface LocalMessage {
  severity: 'error' | 'warning' | 'info';
  code?: string | undefined;
  message: string;
  section?: string | undefined;
  configurationId?: string | undefined;
  sourcePath?: string | undefined;
}

export interface LmcValidationResult extends LmcValidationStart {
  status: ValidationStatus;
  terminal: boolean;
  isValid: boolean;
  /** Parsed messages returned by the authoritative result endpoint. */
  messages: LocalMessage[];
  /** Exact response from /lmc_validation/result, when one was obtained. */
  resultRaw?: unknown;
  /** Retained failure detail. A result failure never discards the start descriptors. */
  requestError?: ValidationRequestError;
}

export interface ValidationReport {
  server: LmcValidationResult | undefined;
  /** Authoritative manufacturing messages from /lmc_validation/result. */
  messages: LocalMessage[];
  /** Diagnostics already attached to the DCSC configuration tree. */
  localDiagnostics: LocalMessage[];
  status: ValidationStatus;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  localErrorCount: number;
  localWarningCount: number;
  localInfoCount: number;
  /** True only for a terminal server success with no local error diagnostics. */
  isValid: boolean;
}


const DIAGNOSTIC_ARRAYS: Record<string, LocalMessage['severity']> = {
  expansionMessages: 'info',
  errors: 'error',
  errorMessages: 'error',
  placementError: 'error',
  warnings: 'warning',
  warningMessages: 'warning',
  warn: 'warning',
  notices: 'info',
  serviceValidationMessages: 'error',
};

/** Starts a manufacturing-validation job and retains the exact descriptor array. */
export async function startLmcValidation(
  http: DcscHttpClient,
  ctx: RequestCtx,
  exportPayload: Record<string, unknown>,
  mode: string,
): Promise<LmcValidationStart> {
  const body = { ...exportPayload, mode };
  const res = await http.send({
    endpoint: 'lmc_validation',
    method: 'POST',
    path: '/lmc_validation',
    body: { kind: 'json', value: body },
    responseKind: 'json',
    timeoutClass: 'heavy',
    ctx,
  });

  const descriptors = Array.isArray(res.raw)
    ? res.raw
    : typeof res.raw === 'object' && res.raw !== null
      ? [res.raw]
      : [];
  const entry = descriptors[0];
  const first = (typeof entry === 'object' && entry !== null ? entry : {}) as Obj;
  return {
    buildEntityNumber: nonBlankString(first['buildEntityNumber']),
    uuid: nonBlankString(first['uuid']),
    lmcURL: nonBlankString(first['lmcURL']),
    raw: res.raw,
    descriptors,
  };
}

/** Makes one bounded result request. The caller decides whether a later retry is supported. */
export async function fetchLmcValidationResult(
  http: DcscHttpClient,
  ctx: RequestCtx,
  start: LmcValidationStart,
): Promise<LmcValidationResult> {
  if (start.descriptors.length === 0) {
    return {
      ...start,
      status: 'unknown',
      terminal: false,
      isValid: false,
      messages: [],
      requestError: {
        phase: 'start',
        message: 'DCSC returned no manufacturing-validation job descriptors.',
      },
    };
  }

  try {
    const res = await http.send({
      endpoint: 'lmc_validation_result',
      method: 'POST',
      path: '/lmc_validation/result',
      body: { kind: 'json', value: start.descriptors },
      responseKind: 'json',
      timeoutClass: 'heavy',
      ctx,
    });
    return parseLmcValidationResult(start, res.raw);
  } catch (err) {
    return {
      ...start,
      status: 'pending',
      terminal: false,
      isValid: false,
      messages: [],
      requestError: requestError('result', err),
    };
  }
}

/** Starts a job and performs exactly one result request. */
export async function runLmcValidation(
  http: DcscHttpClient,
  ctx: RequestCtx,
  exportPayload: Record<string, unknown>,
  mode: string,
): Promise<LmcValidationResult> {
  let start: LmcValidationStart;
  try {
    start = await startLmcValidation(http, ctx, exportPayload, mode);
  } catch (err) {
    return {
      raw: undefined,
      descriptors: [],
      status: 'unavailable',
      terminal: false,
      isValid: false,
      messages: [],
      requestError: requestError('start', err),
    };
  }
  return fetchLmcValidationResult(http, ctx, start);
}

export function parseLmcValidationResult(
  start: LmcValidationStart,
  raw: unknown,
): LmcValidationResult {
  const values = Array.isArray(raw) ? raw : [raw];
  const messages: LocalMessage[] = [];
  let finished = false;
  let pending = values.length === 0;
  let timedOut = false;
  let unknownShape = false;

  for (const value of values) {
    if (typeof value !== 'string') {
      unknownShape = true;
      continue;
    }
    const trimmed = value.trim();
    if (/^finish$/i.test(trimmed)) {
      finished = true;
      continue;
    }
    if (/^no data found$/i.test(trimmed)) {
      pending = true;
      continue;
    }
    if (/^time out$/i.test(trimmed)) {
      timedOut = true;
      continue;
    }

    for (const rawLine of value.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '') continue;
      messages.push(parseReportLine(line));
    }
  }

  const hasErrors = messages.some((message) => message.severity === 'error');
  const status: ValidationStatus = hasErrors
    ? 'invalid'
    : timedOut
      ? 'unavailable'
      : finished
        ? 'valid'
        : pending
          ? 'pending'
          : 'unknown';
  const finalStatus: ValidationStatus =
    unknownShape && (status === 'valid' || status === 'pending') ? 'unknown' : status;

  return {
    ...start,
    status: finalStatus,
    terminal: finalStatus === 'valid' || finalStatus === 'invalid',
    isValid: finalStatus === 'valid',
    messages,
    resultRaw: raw,
    ...(timedOut
      ? {
          requestError: {
            phase: 'result' as const,
            message: 'DCSC manufacturing validation timed out.',
          },
        }
      : {}),
  };
}

/**
 * Collects local diagnostics from the configuration tree. This includes the
 * top-level expansionMessages plus nested section, placement and wizard errors.
 */
export function collectLocalDiagnostics(
  targets: Array<{ configurationId: string; raw: Obj }>,
): LocalMessage[] {
  const out: LocalMessage[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    walkDiagnostics(target.raw, '$', undefined, target.configurationId, out, seen);
  }
  return out;
}

/** Backward-compatible name; now includes all known nested local diagnostics. */
export function collectExpansionMessages(
  targets: Array<{ configurationId: string; raw: Obj }>,
): LocalMessage[] {
  return collectLocalDiagnostics(targets);
}

export function summariseValidation(
  server: LmcValidationResult | undefined,
  localDiagnostics: LocalMessage[],
): ValidationReport {
  const messages = server?.messages ?? [];
  const authoritative = countMessages(messages);
  const local = countMessages(localDiagnostics);
  const status = server?.status ?? 'unavailable';
  return {
    server,
    messages,
    localDiagnostics,
    status,
    ...authoritative,
    localErrorCount: local.errorCount,
    localWarningCount: local.warningCount,
    localInfoCount: local.infoCount,
    isValid: status === 'valid' && local.errorCount === 0,
  };
}

function parseReportLine(line: string): LocalMessage {
  const matched = /^(ERROR|WARN(?:ING)?|INFO)\s*-\s*(.*)$/i.exec(line);
  if (!matched) return { severity: 'error', message: line };
  const label = matched[1]?.toLowerCase();
  const severity: LocalMessage['severity'] =
    label === 'error' ? 'error' : label?.startsWith('warn') ? 'warning' : 'info';
  return { severity, message: matched[2]?.trim() || line };
}

function walkDiagnostics(
  value: unknown,
  path: string,
  section: string | undefined,
  configurationId: string,
  out: LocalMessage[],
  seen: Set<string>,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      walkDiagnostics(entry, `${path}[${index}]`, section, configurationId, out, seen);
    });
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  const obj = value as Obj;
  const localSection =
    path.includes('.sections[') && typeof obj['name'] === 'string' ? obj['name'] : section;

  for (const [key, child] of Object.entries(obj)) {
    const fallback = DIAGNOSTIC_ARRAYS[key];
    if (fallback && Array.isArray(child)) {
      child.forEach((entry, index) => {
        const message = toLocalMessage(
          entry,
          fallback,
          `${path}.${key}[${index}]`,
          localSection,
          configurationId,
        );
        if (!message) return;
        const identity = [
          message.severity,
          message.code ?? '',
          message.message,
          message.section ?? '',
          message.configurationId ?? '',
        ].join('\u0000');
        if (!seen.has(identity)) {
          seen.add(identity);
          out.push(message);
        }
      });
    }
    walkDiagnostics(child, `${path}.${key}`, localSection, configurationId, out, seen);
  }
}

function toLocalMessage(
  value: unknown,
  fallback: LocalMessage['severity'],
  sourcePath: string,
  section: string | undefined,
  configurationId: string,
): LocalMessage | undefined {
  if (typeof value === 'string') {
    if (value.trim() === '') return undefined;
    return { severity: fallback, message: value, section, configurationId, sourcePath };
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const obj = value as Obj;
  const type = String(obj['severity'] ?? obj['type'] ?? obj['errorType'] ?? '').toLowerCase();
  const severity: LocalMessage['severity'] =
    type === 'error' || type === 'err' || type.includes('error')
      ? 'error'
      : type === 'warn' || type === 'warning' || type.includes('warn')
        ? 'warning'
        : fallback;
  const message =
    nonBlankString(obj['text']) ?? nonBlankString(obj['message']) ?? nonBlankString(obj['description']) ?? nonBlankString(obj['messageKey']);
  if (!message) return undefined;
  return {
    severity,
    code: nonBlankString(obj['code']) ?? nonBlankString(obj['messageKey']),
    message,
    section: nonBlankString(obj['sectionName']) ?? nonBlankString(obj['section']) ?? section,
    configurationId,
    sourcePath,
  };
}

function countMessages(messages: LocalMessage[]): {
  errorCount: number;
  warningCount: number;
  infoCount: number;
} {
  return {
    errorCount: messages.filter((message) => message.severity === 'error').length,
    warningCount: messages.filter((message) => message.severity === 'warning').length,
    infoCount: messages.filter((message) => message.severity === 'info').length,
  };
}

function requestError(phase: ValidationRequestError['phase'], err: unknown): ValidationRequestError {
  const obj = (typeof err === 'object' && err !== null ? err : {}) as Obj;
  const userMessage = nonBlankString(obj['userMessage']);
  const ordinaryMessage = err instanceof Error ? err.message : undefined;
  const status = typeof obj['status'] === 'number' ? obj['status'] : undefined;
  const retryable = typeof obj['retryable'] === 'boolean' ? obj['retryable'] : undefined;
  return {
    phase,
    message: userMessage ?? ordinaryMessage ?? String(err),
    ...(status !== undefined ? { status } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  };
}
