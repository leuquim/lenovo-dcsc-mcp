import {
  fetchServiceSavings,
  fetchFlagSummary,
  type ServiceSavingsResult,
  type FlagSummaryResult,
} from '../domain/summaryInsights.js';
import { exportPowerXls, fetchShareUrl } from '../domain/exportExtras.js';
import { toToolError } from '../http/errors.js';
import { restoreSavedBreakoutConnections } from '../domain/importCabling.js';
import { planNativeManualCableSelection, assertNativeConnectionsRetained, stageNativeManualCableQuantity } from '../domain/nativeManualCabling.js';
import { hardwareModeFamily, hardwareEndpointFamily, usesCtoWire } from '../domain/modeFamily.js';
import type { ConfigMode } from '../config/constants.js';
import type { SolutionContext } from '../config/schema.js';
import type { ConfigSession, WorkspaceSession } from '../model/session.js';
import {
  downloadReferenceSolution,
  fetchReferenceSolutions,
  referenceId,
  referencePath,
  type ReferenceQuery,
} from '../domain/referenceSolutions.js';
import { retrieveConfigId as domainRetrieveConfigId, customizeSid as domainCustomizeSid } from '../domain/configId.js';
import { writeCfxmlArtifact, sanitiseFileName, writeExportBundle } from '../files/artifactStore.js';
import {
  buildExportData,
  buildExportForm,
  buildGroups,
  DEFAULT_EXPORT_TYPES,
  newConfigurationId,
  reduceConfiguration,
  type ExportFileType,
} from '../domain/reduce.js';
import { prepareImportFile } from '../domain/importFile.js';
import { hydrateImportedLayout, mergeImportedState } from '../domain/importLayout.js';
import { parseStandaloneImportResponse } from '../domain/importStandalone.js';
import { readConnectionGraph, projectConnectionGraph } from '../domain/cabling.js';
import { renderRackImage } from '../domain/rackImage.js';
import { workspaceHardwareMode } from '../domain/workspaceWire.js';
import { expandImportedClones } from '../domain/importClones.js';
import { type RequestCtx } from '../http/request.js';
import { type CreateSessionInput } from '../session/SessionStore.js';
import {
  collectReplacedParts,
  summariseRackArea,
  toImportParts,
  type ImportDiagnostics,
  type ImportResult,
  type RawImportResponse,
} from './serviceHelpers.js';
import { exportZipPath } from '../domain/endpoints.js';
import { CATALOG_TTL_MS, type Runtime } from './runtime.js';
import { manualCablingInput, prepareConfigIdsDraft, syncLayout } from './workspaceRefresh.js';
import { configureDraft } from './launch.js';
import { assertTrustedWorkspace } from './reconciliation.js';

export async function downloadReferenceSolutionArtifact(rt: Runtime, crnId: string, ctx: RequestCtx, solutionMode?: string) {
  const solution = await rt.resolveSolution(ctx, solutionMode);
  const bytes = await downloadReferenceSolution(rt.http, { ...ctx, solution }, crnId, rt.config.files.maxDownloadBytes);
  return writeCfxmlArtifact(bytes, `${referenceId(crnId, 'crnId')}.xml`, rt.config);
}

export async function referenceSolutions(rt: Runtime, query: ReferenceQuery, ctx: RequestCtx, solutionMode?: string) {
  const solution = await rt.resolveSolution(ctx, solutionMode);
  const key = JSON.stringify([ctx.locale, solution, referencePath(query)]);
  const hit = rt.referencesCache.get(key);
  // Validation is live; catalogs share the ordinary metadata TTL.
  if (query.view !== 'validation' && hit && Date.now() - hit.at < CATALOG_TTL_MS) {
    return { raw: structuredClone(hit.value), solution };
  }
  const raw = await fetchReferenceSolutions(rt.http, { ...ctx, solution }, query);
  if (query.view !== 'validation') rt.referencesCache.set(key, { at: Date.now(), value: structuredClone(raw) });
  return { raw, solution };
}

