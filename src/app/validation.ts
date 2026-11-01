import { preserveUnconfiguredSelections } from '../domain/unconfigured.js';
import { hardwareModeFamily, usesCtoWire } from '../domain/modeFamily.js';
import {
  inspectAutoFixCandidates,
  buildAutoFixCurrentSelections,
  executeAutoFix,
  applyAutoFixSections,
  type AutoFixCandidate,
  type AutoFixResult,
} from '../domain/autoFix.js';
import { buildExportData, reduceConfiguration } from '../domain/reduce.js';
import { collectLocalDiagnostics, summariseValidation, type ValidationReport } from '../domain/validate.js';
import {
  readValidationJobs,
  runValidationJob,
  validationResultFromJob,
  isValidationJobStale,
  validationPayloadSha256,
} from '../domain/validationJobs.js';
import { diffConfigurations } from '../model/diff.js';
import { projectJsonPage } from '../model/pagedJson.js';
import { mandatoryVerifyConfig, type VerifyMandatorySoftwareResult } from '../domain/mandatorySoftware.js';
import { buildIndex } from '../model/index.js';
import { projectSummary } from '../model/project.js';
import { type RequestCtx } from '../http/request.js';
import type { ConfigSession, WorkspaceSession } from '../model/session.js';
import type { SolutionContext } from '../config/schema.js';
import { SessionConflictError } from '../session/SessionStore.js';
import { updateHistoryFactory } from './serviceHelpers.js';
import type { Runtime } from './runtime.js';
import { autoDerive } from './launch.js';
import { refreshRackMetadata } from './workspaceRefresh.js';
import { assertTrustedWorkspace } from './reconciliation.js';

/**
 * Discovers candidate hardware sections eligible for auto-fix on a CTO configuration.
 */
export async function inspectAutoFix(rt: Runtime, handle: string, ctx?: RequestCtx): Promise<{ candidates: AutoFixCandidate[] }> {
  const resolved = rt.sessions.resolveHandle(handle);
  if (!resolved?.session) {
    throw new Error('Auto-fix candidate inspection requires a configuration session handle.');
  }
  const session = resolved.session;
  if (!usesCtoWire(session.mode)) {
    return { candidates: [] };
  }
  const effectiveCtx = ctx ?? rt.newCtx({ locale: session.locale, solution: session.solution });
  const candidates = await inspectAutoFixCandidates(rt.http, session.product.code, effectiveCtx);
  return { candidates };
}

/**
 * Automatically resolves rule validation errors for eligible hardware CTO sections.
 * Runs as a transactional mutation with CAS optimistic concurrency.
 */
export async function autoFix(rt: Runtime, handle: string,
  opts: {
    sections?: string[] | undefined;
    expectedRevision?: number | undefined;
    ctx?: RequestCtx | undefined;
  } = {},): Promise<{ session: ConfigSession; result: AutoFixResult }> {
  const resolved = rt.sessions.resolveHandle(handle);
  if (!resolved?.session) {
    throw new Error('Auto-fix requires a configuration session handle.');
  }
  const target = resolved.session;
  if (!usesCtoWire(target.mode)) {
    throw new Error('Auto-fix is only supported for hardware CTO configurations.');
  }
  if (opts.expectedRevision !== undefined && target.revision !== opts.expectedRevision) {
    throw new SessionConflictError(opts.expectedRevision, target.revision, 'configuration');
  }

  const effectiveCtx = opts.ctx ?? rt.newCtx({ locale: target.locale, solution: target.solution });

  let requiredSections = opts.sections;
  if (!requiredSections || requiredSections.length === 0) {
    const candidates = await inspectAutoFixCandidates(rt.http, target.product.code, effectiveCtx);
    requiredSections = candidates.map((c) => c.characterName);
  }

  if (requiredSections.length === 0) {
    return {
      session: target,
      result: {
        applied: false,
        sectionsChanged: [],
        notices: [],
        errors: null,
        message: 'No eligible auto-fix sections found for this configuration.',
      },
    };
  }

  let fixResult: AutoFixResult = {
    applied: false,
    sectionsChanged: [],
    notices: [],
    errors: null,
    message: 'autoFix Failed',
  };

  const session = await rt.sessions.transact(
    target.id,
    {
      expectedRevision: opts.expectedRevision,
      remoteApplied: true,
      actionHistory: updateHistoryFactory(target.configurationId),
    },
    async (workspace, draft) => {
      if (!draft) {
        throw new Error('Auto-fix requires a configuration session.');
      }

      const currentSelections = buildAutoFixCurrentSelections(draft.raw);
      const response = await executeAutoFix(
        rt.http,
        draft.product.code,
        requiredSections!,
        currentSelections,
        effectiveCtx,
      );

      if (response.autoFixResult !== 'FIX_SUCCESS' || response.sections.length === 0) {
        fixResult = {
          applied: false,
          sectionsChanged: [],
          notices: response.notices ?? [],
          errors: response.errors ?? null,
          message: response.message ?? 'autoFix Failed',
        };
        return draft;
      }

      const merged = applyAutoFixSections(draft.raw, response.sections);
      draft.raw = merged.configuration;

      const reduced = reduceConfiguration(
        draft.raw,
        draft.configurationId,
        hardwareModeFamily(draft.mode),
        draft.solution.solutionMode,
      );

      const derived = await autoDerive(rt, reduced, {
        ctx: effectiveCtx,
        solution: draft.solution,
        mode: draft.mode,
        validationMode: draft.validationMode,
        autoCorrect: draft.autoCorrect,
        sourceRaw: draft.raw,
        ...(workspace ? { workspace } : {}),
      });

      if (derived) {
        draft.raw = {
          ...preserveUnconfiguredSelections(draft.raw, derived),
          quantity: draft.raw.quantity ?? derived.quantity ?? 1,
          hipoDerivedItems: derived.hipoDerivedItems ?? draft.raw.hipoDerivedItems,
          hipoServiceCtoServices: derived.hipoServiceCtoServices ?? draft.raw.hipoServiceCtoServices,
        };
        draft.index = buildIndex(draft.raw);
        draft.reduced = reduceConfiguration(
          draft.raw,
          draft.configurationId,
          hardwareModeFamily(draft.mode),
          draft.solution.solutionMode,
        );
      }

      if (workspace) refreshRackMetadata(workspace, true);

      fixResult = {
        applied: true,
        sectionsChanged: merged.sectionsChanged,
        notices: response.notices ?? [],
        errors: response.errors ?? null,
        message: response.message ?? 'Auto-fix applied successfully.',
      };

      return draft;
    },
  );

  return { session, result: fixResult };
}

