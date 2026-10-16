/**
 * Persistence recovery and legacy-reconciliation parity gate over real MCP stdio.
 *
 * Offline proves corrupt source bytes remain inspectable/exportable across a
 * restart. Live migrates a historical-v1 serializer envelope containing the
 * captured SR630 V3 configuration, reconciles it explicitly, kills the server
 * immediately after the acknowledged apply, restarts, exports and starts a
 * fresh authoritative manufacturing validation.
 *
 * Run:
 *   npx tsx scripts/parity-recovery.ts --suite=all
 *   npx tsx scripts/parity-recovery.ts --suite=offline
 *   npx tsx scripts/parity-recovery.ts --suite=live
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { ConfigSchema } from '../src/config/schema.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { validationPayloadSha256 } from '../src/domain/validationJobs.js';
import type { RawConfiguration } from '../src/model/types.js';
import { SessionStore } from '../src/session/SessionStore.js';
import { loadSessions } from '../src/session/persist.js';

type Json = Record<string, unknown>;
type Suite = 'all' | 'offline' | 'live';

interface RunnerOptions {
  suite: Suite;
  outDir: string;
  keepRuntime: boolean;
  timeoutMs: number;
}

interface CallResult {
  json: unknown;
  isError: boolean;
  bytes: number;
  elapsedMs: number;
}

interface CaseResult {
  name: string;
  status: 'pass' | 'fail' | 'blocked';
  evidence?: Json;
  error?: string;
}

const CAPTURED_SR630 = path.resolve('test/fixtures/parity/sr630-launch.json');
const HISTORICAL_SERIALIZER_COMMIT = 'f640bb4cd31e6b3bcd452bfb2fae19e4f7e85a3c';

function parseArgs(argv = process.argv.slice(2)): RunnerOptions {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const options: RunnerOptions = {
    suite: 'all',
    outDir: path.resolve(`artifacts/parity-recovery/${stamp}`),
    keepRuntime: false,
    timeoutMs: 300_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument.startsWith('--suite=')) {
      const suite = argument.slice('--suite='.length);
      if (suite !== 'all' && suite !== 'offline' && suite !== 'live') {
        throw new Error(`Unknown suite ${suite}. Use all, offline or live.`);
      }
      options.suite = suite;
    } else if (argument === '--out' || argument === '--timeout-ms') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      if (argument === '--out') options.outDir = path.resolve(value);
      else {
        const timeout = Number(value);
        if (!Number.isSafeInteger(timeout) || timeout < 1_000) {
          throw new Error('--timeout-ms must be an integer of at least 1000.');
        }
        options.timeoutMs = timeout;
      }
      index += 1;
    } else if (argument === '--keep-runtime') {
      options.keepRuntime = true;
    } else {
      throw new Error(`Unknown argument ${argument}.`);
    }
  }
  return options;
}

class StdioMcp {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly calls: Array<{ name: string; arguments: Json; result: CallResult }> = [];
  #stderr = '';
  #sequence = 0;

  private constructor(
    readonly name: string,
    readonly outDir: string,
    readonly timeoutMs: number,
    transport: StdioClientTransport,
  ) {
    this.transport = transport;
    this.client = new Client({ name: `parity-recovery-${name}`, version: '1.0.0' });
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-100_000);
    });
  }

  static async start(input: {
    name: string;
    outDir: string;
    timeoutMs: number;
    configFile: string;
  }): Promise<StdioMcp> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/server.ts'],
      cwd: process.cwd(),
      stderr: 'pipe',
      maxBufferSize: 12 * 1024 * 1024,
      env: {
        ...cleanEnvironment(),
        DCSC_CONFIG: input.configFile,
        DCSC_LOG_LEVEL: 'error',
      },
    });
    const instance = new StdioMcp(
      input.name, input.outDir, input.timeoutMs, transport,
    );
    await instance.client.connect(transport);
    const tools = await instance.client.listTools(undefined, { timeout: input.timeoutMs });
    assert(tools.tools.length >= 62, `Expected at least 62 tools, received ${tools.tools.length}.`);
    return instance;
  }

  async call(name: string, args: Json, expectError = false): Promise<CallResult> {
    const started = Date.now();
    const raw = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: this.timeoutMs },
    );
    const content = (raw as { content?: Array<{ type?: string; text?: string }>; isError?: boolean }).content ?? [];
    const text = content.find((entry) => entry.type === 'text')?.text ?? '';
    let json: unknown = text;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      // A plain-text tool response is still retained as evidence.
    }
    const result: CallResult = {
      json,
      isError: raw.isError === true,
      bytes: Buffer.byteLength(text),
      elapsedMs: Date.now() - started,
    };
    this.calls.push({ name, arguments: structuredClone(args), result });
    this.#sequence += 1;
    await writeFile(
      path.join(this.outDir,
        `${safeName(this.name)}-${String(this.#sequence).padStart(3, '0')}-${safeName(name)}.json`),
      `${JSON.stringify({ name, arguments: args, ...result }, null, 2)}\n`,
    );
    if (result.isError !== expectError) {
      throw new Error(
        `${name} ${expectError ? 'succeeded but an error was expected' : `failed: ${JSON.stringify(json)}`}`,
      );
    }
    return result;
  }

  async close(): Promise<void> {
    await this.client.close();
    await writeFile(path.join(this.outDir, `${safeName(this.name)}-stderr.log`), this.#stderr);
  }

  async killAfterAcknowledgement(): Promise<void> {
    const pid = this.transport.pid;
    assert(pid, 'MCP transport has no child process id.');
    process.kill(pid, 'SIGKILL');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          await writeFile(path.join(this.outDir, `${safeName(this.name)}-stderr.log`), this.#stderr);
          return;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`MCP process ${pid} did not exit after SIGKILL.`);
  }
}

async function offlineRecoveryCase(options: RunnerOptions): Promise<CaseResult> {
  const name = 'offline-corrupt-source-recovery';
  const caseDir = path.join(options.outDir, name);
  const runtime = mkdtempSync(path.join(tmpdir(), 'dcsc-parity-recovery-offline-'));
  let first: StdioMcp | undefined;
  let restarted: StdioMcp | undefined;
  await mkdir(caseDir, { recursive: true });
  try {
    const sessionFile = path.join(runtime, 'state', 'sessions.json');
    const artifactDir = path.join(runtime, 'artifacts');
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    const original = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a]);
    writeFileSync(sessionFile, original);
    const configFile = writeConfig(runtime, sessionFile, artifactDir);

    first = await StdioMcp.start({
      name: `${name}-first`, outDir: caseDir, timeoutMs: options.timeoutMs, configFile,
    });
    const health = object((await first.call('dcsc_health', {})).json);
    const recovery = object(health['recovery']);
    assert.equal(recovery['archiveCount'], 1);
    assert.equal(object(recovery['inspect'])['tool'], 'dcsc_recovery_inspect');

    const inspected = object((await first.call('dcsc_recovery_inspect', {
      path: ['recoveryArchives'], offset: 0, limit: 1,
    })).json);
    const archive = object(object(array(inspected['items'])[0])['value']);
    const archiveId = string(archive['id']);
    assert.match(archiveId, /^recovery_[0-9a-f]{64}$/);
    assert.equal(archive['bytes'], original.length);

    const exported = object((await first.call('dcsc_recovery_export', { archiveId })).json);
    const exportPath = string(exported['path']);
    const exportedBytes = readFileSync(exportPath);
    assert.deepEqual(exportedBytes, original);
    assert.equal(exported['sha256'], sha256(original));
    assert.equal(exported['format'], 'lenovo-dcsc-session-source-bytes');
    await first.close();
    first = undefined;

    restarted = await StdioMcp.start({
      name: `${name}-restart`, outDir: caseDir, timeoutMs: options.timeoutMs, configFile,
    });
    const afterRestart = object((await restarted.call('dcsc_recovery_inspect', {
      path: ['recoveryArchives'], offset: 0, limit: 10,
    })).json);
    const ids = array(afterRestart['items']).map((item) =>
      string(object(object(item)['value'])['id']));
    assert(ids.includes(archiveId), 'Recovery archive disappeared after restart.');
    await restarted.close();
    restarted = undefined;

    return {
      name,
      status: 'pass',
      evidence: {
        archiveId,
        bytes: original.length,
        sha256: sha256(original),
        exactBytesExported: true,
        retainedAfterRestart: true,
      },
    };
  } catch (error) {
    return { name, status: 'fail', error: errorMessage(error) };
  } finally {
    await first?.close().catch(() => undefined);
    await restarted?.close().catch(() => undefined);
    if (!options.keepRuntime) rmSync(runtime, { recursive: true, force: true });
  }
}

async function liveLegacyCase(options: RunnerOptions): Promise<CaseResult> {
  const name = 'live-legacy-reconcile-handoff';
  const caseDir = path.join(options.outDir, name);
  const runtime = mkdtempSync(path.join(tmpdir(), 'dcsc-parity-recovery-live-'));
  let first: StdioMcp | undefined;
  let restarted: StdioMcp | undefined;
  await mkdir(caseDir, { recursive: true });
  try {
    const sessionFile = path.join(runtime, 'state', 'sessions.json');
    const artifactDir = path.join(runtime, 'artifacts');
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    const captured = JSON.parse(readFileSync(CAPTURED_SR630, 'utf8')) as RawConfiguration;
    const envelope = historicalV1Envelope(captured);
    const source = Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8');
    writeFileSync(sessionFile, source);
    await writeFile(path.join(caseDir, 'historical-v1-source-sha256.json'), `${JSON.stringify({
      serializerCommit: HISTORICAL_SERIALIZER_COMMIT,
      capturedConfiguration: path.relative(process.cwd(), CAPTURED_SR630),
      bytes: source.length,
      sha256: sha256(source),
    }, null, 2)}\n`);
    const configFile = writeConfig(runtime, sessionFile, artifactDir);

    first = await StdioMcp.start({
      name: `${name}-first`, outDir: caseDir, timeoutMs: options.timeoutMs, configFile,
    });
    const listed = object((await first.call('dcsc_session_list', { limit: 10 })).json);
    const listedSession = object(array(listed['sessions'])[0]);
    const workspace = string(listedSession['workspace']);
    const session = string(listedSession['session']);
    assert.equal(workspace, 'ws_legacy_recovery');
    assert.equal(session, 'sess_legacy_recovery');

    const before = object((await first.call('dcsc_session_info', { session: workspace })).json);
    assert.equal(before['integrity'], 'legacy-unverified');
    await first.call('dcsc_export', {
      session: workspace, scope: 'workspace', fileName: 'blocked-before-reconciliation', fileTypes: ['XML'],
    }, true);
    await first.call('dcsc_validate', { session: workspace, deadlineMs: 30_000 }, true);

    const proposed = object((await first.call('dcsc_reconcile_workspace', {
      session: workspace, action: 'propose', path: [], offset: 0, limit: 1,
    })).json);
    const proposalId = string(proposed['proposalId']);
    assert.match(proposalId, /^recon_/);

    const reviewEvidence: Json = {};
    reviewEvidence['root'] = await drainInspectPages(first, {
      session: workspace, action: 'inspect', proposalId, path: [], offset: 0, limit: 1,
    });
    assert(number(object(reviewEvidence['root'])['pages']) > 1, 'Root proposal review was not paged.');
    reviewEvidence['diffs'] = await drainInspectPages(first, {
      session: workspace, action: 'inspect', proposalId, path: ['diffs'], offset: 0, limit: 1,
    });
    reviewEvidence['firstDiff'] = await drainInspectPages(first, {
      session: workspace, action: 'inspect', proposalId, path: ['diffs', '0'], offset: 0, limit: 1,
    });
    reviewEvidence['warnings'] = await drainInspectPages(first, {
      session: workspace, action: 'inspect', proposalId, path: ['warnings'], offset: 0, limit: 1,
    });
    await writeFile(path.join(caseDir, 'proposal-review-pages.json'), `${JSON.stringify(reviewEvidence, null, 2)}\n`);

    const applied = object((await first.call('dcsc_reconcile_workspace', {
      session: workspace, action: 'apply', proposalId,
    })).json);
    assert.equal(applied['workspace'], workspace);
    assert.equal(applied['integrity'], 'verified');
    const appliedRevision = number(applied['revision']);
    await first.killAfterAcknowledgement();
    first = undefined;

    restarted = await StdioMcp.start({
      name: `${name}-restart`, outDir: caseDir, timeoutMs: options.timeoutMs, configFile,
    });
    const restored = object((await restarted.call('dcsc_session_info', { session: workspace })).json);
    assert.equal(restored['integrity'], 'verified');
    const restoredConfigurationRevision = number(restored['revision']);
    assert(
      restoredConfigurationRevision >= 3,
      'Reconciled configuration revision did not survive restart.',
    );

    const exported = object((await restarted.call('dcsc_export', {
      session: workspace,
      scope: 'workspace',
      fileName: 'legacy-reconciled-sr630',
      fileTypes: ['XML'],
    })).json);
    assert(number(exported['bytes']) > 0, 'Reconciled export was empty.');
    assert(number(exported['configurationsExported']) === 1);

    const validation = object((await restarted.call('dcsc_validate', {
      session: workspace,
      deadlineMs: Math.min(options.timeoutMs, 300_000),
    })).json);
    const validationStatus = string(validation['status']);
    assert(
      ['valid', 'invalid', 'pending', 'unknown', 'unavailable'].includes(validationStatus),
      `Fresh validation returned an unrecognised status: ${validationStatus}.`,
    );
    assert.equal(validation['stale'], false);
    assert.equal(validation['source'], 'lmc_validation');
    assert.equal(validation['session'], workspace);
    assert.equal(validation['workspaceId'], workspace);
    assert.match(string(validation['payloadSha256']), /^[0-9a-f]{64}$/);
    assert.equal(validation['validatedRevision'], appliedRevision);
    const validatedScope = object(validation['validatedScope']);
    assert.equal(validatedScope['scope'], 'workspace');
    assert.equal(validatedScope['configurations'], 1);
    assert.equal(validatedScope['racksInSolution'], 0);
    assert.equal(validatedScope['racksValidated'], 0);
    const jobId = string(validation['jobId']);
    assert.match(jobId, /^[^:]+:[0-9a-f]{64}:\d+$/);
    const validationJob = await inspectValidationJob(restarted, workspace, jobId);
    const canonicalPayloadSha256 = canonicalWorkspaceHash(sessionFile, artifactDir, workspace);
    assert.equal(validation['payloadSha256'], canonicalPayloadSha256,
      'Validation job was not bound to the reconciled canonical workspace payload.');
    assert.equal(validationJob['id'], jobId);
    assert.equal(validationJob['payloadSha256'], validation['payloadSha256']);
    assert.equal(validationJob['validatedRevision'], validation['validatedRevision']);
    assert.equal(validationJob['stale'], false);
    assert.equal(validationJob['currentStatus'], validationStatus);
    const validationTarget = object(validationJob['target']);
    assert.equal(validationTarget['handle'], workspace);
    assert.equal(validationTarget['scope'], 'workspace');
    assert.equal(validationJob['mode'], 'cto');

    const evidence: Json = {
      serializerCommit: HISTORICAL_SERIALIZER_COMMIT,
      sourceSha256: sha256(source),
      workspace,
      session,
      legacyIntegrity: before['integrity'],
      preReconciliationExportRejected: true,
      preReconciliationValidationRejected: true,
      proposalId,
      proposalStatus: proposed['status'],
      changedConfigurations: proposed['changedConfigurations'],
      proposalReview: structuredClone(reviewEvidence),
      appliedRevision,
      appliedIntegrity: applied['integrity'],
      restoredConfigurationRevision,
      restoredIntegrity: restored['integrity'],
      survivedImmediateSigkill: true,
      exportBytes: exported['bytes'],
      exportSha256: exported['sha256'],
      configurationsExported: exported['configurationsExported'],
      validationStatus,
      validationIsValid: validation['isValid'],
      validationStale: validation['stale'],
      validationFreshRequired: validation['freshValidationRequired'],
      validationJobId: jobId,
      validationJobTerminal: validationJob['terminal'],
      validationJobStatus: validationJob['currentStatus'],
      validationJobStale: validationJob['stale'],
      validationJobFreshRequired: validationJob['freshValidationRequired'],
      validationJobTarget: structuredClone(validationTarget),
      validationJobMode: validationJob['mode'],
      ...(validationJob['observedStatus'] === undefined
        ? {} : { validationJobObservedStatus: validationJob['observedStatus'] }),
      ...(validationJob['error'] === undefined
        ? {} : { validationJobError: structuredClone(validationJob['error']) }),
      validationPayloadSha256: validation['payloadSha256'],
      validationPayloadMatchesCanonicalExport: true,
      validationValidatedRevision: validation['validatedRevision'],
      validationValidatedScope: structuredClone(validatedScope),
      ...(validation['warning'] === undefined ? {} : { validationWarning: validation['warning'] }),
    };

    if (validationStatus === 'pending' || validationStatus === 'unknown' ||
        validationStatus === 'unavailable') {
      assert.equal(validation['isValid'], false);
      assert.equal(validation['freshValidationRequired'], true);
      assert.equal(validationJob['isValid'], false);
      assert.equal(validationJob['terminal'], false);
      assert.equal(validationJob['freshValidationRequired'], true);
      await restarted.close();
      restarted = undefined;
      return {
        name,
        status: 'blocked',
        evidence,
        error: `Fresh validation was not terminal: ${validationStatus}.`,
      };
    }

    assert.equal(validation['freshValidationRequired'], false);
    assert.equal(validation['isValid'], validationStatus === 'valid');
    assert.equal(validationJob['terminal'], true);
    assert.equal(validationJob['freshValidationRequired'], false);
    assert.equal(validationJob['isValid'], validationStatus === 'valid');
    await restarted.close();
    restarted = undefined;

    return {
      name,
      status: 'pass',
      evidence,
    };
  } catch (error) {
    const message = errorMessage(error);
    const blocked = !(error instanceof assert.AssertionError)
      && /403|429|502|503|504|timeout|circuit|waf|network|fetch failed/i.test(message);
    return { name, status: blocked ? 'blocked' : 'fail', error: message };
  } finally {
    await first?.close().catch(() => undefined);
    await restarted?.close().catch(() => undefined);
    if (!options.keepRuntime) rmSync(runtime, { recursive: true, force: true });
  }
}

async function inspectValidationJob(
  client: StdioMcp,
  session: string,
  jobId: string,
): Promise<Json> {
  const fields: Json = {};
  let args: Json = { session, jobId, path: [], offset: 0, limit: 50 };
  for (;;) {
    const page = object((await client.call('dcsc_validation_jobs', args)).json);
    for (const item of array(page['items'])) {
      const entry = object(item);
      if (typeof entry['key'] === 'string' && Object.hasOwn(entry, 'value')) {
        fields[entry['key']] = entry['value'];
      }
    }
    const next = page['next'];
    if (!next) return fields;
    args = object(object(next)['arguments']);
  }
}

function canonicalWorkspaceHash(
  sessionFile: string,
  artifactDir: string,
  workspaceId: string,
): string {
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

function historicalV1Envelope(captured: RawConfiguration): Json {
  const configurationId = 'US__legacy_recovery0';
  const raw = structuredClone(captured);
  raw.id = configurationId;
  raw.workspaceId = 'ws_legacy_recovery';
  const reduced = reduceConfiguration(raw, configurationId, 'cto', 'General Purpose');
  const timestamp = Date.now() - 1_000;
  // This is the field-for-field schema emitted by persist.ts at commit f640bb4.
  return {
    version: 1,
    savedAt: timestamp,
    workspaces: [{
      id: 'ws_legacy_recovery',
      label: 'Captured SR630 V3 historical-v1 recovery gate',
      locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
      solution: { solutionMode: 'General Purpose', masterSlices: ['ISG'] },
      validationMode: 'guided',
      rackArea: [],
      rackSummaries: [],
      cables: [],
      floorItems: [],
      powerSelections: [],
      revision: 3,
      createdAt: timestamp,
      lastAccessAt: timestamp,
      pricedAt: timestamp,
      configurations: [{
        id: 'sess_legacy_recovery',
        label: 'Captured SR630 V3',
        product: {
          code: raw.sliceCtoCode ?? raw.code ?? '7D73CTO1WW',
          description: raw.description ?? 'ThinkSystem SR630 V3',
          type: raw.type ?? 'SERVER',
        },
        mode: 'cto',
        validationMode: 'guided',
        raw,
        configurationId,
        reduced,
        primed: true,
        revision: 2,
        intents: [],
        snapshots: [],
        createdAt: timestamp,
        lastAccessAt: timestamp,
        pricedAt: timestamp,
      }],
    }],
  };
}

async function drainInspectPages(client: StdioMcp, initial: Json): Promise<Json> {
  const pages: Array<{ path: unknown; offset: unknown; total: unknown; returned: unknown; sha256: string }> = [];
  let args = structuredClone(initial);
  const seen = new Set<string>();
  for (let page = 0; page < 200; page += 1) {
    const key = JSON.stringify(args);
    assert(!seen.has(key), 'Proposal inspection returned a cyclic continuation.');
    seen.add(key);
    const result = object((await client.call('dcsc_reconcile_workspace', args)).json);
    pages.push({
      path: result['path'],
      offset: result['offset'],
      total: result['total'],
      returned: result['returned'],
      sha256: sha256(Buffer.from(JSON.stringify(result))),
    });
    const next = object(result['next']);
    if (Object.keys(next).length === 0) {
      return { pages: pages.length, itemsSeen: pages.reduce((sum, item) => sum + number(item.returned), 0), detail: pages };
    }
    assert.equal(next['tool'], 'dcsc_reconcile_workspace');
    args = object(next['arguments']);
  }
  throw new Error('Proposal inspection exceeded 200 pages.');
}

function writeConfig(root: string, sessionFile: string, artifactDir: string): string {
  const configFile = path.join(root, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    logLevel: 'error',
    locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
    files: {
      persistSessions: true,
      sessionFile,
      artifactDir,
      maxDownloadBytes: 200 * 1024 * 1024,
    },
  }));
  return configFile;
}

function cleanEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && !entry[0].startsWith('DCSC_')),
  );
}

function object(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Json
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`Expected string, received ${typeof value}.`);
  return value;
}

function number(value: unknown): number {
  if (typeof value !== 'number') throw new Error(`Expected number, received ${typeof value}.`);
  assert(Number.isFinite(value), 'Expected a finite number.');
  return value;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const options = parseArgs();
  await mkdir(options.outDir, { recursive: true });
  const results: CaseResult[] = [];
  if (options.suite === 'all' || options.suite === 'offline') {
    results.push(await offlineRecoveryCase(options));
  }
  if (options.suite === 'all' || options.suite === 'live') {
    results.push(await liveLegacyCase(options));
  }
  const report = {
    generatedAt: new Date().toISOString(),
    suite: options.suite,
    serializerCommit: HISTORICAL_SERIALIZER_COMMIT,
    results,
    counts: {
      passed: results.filter((result) => result.status === 'pass').length,
      failed: results.filter((result) => result.status === 'fail').length,
      blocked: results.filter((result) => result.status === 'blocked').length,
    },
  };
  await writeFile(path.join(options.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = results.some((result) => result.status === 'fail')
    ? 1
    : results.some((result) => result.status === 'blocked') ? 2 : 0;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