export async function launchReferenceSolution(rt: Runtime, crnId: string, ctx: RequestCtx, solutionMode?: string): Promise<ImportResult> {
  const id = referenceId(crnId, 'crnId');
  const solution = await rt.resolveSolution(ctx, solutionMode);
  const response = await rt.http.send({ endpoint: 'reference_customize', method: 'GET',
    path: `/reference_solution/CRNs/${id}/customize`, responseKind: 'json', timeoutClass: 'heavy',
    ctx: { ...ctx, solution } });
  const raw: unknown = response.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('DCSC returned no customizable reference solution.');
  return acceptImportPayload(rt, { ...raw, crnId: id }, { ctx, solution, fileName: `${id}.xml` });
}

/**
 * Retrieves an online configuration by ID from DCSC and ingests it into a workspace session.
 */
export async function retrieveConfigId(rt: Runtime, configId: string,
  opts: {
    workspaceId?: string | undefined;
    solutionMode?: string | undefined;
    expectedRevision?: number | undefined;
    mode?: ConfigMode | undefined;
    ctx?: RequestCtx | undefined;
  } = {},): Promise<ImportResult> {
  const ctx = opts.ctx ?? rt.newCtx();
  const solution = await rt.resolveSolution(ctx, opts.solutionMode);

  let existingIds: string[] = [];
  if (opts.workspaceId) {
    const ws = rt.sessions.getWorkspace(opts.workspaceId);
    if (ws) {
      existingIds = [...ws.configurations.values()].map((s) => s.configurationId);
    }
  }

  let payload: unknown;
  try {
    payload = await domainRetrieveConfigId(rt.http, configId, existingIds, { ...ctx, solution });
  } catch (err) {
    // If anonymous DCSC upstream does not persist newly minted IDs to cloud,
    // fallback to active local session that holds userGeneratedConfigId.
    const localMatch = rt.sessions.list().find((s) => s.raw.userGeneratedConfigId === configId);
    if (localMatch) {
      payload = [{
        configuration: [structuredClone(localMatch.raw)],
        workspace: {},
      }];
    } else {
      throw err;
    }
  }
  return acceptImportPayload(rt, payload, {
    ctx: { ...ctx, solution },
    solution,
    mode: opts.mode,
    workspaceId: opts.workspaceId,
    fileName: `${configId}.xml`,
    expectedRevision: opts.expectedRevision,
  });
}

/**
 * Customizes a preconfigured Solution ID (SID) template into a workspace session.
 */
export async function customizeSid(rt: Runtime, sidNumber: string,
  opts: {
    ctx?: RequestCtx | undefined;
    solutionMode?: string | undefined;
    workspaceId?: string | undefined;
    expectedRevision?: number | undefined;
    mode?: ConfigMode | undefined;
  } = {},): Promise<ImportResult> {
  const id = sidNumber.trim();
  const ctx = opts.ctx ?? rt.newCtx();
  const solution = await rt.resolveSolution(ctx, opts.solutionMode);
  const raw = await domainCustomizeSid(rt.http, id, { ...ctx, solution });
  return acceptImportPayload(
    rt, { ...(raw as Record<string, unknown>), crnId: id },
    {
      ctx: { ...ctx, solution },
      solution,
      mode: opts.mode,
      workspaceId: opts.workspaceId,
      fileName: `${id}.xml`,
      expectedRevision: opts.expectedRevision,
    },
  );
}

/**
 * Imports CFXML or an exported Excel workbook through DCSC's own importer.
 *
 * This deliberately posts the file to /multiple/cfxml_import rather than
 * parsing it locally and re-launching each product code. Launch does not
 * enforce slice membership, so a local replay happily "imports" a CFXML that
 * the real DCSC rejects — a config whose declared solution mode does not
 * contain the model comes back from launch fully priced, while the genuine
 * import drops it as a missing part. Only the server can tell us that, so we
 * ask it, and surface whatever it reports.
 *
 * Whether a model imports at all is decided by the solution mode of *this
 * request*, not by the file: DCSC resolves each product against the mode's
 * catalog. The same CFXML for a General-Purpose-only model (SR685a V3, say)
 * imports cleanly under "General Purpose" and is rejected outright under
 * "HPC and AI - Systems". Callers who know better can override the mode.
 */