type ValidationScope = 'configuration' | 'workspace';

export type ValidationOutcome = ValidationReport & {
  jobId: string;
  payloadSha256: string;
  freshValidationRequired: boolean;
  sessionHandle: string;
  validatedRevision: number;
  stale: boolean;
  workspaceId?: string | undefined;
  headroom: Array<{
    configuration: string;
    productCode: string;
    constraints: unknown[];
    breached: string[];
  }>;
  source: 'lmc_validation';
  /** True when racks were present but omitted from the LMC payload (same gap as export). */
  rackDataOmitted: boolean;
  /** What the isValid verdict actually covers. Never claims more than was sent. */
  validatedScope: {
    scope: ValidationScope;
    configurations: number;
    racksInSolution: number;
    racksValidated: number;
    covers: string;
  };
  warning?: string | undefined;
};

function xmlExportOfSession(session: ConfigSession, solution: SolutionContext, validationMode: ConfigSession['validationMode']) {
  return buildExportData({
    raw: session.raw,
    config: reduceConfiguration(session.raw, session.configurationId,
      hardwareModeFamily(session.mode), solution.solutionMode),
    solution, fileTypes: ['XML'], validationMode,
  });
}

function xmlExportOfWorkspace(workspace: WorkspaceSession, solution: SolutionContext) {
  return buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode: workspace.validationMode });
}

// Grouped by configuration: a flat array repeats "Memory 32/32" once per
// node with nothing to say which node, and hides the one row that matters.
function validationHeadroom(targets: ConfigSession[]) {
  return targets.map((s) => {
    const constraints = projectSummary({
      sessionId: s.id,
      revision: s.revision,
      raw: s.raw,
      index: s.index,
      currency: s.locale.currency,
      country: s.locale.country,
      pricedAt: s.pricedAt,
    }).constraints;
    const breached = constraints
      .filter((c): c is typeof c & { breached: true; name: string } =>
        (c as { breached?: boolean }).breached === true,
      )
      .map((c) => c.name);
    return {
      configuration: s.id,
      productCode: s.product.code,
      constraints,
      breached,
    };
  });
}

function describeValidatedScope(
  scope: ValidationScope,
  targets: ConfigSession[],
  session: ConfigSession | undefined,
  racksInSolution: number,
  racksValidated: number,
) {
  const covers =
    scope === 'configuration'
      ? `One configuration (${session?.product.code ?? 'unknown'}). Other products in the workspace were not sent.`
      : racksInSolution === 0
        ? `${targets.length} configuration(s). No racks in this solution.`
        : racksValidated === 0
          ? `${targets.length} configuration(s) only. ${racksInSolution} rack(s) present but NOT validated — ` +
            'their layout, PDU sufficiency, weight and stability were not checked by DCSC.'
          : `${targets.length} configuration(s) and ${racksValidated} rack(s).`;
  return {
    scope,
    configurations: targets.length,
    racksInSolution,
    racksValidated,
    covers,
  };
}

