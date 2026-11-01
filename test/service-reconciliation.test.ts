import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema, type Config } from '../src/config/schema.js';
import { RECONCILIATION_PROPOSALS_STATE_KEY } from '../src/domain/reconciliation.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { workspaceFile } from '../src/session/persist.js';
import { SessionConflictError } from '../src/session/SessionStore.js';
import type { ConfigSession, WorkspaceSession } from '../src/model/session.js';
import { SessionPersistenceError } from '../src/http/persistenceError.js';
import { projectProposal } from '../src/mcp/reconciliationTools.js';
import { DcscService } from '../src/mcp/service.js';
import type { RawConfiguration } from '../src/model/types.js';

const completeFixture = JSON.parse(
  readFileSync(new URL('./fixtures/parity/sr630-launch.json', import.meta.url), 'utf8'),
) as RawConfiguration;
const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
const roots: string[] = [];
const services: DcscService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(persistSessions = false): { config: Config; sessionFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'dcsc-service-reconciliation-'));
  roots.push(root);
  const sessionFile = join(root, 'state', 'sessions.json');
  return {
    sessionFile,
    config: ConfigSchema.parse({
      files: { persistSessions, sessionFile, artifactDir: join(root, 'artifacts') },
      logLevel: 'error',
    }),
  };
}

function service(configValue: Config): DcscService {
  const value = new DcscService(configValue);
  services.push(value);
  return value;
}

function addLegacyWorkspace(value: DcscService): {
  workspace: WorkspaceSession;
  session: ConfigSession;
  complete: RawConfiguration;
} {
  const configurationId = 'US__reconcile-service0';
  const complete = structuredClone(completeFixture);
  complete.id = configurationId;
  const legacy = structuredClone(complete);
  legacy.totalPrice = 12_922.01;
  delete legacy.hipoDerivedItems;
  delete legacy.hipoServiceCtoServices;
  legacy.tabs = (legacy.tabs ?? []).filter((tab) => tab.type === 'hardware');
  const session = value.sessions.create({
    locale: value.locale,
    solution,
    mode: 'cto',
    raw: legacy,
    configurationId,
    reduced: reduceConfiguration(legacy, configurationId),
    primed: true,
  });
  const workspace = value.sessions.getWorkspace(session.id);
  if (!workspace) throw new Error('missing workspace');
  workspace.integrity = 'legacy-unverified';
  workspace.integrityWarnings = [
    'Migrated from v1: omitted state cannot be assumed to represent user intent.',
  ];
  return { workspace, session, complete };
}

function mockCompleteDerive(value: DcscService, complete: RawConfiguration) {
  return vi.spyOn(value.http, 'send').mockResolvedValue({
    raw: { configurations: [structuredClone(complete)] },
  } as never);
}