export async function importConfig(rt: Runtime, opts: {
  content: string | Uint8Array;
  ctx: RequestCtx;
  mode?: ConfigMode;
  workspaceId?: string;
  fileName?: string;
  solutionMode?: string;
  expectedRevision?: number | undefined;
}): Promise<ImportResult> {
  // XML parsing recovers its declared solution mode and saved breakout shapes,
  // and rejects invalid CFXML. Excel stays binary and is interpreted by Lenovo.
  // Note that
  // DCSC stamps "General Purpose" into every export's Configuration Type
  // regardless of the mode it was built in, so this is a weak default.
  const existing = opts.workspaceId ? rt.sessions.getWorkspace(opts.workspaceId) : undefined;
  if (opts.workspaceId && !existing) throw new Error(`Workspace ${opts.workspaceId} not found.`);
  const ctx = existing ? { ...opts.ctx, locale: existing.locale } : opts.ctx;
  const file = prepareImportFile(opts.content, opts.fileName);
  const solution = await rt.resolveSolution(ctx, opts.solutionMode ?? existing?.solution.solutionMode ?? file.solutionMode);

  const res = await rt.http.send({
    endpoint: 'cfxml_import',
    method: 'POST',
    path: file.source?.isXconfig ? '/cfxml_import' : '/multiple/cfxml_import',
    query: { entranceFlag: 'homePage', serviceCto: true, controlExpressModal: true },
    body: {
      kind: 'multipart',
      parts: [
        {
          name: 'cfxmlFile',
          filename: file.fileName,
          contentType: file.contentType,
          content: file.content,
        },
      ],
    },
    responseKind: 'json',
    timeoutClass: 'heavy',
    ctx: { ...ctx, solution },
  });

  return acceptImportPayload(rt, res.raw, { ctx, solution, mode: opts.mode,
    workspaceId: opts.workspaceId, fileName: file.fileName, expectedRevision: opts.expectedRevision, importSource: file.source });
}

type StandaloneImport = ReturnType<typeof parseStandaloneImportResponse>;

function buildImportDiagnostics(
  payload: RawImportResponse,
  standalone: StandaloneImport,
  restoredBreakouts: number,
  importSource: ReturnType<typeof prepareImportFile>['source'] | undefined,
): ImportDiagnostics {
  const diagnostics: ImportDiagnostics = {
    missingParts: toImportParts(payload.missingParts),
    removedParts: toImportParts(payload.removedParts),
    replacedParts: collectReplacedParts(payload.differentPartMap),
    eccnRestricted: payload.eccnRestricted === true,
  };

  if (standalone) diagnostics.warnings = standalone.diagnostics.warnings;
  if (restoredBreakouts) diagnostics.warnings = [...(diagnostics.warnings ?? []),
    `Restored ${restoredBreakouts} saved breakout branch shapes that Lenovo's import response omitted. Website reimport may still lose these shapes.`];
  if (importSource?.isXconfig) {
    const warnings: string[] = [];
    if (importSource.savedCabling && !payload['networkingInformation'] && !payload['connectionData']) {
      warnings.push('The x-config source contains saved cabling, but Lenovo returned no networking or connection-recovery metadata. Imported cabling is not verified; inspect or regenerate the native graph before handoff.');
    }
    if (importSource.savedFloor && !payload['floorInformation']) {
      warnings.push('The x-config source contains saved floor information, but Lenovo returned no floor metadata. Verify the imported floor placement before handoff.');
    }
    if (importSource.sourceInspectionUnavailable) warnings.push('The x-config source archive could not be inspected within the supported decoding limits. Source floor/cabling preservation is unverified.');
    diagnostics.warnings = [...(diagnostics.warnings ?? []), ...warnings];
  }
  if (payload['needImportExcel'] === true) {
    diagnostics.warnings = [...(diagnostics.warnings ?? []),
      'Lenovo requests a companion Excel recovery step for this legacy design. That recovery workflow is not yet supported by the MCP; floor placement and cabling may be incomplete. Complete recovery on the website before relying on the imported layout.'];
  }
  return diagnostics;
}