/** Hash of the payload the current state would send, or undefined when there is nothing to validate. */
function currentValidationHash(
  rt: Runtime,
  sessionHandle: string,
  scope: ValidationScope,
  solution: SolutionContext,
  mode: string,
): { revision: number; hash: string | undefined } {
  const current = rt.sessions.resolveHandle(sessionHandle);
  const currentWorkspace = scope === 'workspace' ? current?.workspace : undefined;
  const currentSession = current?.session;
  const revision = currentWorkspace?.revision ?? currentSession?.revision ?? -1;
  let hash: string | undefined;
  if (currentWorkspace) {
    hash = validationPayloadSha256(xmlExportOfWorkspace(currentWorkspace, solution), mode);
  } else if (currentSession) {
    hash = validationPayloadSha256(xmlExportOfSession(currentSession, solution, currentSession.validationMode), mode);
  }
  return { revision, hash };
}

/**
 * Validates a configuration against DCSC's LMC validation endpoint.
 *
 * The SPA posts the export payload to /lmc_validation and receives a
 * manufacturing handoff (build entity + deep link). Local expansionMessages
 * from autoDerive are merged in so callers still see rule text that is
 * already on the tree.
 */
export async function validate(rt: Runtime, sessionHandle: string, ctx: RequestCtx, opts: { deadlineMs?: number | undefined } = {}): Promise<ValidationOutcome> {
  assertTrustedWorkspace(rt, sessionHandle);
  const resolved = rt.sessions.resolveHandle(sessionHandle);
  if (!resolved) throw new Error(`Session / Workspace ${sessionHandle} not found`);

  // Same scope rule as export: a configuration handle validates that
  // configuration, not everything sharing its workspace.
  const scope: ValidationScope =
    resolved.kind === 'workspace' ? 'workspace' : 'configuration';
  const session = resolved.session ? structuredClone(resolved.session) : undefined;
  const workspace = scope === 'workspace' && resolved.workspace ? structuredClone(resolved.workspace) : undefined;

  const targets = workspace ? [...workspace.configurations.values()] : [session!];
  const solution = workspace?.solution ?? session!.solution;
  const validationMode = workspace?.validationMode ?? session!.validationMode;
  if (targets.length === 0) throw new Error('Manufacturing validation requires a hardware configuration.');
  const modes = new Set(targets.map((target) => hardwareModeFamily(target.mode)));
  if (modes.size > 1) throw new Error('Validate CTO and LFO configurations separately; mixed-mode manufacturing validation is not established.');
  const mode = [...modes][0]!;

  const validatedRevision = workspace?.revision ?? session!.revision;
  const rackDataOmitted = false;
  const exportPayload = workspace
    ? buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode })
    : xmlExportOfSession(session!, solution, validationMode);

  const messages = collectLocalDiagnostics(
    targets.map((s) => ({
      configurationId: s.configurationId,
      raw: s.raw as Record<string, unknown>,
    })),
  );

  const headroom = validationHeadroom(targets);

  const racksInSolution = workspace?.rackArea.length ?? 0;
  const racksValidated = rackDataOmitted ? 0 : racksInSolution;
  const validatedScope = describeValidatedScope(scope, targets, session, racksInSolution, racksValidated);
  const projection = {
    localDiagnostics: messages,
    headroom,
    rackDataOmitted,
    validatedScope,
  };

  const job = await runValidationJob(rt.http,
    { ...ctx, locale: workspace?.locale ?? session!.locale, solution }, exportPayload, mode, {
      validatedRevision, target: { handle: sessionHandle, scope }, deadlineMs: opts.deadlineMs,
      onUpdate: (snapshot) => rt.sessions.recordValidationJob(sessionHandle, {
        ...snapshot,
        projection: structuredClone(projection),
      }, {
        remoteApplied: snapshot.descriptors.length > 0, operation: 'validation',
        recoveryHint: 'The validation result was not saved. Correct persistence and request fresh validation; do not reuse the descriptor.',
      }),
    });
  const { revision: currentRevision, hash: currentHash } = currentValidationHash(rt, sessionHandle, scope, solution, mode);
  const server = validationResultFromJob(job);
  const stale = isValidationJobStale(job, currentRevision, currentHash);
  const summary = summariseValidation(server, messages);
  if (stale) {
    summary.isValid = false;
    summary.status = 'unavailable';
  }

  const warning = stale
    ? 'Configuration changed during validation; validate the current revision again.'
    : server.requestError?.message;

  return {
    jobId: job.id,
    payloadSha256: job.payloadSha256,
    freshValidationRequired: stale || job.freshValidationRequired,
    validatedRevision,
    stale,
    sessionHandle,
    workspaceId: workspace?.id ?? session?.workspaceId,
    source: 'lmc_validation',
    ...summary,
    headroom,
    rackDataOmitted,
    validatedScope,
    ...(warning !== undefined ? { warning } : {}),
  };
}

