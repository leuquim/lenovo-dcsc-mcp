/** Persistence recovery over real stdio: corrupt source bytes stay inspectable and exportable; a historical-v1 workspace is reconciled, survives SIGKILL and validates fresh. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ConfigSchema } from '../../../src/config/schema.js';
import { buildExportData, reduceConfiguration } from '../../../src/domain/reduce.js';
import { validationPayloadSha256 } from '../../../src/domain/validationJobs.js';
import type { RawConfiguration } from '../../../src/model/types.js';
import { loadSessions } from '../../../src/session/persist.js';
import { SessionStore } from '../../../src/session/SessionStore.js';
import type { Harness, Json, ParityCase } from '../harness.js';
import { rows } from '../rackUi.js';
import { object } from '../softwareSummaryUi.js';

const CAPTURED_SR630 = path.resolve('test/fixtures/parity/sr630-launch.json');
const LEGACY_WORKSPACE = 'ws_legacy_recovery';
const LEGACY_SESSION = 'sess_legacy_recovery';
const CORRUPT_SOURCE = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a]);
const TERMINAL_STATUSES = ['valid', 'invalid'];
const VALIDATION_DEADLINE_MS = 300_000;
const MAX_REVIEW_PAGES = 200;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Replaces the server's persisted state and restarts it from those bytes. */
async function restartFrom(h: Harness, source: Buffer): Promise<void> {
  mkdirSync(path.dirname(h.mcp.sessionFile), { recursive: true });
  writeFileSync(h.mcp.sessionFile, source);
  await h.mcp.killAndRestart();
}

function historicalV1Envelope(captured: RawConfiguration): Json {
  const configurationId = 'US__legacy_recovery0';
  const raw = structuredClone(captured);
  raw.id = configurationId;
  raw.workspaceId = LEGACY_WORKSPACE;
  const reduced = reduceConfiguration(raw, configurationId, 'cto', 'General Purpose');
  const timestamp = Date.now() - 1_000;
  return {
    version: 1, savedAt: timestamp,
    workspaces: [{
      id: LEGACY_WORKSPACE, label: 'Captured SR630 V3 historical-v1 recovery gate',
      locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
      solution: { solutionMode: 'General Purpose', masterSlices: ['ISG'] }, validationMode: 'guided',
      rackArea: [], rackSummaries: [], cables: [], floorItems: [], powerSelections: [], revision: 3,
      createdAt: timestamp, lastAccessAt: timestamp, pricedAt: timestamp,
      configurations: [{
        id: LEGACY_SESSION, label: 'Captured SR630 V3',
        product: { code: raw.sliceCtoCode ?? raw.code ?? '7D73CTO1WW', description: raw.description ?? 'ThinkSystem SR630 V3', type: raw.type ?? 'SERVER' },
        mode: 'cto', validationMode: 'guided', raw, configurationId, reduced, primed: true, revision: 2, intents: [], snapshots: [],
        createdAt: timestamp, lastAccessAt: timestamp, pricedAt: timestamp,
      }],
    }],
  };
}

async function drainPages(h: Harness, initial: Json) {
  const pages: Array<{ path: unknown; offset: unknown; total: unknown; returned: unknown }> = [];
  let args = structuredClone(initial);
  const seen = new Set<string>();
  for (let index = 0; index < MAX_REVIEW_PAGES; index += 1) {
    assert(!seen.has(JSON.stringify(args)), 'Proposal inspection returned a cyclic continuation.');
    seen.add(JSON.stringify(args));
    const result = await h.mcp.call('dcsc_reconcile_workspace', args);
    pages.push({ path: result['path'], offset: result['offset'], total: result['total'], returned: result['returned'] });
    const next = object(result['next']);
    if (Object.keys(next).length === 0) return pages;
    assert.equal(next['tool'], 'dcsc_reconcile_workspace');
    args = object(next['arguments']);
  }
  throw new Error(`Proposal inspection exceeded ${MAX_REVIEW_PAGES} pages.`);
}