async function rejectEmptyImport(
  rt: Runtime,
  ctx: RequestCtx,
  solution: SolutionContext,
  diagnostics: ImportDiagnostics,
): Promise<never> {
  const missing = diagnostics.missingParts.map((p) => p.productCode).join(', ');
  const others = (await rt.solutionModes(ctx))
    .map((m) => m.mode)
    .filter((m) => m !== solution.solutionMode);
  throw new Error(
    `DCSC rejected every product in this configuration file${missing ? ` (missing: ${missing})` : ''}. ` +
      `The import ran in solution mode "${solution.solutionMode}"; a model that is not in ` +
      'that mode\'s catalog is dropped even though the file itself is valid. ' +
      (others.length > 0
        ? `Retry with solutionMode set to one of: ${others.join(', ')}.`
        : 'Check that the model is available in this mode.'),
  );
}

type BreakoutPlan = ReturnType<typeof planNativeManualCableSelection>;

function planSavedBreakouts(workspace: WorkspaceSession): Map<string, BreakoutPlan> {
  const breakoutPlans = new Map<string, BreakoutPlan>();
  const input = manualCablingInput(workspace);
  for (const value of readConnectionGraph(workspace.serverState)) {
    const row = value as Record<string, unknown>;
    if (row.category !== 'BREAKOUT' || row.divider !== 4) continue;
    // CFXML rows omit cableFeature. Resolve the saved part against the
    // destination catalog rather than requiring live distance metadata.
    const plan = planNativeManualCableSelection(input, { ...row,
      cableFeature: { featureCode: row.cablePart, selectionGroups: [] } });
    breakoutPlans.set(JSON.stringify([plan.configurationIds ?? [plan.configurationId], plan.code]), plan);
  }
  return breakoutPlans;
}

async function restoreBreakoutQuantities(
  rt: Runtime,
  workspace: WorkspaceSession,
  ctx: RequestCtx,
  breakoutPlans: Map<string, BreakoutPlan>,
  savedConnections: Parameters<typeof assertNativeConnectionsRetained>[0],
): Promise<void> {
  // Native import derivation counts branches rather than distinct cable heads.
  // Restore each physical-port quantity (and imported spares) through native configure.
  for (const plan of breakoutPlans.values()) {
    const destination = [...workspace.configurations.values()].find(c => c.configurationId === plan.configurationId)!;
    if ((destination.index.selected.get(plan.code) ?? 0) !== plan.quantity) {
      // Native derive reads rack feature quantities ahead of the configuration delta.
      const staged = stageNativeManualCableQuantity(manualCablingInput(workspace), plan);
      workspace.rackArea = staged.rackArea; workspace.nonRackArea = staged.nonRackArea;
      await configureDraft(rt, destination, [{ section: plan.section, code: plan.code, quantity: plan.quantity }], ctx, workspace);
    }
    const physical = stageNativeManualCableQuantity(manualCablingInput(workspace), plan);
    workspace.rackArea = physical.rackArea; workspace.nonRackArea = physical.nonRackArea;
    if ((destination.index.selected.get(plan.code) ?? 0) !== plan.quantity) {
      throw new Error('DCSC did not retain the saved breakout cable quantity. Workspace was not committed.');
    }
  }
  assertNativeConnectionsRetained(savedConnections, readConnectionGraph(workspace.serverState));
  // The native quantity-only correction above marks the graph stale. Its
  // original imported routes and accepted cable demand have now been verified.
  delete workspace.serverState.connectionGraphInvalidation;
}

