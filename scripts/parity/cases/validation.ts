/**
 * Manufacturing validation over real MCP stdio. A descriptor, job id, HTTP success or local diagnostics never
 * establish a verdict: only terminal `valid` / `invalid` results of `/lmc_validation/result` for the exact current
 * export payload pass. Pending, unknown and unavailable results are recorded as blocked.
 */
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ConfigSchema } from '../../../src/config/schema.js';
import { buildExportData } from '../../../src/domain/reduce.js';
import { validationPayloadSha256 } from '../../../src/domain/validationJobs.js';
import { SessionStore } from '../../../src/session/SessionStore.js';
import { loadSessions } from '../../../src/session/persist.js';
import { readJsonProjection } from '../../lib/read-json-projection.js';
import type { Harness, Json, ParityCase } from '../harness.js';

type Verdict = 'valid' | 'invalid';
const SOURCE_XML = path.resolve('test/fixtures/parity/xml/one-rack-sr630-v3.xml');
const VALIDATION_DEADLINE_MS = 300_000;
const NON_TERMINAL_STATUSES = ['pending', 'unknown', 'unavailable'];

const object = (value: unknown): Json => {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected object.');
  return value as Json;
};
const array = (value: unknown): unknown[] => {
  assert(Array.isArray(value), 'Expected array.');
  return value;
};
const string = (value: unknown): string => {
  assert.equal(typeof value, 'string');
  return value as string;
};
const number = (value: unknown): number => {
  assert.equal(typeof value, 'number');
  return value as number;
};

function continuation(value: unknown, session: string, jobId: string, expectedPath: string[]) {
  const link = object(value);
  assert.equal(link['tool'], 'dcsc_workspace_get');
  const args = object(link['arguments']);
  const view = object(args['view']);
  assert.equal(view['kind'], 'validation');
  assert.equal(args['session'], session);
  assert.equal(view['jobId'], jobId);
  assert.deepEqual(view['path'], expectedPath);
  assert.equal(view['offset'], 0);
  assert(number(view['limit']) > 0);
  return { tool: string(link['tool']), arguments: args };
}

async function inspectJob(h: Harness, session: string, jobId: string, directReport?: Json): Promise<Json> {
  const initial = directReport?.['compacted'] === true
    ? continuation(object(object(directReport['pages'])['savedJob'])['inspect'], session, jobId, [])
    : { tool: 'dcsc_workspace_get', arguments: { session, view: { kind: 'validation', jobId, path: [], offset: 0, limit: 50 } } };
  return object(await readJsonProjection((name, args) => h.mcp.call(name, args), initial, 'object'));
}

function severityCounts(messages: unknown[]) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const value of messages) {
    const severity = string(object(value)['severity']);
    assert(severity === 'error' || severity === 'warning' || severity === 'info', `Unexpected validation severity ${severity}.`);
    counts[severity] += 1;
  }
  return counts;
}

async function verifyInspection(h: Harness, name: string, session: string, report: Json, job: Json): Promise<void> {
  const jobId = string(report['jobId']);
  const projection = object(job['projection']);
  const authoritativeMessages = array(object(job['report'])['messages']);
  const localDiagnostics = array(projection['localDiagnostics']);
  const headroom = array(projection['headroom']);
  const authoritative = severityCounts(authoritativeMessages);
  const local = severityCounts(localDiagnostics);

  h.compare(`${name}:counts`,
    { authoritative, local, scope: projection['validatedScope'], rackDataOmitted: projection['rackDataOmitted'] },
    { authoritative: { error: report['errorCount'], warning: report['warningCount'], info: report['infoCount'] },
      local: { error: report['localErrorCount'], warning: report['localWarningCount'], info: report['localInfoCount'] },
      scope: report['validatedScope'], rackDataOmitted: report['rackDataOmitted'] });
  assert.equal(headroom.length, object(projection['validatedScope'])['configurations']);
  for (const value of headroom) {
    const entry = object(value);
    assert.equal(typeof entry['configuration'], 'string');
    assert.equal(typeof entry['productCode'], 'string');
    array(entry['constraints']);
    array(entry['breached']);
  }

  const pages = report['compacted'] === true ? object(report['pages']) : undefined;
  for (const [field, expectedPath, expected] of [
    ['messages', ['report', 'messages'], authoritativeMessages],
    ['localDiagnostics', ['projection', 'localDiagnostics'], localDiagnostics],
    ['headroom', ['projection', 'headroom'], headroom],
  ] as const) {
    if (!pages) {
      h.compare(`${name}:inline-${field}`, expected, report[field]);
      continue;
    }
    const page = object(pages[field]);
    assert.equal(page['total'], expected.length, `${field} page total does not match the saved job.`);
    assert.equal(report[`${field}Returned`], array(report[field]).length, `${field} returned count does not match the inline preview.`);
    assert(number(report[`${field}Returned`]) <= expected.length, `${field} inline preview exceeds the saved collection.`);
    const link = continuation(page['inspect'], session, jobId, [...expectedPath]);
    h.compare(`${name}:continuation-${field}`, expected,
      await readJsonProjection((tool, args) => h.mcp.call(tool, args), link, 'array'));
  }
}

function canonicalPayloadSha256(h: Harness, workspaceId: string): string {
  const config = ConfigSchema.parse({
    files: { persistSessions: true, sessionFile: h.mcp.sessionFile, artifactDir: h.mcp.artifactDir },
    logLevel: 'error',
  });
  const store = new SessionStore(100);
  assert(loadSessions(store, config) > 0, 'No persisted workspace was available for payload verification.');
  const workspace = store.getWorkspace(workspaceId);
  assert(workspace, `Persisted workspace ${workspaceId} was not found.`);
  return validationPayloadSha256(buildExportData({
    workspace, solution: workspace.solution, fileTypes: ['XML'], validationMode: workspace.validationMode,
  }), 'cto');
}