async function validationJob(h: Harness, session: string, jobId: string): Promise<Json> {
  const fields: Json = {};
  let args: Json = { session, view: { kind: 'validation', jobId, path: [], offset: 0, limit: 50 } };
  for (;;) {
    const page = await h.mcp.call('dcsc_workspace_get', args);
    for (const entry of rows(page['items'])) if (typeof entry['key'] === 'string' && Object.hasOwn(entry, 'value')) fields[entry['key']] = entry['value'];
    if (!page['next']) return fields;
    args = object(object(page['next'])['arguments']);
  }
}

function canonicalWorkspaceHash(h: Harness, workspaceId: string): string {
  const store = new SessionStore(100);
  loadSessions(store, ConfigSchema.parse({ logLevel: 'error', files: { persistSessions: true, sessionFile: h.mcp.sessionFile } }));
  const workspace = store.getWorkspace(workspaceId);
  assert(workspace, `Persisted workspace ${workspaceId} was not found.`);
  return validationPayloadSha256(buildExportData({ workspace, solution: workspace.solution, fileTypes: ['XML'], validationMode: workspace.validationMode }), 'cto');
}

const corruptSourceCase: ParityCase = {
  id: 'recovery-corrupt-source',
  tags: ['recovery'],
  async run(h) {
    const { mcp, step, compare } = h;
    const archive = await step('recover', async () => {
      await restartFrom(h, CORRUPT_SOURCE);
      const health = await mcp.call('dcsc_session_list', { view: 'health' });
      const inspected = await mcp.call('dcsc_session_list', { view: 'recovery', path: ['recoveryArchives'], offset: 0, limit: 1 });
      const entry = object(object(rows(inspected['items'])[0])['value']);
      const exported = await mcp.call('dcsc_recovery_export', { archiveId: entry['id'] });
      compare('archive-inspectable', { archiveCount: 1, inspectTool: 'dcsc_session_list', idShape: true, bytes: CORRUPT_SOURCE.length },
        { archiveCount: object(health['recovery'])['archiveCount'], inspectTool: object(object(health['recovery'])['inspect'])['tool'],
          idShape: /^recovery_[0-9a-f]{64}$/.test(String(entry['id'])), bytes: entry['bytes'] });
      compare('exact-bytes-exported', { bytes: CORRUPT_SOURCE.toString('hex'), sha256: sha256(CORRUPT_SOURCE), format: 'lenovo-dcsc-session-source-bytes' },
        { bytes: readFileSync(String(exported['path'])).toString('hex'), sha256: exported['sha256'], format: exported['format'] });
      return String(entry['id']);
    });
    await step('restart', async () => {
      await mcp.killAndRestart();
      const listed = await mcp.call('dcsc_session_list', { view: 'recovery', path: ['recoveryArchives'], offset: 0, limit: 10 });
      compare('archive-retained-after-restart', true, rows(listed['items']).some(item => object(item['value'])['id'] === archive));
    });
  },
};