async function acceptImportPayload(rt: Runtime, raw: unknown, opts: {
  ctx: RequestCtx; solution: SolutionContext; mode?: ConfigMode | undefined;
  workspaceId?: string | undefined; fileName?: string | undefined; expectedRevision?: number | undefined;
  importSource?: ReturnType<typeof prepareImportFile>['source'] | undefined;
}): Promise<ImportResult> {
  const { ctx, solution } = opts;
  // The endpoint answers with a single-element array in every case we have
  // observed, but tolerate a bare object.
  const importedPayload = (Array.isArray(raw) ? raw[0] : raw) as RawImportResponse | undefined;
  if (!importedPayload || typeof importedPayload !== 'object') {
    throw new Error('DCSC returned an unrecognised response to the configuration import.');
  }
  const payload = expandImportedClones(importedPayload);
  const restoredBreakouts = restoreSavedBreakoutConnections(payload, opts.importSource?.breakoutConnections ?? []);

  const standalone = parseStandaloneImportResponse(payload);
  const diagnostics = buildImportDiagnostics(payload, standalone, restoredBreakouts, opts.importSource);
  const configurations = standalone?.kind === 'service' ? []
    : Array.isArray(payload.configuration) ? payload.configuration : [];

  if (configurations.length === 0 && !standalone) await rejectEmptyImport(rt, ctx, solution, diagnostics);

  const mode = opts.mode ?? (payload.type === 'lfo' ? 'lfo' : 'cto');
  const reduceMode = hardwareModeFamily(mode);
  const inputs: CreateSessionInput[] = configurations.map((raw) => {
    const configurationId = raw.id || newConfigurationId(ctx.locale.country);
    return {
      primed: true,
      configurable: (raw.tabs ?? []).some((tab) => (tab.subTabs ?? []).some((subTab) => (subTab.sections?.length ?? 0) > 0)),
      locale: ctx.locale, solution, mode, raw, configurationId,
      reduced: reduceConfiguration(raw, configurationId, reduceMode, solution.solutionMode),
    };
  });
  const result = await rt.sessions.createManyAtomic(inputs, {
    remoteApplied: true,
    workspaceHandle: opts.workspaceId,
    expectedRevision: opts.expectedRevision,
    workspaceContext: { locale: ctx.locale, solution },
    actionHistory: () => ({ command: 'IMPORT', fileName: opts.fileName ?? 'configuration.xml' }),
    prepare: async (workspace) => {
      if (standalone?.kind === 'service' && (workspace.configurations.size > 0 || workspace.serverState.standaloneSoftwareState || workspace.serverState.standaloneHardwareState)) {
        throw new Error('Independent services require a separate service workspace. Import without workspace to create one.');
      }
      if (workspace.serverState.standaloneServiceState) {
        throw new Error('This workspace already contains independent services. Import into a new workspace.');
      }
      if (standalone?.kind === 'software' && workspace.serverState.standaloneSoftwareState) {
        throw new Error('This workspace already contains standalone software. Import into a new workspace to preserve both baskets.');
      }
      const importedHardware = standalone?.kind === 'hardware' ? standalone.state
        : standalone?.kind === 'software' ? standalone.hardware : undefined;
      if (importedHardware && workspace.serverState.standaloneHardwareState) {
        throw new Error('This workspace already contains standalone hardware. Import into a new workspace to preserve both baskets.');
      }
      mergeImportedState(workspace, payload);
      workspace.serverState.lastImportDiagnostics = structuredClone(diagnostics);
      if (importedHardware) workspace.serverState.standaloneHardwareState = importedHardware;
      if (standalone && standalone.kind !== 'hardware') {
        const key = standalone.kind === 'software' ? 'standaloneSoftwareState' : 'standaloneServiceState';
        workspace.serverState[key] = standalone.state;
      }
      if (standalone) {
        workspace.integrityWarnings.push(...standalone.diagnostics.warnings);
      }
      await hydrateImportedLayout(rt.http, { ...ctx, locale: workspace.locale, solution }, workspace, payload);
      const breakoutPlans = restoredBreakouts ? planSavedBreakouts(workspace) : new Map<string, BreakoutPlan>();
      if (workspace.rackArea.length > 0 || workspace.nonRackArea.length > 0) {
        await syncLayout(rt, workspace, workspace.rackArea, ctx, { preserveImportedManualCables: true });
      } else workspace.rackSummaries = summariseRackArea(workspace.rackArea);
      if (restoredBreakouts) {
        await restoreBreakoutQuantities(rt, workspace, ctx, breakoutPlans, opts.importSource!.breakoutConnections);
      }
    },
  });
  return { workspaceId: result.workspace.id, sessions: result.sessions, diagnostics,
    ...(standalone ? { standaloneKind: standalone.kind } : {}) };
}