/** Saved reports are inspectable without making another result request. */
export function validationJobs(rt: Runtime, handle: string) {
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error(`Session / Workspace ${handle} not found`);
  return readValidationJobs(workspace.serverState).reverse().map(job => {
    const target = job.target && rt.sessions.resolveHandle(job.target.handle);
    const sameWorkspace = target?.workspace?.id === workspace.id;
    let hash: string | undefined;
    let revision = -1;
    if (sameWorkspace && target?.kind === job.target?.scope) {
      try {
        if (target.kind === 'workspace') {
          revision = target.workspace.revision;
          hash = validationPayloadSha256(xmlExportOfWorkspace(target.workspace, target.workspace.solution), job.mode);
        } else {
          const session = target.session;
          revision = session.revision;
          hash = validationPayloadSha256(xmlExportOfSession(session, session.solution, session.validationMode), job.mode);
        }
      } catch { /* An unbuildable current payload cannot reuse a saved verdict. */ }
    }
    const stale = hash === undefined || isValidationJobStale(job, revision, hash);
    const report = validationResultFromJob(job);
    return { ...job, stale, isValid: !stale && report.isValid,
      currentStatus: stale ? 'unavailable' : report.status,
      freshValidationRequired: stale || job.freshValidationRequired,
      ...(job.target ? {} : { scopeWarning: 'This older job has no recorded target scope. Run fresh validation before relying on its verdict.' }),
      report,
    };
  });
}

export function diffSessions(rt: Runtime, sessionHandleA: string, sessionHandleB: string) {
  const sA = rt.sessions.get(sessionHandleA);
  const sB = rt.sessions.get(sessionHandleB);
  if (!sA || !sB) {
    throw new Error(
      `Both sessions must exist to compare. Found: A (${sA ? 'ok' : 'missing'}), B (${sB ? 'ok' : 'missing'}).`,
    );
  }

  if (sA.locale.currency !== sB.locale.currency) {
    throw new Error(`Cannot compare prices in ${sA.locale.currency} and ${sB.locale.currency}. Choose configurations with the same currency.`);
  }

  const diff = diffConfigurations({
    beforeIndex: sA.index,
    afterIndex: sB.index,
    beforeRaw: sA.raw,
    afterRaw: sB.raw,
    currency: sA.locale.currency,
    requested: new Set<string>(),
  });

  return {
    sessionA: sA.id,
    sessionB: sB.id,
    productA: sA.product,
    productB: sB.product,
    currency: sA.locale.currency,
    ...diff,
  };
}

/** Checks the mandatory OS/hypervisor selections of one configuration, as the website does before Summary. */
export async function verifyMandatorySoftware(rt: Runtime, handle: string, ctx: RequestCtx): Promise<VerifyMandatorySoftwareResult> {
  const resolved = rt.sessions.resolveHandle(handle);
  const session = resolved?.session;
  if (!session) throw new Error('Mandatory software verification requires a configuration session handle.');
  const mode = hardwareModeFamily(session.mode);
  return mandatoryVerifyConfig(rt.http, { ...ctx, locale: session.locale, solution: session.solution }, {
    mode,
    configuration: { ...session.reduced, code: session.reduced.ctoCode, lfoCode: session.reduced.lfoCode ?? undefined },
  });
}

/** Saved validation jobs of a workspace, or one job's recorded report, as paged JSON. */
export function inspectValidationJobs(rt: Runtime, opts: {
  session: string; jobId?: string | undefined; path: string[]; offset: number; limit: number;
}): Record<string, unknown> {
  const jobs = validationJobs(rt, opts.session);
  let source: unknown;
  if (opts.jobId) {
    source = jobs.find(job => job.id === opts.jobId);
    if (!source) throw new Error(`Validation job ${opts.jobId} is not stored in this workspace.`);
  } else {
    source = jobs.map(job => ({ jobId: job.id, target: job.target, status: job.currentStatus,
      isValid: job.isValid, stale: job.stale, validatedRevision: job.validatedRevision,
      startedAt: job.startedAt, terminal: job.terminal, freshValidationRequired: job.freshValidationRequired,
      next: { tool: 'dcsc_workspace_get', arguments: { session: opts.session, view: 'validation', jobId: job.id } } }));
  }
  return projectJsonPage(source, { tool: 'dcsc_workspace_get',
    arguments: { session: opts.session, view: 'validation', ...(opts.jobId ? { jobId: opts.jobId } : {}) },
    path: opts.path, offset: opts.offset, limit: opts.limit });
}