const legacyReconcileCase: ParityCase = {
  id: 'recovery-legacy-reconcile',
  tags: ['recovery', 'validation'],
  async run(h) {
    const { mcp, step, compare } = h;
    const source = Buffer.from(`${JSON.stringify(historicalV1Envelope(JSON.parse(readFileSync(CAPTURED_SR630, 'utf8')) as RawConfiguration))}\n`, 'utf8');

    const applied = await step('reconcile', async () => {
      await restartFrom(h, source);
      const listed = await mcp.call('dcsc_session_list', { limit: 10 });
      const first = object(rows(listed['sessions'])[0]);
      const workspace = String(first['workspace']);
      const before = await mcp.call('dcsc_workspace_get', { session: workspace });
      await mcp.call('dcsc_export', { kind: 'reports', session: workspace, scope: 'workspace', fileName: 'blocked-before-reconciliation', fileTypes: ['XML'] }, { expectError: true });
      await mcp.call('dcsc_validate', { session: workspace, deadlineMs: 30_000 }, { expectError: true });
      const proposed = await mcp.call('dcsc_reconcile_workspace', { session: workspace, action: 'propose', path: [], offset: 0, limit: 1 });
      const proposalId = String(proposed['proposalId']);
      const reviewPaths: string[][] = [[], ['diffs'], ['diffs', '0'], ['warnings']];
      const reviews = [];
      for (const reviewPath of reviewPaths) {
        reviews.push(await drainPages(h, { session: workspace, action: 'inspect', proposalId, path: reviewPath, offset: 0, limit: 1 }));
      }
      const result = await mcp.call('dcsc_reconcile_workspace', { session: workspace, action: 'apply', proposalId });
      compare('legacy-reconciliation', { workspace: LEGACY_WORKSPACE, session: LEGACY_SESSION, legacyIntegrity: 'legacy-unverified', proposalIdShape: true,
        rootReviewPaged: true, appliedSession: workspace, appliedIntegrity: 'verified' },
      { workspace, session: first['session'], legacyIntegrity: before['integrity'], proposalIdShape: /^recon_/.test(proposalId),
        rootReviewPaged: reviews[0]!.length > 1, appliedSession: result['session'], appliedIntegrity: result['integrity'] });
      return { workspace, appliedRevision: Number(result['revision']) };
    });

    await step('restart-and-validate', async () => {
      const { workspace, appliedRevision } = applied;
      await mcp.killAndRestart();
      const restored = await mcp.call('dcsc_workspace_get', { session: workspace });
      const exported = await mcp.call('dcsc_export', { kind: 'reports', session: workspace, scope: 'workspace', fileName: 'legacy-reconciled-sr630', fileTypes: ['XML'] });
      compare('reconciliation-survives-sigkill', { integrity: 'verified', revisionAtLeast: true, exportNotEmpty: true, configurationsExported: 1 },
        { integrity: restored['integrity'], revisionAtLeast: Number(restored['revision']) >= 3, exportNotEmpty: Number(exported['bytes']) > 0,
          configurationsExported: exported['configurationsExported'] });

      const validate = () => mcp.call('dcsc_validate', { session: workspace, deadlineMs: VALIDATION_DEADLINE_MS });
      const validation = await validate();
      const status = String(validation['status']);
      const jobId = String(validation['jobId']);
      const job = await validationJob(h, workspace, jobId);
      const terminal = TERMINAL_STATUSES.includes(status);
      compare('validation-bound-to-reconciled-payload', {
        source: 'lmc_validation', stale: false, session: workspace, workspaceId: workspace, payloadSha256: canonicalWorkspaceHash(h, workspace), validatedRevision: appliedRevision,
        scope: { scope: 'workspace', configurations: 1, racksInSolution: 0, racksValidated: 0 }, jobIdShape: true,
        job: { id: jobId, payloadSha256: validation['payloadSha256'], validatedRevision: validation['validatedRevision'], stale: false, currentStatus: status,
          target: { handle: workspace, scope: 'workspace' }, mode: 'cto' },
      }, {
        source: validation['source'], stale: validation['stale'], session: validation['session'], workspaceId: validation['workspaceId'], payloadSha256: validation['payloadSha256'],
        validatedRevision: validation['validatedRevision'], scope: pickScope(object(validation['validatedScope'])),
        jobIdShape: /^[^:]+:[0-9a-f]{64}:\d+$/.test(jobId),
        job: { id: job['id'], payloadSha256: job['payloadSha256'], validatedRevision: job['validatedRevision'], stale: job['stale'], currentStatus: job['currentStatus'],
          target: pickTarget(object(job['target'])), mode: job['mode'] },
      });
      if (!terminal) {
        await h.skip('fresh-validation-terminal', `DCSC returned a non-terminal validation status (${status}).`, async () => {
          const retried = await validate();
          if (TERMINAL_STATUSES.includes(String(retried['status']))) return retried;
          throw new Error(`Fresh validation was not terminal: ${String(retried['status'])}.`);
        });
        return;
      }
      compare('validation-terminal', { freshValidationRequired: false, isValid: status === 'valid', jobTerminal: true, jobFreshValidationRequired: false, jobIsValid: status === 'valid' },
        { freshValidationRequired: validation['freshValidationRequired'], isValid: validation['isValid'], jobTerminal: job['terminal'],
          jobFreshValidationRequired: job['freshValidationRequired'], jobIsValid: job['isValid'] });
    });
  },
};

const pickScope = (scope: Json) => ({ scope: scope['scope'], configurations: scope['configurations'], racksInSolution: scope['racksInSolution'], racksValidated: scope['racksValidated'] });
const pickTarget = (target: Json) => ({ handle: target['handle'], scope: target['scope'] });

export default [corruptSourceCase, legacyReconcileCase];
