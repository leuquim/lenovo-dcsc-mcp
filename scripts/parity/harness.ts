import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';

import { startMcp, type McpMode, type WireRequest } from './mcp.js';
import { createWeb } from './web.js';

export { normalizers, sha256 } from './normalizers.js';
export type { Json } from './mcp.js';

export type Status = 'pass' | 'fail' | 'known-difference' | 'blocked';
export type Normalizer = (value: unknown) => unknown;

export interface Diff { path: string; web: unknown; mcp: unknown }
export interface ExpectedDifference extends Diff { doc: string }

/** Query keys only the website's own client adds; they carry no configuration state. */
const CLIENT_QUERY_KEYS = new Set(['countryName', 'current_country_or_region', 'controlExpressModal', '_request']);
/** Preamble keys the MCP client sends on every request; the website omits some per request, so they compare only where it sends them. */
const PREAMBLE_QUERY_KEYS = new Set(['geo', 'country_or_region', 'language', 'currency', 'solutionMode', 'masterSlices', 'sbSlices']);

/** A website request captured with page.on('request'); body is the decoded form fields or JSON. */
export interface CapturedRequest { method: string; path: string; query?: Record<string, unknown>; body?: unknown }

interface StepRecord { name: string; ms: number; ok: boolean; error?: string }
interface CompareRecord {
  name: string;
  status: 'pass' | 'fail' | 'known-difference';
  unexpected: Diff[];
  known: ExpectedDifference[];
  stale: ExpectedDifference[];
}
interface SkipRecord { name: string; reason: string; status: 'blocked' | 'fail'; upstreamError?: string }

export interface ParityCase {
  id: string;
  tags: string[];
  /** 'in-process' runs the server in the harness process so upstream requests can be recorded. Default 'stdio'. */
  mode?: McpMode;
  run(h: Harness): Promise<void>;
}