describe('service reconciliation integration', () => {
  it('durably proposes, inspects, and explicitly accepts a current complete derive', async () => {
    const setup = config(true);
    const first = service(setup.config);
    const { workspace, session, complete } = addLegacyWorkspace(first);
    const send = mockCompleteDerive(first, complete);

    const proposal = await first.proposeReconciliation(workspace.id, first.newCtx({ solution }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      endpoint: 'workspace_reconciliation',
      path: '/ctos/autoDerive',
      query: { entranceFlag: 'summary', guideMode: true },
      body: { kind: 'json', value: {
        configurations: [expect.objectContaining({ id: session.configurationId })],
        customizingFlags: { autoDerive: true, autoVariant: true },
      } },
    });
    expect(proposal).toMatchObject({
      workspaceId: workspace.id,
      sourceRevision: workspace.revision,
      status: 'changes-proposed',
    });
    expect(workspace.integrity).toBe('legacy-unverified');
    expect(workspace.revision).toBe(proposal.sourceRevision);
    expect(existsSync(workspaceFile(setup.config, workspace.id))).toBe(true);

    const second = service(setup.config);
    const restored = second.sessions.getWorkspace(workspace.id);
    expect(restored?.integrity).toBe('legacy-unverified');
    const inspected = second.reconciliationProposal(session.id, proposal.id);
    expect(inspected).toEqual(proposal);
    inspected.warnings.length = 0;
    expect(second.reconciliationProposal(workspace.id, proposal.id).warnings.length).toBeGreaterThan(0);

    const accepted = await second.acceptReconciliation(session.id, proposal.id);
    expect(accepted).toEqual({
      workspace: workspace.id,
      revision: proposal.sourceRevision + 1,
      integrity: 'verified',
    });
    expect(restored?.serverState[RECONCILIATION_PROPOSALS_STATE_KEY]).toBeUndefined();
    expect(() => second.reconciliationProposal(workspace.id, proposal.id)).toThrow(/not found/i);

    const third = service(setup.config);
    const verified = third.sessions.getWorkspace(workspace.id);
    expect(verified?.integrity).toBe('verified');
    expect([...verified!.configurations.values()][0]?.raw.hipoDerivedItems).toHaveLength(2);
    expect(() => third.assertTrustedWorkspace(session.id)).not.toThrow();
  });

  it('does not publish a proposal if the durable metadata write fails', async () => {
    const setup = config(false);
    const value = service(setup.config);
    const { workspace, complete } = addLegacyWorkspace(value);
    const send = mockCompleteDerive(value, complete);
    const revision = workspace.revision;
    const cause = new Error('proposal disk write failed');
    const persist = vi.fn(() => { throw cause; });
    value.sessions.setPersistenceWriter(persist);

    const failure = await value.proposeReconciliation(workspace.id, value.newCtx({ solution }))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionPersistenceError);
    expect(failure).toMatchObject({
      code: 'DCSC_LOCAL_NOT_COMMITTED',
      localNotCommitted: true,
      remoteApplied: true,
      cause,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(workspace.serverState[RECONCILIATION_PROPOSALS_STATE_KEY]).toBeUndefined();
    expect(workspace.integrity).toBe('legacy-unverified');
    expect(workspace.revision).toBe(revision);
  });

  it('rejects a proposal when the workspace changes while derive is in flight', async () => {
    const setup = config(false);
    const value = service(setup.config);
    const { workspace, complete } = addLegacyWorkspace(value);
    vi.spyOn(value.http, 'send').mockImplementation(async () => {
      await value.sessions.transact(workspace.id, {}, (draft) => {
        draft.label = 'changed concurrently';
      });
      return { raw: { configurations: [structuredClone(complete)] } } as never;
    });

    await expect(value.proposeReconciliation(workspace.id, value.newCtx({ solution })))
      .rejects.toBeInstanceOf(SessionConflictError);
    expect(workspace.serverState[RECONCILIATION_PROPOSALS_STATE_KEY]).toBeUndefined();
    expect(workspace.integrity).toBe('legacy-unverified');
  });

  it.each([
    {
      name: 'partial response',
      response: { configurations: [] },
      message: /did not return every workspace configuration/i,
    },
    {
      name: 'unknown identity',
      response: { configurations: [{ ...completeFixture, id: 'US__unknown0' }] },
      message: /unknown configuration identity/i,
    },
    {
      name: 'incomplete configuration',
      response: { configurations: [{ ...completeFixture, id: 'US__reconcile-service0', hipoDerivedItems: undefined }] },
      message: /associated-software array/i,
    },
  ])('rejects $name without retaining a misleading proposal', async ({ response, message }) => {
    const setup = config(false);
    const value = service(setup.config);
    const { workspace } = addLegacyWorkspace(value);
    const record = vi.spyOn(value.sessions, 'recordReconciliationProposal');
    vi.spyOn(value.http, 'send').mockResolvedValue({ raw: response } as never);

    await expect(value.proposeReconciliation(workspace.id, value.newCtx({ solution })))
      .rejects.toThrow(message);
    expect(record).not.toHaveBeenCalled();
    expect(workspace.serverState[RECONCILIATION_PROPOSALS_STATE_KEY]).toBeUndefined();
  });

  it('blocks legacy export and manufacturing validation before any upstream request', async () => {
    const setup = config(false);
    const value = service(setup.config);
    const { workspace, session } = addLegacyWorkspace(value);
    const send = vi.spyOn(value.http, 'send');

    await expect(value.validate(workspace.id, value.newCtx({ solution })))
      .rejects.toThrow(/legacy-unverified.*reconcile/i);
    await expect(value.exportZip(session.id, {
      fileTypes: ['XML'], fileName: 'legacy', ctx: value.newCtx({ solution }),
    })).rejects.toThrow(/legacy-unverified.*reconcile/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('pages proposal review fields without exposing the internal replacement target', async () => {
    const setup = config(false);
    const value = service(setup.config);
    const { workspace, complete } = addLegacyWorkspace(value);
    mockCompleteDerive(value, complete);
    const proposal = await value.proposeReconciliation(workspace.id, value.newCtx({ solution }));

    const root = projectProposal(proposal, [], 0, 2);
    expect(root).toMatchObject({ proposalId: proposal.id, offset: 0, returned: 2 });
    expect(root.next).toMatchObject({ arguments: { offset: 2, path: [] } });
    expect(() => projectProposal(proposal, ['target'], 0, 20)).toThrow(/unknown review path/i);

    const diffs = projectProposal(proposal, ['diffs'], 0, 1);
    expect(diffs).toMatchObject({
      proposalId: proposal.id,
      path: ['diffs'],
      total: 1,
      returned: 1,
      items: [expect.objectContaining({ key: '0', nextPath: ['diffs', '0'] })],
    });
    const message = projectProposal(proposal, ['warnings', '0', 'message'], 0, 12);
    expect(message).toMatchObject({
      proposalId: proposal.id,
      path: ['warnings', '0', 'message'],
      offset: 0,
      text: expect.any(String),
      next: expect.objectContaining({ arguments: expect.objectContaining({ offset: 12 }) }),
    });
  });
});
