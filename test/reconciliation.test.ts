import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  RECONCILIATION_HISTORY_STATE_KEY,
  RECONCILIATION_PROPOSALS_STATE_KEY,
  ReconciliationConflictError,
  applyReconciliationProposal,
  canonicalWorkspaceHash,
  proposeLegacyReconciliation,
  type FaithfulDerivedWorkspace,
} from '../src/domain/reconciliation.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import type { RawConfiguration } from '../src/model/types.js';
import { SessionStore, type WorkspaceSession } from '../src/session/SessionStore.js';
import { SessionPersistenceError } from '../src/session/persistenceError.js';

const complete = JSON.parse(
  readFileSync(new URL('./fixtures/parity/sr630-launch.json', import.meta.url), 'utf8'),
) as RawConfiguration;

function legacyWorkspace(): {
  store: SessionStore;
  workspace: WorkspaceSession;
  full: RawConfiguration;
  sessionId: string;
} {
  const full = structuredClone(complete);
  const configurationId = 'US__reconcile0';
  full.id = configurationId;
  const legacy = structuredClone(full);
  legacy.totalPrice = 12_922.01;
  delete legacy.hipoDerivedItems;
  delete legacy.hipoServiceCtoServices;
  legacy.tabs = (legacy.tabs ?? []).filter((tab) => tab.type === 'hardware');

  const store = new SessionStore();
  const session = store.create({
    locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
    solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
    mode: 'cto',
    raw: legacy,
    configurationId,
    reduced: reduceConfiguration(legacy, configurationId),
    primed: true,
  });
  const workspace = store.getWorkspace(session.id);
  if (!workspace) throw new Error('missing workspace');
  workspace.integrity = 'legacy-unverified';
  workspace.integrityWarnings = [
    'Migrated from v1: omitted state cannot be assumed to represent user intent.',
  ];
  workspace.recoveryData = [{
    kind: 'discarded-history',
    warning: 'Discarded inconsistent historical snapshot',
    record: { quarantined: 'original record' },
  }];
  return { store, workspace, full, sessionId: session.id };
}

function derivedEvidence(
  workspace: WorkspaceSession,
  sessionId: string,
  raw: RawConfiguration,
): FaithfulDerivedWorkspace {
  const session = workspace.configurations.get(sessionId);
  if (!session) throw new Error('missing session');
  return {
    workspaceId: workspace.id,
    sourceRevision: workspace.revision,
    sourceHash: canonicalWorkspaceHash(workspace),
    country: workspace.locale.country,
    currency: workspace.locale.currency,
    solutionMode: workspace.solution.solutionMode,
    completedAt: 1_800_000_000_000,
    configurations: [{
      sessionId,
      configurationId: session.configurationId,
      accepted: true,
      raw: structuredClone(raw),
    }],
  };
}