const validate = (h: Harness, workspace: string) =>
  h.mcp.call('dcsc_validate', { session: workspace, deadlineMs: VALIDATION_DEADLINE_MS }, { timeoutMs: VALIDATION_DEADLINE_MS + 30_000 });

async function validateCase(h: Harness, name: string, expected: Verdict, workspace: string): Promise<Json> {
  const exported = await h.mcp.call('dcsc_export', { kind: 'reports', session: workspace, scope: 'workspace', fileName: name, fileTypes: ['XML'] });
  assert.equal(exported['configurationsExported'], 2);
  const xmlPath = string(exported['xml']);
  const xml = readFileSync(xmlPath, 'utf8').replaceAll('-', '');
  assert(xml.includes('7D6DCTO1WW') && xml.includes('7D73CTO1WW'), 'Export XML omitted a configuration included in the validation workspace.');
  copyFileSync(xmlPath, path.join(h.out, `${name}.xml`));

  const report = await validate(h, workspace);
  const job = await inspectJob(h, workspace, string(report['jobId']), report);
  await verifyInspection(h, name, workspace, report, job);

  assert.equal(report['source'], 'lmc_validation');
  assert.match(string(report['jobId']), /^[^:]+:[0-9a-f]{64}:\d+$/);
  h.compare(`${name}:payload-binds-to-current-export`, canonicalPayloadSha256(h, workspace), report['payloadSha256']);
  h.compare(`${name}:job-binds-to-report`,
    { stale: false, validatedRevision: report['validatedRevision'], payloadSha256: report['payloadSha256'] },
    { stale: job['stale'], validatedRevision: job['validatedRevision'], payloadSha256: job['payloadSha256'] });

  const status = string(report['status']);
  if (NON_TERMINAL_STATUSES.includes(status)) {
    h.compare(`${name}:non-terminal-is-not-valid`, { isValid: false, freshValidationRequired: true },
      { isValid: report['isValid'], freshValidationRequired: report['freshValidationRequired'] });
    await h.skip(`${name}:terminal-verdict`, `Authoritative result is ${status}: ${String(report['warning'] ?? 'no terminal result')}`,
      async () => {
        const retried = string((await validate(h, workspace))['status']);
        if (NON_TERMINAL_STATUSES.includes(retried)) throw new Error(`Authoritative result is still ${retried}.`);
      });
    return report;
  }
  h.compare(`${name}:verdict`,
    { status: expected, isValid: expected === 'valid', terminal: true, currentStatus: expected },
    { status, isValid: report['isValid'], terminal: job['terminal'], currentStatus: job['currentStatus'] });
  if (expected === 'valid') {
    h.compare(`${name}:no-errors`, { errorCount: 0, localErrorCount: 0 },
      { errorCount: report['errorCount'], localErrorCount: report['localErrorCount'] });
  } else {
    assert(number(report['errorCount']) > 0, 'Invalid verdict contained no authoritative errors.');
  }
  return report;
}

export default {
  id: 'validation',
  tags: ['validation'],
  async run(h) {
    const { mcp, step, compare } = h;
    const { workspace, server } = await step('import', async () => {
      const imported = await mcp.call('dcsc_import', { filePath: SOURCE_XML, mode: 'cto' });
      const sessions = array(imported['configurations']).map(object);
      const server = sessions.find(session => session['productCode'] === '7D73CTO1WW');
      assert(server, 'Imported validation fixture did not contain its SR630 V3 server.');
      assert.equal(sessions.length, 2);
      return { workspace: string(imported['session']), server };
    });

    const valid = await step('validate-current-valid-candidate', () =>
      validateCase(h, 'current-valid-candidate', 'valid', workspace));

    await step('edit-removes-processor', async () => {
      const controls = await mcp.call('dcsc_configure', {
        session: string(server['id']), validationMode: 'expert', autoCorrect: false, expectedRevision: number(valid['validatedRevision']),
      });
      const changed = await mcp.call('dcsc_configure', {
        session: string(server['id']), changes: [{ section: 'processors.processor', code: 'BYW3', quantity: 0 }],
        expectedRevision: number(controls['revision']),
      });
      compare('edit-removed-processor', { applied: true, removedProcessor: true },
        { applied: changed['applied'], removedProcessor: array(changed['removed']).some(item => object(item)['code'] === 'BYW3') });
      const staleJob = await inspectJob(h, workspace, string(valid['jobId']));
      compare('edit-stales-prior-job', { stale: true, isValid: false, currentStatus: 'unavailable', freshValidationRequired: true },
        { stale: staleJob['stale'], isValid: staleJob['isValid'], currentStatus: staleJob['currentStatus'],
          freshValidationRequired: staleJob['freshValidationRequired'] });
      const current = await mcp.call('dcsc_workspace_get', { session: string(server['id']) });
      compare('edit-advances-revision', true, number(current['revision']) > number(valid['validatedRevision']));
    });

    await step('validate-current-invalid-no-processor', async () => {
      const invalid = await validateCase(h, 'current-invalid-no-processor', 'invalid', workspace);
      compare('current-invalid-no-processor:keeps-local-errors', true, number(invalid['localErrorCount']) > 0);
    });
  },
} satisfies ParityCase;