/**
 * Streams the export ZIP to disk and returns where it landed.
 *
 * Scope follows the handle: a configuration id exports that configuration,
 * a workspace id exports the workspace. That distinction is load-bearing —
 * resolving a configuration id to its parent used to export every product in
 * the workspace, which both surprised the caller and walked into the rack
 * payload rejection below.
 *
 * Rack export uses the website's slim hierarchy plus independent physical
 * rackData. A failed full-workspace handoff is surfaced without dropping layout.
 */
export async function exportZip(rt: Runtime, sessionHandle: string,
  opts: {
    fileTypes: ExportFileType[];
    fileName: string;
    ctx: RequestCtx;
    scope?: 'auto' | 'configuration' | 'workspace' | undefined;
    /** Retained for compatibility; rack data is always included for workspace export. */
    attemptRackPayload?: boolean | undefined;
  },): Promise<{
  stream: NodeJS.ReadableStream;
  contentDisposition: string | undefined;
  rackDataOmitted: boolean;
  scope: 'configuration' | 'workspace';
  configurationsExported: number;
  manualPlanningLinksOmitted: number;
  breakoutBranchesAtRisk: number;
}> {
  assertTrustedWorkspace(rt, sessionHandle);
  const resolved = rt.sessions.resolveHandle(sessionHandle);
  if (!resolved) throw new Error(`Session / Workspace ${sessionHandle} not found`);

  const requested = opts.scope ?? 'auto';
  if (requested === 'workspace' && !resolved.workspace) {
    throw new Error(`No workspace found for ${sessionHandle}.`);
  }
  if (requested === 'configuration' && !resolved.session) {
    throw new Error(`No single configuration found for ${sessionHandle}.`);
  }
  const scope: 'configuration' | 'workspace' =
    requested === 'auto' ? (resolved.kind === 'workspace' ? 'workspace' : 'configuration') : requested;

  // Enrichment and HTTP waits must not observe or mutate concurrent changes.
  const workspace = resolved.workspace ? structuredClone(resolved.workspace) : undefined;
  const session = resolved.session ? (workspace?.configurations.get(resolved.session.id) ?? structuredClone(resolved.session)) : undefined;
  if (scope === 'configuration' && !session) {
    throw new Error(`No configuration to export for ${sessionHandle}.`);
  }

  const solution = workspace?.solution ?? session!.solution;
  const validationMode = workspace?.validationMode ?? session!.validationMode;
  const family = hardwareEndpointFamily(
    scope === 'workspace' ? workspaceHardwareMode(workspace!.configurations.values()) : session!.mode,
  );
  const isLfo = family === 'lfos';

  const hasRacks = (workspace?.rackArea.length ?? 0) > 0;
  const includeRacks = hasRacks;
  const useWorkspace = scope === 'workspace' && workspace !== undefined;

  const stripped = workspace;
  if (stripped) await prepareConfigIdsDraft(rt, stripped, opts.ctx);
  const placement = session && stripped?.nonRackArea.find(item => item.id === session.configurationId);
  const graphLinkIds = new Set(projectConnectionGraph(readConnectionGraph(workspace?.serverState ?? {}))
    .cables.map(link => link.id));
  const manualPlanningLinksOmitted = useWorkspace
    ? workspace.cables.filter(link => !graphLinkIds.has(link.id)).length : 0;

  const data = useWorkspace
    ? buildExportData({
        workspace: stripped!,
        solution,
        fileTypes: opts.fileTypes,
        validationMode,
      })
    : buildExportData({
        raw: session!.raw,
        config: session!.reduced,
        ...(placement ? { placement } : {}),
        autoDerivedResults: Array.isArray(stripped?.serverState.autoDerivedResults)
          ? stripped.serverState.autoDerivedResults.filter(value => {
            if (!value || typeof value !== 'object') return false;
            const record = value as Record<string, unknown>;
            const part = record.derivePart as Record<string, unknown> | undefined;
            return part?.targetWorkspaceId === session!.configurationId ||
              Array.isArray(record.appliedConfigurations) && record.appliedConfigurations.includes(session!.configurationId);
          }) : [],
        solution,
        fileTypes: opts.fileTypes,
        validationMode,
      });

  const form = buildExportForm({
    data,
    image: useWorkspace && hasRacks && opts.fileTypes.includes('RACK_REPORT') ? renderRackImage(workspace) : undefined,
    groups: useWorkspace
      ? buildGroups(stripped!)
      : buildGroups(session!.raw, session!.configurationId, session!.mode),
  });

  const res = await rt.http.send({
    endpoint: isLfo ? 'lfo_export_zip' : 'cto_export_zip',
    method: 'POST',
    path: exportZipPath(family),
    query: { fileName: opts.fileName },
    requiresSolution: false,
    body: { kind: 'form', fields: form },
    responseKind: 'stream',
    timeoutClass: 'export',
    ctx: { ...opts.ctx, locale: workspace?.locale ?? session!.locale, solution },
  });

  return {
    stream: res.stream,
    contentDisposition: res.contentDisposition,
    rackDataOmitted: hasRacks && !includeRacks,
    scope,
    configurationsExported: useWorkspace ? workspace!.configurations.size : 1,
    manualPlanningLinksOmitted,
    breakoutBranchesAtRisk: useWorkspace ? readConnectionGraph(workspace!.serverState).filter(value => {
      const row = value as Record<string, unknown>;
      return row.category === 'BREAKOUT' && row.divider === 4;
    }).length : 0,
  };
}

