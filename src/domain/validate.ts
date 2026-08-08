import type { DcscHttpClient, RequestCtx } from '../http/request.js';

/**
 * Server-side configuration validation via /lmc_validation.
 *
 * The SPA posts the same payload it builds for export (prepareExportData),
 * then receives a Lenovo Manufacturing Configurator handoff: a build entity
 * number, uuid, and deep link. Detailed rule text may also live on the
 * configuration as expansionMessages from autoDerive; both are surfaced.
 */

export interface LmcValidationStart {
  buildEntityNumber?: string | undefined;
  uuid?: string | undefined;
  lmcURL?: string | undefined;
  raw: unknown;
}

export interface LocalMessage {
  severity: 'error' | 'warning' | 'info';
  code?: string | undefined;
  message: string;
  section?: string | undefined;
  configurationId?: string | undefined;
}

export interface ValidationReport {
  /** DCSC accepted the validation request and returned an LMC handoff. */
  server: LmcValidationStart | undefined;
  /** Messages already attached to the configuration tree (expansionMessages). */
  messages: LocalMessage[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
  isValid: boolean;
}

type Obj = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Posts the export-shaped workspace/configuration payload to /lmc_validation. */
export async function runLmcValidation(
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

  const root = res.raw;
  const entry = Array.isArray(root) ? root[0] : root;
  const o = (typeof entry === 'object' && entry !== null ? entry : {}) as Obj;
  return {
    buildEntityNumber: str(o['buildEntityNumber']),
    uuid: str(o['uuid']),
    lmcURL: str(o['lmcURL']),
    raw: res.raw,
  };
}

/** Collects expansionMessages from one or more raw configurations. */
export function collectExpansionMessages(
  targets: Array<{ configurationId: string; raw: Obj }>,
): LocalMessage[] {
  const out: LocalMessage[] = [];
  for (const t of targets) {
    const msgs = t.raw['expansionMessages'];
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      if (typeof m !== 'object' || m === null) continue;
      const o = m as Obj;
      const type = String(o['type'] ?? o['severity'] ?? 'info').toLowerCase();
      const severity: LocalMessage['severity'] =
        type === 'error' || type === 'err' ? 'error' : type === 'warn' || type === 'warning' ? 'warning' : 'info';
      out.push({
        severity,
        code: str(o['code']),
        message: str(o['text']) ?? str(o['message']) ?? JSON.stringify(m),
        section: str(o['sectionName']) ?? str(o['section']),
        configurationId: t.configurationId,
      });
    }
  }
  return out;
}

export function summariseValidation(
  server: LmcValidationStart | undefined,
  messages: LocalMessage[],
): ValidationReport {
  const errorCount = messages.filter((m) => m.severity === 'error').length;
  const warningCount = messages.filter((m) => m.severity === 'warning').length;
  const infoCount = messages.filter((m) => m.severity === 'info').length;
  return {
    server,
    messages,
    errorCount,
    warningCount,
    infoCount,
    isValid: errorCount === 0,
  };
}