describe('legacy reconciliation', () => {
  it('proposes a complete, reviewable diff without claiming lost intent was recovered', () => {
    const { workspace, full, sessionId } = legacyWorkspace();
    const before = structuredClone(workspace.configurations.get(sessionId)?.raw);
    const proposal = proposeLegacyReconciliation(
      workspace,
      derivedEvidence(workspace, sessionId, full),
      1_800_000_000_100,
    );

    expect(proposal).toMatchObject({
      version: 1,
      workspaceId: workspace.id,
      sourceRevision: workspace.revision,
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: 'changes-proposed',
    });
    const diff = proposal.diffs[0];
    expect(diff?.selections.changed).toBe(true);
    expect(diff?.bom.changed).toBe(true);
    expect(diff?.pricing).toMatchObject({
      changed: true,
      before: { currency: 'USD', totalPrice: 12_922.01 },
      after: { currency: 'USD', totalPrice: 15_650.51 },
    });
    expect(diff?.bom.before.associatedSoftware).toEqual([]);
    expect(diff?.bom.after.associatedSoftware).toHaveLength(2);
    expect(diff?.bom.after.associatedServices).toHaveLength(3);
    expect(proposal.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      'legacy-integrity-warning',
      'missing-edit-intent',
      'omitted-software-field',
      'omitted-service-field',
      'catalog-or-intent-ambiguity',
      'recovery-data-retained',
    ]));
    expect(workspace.configurations.get(sessionId)?.raw).toEqual(before);
    expect(workspace.integrity).toBe('legacy-unverified');
  });

  it('applies only explicit acceptance and keeps an audit of acknowledged uncertainty', () => {
    const { workspace, full, sessionId } = legacyWorkspace();
    const proposal = proposeLegacyReconciliation(
      workspace,
      derivedEvidence(workspace, sessionId, full),
      1_800_000_000_100,
    );

    const reconciled = applyReconciliationProposal(workspace, proposal, {
      proposalId: proposal.id,
      acceptedAt: 1_800_000_000_200,
    });
    const session = reconciled.configurations.get(sessionId);
    expect(reconciled.integrity).toBe('verified');
    expect(reconciled.integrityWarnings).toEqual([]);
    expect(reconciled.recoveryData).toEqual(workspace.recoveryData);
    expect(session?.raw.hipoDerivedItems).toHaveLength(2);
    expect(session?.raw.hipoServiceCtoServices).toHaveLength(3);
    expect(session?.reduced.hipoDerivedItems).toHaveLength(2);
    expect(session?.index).toBeDefined();
    expect(reconciled.serverState[RECONCILIATION_HISTORY_STATE_KEY]).toEqual([
      expect.objectContaining({
        proposalId: proposal.id,
        sourceHash: proposal.sourceHash,
        targetHash: proposal.targetHash,
        acknowledgedWarnings: proposal.warnings,
      }),
    ]);
    expect(workspace.integrity).toBe('legacy-unverified');
    expect(workspace.configurations.get(sessionId)?.raw.hipoDerivedItems).toBeUndefined();
  });

  it('rejects stale, mismatched, and tampered proposals', () => {
    const { workspace, full, sessionId } = legacyWorkspace();
    const proposal = proposeLegacyReconciliation(
      workspace,
      derivedEvidence(workspace, sessionId, full),
      1_800_000_000_100,
    );
    const acceptance = { proposalId: proposal.id, acceptedAt: 1_800_000_000_200 };

    const stale = structuredCloneWorkspace(workspace);
    stale.revision += 1;
    expect(() => applyReconciliationProposal(stale, proposal, acceptance))
      .toThrow(ReconciliationConflictError);
    expect(() => applyReconciliationProposal(stale, proposal, acceptance))
      .toThrow(/stale/i);

    const changedWithoutRevision = structuredCloneWorkspace(workspace);
    changedWithoutRevision.configurations.get(sessionId)!.raw.quantity = 8;
    expect(() => applyReconciliationProposal(changedWithoutRevision, proposal, acceptance))
      .toThrow(/source state/i);

    const changedLayoutWithoutRevision = structuredCloneWorkspace(workspace);
    changedLayoutWithoutRevision.floorItems.push({ id: 'floor-1', rackId: 'rack-1', x: 1, y: 2 });
    expect(() => applyReconciliationProposal(changedLayoutWithoutRevision, proposal, acceptance))
      .toThrow(/source state/i);

    const tampered = structuredClone(proposal);
    tampered.target.configurations[0]!.raw.totalPrice = 1;
    expect(() => applyReconciliationProposal(workspace, tampered, acceptance))
      .toThrow(/target state/i);
    expect(() => applyReconciliationProposal(workspace, proposal, {
      proposalId: 'another-proposal', acceptedAt: 1_800_000_000_200,
    })).toThrow(/does not identify/i);
  });

  it('rejects incomplete or mismatched derive evidence before making a proposal', () => {
    const { workspace, full, sessionId } = legacyWorkspace();
    const incomplete = derivedEvidence(workspace, sessionId, full);
    delete incomplete.configurations[0]!.raw.hipoDerivedItems;
    expect(() => proposeLegacyReconciliation(workspace, incomplete)).toThrow(/associated-software/i);

    const wrongCurrency = derivedEvidence(workspace, sessionId, full);
    wrongCurrency.currency = 'EUR';
    expect(() => proposeLegacyReconciliation(workspace, wrongCurrency)).toThrow(/locale, currency/i);

    const wrongSource = derivedEvidence(workspace, sessionId, full);
    wrongSource.sourceHash = '0'.repeat(64);
    expect(() => proposeLegacyReconciliation(workspace, wrongSource)).toThrow(/canonical workspace source/i);
  });

  it('requires explicit acceptance even when the current derive matches legacy content', () => {
    const { workspace, full, sessionId } = legacyWorkspace();
    const current = workspace.configurations.get(sessionId)!;
    current.raw = structuredClone(full);
    current.reduced = reduceConfiguration(full, current.configurationId);
    const proposal = proposeLegacyReconciliation(
      workspace,
      derivedEvidence(workspace, sessionId, full),
      1_800_000_000_100,
    );

    expect(proposal.status).toBe('no-change');
    expect(workspace.integrity).toBe('legacy-unverified');
    expect(() => applyReconciliationProposal(workspace, proposal, {
      proposalId: '', acceptedAt: 1_800_000_000_200,
    })).toThrow(/does not identify/i);
    expect(applyReconciliationProposal(workspace, proposal, {
      proposalId: proposal.id, acceptedAt: 1_800_000_000_200,
    }).integrity).toBe('verified');
  });

  it('does not invalidate a proposal when only pending proposal or validation metadata is recorded', () => {
    const { workspace, full, sessionId } = legacyWorkspace();
    const proposal = proposeLegacyReconciliation(
      workspace,
      derivedEvidence(workspace, sessionId, full),
      1_800_000_000_100,
    );
    workspace.serverState[RECONCILIATION_PROPOSALS_STATE_KEY] = [proposal];
    workspace.serverState.validationJobs = [{ id: 'metadata-only' }];

    expect(canonicalWorkspaceHash(workspace)).toBe(proposal.sourceHash);
    expect(applyReconciliationProposal(workspace, proposal, {
      proposalId: proposal.id,
      acceptedAt: 1_800_000_000_200,
    }).integrity).toBe('verified');
  });

  it('durably records bounded proposal metadata without changing design revisions or history', async () => {
    const { store, workspace, full, sessionId } = legacyWorkspace();
    const base = proposeLegacyReconciliation(
      workspace,
      derivedEvidence(workspace, sessionId, full),
      1_800_000_000_100,
    );
    const revision = workspace.revision;
    const configurationRevision = workspace.configurations.get(sessionId)?.revision;
    const history = structuredClone(workspace.history);
    let persisted: WorkspaceSession | undefined;
    store.setPersistenceWriter((candidates) => {
      persisted = candidates.find((candidate) => candidate.id === workspace.id);
      expect(workspace.serverState[RECONCILIATION_PROPOSALS_STATE_KEY]).toBeUndefined();
    });

    await store.recordReconciliationProposal(sessionId, base);
    expect(workspace.revision).toBe(revision);
    expect(workspace.configurations.get(sessionId)?.revision).toBe(configurationRevision);
    expect(workspace.history).toEqual(history);
    expect(workspace.serverState[RECONCILIATION_PROPOSALS_STATE_KEY]).toEqual([base]);
    expect(persisted?.serverState[RECONCILIATION_PROPOSALS_STATE_KEY]).toEqual([base]);

    store.setPersistenceWriter(undefined);
    for (let index = 1; index <= 5; index += 1) {
      await store.recordReconciliationProposal(workspace.id, {
        ...structuredClone(base),
        id: `recon_${index}`,
        createdAt: base.createdAt + index,
      });
    }
    expect((workspace.serverState[RECONCILIATION_PROPOSALS_STATE_KEY] as Array<{ id: string }>)
      .map((proposal) => proposal.id)).toEqual([
      'recon_1', 'recon_2', 'recon_3', 'recon_4', 'recon_5',
    ]);
    expect(workspace.revision).toBe(revision);
  });

  it('does not publish proposal metadata when durable persistence fails', async () => {
    const { store, workspace, full, sessionId } = legacyWorkspace();
    const proposal = proposeLegacyReconciliation(
      workspace,
      derivedEvidence(workspace, sessionId, full),
      1_800_000_000_100,
    );
    const before = structuredClone(workspace.serverState);
    const cause = new Error('disk full');
    let writerCalls = 0;
    store.setPersistenceWriter(() => {
      writerCalls += 1;
      throw cause;
    });

    const failure = await store.recordReconciliationProposal(workspace.id, proposal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionPersistenceError);
    expect(failure).toMatchObject({
      code: 'DCSC_LOCAL_NOT_COMMITTED',
      localNotCommitted: true,
      remoteApplied: false,
      cause,
    });
    expect(writerCalls).toBe(1);
    expect(workspace.serverState).toEqual(before);
    expect(workspace.revision).toBe(proposal.sourceRevision);
  });

  it('preserves pending proposal metadata across content replacement and undo', async () => {
    const { store, workspace, full, sessionId } = legacyWorkspace();
    const proposal = proposeLegacyReconciliation(
      workspace,
      derivedEvidence(workspace, sessionId, full),
      1_800_000_000_100,
    );
    await store.recordReconciliationProposal(workspace.id, proposal);
    await store.transact(workspace.id, {}, (draft) => {
      draft.serverState = { replacement: true };
    });
    expect(workspace.serverState).toMatchObject({
      replacement: true,
      [RECONCILIATION_PROPOSALS_STATE_KEY]: [proposal],
    });

    expect(await store.undoWorkspace(workspace.id, workspace.revision)).toBe(true);
    expect(workspace.serverState[RECONCILIATION_PROPOSALS_STATE_KEY]).toEqual([proposal]);
  });

  it('atomically removes stale pending proposals when an accepted reconciliation is committed', async () => {
    const { store, workspace, full, sessionId } = legacyWorkspace();
    const proposal = proposeLegacyReconciliation(
      workspace,
      derivedEvidence(workspace, sessionId, full),
      1_800_000_000_100,
    );
    await store.recordReconciliationProposal(workspace.id, proposal);
    await store.transact(
      workspace.id,
      { expectedRevision: proposal.sourceRevision },
      (draft) => {
        const reconciled = applyReconciliationProposal(draft, proposal, {
          proposalId: proposal.id,
          acceptedAt: 1_800_000_000_200,
        });
        Object.assign(draft, reconciled);
      },
    );

    expect(workspace.integrity).toBe('verified');
    expect(workspace.serverState[RECONCILIATION_PROPOSALS_STATE_KEY]).toBeUndefined();
    expect(workspace.serverState[RECONCILIATION_HISTORY_STATE_KEY]).toEqual([
      expect.objectContaining({ proposalId: proposal.id }),
    ]);
  });
});

function structuredCloneWorkspace(workspace: WorkspaceSession): WorkspaceSession {
  const clone = structuredClone({ ...workspace, configurations: undefined, racks: undefined });
  return {
    ...clone,
    configurations: new Map(
      [...workspace.configurations].map(([id, session]) => [id, {
        ...structuredClone({ ...session, index: undefined }),
        index: session.index,
      }]),
    ),
    racks: new Map([...workspace.racks].map(([id, rack]) => [id, structuredClone(rack)])),
  } as WorkspaceSession;
}
