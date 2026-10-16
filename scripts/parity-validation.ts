/**
 * Strict manufacturing-validation parity gate over real MCP stdio.
 *
 * This gate never treats a descriptor, job id, HTTP success, or local rule
 * diagnostics as a manufacturing verdict. A release pass requires terminal
 * `valid` and `invalid` responses from `/lmc_validation/result` for the exact
 * current export payloads. Pending, unknown and unavailable are blocked.
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { ConfigSchema } from '../src/config/schema.js';
import { buildExportData } from '../src/domain/reduce.js';
import { validationPayloadSha256 } from '../src/domain/validationJobs.js';
import { SessionStore } from '../src/session/SessionStore.js';
import { loadSessions } from '../src/session/persist.js';
import { readJsonProjection } from './lib/read-json-projection.js';

type Json = Record<string, unknown>;
type Verdict = 'valid' | 'invalid';
type Outcome = 'pass' | 'fail' | 'blocked';

const MAX_TOOL_BYTES = 8_000;
const SOURCE_XML = path.resolve('test/fixtures/parity/xml/one-rack-sr630-v3.xml');

interface CallResult {
  json: unknown;
  isError: boolean;
  bytes: number;
  elapsedMs: number;
}

interface CaseResult {
  name: string;
  expected: Verdict;
  outcome: Outcome;
  report: Json;
  job: Json;
  export: Json;
  canonicalPayloadSha256: string;
  inspection: InspectionResult;
  reason?: string;
}

interface InspectionResult {
  reconstructedJobFields: number;
  authoritativeMessages: number;
  authoritativeCounts: { error: number; warning: number; info: number };
  localDiagnostics: number;
  localCounts: { error: number; warning: number; info: number };
  headroomConfigurations: number;
  directCompacted: boolean;
  continuationsExecuted: string[];
}

function parseArgs(argv = process.argv.slice(2)): { outDir: string; keepRuntime: boolean } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let outDir = path.resolve(`artifacts/parity-validation/${stamp}`);
  let keepRuntime = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--out') {
      const value = argv[++index];
      if (!value) throw new Error('--out requires a path.');
      outDir = path.resolve(value);
    } else if (argument === '--keep-runtime') {
      keepRuntime = true;
    } else {
      throw new Error(`Unknown argument ${argument}.`);
    }
  }
  return { outDir, keepRuntime };
}

class McpRunner {
  readonly client = new Client({ name: 'parity-validation', version: '1.0.0' });
  readonly transport: StdioClientTransport;
  #sequence = 0;
  #stderr = '';

  constructor(readonly outDir: string, configFile: string) {
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/server.ts'],
      cwd: process.cwd(),
      stderr: 'pipe',
      maxBufferSize: 12 * 1024 * 1024,
      env: cleanEnvironment({
        DCSC_CONFIG: configFile,
        DCSC_LOG_LEVEL: 'error',
      }),
    });
    this.transport.stderr?.on('data', (chunk: Buffer | string) => {
      this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-100_000);
    });
  }

  async start(): Promise<void> {
    await this.client.connect(this.transport);
    const listed = await this.client.listTools(undefined, { timeout: 300_000 });
    assert(listed.tools.some(tool => tool.name === 'dcsc_validate'));
    assert(listed.tools.some(tool => tool.name === 'dcsc_validation_jobs'));
  }

  async call(name: string, args: Json): Promise<CallResult> {
    const started = Date.now();
    const raw = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
    const text = (raw.content as Array<{ type?: string; text?: string }> | undefined)
      ?.find(entry => entry.type === 'text')?.text ?? '';
    let json: unknown = text;
    try { json = JSON.parse(text) as unknown; } catch { /* Preserve non-JSON evidence. */ }
    const result = {
      json,
      isError: raw.isError === true,
      bytes: Buffer.byteLength(text),
      elapsedMs: Date.now() - started,
    };
    assert(result.bytes < MAX_TOOL_BYTES, `${name} returned ${result.bytes} bytes.`);
    this.#sequence += 1;
    await writeFile(path.join(this.outDir,
      `${String(this.#sequence).padStart(3, '0')}-${safeName(name)}.json`),
    `${JSON.stringify({ name, arguments: args, ...result }, null, 2)}\n`);
    if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(json)}`);
    return result;
  }

  async close(): Promise<void> {
    await this.client.close();
    await writeFile(path.join(this.outDir, 'server-stderr.log'), this.#stderr);
  }
}

async function inspectJob(
  runner: McpRunner,
  session: string,
  jobId: string,
  directReport?: Json,
): Promise<Json> {
  const fallback = {
    tool: 'dcsc_validation_jobs',
    arguments: { session, jobId, path: [], offset: 0, limit: 50 },
  };
  const savedJob = directReport?.['compacted'] === true
    ? continuation(object(object(directReport['pages'])['savedJob'])['inspect'], session, jobId, [])
    : fallback;
  return object(await readJsonProjection(
    async (name, args) => object((await runner.call(name, args)).json),
    savedJob,
    'object',
  ));
}

function continuation(value: unknown, session: string, jobId: string, expectedPath: string[]): {
  tool: string;
  arguments: Json;
} {
  const link = object(value);
  assert.equal(link['tool'], 'dcsc_validation_jobs');
  const args = object(link['arguments']);
  assert.equal(args['session'], session);
  assert.equal(args['jobId'], jobId);
  assert.deepEqual(args['path'], expectedPath);
  assert.equal(args['offset'], 0);
  assert(number(args['limit']) > 0);
  return { tool: string(link['tool']), arguments: args };
}

function severityCounts(messages: unknown[]): { error: number; warning: number; info: number } {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const value of messages) {
    const severity = string(object(value)['severity']);
    assert(severity === 'error' || severity === 'warning' || severity === 'info',
      `Unexpected validation severity ${severity}.`);
    counts[severity] += 1;
  }
  return counts;
}

async function verifyInspection(
  runner: McpRunner,
  session: string,
  report: Json,
  job: Json,
): Promise<InspectionResult> {
  const jobId = string(report['jobId']);
  const savedReport = object(job['report']);
  const projection = object(job['projection']);
  const authoritativeMessages = array(savedReport['messages']);
  const localDiagnostics = array(projection['localDiagnostics']);
  const headroom = array(projection['headroom']);
  const authoritativeCounts = severityCounts(authoritativeMessages);
  const localCounts = severityCounts(localDiagnostics);

  assert.equal(report['errorCount'], authoritativeCounts.error);
  assert.equal(report['warningCount'], authoritativeCounts.warning);
  assert.equal(report['infoCount'], authoritativeCounts.info);
  assert.equal(report['localErrorCount'], localCounts.error);
  assert.equal(report['localWarningCount'], localCounts.warning);
  assert.equal(report['localInfoCount'], localCounts.info);
  assert.deepEqual(projection['validatedScope'], report['validatedScope']);
  assert.equal(projection['rackDataOmitted'], report['rackDataOmitted']);
  const validatedScope = object(projection['validatedScope']);
  assert.equal(headroom.length, validatedScope['configurations']);
  for (const value of headroom) {
    const entry = object(value);
    assert.equal(typeof entry['configuration'], 'string');
    assert.equal(typeof entry['productCode'], 'string');
    array(entry['constraints']);
    array(entry['breached']);
  }

  const continuationsExecuted: string[] = [];
  if (report['compacted'] === true) {
    const pages = object(report['pages']);
    const checks = [
      ['messages', ['report', 'messages'], authoritativeMessages],
      ['localDiagnostics', ['projection', 'localDiagnostics'], localDiagnostics],
      ['headroom', ['projection', 'headroom'], headroom],
    ] as const;
    for (const [name, expectedPath, expected] of checks) {
      const page = object(pages[name]);
      assert.equal(page['total'], expected.length, `${name} page total does not match the saved job.`);
      assert.equal(report[`${name}Returned`], array(report[name]).length,
        `${name} returned count does not match the inline preview.`);
      assert(number(report[`${name}Returned`]) <= expected.length,
        `${name} inline preview exceeds the complete saved collection.`);
      const link = continuation(page['inspect'], session, jobId, [...expectedPath]);
      const reconstructed = await readJsonProjection(
        async (tool, args) => object((await runner.call(tool, args)).json), link, 'array',
      );
      assert.deepEqual(reconstructed, expected, `${name} continuation did not reconstruct the saved job.`);
      continuationsExecuted.push(name);
    }
  } else {
    assert.deepEqual(report['messages'], authoritativeMessages);
    assert.deepEqual(report['localDiagnostics'], localDiagnostics);
    assert.deepEqual(report['headroom'], headroom);
  }

  return {
    reconstructedJobFields: Object.keys(job).length,
    authoritativeMessages: authoritativeMessages.length,
    authoritativeCounts,
    localDiagnostics: localDiagnostics.length,
    localCounts,
    headroomConfigurations: headroom.length,
    directCompacted: report['compacted'] === true,
    continuationsExecuted,
  };
}

function canonicalWorkspaceHash(sessionFile: string, artifactDir: string, workspaceId: string): string {
  const config = ConfigSchema.parse({
    files: { persistSessions: true, sessionFile, artifactDir },
    logLevel: 'error',
  });
  const store = new SessionStore(100);
  const count = loadSessions(store, config);
  assert(count > 0, 'No persisted workspace was available for payload verification.');
  const workspace = store.getWorkspace(workspaceId);
  assert(workspace, `Persisted workspace ${workspaceId} was not found.`);
  const payload = buildExportData({
    workspace,
    solution: workspace.solution,
    fileTypes: ['XML'],
    validationMode: workspace.validationMode,
  });
  return validationPayloadSha256(payload, 'cto');
}

function assess(expected: Verdict, report: Json, job: Json): { outcome: Outcome; reason?: string } {
  assert.equal(report['source'], 'lmc_validation');
  assert.match(string(report['jobId']), /^[^:]+:[0-9a-f]{64}:\d+$/);
  assert.match(string(report['payloadSha256']), /^[0-9a-f]{64}$/);
  assert.equal(report['stale'], false);
  assert.equal(job['stale'], false);
  assert.equal(job['validatedRevision'], report['validatedRevision']);
  assert.equal(job['payloadSha256'], report['payloadSha256']);

  const status = string(report['status']);
  if (status === 'pending' || status === 'unknown' || status === 'unavailable') {
    assert.equal(report['isValid'], false);
    assert.equal(job['isValid'], false);
    assert.equal(report['freshValidationRequired'], true);
    return {
      outcome: 'blocked',
      reason: `Authoritative result is ${status}: ${String(report['warning'] ?? 'no terminal result')}`,
    };
  }

  assert.equal(job['terminal'], true, 'A non-terminal job cannot establish a verdict.');
  assert.equal(status, expected, `Expected terminal ${expected}, received ${status}.`);
  assert.equal(job['currentStatus'], expected);
  if (expected === 'valid') {
    assert.equal(report['isValid'], true);
    assert.equal(job['isValid'], true);
    assert.equal(report['errorCount'], 0);
    assert.equal(report['localErrorCount'], 0);
  } else {
    assert.equal(report['isValid'], false);
    assert.equal(job['isValid'], false);
    assert(number(report['errorCount']) > 0, 'Invalid verdict contained no authoritative errors.');
  }
  return { outcome: 'pass' };
}

async function validateCase(input: {
  runner: McpRunner;
  name: string;
  expected: Verdict;
  workspace: string;
  sessionFile: string;
  artifactDir: string;
  outDir: string;
}): Promise<CaseResult> {
  const exported = object((await input.runner.call('dcsc_export', {
    session: input.workspace,
    scope: 'workspace',
    fileName: input.name,
    fileTypes: ['XML'],
  })).json);
  assert.equal(exported['configurationsExported'], 2);
  const xmlPath = string(exported['xml']);
  const xml = readFileSync(xmlPath, 'utf8');
  const normalizedXml = xml.replaceAll('-', '');
  assert(normalizedXml.includes('7D6DCTO1WW') && normalizedXml.includes('7D73CTO1WW'),
    'Export XML omitted a configuration included in the validation workspace.');
  copyFileSync(xmlPath, path.join(input.outDir, `${input.name}.xml`));

  const report = object((await input.runner.call('dcsc_validate', {
    session: input.workspace,
    deadlineMs: 300_000,
  })).json);
  const job = await inspectJob(input.runner, input.workspace, string(report['jobId']), report);
  const inspection = await verifyInspection(input.runner, input.workspace, report, job);
  const canonicalPayloadSha256 = canonicalWorkspaceHash(
    input.sessionFile, input.artifactDir, input.workspace,
  );
  assert.equal(report['payloadSha256'], canonicalPayloadSha256,
    'Validation job was not bound to the current canonical workspace export payload.');
  const assessed = assess(input.expected, report, job);
  return {
    name: input.name,
    expected: input.expected,
    outcome: assessed.outcome,
    report,
    job,
    export: exported,
    canonicalPayloadSha256,
    inspection,
    ...(assessed.reason ? { reason: assessed.reason } : {}),
  };
}

async function main(): Promise<void> {
  const options = parseArgs();
  mkdirSync(options.outDir, { recursive: true });
  const runtime = mkdtempSync(path.join(tmpdir(), 'dcsc-parity-validation-'));
  const sessionFile = path.join(runtime, 'state', 'sessions.json');
  const artifactDir = path.join(runtime, 'artifacts');
  const configFile = path.join(runtime, 'config.json');
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify({
    files: { persistSessions: true, sessionFile, artifactDir },
    logLevel: 'error',
  }));
  await mkdir(artifactDir, { recursive: true });

  const runner = new McpRunner(options.outDir, configFile);
  const cases: CaseResult[] = [];
  try {
    await runner.start();
    const imported = object((await runner.call('dcsc_import', {
      filePath: SOURCE_XML,
      mode: 'cto',
    })).json);
    const workspace = string(imported['workspace']);
    const sessions = array(imported['sessions']).map(object);
    const server = sessions.find(session => session['productCode'] === '7D73CTO1WW');
    assert(server, 'Imported validation fixture did not contain its SR630 V3 server.');
    assert.equal(sessions.length, 2);

    const valid = await validateCase({
      runner, name: 'current-valid-candidate', expected: 'valid', workspace,
      sessionFile, artifactDir, outDir: options.outDir,
    });
    cases.push(valid);

    const controls = object((await runner.call('dcsc_set_configuration_controls', {
      session: workspace,
      validationMode: 'expert',
      autoCorrect: false,
      expectedRevision: number(valid.report['validatedRevision']),
    })).json);
    const changed = object((await runner.call('dcsc_configure', {
      session: string(server['id']),
      changes: [{ section: 'processors.processor', code: 'BYW3', quantity: 0 }],
      expectedRevision: number(controls['revision']),
    })).json);
    assert.equal(changed['applied'], true);
    assert(array(changed['removed']).some(item => object(item)['code'] === 'BYW3'));

    const staleJob = await inspectJob(runner, workspace, string(valid.report['jobId']));
    assert.equal(staleJob['stale'], true, 'A canonical edit did not stale the prior validation job.');
    assert.equal(staleJob['isValid'], false);
    assert.equal(staleJob['currentStatus'], 'unavailable');
    assert.equal(staleJob['freshValidationRequired'], true);

    const current = object((await runner.call('dcsc_session_info', {
      session: string(server['id']),
    })).json);
    assert(number(current['revision']) > number(valid.report['validatedRevision']));

    const invalid = await validateCase({
      runner, name: 'current-invalid-no-processor', expected: 'invalid', workspace,
      sessionFile, artifactDir, outDir: options.outDir,
    });
    assert(number(invalid.report['localErrorCount']) > 0,
      'The deliberate no-processor state did not retain its local rule errors.');
    cases.push(invalid);

    const outcome: Outcome = cases.some(entry => entry.outcome === 'fail')
      ? 'fail'
      : cases.some(entry => entry.outcome === 'blocked') ? 'blocked' : 'pass';
    const summary = {
      outcome,
      strictReleaseGate: true,
      sourceXml: path.relative(process.cwd(), SOURCE_XML),
      workspace,
      revisionBinding: {
        originalJobId: valid.report['jobId'],
        validatedRevision: valid.report['validatedRevision'],
        staleAfterEdit: staleJob['stale'],
        currentStatusAfterEdit: staleJob['currentStatus'],
        freshValidationRequired: staleJob['freshValidationRequired'],
      },
      cases: cases.map(entry => ({
        name: entry.name,
        expected: entry.expected,
        outcome: entry.outcome,
        actualStatus: entry.report['status'],
        isValid: entry.report['isValid'],
        terminal: entry.job['terminal'],
        authoritativeErrors: entry.report['errorCount'],
        localErrors: entry.report['localErrorCount'],
        payloadSha256: entry.report['payloadSha256'],
        payloadMatchesCanonicalExport: entry.report['payloadSha256'] === entry.canonicalPayloadSha256,
        inspection: entry.inspection,
        reason: entry.reason,
      })),
    };
    await writeFile(path.join(options.outDir, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode = outcome === 'fail' ? 1 : outcome === 'blocked' ? 2 : 0;
  } catch (error) {
    const report = { outcome: 'fail', strictReleaseGate: true, error: errorMessage(error), cases };
    await writeFile(path.join(options.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await runner.close().catch(() => undefined);
    if (!options.keepRuntime) rmSync(runtime, { recursive: true, force: true });
  }
}

function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)),
    ...extra,
  };
}

function object(value: unknown): Json {
  assert(value && typeof value === 'object' && !Array.isArray(value), `Expected object, got ${typeof value}.`);
  return value as Json;
}

function array(value: unknown): unknown[] {
  assert(Array.isArray(value), 'Expected array.');
  return value;
}

function string(value: unknown): string {
  assert.equal(typeof value, 'string');
  return value as string;
}

function number(value: unknown): number {
  assert.equal(typeof value, 'number');
  return value as number;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

await main();