export async function summaryInsights(rt: Runtime, input: {
    session?: string | undefined;
    type?: 'serviceSaving' | 'flagSummary' | string | undefined;
    workspaceSnapshot?: Record<string, unknown> | undefined;
  },
  ctx?: RequestCtx,): Promise<ServiceSavingsResult | FlagSummaryResult> {
  const effectiveCtx = ctx ?? rt.newCtx({ solution: await rt.resolveSolution(rt.newCtx()) });
  let snapshot = input.workspaceSnapshot;
  if (!snapshot && input.session) {
    const resolved = rt.sessions.resolveHandle(input.session);
    const ws = resolved?.workspace;
    if (ws) {
      snapshot = {
        ...buildExportData({
          workspace: ws,
          solution: ws.solution,
          fileTypes: ['SUMMARY'],
          validationMode: 'guided',
        }),
        groups: buildGroups(ws),
      };
    }
  }
  if (!snapshot) {
    throw new Error('Either session handle or workspaceSnapshot must be provided for summary insights.');
  }
  if (input.type === 'flagSummary') {
    return fetchFlagSummary(rt.http, effectiveCtx, snapshot);
  }
  return fetchServiceSavings(rt.http, effectiveCtx, snapshot);
}

export async function shareUrlFields(
  rt: Runtime,
  ctx: RequestCtx,
  include: boolean | undefined,
  configId: string,
): Promise<{ shareUrl?: string; shareUrlError?: string }> {
  if (!include) return {};
  try {
    return { shareUrl: (await fetchShareUrl(rt.http, ctx, configId)).shareUrl };
  } catch (err) {
    return { shareUrlError: toToolError(err).error };
  }
}

function buildWorkspaceReportForm(
  workspace: WorkspaceSession,
  solution: SolutionContext,
  fileTypes: ExportFileType[],
  validationMode: ConfigSession['validationMode'],
) {
  return buildExportForm({
    data: buildExportData({ workspace, solution, fileTypes, validationMode }),
    image: workspace.rackArea.length > 0 && fileTypes.includes('RACK_REPORT') ? renderRackImage(workspace) : undefined,
    groups: buildGroups(workspace),
  });
}

function buildConfigurationReportForm(
  session: ConfigSession,
  workspace: WorkspaceSession | undefined,
  placement: Record<string, unknown> | undefined,
  solution: SolutionContext,
  fileTypes: ExportFileType[],
  validationMode: ConfigSession['validationMode'],
) {
  const autoDerivedResults = Array.isArray(workspace?.serverState.autoDerivedResults)
    ? (workspace.serverState.autoDerivedResults.filter((value) => {
        if (!value || typeof value !== 'object') return false;
        const record = value as Record<string, unknown>;
        const part = record.derivePart as Record<string, unknown> | undefined;
        return part?.targetWorkspaceId === session.configurationId ||
          (Array.isArray(record.appliedConfigurations) && record.appliedConfigurations.includes(session.configurationId));
      }) as Array<Record<string, unknown>>) : [];
  return buildExportForm({
    data: buildExportData({
      raw: session.raw,
      config: session.reduced,
      ...(placement ? { placement } : {}),
      autoDerivedResults,
      solution,
      fileTypes,
      validationMode,
    }),
    image: undefined,
    groups: buildGroups(session.raw, session.configurationId, session.mode),
  });
}

