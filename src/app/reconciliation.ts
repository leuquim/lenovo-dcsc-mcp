import { hardwareEndpointFamily } from '../domain/modeFamily.js';
import { buildAutoDeriveRequest } from '../domain/reduce.js';
import { assertConfigurationReconciliationAllowed, hasUnrepairedRecoveryData } from '../domain/workspaceIntegrity.js';
import {
  applyReconciliationProposal,
  canonicalWorkspaceHash,
  proposeLegacyReconciliation,
  RECONCILIATION_PROPOSALS_STATE_KEY,
  type ReconciliationProposal,
} from '../domain/reconciliation.js';
import { type RequestCtx } from '../http/request.js';
import type { RawConfiguration } from '../model/types.js';
import type { Runtime } from './runtime.js';

export function assertTrustedWorkspace(rt: Runtime, handle: string): void {
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error(`Workspace for ${handle} not found.`);
  if (workspace.integrity !== 'verified' || hasUnrepairedRecoveryData(workspace)) {
    if (workspace.integrity === 'damaged' || hasUnrepairedRecoveryData(workspace)) {
      throw new Error(`Workspace ${workspace.id} has damaged or quarantined data. Export recovery records and repair or re-import complete CFXML before export or manufacturing validation. Configuration-only reconciliation cannot restore missing configurations or layout.`);
    }
    throw new Error(`Workspace ${workspace.id} is ${workspace.integrity}. Re-import a complete CFXML or use dcsc_reconcile_workspace to review and explicitly accept a current derive before export or manufacturing validation. Existing selections remain readable.`);
  }
}

export async function proposeReconciliation(rt: Runtime, handle: string, ctx: RequestCtx): Promise<ReconciliationProposal> {
  const live = rt.sessions.getWorkspace(handle);
  if (!live) throw new Error(`Workspace for ${handle} not found.`);
  assertConfigurationReconciliationAllowed(live);
  const workspace = structuredClone(live);
  if (workspace.configurations.size === 0) throw new Error('Configuration reconciliation requires hardware. Re-import standalone state from CFXML.');
  const modes = new Set([...workspace.configurations.values()].map(session => hardwareEndpointFamily(session.mode)));
  if (modes.size !== 1) throw new Error('Reconcile CTO and LFO hardware in separate workspaces.');
  const sourceHash = canonicalWorkspaceHash(workspace);
  const result = await rt.http.send({
    endpoint: 'workspace_reconciliation', method: 'POST', path: `/${[...modes][0]}/autoDerive`,
    query: { entranceFlag: 'summary', guideMode: workspace.validationMode === 'guided' },
    body: { kind: 'json', value: buildAutoDeriveRequest(workspace, {
      validationMode: workspace.validationMode,
      autoCorrect: [...workspace.configurations.values()].every(session => session.autoCorrect),
    }) },
    responseKind: 'json', timeoutClass: 'heavy', ctx: { ...ctx, locale: workspace.locale, solution: workspace.solution },
  });
  const returned = (result.raw as { configurations?: RawConfiguration[] })?.configurations;
  if (!Array.isArray(returned) || returned.length !== workspace.configurations.size) {
    throw new Error('DCSC did not return every workspace configuration. No reconciliation proposal was created; re-import a complete current CFXML.');
  }
  const byId = new Map([...workspace.configurations.values()].map(session => [session.configurationId, session]));
  const configurations = returned.map(raw => {
    const session = typeof raw?.id === 'string' ? byId.get(raw.id) : undefined;
    if (!session) throw new Error('DCSC reconciliation returned an unknown configuration identity.');
    return { sessionId: session.id, configurationId: session.configurationId, accepted: true as const, raw };
  });
  const proposal = proposeLegacyReconciliation(workspace, {
    workspaceId: workspace.id, sourceRevision: workspace.revision, sourceHash,
    country: workspace.locale.country, currency: workspace.locale.currency,
    solutionMode: workspace.solution.solutionMode, completedAt: Date.now(), configurations,
  });
  await rt.sessions.recordReconciliationProposal(workspace.id, proposal, {
    remoteApplied: true,
    operation: 'reconciliation proposal',
    recoveryHint: 'The current derive succeeded but its proposal was not saved. Correct persistence and explicitly request a fresh proposal; no local design change was published.',
  });
  return proposal;
}

export function reconciliationProposal(rt: Runtime, handle: string, proposalId: string): ReconciliationProposal {
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error(`Workspace for ${handle} not found.`);
  const proposals = workspace.serverState[RECONCILIATION_PROPOSALS_STATE_KEY];
  const proposal = Array.isArray(proposals)
    ? (proposals as ReconciliationProposal[]).find(candidate => candidate.id === proposalId) : undefined;
  if (!proposal) throw new Error(`Reconciliation proposal ${proposalId} not found. Create a new proposal.`);
  return structuredClone(proposal);
}

export async function acceptReconciliation(rt: Runtime, handle: string, proposalId: string): Promise<{ workspace: string; revision: number; integrity: string }> {
  const proposal = reconciliationProposal(rt, handle, proposalId);
  await rt.sessions.transact(proposal.workspaceId, { expectedRevision: proposal.sourceRevision }, draft => {
    const reconciled = applyReconciliationProposal(draft, proposal, { proposalId, acceptedAt: Date.now() });
    Object.assign(draft, reconciled);
  });
  const workspace = rt.sessions.getWorkspace(handle)!;
  return { workspace: workspace.id, revision: workspace.revision, integrity: workspace.integrity };
}