export interface Report {
  case: string;
  status: Status;
  failure?: string;
  gitSha: string;
  startedAt: string;
  steps: StepRecord[];
  compares: CompareRecord[];
  skips: SkipRecord[];
  mcpCalls: number;
  maxResponseBytes: number;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const errorText = (error: unknown) => error instanceof Error ? error.stack ?? error.message : String(error);

export function diff(web: unknown, mcp: unknown, at = '$'): Diff[] {
  if (isDeepStrictEqual(web, mcp)) return [];
  if (isPlainObject(web) && isPlainObject(mcp)) {
    return [...new Set([...Object.keys(web), ...Object.keys(mcp)])]
      .flatMap(key => diff(web[key], mcp[key], `${at}.${key}`));
  }
  if (Array.isArray(web) && Array.isArray(mcp)) {
    return Array.from({ length: Math.max(web.length, mcp.length) }, (_, index) => index)
      .flatMap(index => diff(web[index], mcp[index], `${at}[${index}]`));
  }
  return [{ path: at, web, mcp }];
}

const sameDifference = (left: Diff, right: Diff) =>
  left.path === right.path && isDeepStrictEqual(left.web, right.web) && isDeepStrictEqual(left.mcp, right.mcp);

function caseStatus(steps: StepRecord[], compares: CompareRecord[], skips: SkipRecord[]): Pick<Report, 'status' | 'failure'> {
  if (steps.some(step => !step.ok)) return { status: 'fail', failure: 'step-threw' };
  if (compares.some(entry => entry.status === 'fail')) return { status: 'fail', failure: 'unexpected-or-stale-difference' };
  if (skips.some(entry => entry.status === 'fail')) return { status: 'fail', failure: 'stale-block' };
  if (compares.length === 0 && skips.length === 0) return { status: 'fail', failure: 'no-evidence' };
  if (skips.length > 0) return { status: 'blocked' };
  if (compares.some(entry => entry.status === 'known-difference')) return { status: 'known-difference' };
  return { status: 'pass' };
}

function gitSha(): string {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

export async function createHarness(caseId: string, mode: McpMode = 'stdio', artifactsRoot = 'artifacts/parity') {
  const startedAt = new Date().toISOString();
  const out = path.resolve(artifactsRoot, caseId, startedAt.replace(/[:.]/g, '-'));
  await mkdir(out, { recursive: true });
  const mcp = await startMcp(out, mode);
  const web = createWeb(out);
  const steps: StepRecord[] = [];
  const compares: CompareRecord[] = [];
  const skips: SkipRecord[] = [];

  const harness = {
    out,
    mcp,
    web,
    async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const started = Date.now();
      try {
        const value = await fn();
        steps.push({ name, ms: Date.now() - started, ok: true });
        return value;
      } catch (error) {
        steps.push({ name, ms: Date.now() - started, ok: false, error: errorText(error) });
        throw error;
      }
    },
    compare(name: string, webEvidence: unknown, mcpEvidence: unknown,
      options: { normalize?: Normalizer; expectedDifferences?: ExpectedDifference[] } = {}): void {
      const normalize = options.normalize ?? ((value: unknown) => value);
      const expected = options.expectedDifferences ?? [];
      const found = diff(normalize(webEvidence), normalize(mcpEvidence));
      const known = expected.filter(entry => found.some(item => sameDifference(item, entry)));
      const stale = expected.filter(entry => !known.includes(entry));
      const unexpected = found.filter(item => !expected.some(entry => sameDifference(item, entry)));
      const status = unexpected.length > 0 || stale.length > 0 ? 'fail' : known.length > 0 ? 'known-difference' : 'pass';
      compares.push({ name, status, unexpected, known, stale });
    },
    /** Request-shape parity: the website's captured request against a request recorded in `mcp.requests`. */
    compareRequest(name: string, webCapture: CapturedRequest, mcpRequest: WireRequest,
      options: { normalize?: Normalizer; expectedDifferences?: ExpectedDifference[] } = {}): void {
      const normalize = options.normalize ?? ((value: unknown) => value);
      const apiPath = (value: string) => value.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api(?=\/)/, '').split('?')[0];
      const pathQuery = (value: string) => Object.fromEntries([...new URL(value, 'https://dcsc.lenovo.com').searchParams]
        .filter(([key]) => !CLIENT_QUERY_KEYS.has(key)));
      const named = (query: Record<string, unknown>) => Object.fromEntries(Object.entries(query)
        .filter(([key]) => !CLIENT_QUERY_KEYS.has(key))
        .map(([key, value]) => [key, key === 'fileName' ? '<file name>' : String(value)]));
      const shape = (method: string, requestPath: string, query: Record<string, unknown> | undefined, body: unknown) =>
        ({ method, path: apiPath(requestPath), query: named(query ?? pathQuery(requestPath)), body: normalize(body) });
      const mcpBody = mcpRequest.body?.kind === 'form' ? mcpRequest.body.fields
        : mcpRequest.body?.kind === 'json' ? mcpRequest.body.value : mcpRequest.body;
      const web = shape(webCapture.method, webCapture.path, webCapture.query, webCapture.body);
      const mcp = shape(mcpRequest.method, mcpRequest.path, mcpRequest.query, mcpBody);
      for (const key of PREAMBLE_QUERY_KEYS) {
        if (web.query[key] === '') delete web.query[key];
        if (!(key in web.query)) delete mcp.query[key];
      }
      harness.compare(name, web, mcp, options.expectedDifferences ? { expectedDifferences: options.expectedDifferences } : {});
    },
    /** Records a blocked check; `probe` re-attempts the blocked call and must still throw the upstream error. */
    async skip(name: string, reason: string, probe: () => Promise<unknown>): Promise<void> {
      try {
        await probe();
        skips.push({ name, reason, status: 'fail', upstreamError: 'The blocked call now succeeds; remove the skip.' });
      } catch (error) {
        skips.push({ name, reason, status: 'blocked', upstreamError: errorText(error) });
      }
    },
  };

  return {
    harness,
    async finish(thrown?: unknown): Promise<Report> {
      if (thrown !== undefined && !steps.some(step => !step.ok)) {
        steps.push({ name: 'case', ms: 0, ok: false, error: errorText(thrown) });
      }
      await harness.web.close();
      await harness.mcp.close();
      const report: Report = {
        case: caseId, ...caseStatus(steps, compares, skips), gitSha: gitSha(), startedAt, steps, compares, skips,
        mcpCalls: mcp.calls.length, maxResponseBytes: Math.max(0, ...mcp.calls.map(call => call.bytes)),
      };
      await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
      return report;
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>['harness'];