export async function exportWorkspace(rt: Runtime, sessionHandle: string,
  opts: {
    fileTypes?: ExportFileType[] | undefined;
    fileName?: string | undefined;
    scope?: 'auto' | 'configuration' | 'workspace' | undefined;
    directReport?: 'POWER_XLS' | undefined;
    includeShareUrl?: boolean | undefined;
    ctx?: RequestCtx | undefined;
  } = {},): Promise<Record<string, unknown>> {
  assertTrustedWorkspace(rt, sessionHandle);
  const resolved = rt.sessions.resolveHandle(sessionHandle);
  if (!resolved) throw new Error(`Session / Workspace ${sessionHandle} not found`);

  const requested = opts.scope ?? 'auto';
  const scope: 'configuration' | 'workspace' =
    requested === 'auto' ? (resolved.kind === 'workspace' ? 'workspace' : 'configuration') : requested;

  const workspace = resolved.workspace ? structuredClone(resolved.workspace) : undefined;
  const session = resolved.session ? (workspace?.configurations.get(resolved.session.id) ?? structuredClone(resolved.session)) : undefined;

  const effectiveLocale = workspace?.locale ?? session?.locale ?? rt.locale;
  const effectiveSolution = workspace?.solution ?? session?.solution ?? await rt.resolveSolution(rt.newCtx());
  const effectiveCtx = opts.ctx ?? rt.newCtx({ locale: effectiveLocale, solution: effectiveSolution });

  const pCode = session?.product.code ?? (workspace && [...workspace.configurations.values()][0]?.product.code) ?? 'solution';
  const baseFileName = sanitiseFileName(opts.fileName ?? `${pCode}-${Date.now()}`);

  const configId = session?.configurationId
    ?? (workspace && [...workspace.configurations.values()][0]?.configurationId)
    ?? sessionHandle;

  if (opts.directReport === 'POWER_XLS') {
    const isLfo = scope === 'workspace' && workspace
      ? workspaceHardwareMode(workspace.configurations.values()) === 'lfo'
      : session ? !usesCtoWire(session.mode) : false;

    const stripped = workspace;
    if (stripped) await prepareConfigIdsDraft(rt, stripped, effectiveCtx);
    const placement = session && stripped?.nonRackArea.find((item) => item.id === session.configurationId);
    const validationMode = workspace?.validationMode ?? session?.validationMode ?? 'expert';

    const fileTypes = opts.fileTypes ?? DEFAULT_EXPORT_TYPES;
    const form = scope === 'workspace' && workspace
      ? buildWorkspaceReportForm(workspace, effectiveSolution, fileTypes, validationMode)
      : buildConfigurationReportForm(session!, stripped, placement, effectiveSolution, fileTypes, validationMode);

    const report = await exportPowerXls(rt.http, effectiveCtx, rt.config, {
      mode: isLfo ? 'lfo' : 'cto',
      fileName: `${baseFileName}.xlsx`,
      exportFormPayload: form,
    });

    return {
      session: sessionHandle,
      scope,
      directReport: opts.directReport,
      ...report,
      ...await shareUrlFields(rt, effectiveCtx, opts.includeShareUrl, configId),
    };
  }

  // Default ZIP export
  const zipResult = await exportZip(rt, sessionHandle, {
    fileTypes: opts.fileTypes ?? DEFAULT_EXPORT_TYPES,
    fileName: baseFileName,
    ctx: effectiveCtx,
    scope: opts.scope,
  });

  const bundle = await writeExportBundle(zipResult.stream, baseFileName, rt.config);

  return {
    session: sessionHandle,
    ...zipResult,
    ...bundle,
    ...await shareUrlFields(rt, effectiveCtx, opts.includeShareUrl, configId),
  };
}
