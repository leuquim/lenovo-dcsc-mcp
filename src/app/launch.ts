import {
  resolveLinkedCloneGroup,
  projectLinkedCloneResponse,
  projectHpcLinkedResponses,
  type LinkedCloneGroup,
} from '../domain/linkedCloneEdit.js';
import { hydrateUnconfiguredCatalog, preserveUnconfiguredSelections, stageUnconfiguredSelection } from '../domain/unconfigured.js';
import { splitStoragePhysicalDerive } from '../domain/storagePhysicalDerive.js';
import { hardwareModeFamily, hardwareEndpointFamily, usesCtoWire } from '../domain/modeFamily.js';
import type { ConfigMode } from '../config/constants.js';
import type { SolutionContext } from '../config/schema.js';
import { applySoftwareDerivePatch, isSoftwareDerivePatch } from '../domain/softwareDerive.js';
import { BLUEPRINTS } from '../domain/blueprints.js';
import { generateConfigId as domainGenerateConfigId } from '../domain/configId.js';
import { toSolutionContext } from '../domain/context.js';
import {
  buildAutoDeriveRequest,
  buildGroups,
  newConfigurationId,
  reduceConfiguration,
  type ReducedConfiguration,
} from '../domain/reduce.js';
import { withDerivedPlacements, mergeDerivedConfigurations, type RackObject } from '../domain/rack.js';
import {
  readStorageConnectionNetworks,
  managedStorageComponentIds,
  configurationCloneDependency,
  storagePhysicalTemplateIds,
} from '../domain/storagePreferences.js';
import { invalidateConnectionGraph } from '../domain/cabling.js';
import { physicalIds, removeWorkspaceReferences } from '../domain/workspaceReferences.js';
import { buildRackRecustomizePlan, parseRackRecustomizeResult } from '../domain/rackRecustomize.js';
import { configIdTargetCodes } from '../domain/configIdFeatures.js';
import { projectAutoDerivedSelections } from '../domain/autoDerivedSelections.js';
import { buildLfoHardwareDeriveRequest } from '../domain/lfoWire.js';
import { resolveSection } from '../model/index.js';
import { type RequestCtx } from '../http/request.js';
import { logger } from '../http/trace.js';
import type { RawConfiguration } from '../model/types.js';
import { type CreateSessionInput } from '../session/SessionStore.js';
import type { ConfigSession, WorkspaceSession } from '../model/session.js';
import {
  addHistoryFactory,
  catalogCodeSet,
  configurationControlsHistoryFactory,
  prepareConfigurationChanges,
  removeHistoryFactory,
  summariseRackArea,
  updateHistoryFactory,
  assertWorkspaceRevision,
  requireConfiguration,
  linkedGroup,
  rebuildDerived,
} from './serviceHelpers.js';
import { errorMessage } from '../util/coerce.js';
import { autoDerivePath, launchPath } from '../domain/endpoints.js';
import type { Runtime } from './runtime.js';
import { acceptDerivedWorkspaceConfigurations, acceptWorkspaceConfigurations, prepareConfigIdsDraft, refreshRackMetadata, refreshStorageLayoutDraft } from './workspaceRefresh.js';

interface LaunchOptions {
  expectedRevision?: number | undefined;
  productCode: string;
  mode: ConfigMode;
  solution: SolutionContext;
  ctx: RequestCtx;
  label?: string | undefined;
  workspaceId?: string | undefined;
}

/**
 * Control-flow marker for "priming was deliberately not attempted".
 *
 * Distinguishes a preconfigured model with nothing to derive from a real
 * priming failure, so the latter still gets logged as a warning.
 */
class SkipPriming extends Error {
  constructor() {
    super('priming skipped: no configurable sections');
    this.name = 'SkipPriming';
  }
}

/**
 * Generates an online 10-character Lenovo DCSC Configuration ID.
 * If a session or workspace handle is supplied, binds the ID to its state.
 */
export async function generateConfigId(rt: Runtime, handle?: string, ctx?: RequestCtx): Promise<{ configId: string }> {
  let effectiveCtx = ctx;
  let session: ConfigSession | undefined;
  let workspace: WorkspaceSession | undefined;

  if (handle) {
    const resolved = rt.sessions.resolveHandle(handle);
    session = resolved?.session;
    workspace = resolved?.workspace;
    if (session) {
      effectiveCtx = ctx ?? rt.newCtx({ locale: session.locale, solution: session.solution });
    } else if (workspace) {
      effectiveCtx = ctx ?? rt.newCtx({ locale: workspace.locale, solution: workspace.solution });
    }
  }

  if (!effectiveCtx) effectiveCtx = rt.newCtx();
  const result = await domainGenerateConfigId(rt.http, effectiveCtx);

  if (session) {
    session.raw.userGeneratedConfigId = result.configId;
  }
  if (workspace) {
    workspace.serverState.userGeneratedConfigId = result.configId;
  }

  return result;
}

/**
 * Which solution modes' catalogs contain each of these product codes.
 *
 * DCSC resolves a product against the catalog of whichever mode it is asked
 * about, and launch does not enforce membership — so a model can launch and
 * price cleanly under a mode it is not in, then be rejected outright on
 * import. SR685a V3 (7DHCCTO1WW) is General Purpose only and behaves exactly
 * that way. Knowing where a model actually lives makes that visible up front
 * instead of three steps later.
 *
 * Costs at most one request per mode per day thanks to the catalog cache.
 */
export async function modesContaining(rt: Runtime, ctx: RequestCtx, codes: string[]): Promise<Map<string, string[]>> {
  const wanted = new Set(codes.map((c) => c.toUpperCase()));
  const out = new Map<string, string[]>();
  for (const code of wanted) out.set(code, []);
  if (wanted.size === 0) return out;

  for (const info of await rt.solutionModes(ctx)) {
    const solution = await rt.resolveSolution(ctx, info.mode);
    const catalog = await rt.catalog(ctx, solution);
    const codeSet = catalogCodeSet(catalog);
    for (const code of wanted) {
      if (codeSet.has(code)) {
        const modes = out.get(code)!;
        if (!modes.includes(info.mode)) modes.push(info.mode);
      }
    }
  }
  return out;
}

export async function blueprintAvailability(rt: Runtime, ctx: RequestCtx) {
  const modes = await rt.solutionModes(ctx);
  const catalogs = await Promise.all(modes.map(async info => {
    const solution = toSolutionContext(modes, info.mode);
    return { mode: info.mode, catalog: await rt.catalog(ctx, solution) };
  }));
  return BLUEPRINTS.map(blueprint => {
    const availableModes = catalogs.filter(({ catalog }) => catalog.entries.some(entry =>
      entry.code.toUpperCase() === blueprint.productCode.toUpperCase() && !entry.withdrawn)).map(item => item.mode);
    return { ...blueprint, available: availableModes.length > 0, availableModes,
      catalogCheckedAt: new Date(Math.min(...catalogs.map(item => item.catalog.fetchedAt))).toISOString(),
      historicalVerification: { date: blueprint.verifiedOn, country: 'US', currency: 'USD', listPrice: blueprint.verifiedListPriceUsd },
      availabilityNote: availableModes.length ? 'Current catalog availability; configured BOM and pricing require fresh verification.' : 'Not present in the current catalogs for this locale. This historical blueprint cannot be launched.' };
  });
}

/**
 * Launches a configuration and opens a session within a workspace.
 */
export async function launch(rt: Runtime, opts: LaunchOptions): Promise<ConfigSession> {
  const workspace = opts.workspaceId ? rt.sessions.getWorkspace(opts.workspaceId) : undefined;
  if (opts.workspaceId && !workspace) throw new Error(`Workspace ${opts.workspaceId} not found`);
  if (opts.expectedRevision !== undefined && !workspace) throw new Error('expectedRevision requires an existing workspace.');
  if (workspace) assertWorkspaceRevision(workspace, opts.expectedRevision);
  const prepared = await prepareLaunch(rt, { ...opts, ...(workspace ? { workspaceId: workspace.id } : {}) });
  const result = await rt.sessions.createManyAtomic([prepared], {
    remoteApplied: true,
    actionHistory: addHistoryFactory(prepared.configurationId),
    ...(workspace ? { workspaceHandle: workspace.id, expectedRevision: opts.expectedRevision } : {}),
  });
  return result.sessions[0]!;
}

export async function prepareLaunch(rt: Runtime, opts: LaunchOptions): Promise<CreateSessionInput> {
  const { productCode, mode, solution, ctx } = opts;
  const path = launchPath(mode, productCode);

  const res = await rt.http.send({
    endpoint: `${mode}_launch`,
    method: 'POST',
    path,
    query: { serviceCto: true, serviceType: 'servicecto', controlExpressModal: true },
    body: { kind: 'json', value: {} },
    responseKind: 'json',
    timeoutClass: 'interactive',
    ctx: { ...ctx, solution },
  }).catch((err: unknown) => {
    // Verified 2026-08-08: /lfos/{code}/add_options_launch is 404 across
    // models ("No static resource"). The route is gone from this release;
    // lfo-as-cto is the mode that actually yields a configurable tree.
    if (mode === 'lfo-add-options') {
      throw new Error(
        `DCSC has no add-options route for ${productCode} (HTTP 404). This mode appears retired ` +
          'in the current release. Relaunch with mode "lfo-as-cto" to get a configurable tree ' +
          'for a preconfigured model.',
      );
    }
    throw err;
  });

  let raw = res.raw as RawConfiguration;
  if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.tabs)) {
    throw new Error(
      `DCSC returned no configuration tree for ${productCode}. The product code may not be configurable in this solution mode.`,
    );
  }

  const configurationId = newConfigurationId(ctx.locale.country);
  const reduceMode = hardwareModeFamily(mode);
  let reduced = reduceConfiguration(raw, configurationId, reduceMode, solution.solutionMode);

  // A preconfigured model comes back with no sections at all — there is
  // nothing to derive, and posting a section-less body is a guaranteed
  // HTTP 400 "Failed to read request" that also feeds the breaker's failure
  // window. Skipping it is not a degraded path; it is the correct one.
  const sectionCount = (raw.tabs ?? []).reduce(
    (n, t) => n + (t?.subTabs ?? []).reduce((m, st) => m + (st?.sections?.length ?? 0), 0),
    0,
  );

  let primed = false;
  try {
    if (sectionCount === 0) {
      logger().debug(
        { productCode, mode },
        'No configurable sections; skipping priming autoDerive',
      );
      throw new SkipPriming();
    }
    const derived = await autoDerive(rt, reduced, {
      ctx,
      solution,
      mode,
      validationMode: 'guided',
    });
    if (derived) {
      raw = {
        ...derived,
        hipoDerivedItems: derived.hipoDerivedItems ?? raw.hipoDerivedItems,
        hipoServiceCtoServices: derived.hipoServiceCtoServices ?? raw.hipoServiceCtoServices,
      };
      reduced = reduceConfiguration(raw, configurationId, reduceMode, solution.solutionMode);
      primed = true;
    }
  } catch (err) {
    if (!(err instanceof SkipPriming)) {
      logger().warn(
        { productCode, mode, err: errorMessage(err) },
        'Priming autoDerive failed; session is read-only until it succeeds',
      );
    }
  }

  return {
    primed,
    configurable: sectionCount > 0,
    locale: ctx.locale,
    solution,
    mode,
    raw,
    configurationId,
    reduced,
    workspaceId: opts.workspaceId,
    ...(opts.label !== undefined ? { label: opts.label } : {}),
  };
}

export async function autoDerive(rt: Runtime, reduced: ReducedConfiguration,
  opts: {
    ctx: RequestCtx;
    solution: SolutionContext;
    mode: ConfigMode;
    validationMode: 'guided' | 'expert';
    autoCorrect?: boolean;
    softwareEdit?: boolean;
    sourceRaw?: RawConfiguration;
    workspace?: WorkspaceSession;
  },): Promise<RawConfiguration | undefined> {
  const family = hardwareEndpointFamily(opts.mode);
  const isLfo = family === 'lfos';
  const lfoHardware = isLfo && !opts.softwareEdit;
  const storageComponent = !!opts.workspace && managedStorageComponentIds(opts.workspace.serverState).has(reduced.id);
  const rackContext = !isLfo && opts.workspace && opts.sourceRaw?.type === 'rack' &&
    opts.workspace.rackArea.some(rack => rack.id === reduced.id) ? opts.workspace : undefined;
  let rackBody: Record<string, unknown> | undefined;
  if (rackContext) {
    rackBody = buildRackRecustomizePlan(rackContext, reduced.id).body;
    rackBody.configurations = (rackBody.configurations as ReducedConfiguration[])
      .map(config => config.id === reduced.id ? reduced : config);
  } else if (opts.workspace && (storageComponent || configIdTargetCodes(opts.sourceRaw).length > 0 ||
    Array.isArray(opts.workspace.serverState.autoDerivedResults) && opts.workspace.serverState.autoDerivedResults.length > 0)) {
    rackBody = buildAutoDeriveRequest(opts.workspace, { validationMode: opts.validationMode,
      ...(opts.autoCorrect !== undefined ? { autoCorrect: opts.autoCorrect } : {}) });
    rackBody.customizingIds = storageComponent
      ? [...storagePhysicalTemplateIds(opts.workspace)].filter(([id, template]) => template === reduced.id && id !== template)
          .map(([id]) => id).concat(reduced.id)
      : [reduced.id];
    rackBody.configurations = (rackBody.configurations as ReducedConfiguration[])
      .map(config => config.id === reduced.id ? reduced : config);
  }
  const res = await rt.http.send({
    endpoint: isLfo ? 'lfo_autoDerive' : 'cto_autoDerive',
    method: 'POST',
    path: autoDerivePath(family),
    query: { configurationId: reduced.id, ...(storageComponent ? {} : { entranceFlag: 'customize' }),
      ...(lfoHardware ? { isLfo: true, scope: 'HW' }
        : opts.softwareEdit ? { isCustomizeOSSoftware: true, isCustomizeNewSoftwareEngine: true }
        : { guideMode: opts.validationMode === 'guided' }) },
    body: {
      kind: 'json',
      value: rackBody ?? (lfoHardware ? buildLfoHardwareDeriveRequest(reduced, opts.workspace)
        : buildAutoDeriveRequest(reduced, { validationMode: opts.validationMode,
        ...(opts.autoCorrect !== undefined ? { autoCorrect: opts.autoCorrect } : {}) })),
    },
    responseKind: 'json',
    timeoutClass: 'heavy',
    ctx: { ...opts.ctx, locale: opts.workspace?.locale ?? opts.ctx.locale, solution: opts.solution },
  });
  const metadata = res.raw as Record<string, unknown>;
  if (opts.workspace && Array.isArray(metadata.autoDerivedResults)) {
    opts.workspace.serverState.autoDerivedResults = structuredClone(metadata.autoDerivedResults);
  }
  if (storageComponent && opts.workspace && Array.isArray(metadata.configurations)) {
    const aliases = new Map([...storagePhysicalTemplateIds(opts.workspace)].filter(([id, template]) => id !== template));
    const split = splitStoragePhysicalDerive([...opts.workspace.configurations.values()].map(session => session.raw), metadata, aliases);
    const updated = split.configurations.find(configuration => configuration.id === reduced.id);
    if (!updated) throw new Error('DCSC did not return the edited storage template. Workspace was not committed.');
    acceptDerivedWorkspaceConfigurations(opts.workspace, metadata);
    return projectAutoDerivedSelections(withDerivedPlacements(updated, metadata), metadata.autoDerivedResults).configuration;
  }
  if (rackContext) return projectAutoDerivedSelections(
    withDerivedPlacements(parseRackRecustomizeResult(res.raw, reduced.id).configuration, metadata),
    metadata.autoDerivedResults).configuration;
  const body = res.raw as { configurations?: RawConfiguration[] };
  if (body.configurations?.length) {
    const configuration = body.configurations.find(configuration => configuration.id === reduced.id) ??
      (body.configurations.length === 1 ? body.configurations[0] : undefined);
    return configuration ? projectAutoDerivedSelections(withDerivedPlacements(configuration, metadata), metadata.autoDerivedResults).configuration : undefined;
  }
  if (opts.softwareEdit && opts.sourceRaw && isSoftwareDerivePatch(res.raw)) {
    return applySoftwareDerivePatch(opts.sourceRaw, res.raw);
  }
  return undefined;
}

/**
 * Applies selection changes and commits the reconciled result.
 */
export async function configure(rt: Runtime, session: ConfigSession,
  changes: Array<{ section: string; code: string; quantity: number }>,
  ctx: RequestCtx,
  expectedRevision?: number,): Promise<ConfigSession> {
  return rt.sessions.transact(session.id, {
    expectedRevision,
    remoteApplied: true,
    actionHistory: updateHistoryFactory(session.configurationId),
  }, async (workspace, draft) => {
    if (!draft) throw new Error('A configuration handle is required.');
    return configureDraft(rt, draft, changes, ctx, workspace);
  });
}

export async function loadUnconfigured(rt: Runtime, handle: string, expectedWorkspaceRevision: number, ctx: RequestCtx) {
  const resolved = requireConfiguration(rt.sessions, handle, 'Choose one configuration handle before loading Unconfigured options.');
  await rt.sessions.transact(handle, { expectedRevision: resolved.session.revision, remoteApplied: false }, async (workspace, session) => {
    assertWorkspaceRevision(workspace, expectedWorkspaceRevision);
    if (!session) throw new Error('A configuration handle is required.');
    const code = session.raw.sliceCtoCode ?? session.raw.ctoCode ?? session.raw.code;
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]+$/.test(code)) throw new Error('Configuration has no native product code.');
    const response = await rt.http.send({ endpoint: 'unconfigured_catalog', method: 'POST', path: `/unconfigured/${code}`,
      responseKind: 'json', timeoutClass: 'heavy', ctx: { ...ctx, locale: workspace.locale, solution: workspace.solution } });
    const group = linkedGroup(workspace, session.configurationId);
    for (const member of workspace.configurations.values()) {
      if (!group.memberIds.includes(member.configurationId)) continue;
      const memberCode = member.raw.sliceCtoCode ?? member.raw.ctoCode ?? member.raw.code;
      if (memberCode !== code) throw new Error('Linked configurations have inconsistent product identities; catalog refresh was not committed.');
      member.raw = hydrateUnconfiguredCatalog(member.raw, response.raw as RawConfiguration);
      rebuildDerived(member, workspace);
    }
    refreshRackMetadata(workspace, true);
  });
  return rt.sessions.get(handle)!;
}

export async function setUnconfigured(rt: Runtime, handle: string, changes: Array<{ section: string; code: string; quantity: number }>, expectedWorkspaceRevision: number) {
  const resolved = requireConfiguration(rt.sessions, handle, 'Choose one configuration handle before editing Unconfigured selections.');
  if (changes.length === 0) throw new Error('Provide at least one Unconfigured selection change.');
  await rt.sessions.transact(resolved.workspace.id, { expectedRevision: expectedWorkspaceRevision, remoteApplied: false }, async workspace => {
    const session = workspace.configurations.get(resolved.session.id);
    if (!session) throw new Error('Configuration is no longer present.');
    const edits = changes.map(change => {
      const section = resolveSection(session.index, change.section);
      if (!section) throw new Error('Load Unconfigured options and use an exact section ID from dcsc_list_options.');
      return { ...change, sectionName: section.name };
    });
    const group = linkedGroup(workspace, session.configurationId);
    for (const member of workspace.configurations.values()) {
      if (!group.memberIds.includes(member.configurationId)) continue;
      for (const edit of edits) member.raw = stageUnconfiguredSelection(member.raw, edit);
      rebuildDerived(member, workspace);
      member.intents.push({ at: Date.now(), changes });
    }
    refreshRackMetadata(workspace, true);
    invalidateConnectionGraph(workspace.serverState, 'Unconfigured selections changed. Regenerate connections before handoff.');
  });
  return rt.sessions.get(handle)!;
}

async function prepareRackCustomizationDraft(rt: Runtime, workspace: WorkspaceSession, session: ConfigSession, ctx: RequestCtx): Promise<void> {
  const ready = Array.isArray(workspace.serverState.rackCustomizationReady)
    ? workspace.serverState.rackCustomizationReady as string[] : [];
  if (ready.includes(session.configurationId)) return;
  const plan = buildRackRecustomizePlan(workspace, session.configurationId);
  const response = await rt.http.send({ ...plan, body: { kind: 'json', value: plan.body },
    responseKind: 'json', timeoutClass: 'heavy',
    ctx: { ...ctx, locale: workspace.locale, solution: workspace.solution } });
  const parsed = parseRackRecustomizeResult(response.raw, session.configurationId);
  if (Array.isArray(parsed.responseState.autoDerivedResults)) {
    workspace.serverState.autoDerivedResults = structuredClone(parsed.responseState.autoDerivedResults);
  }
  acceptWorkspaceConfigurations(workspace, mergeDerivedConfigurations(
    [...workspace.configurations.values()].map(value => value.raw), { configurations: [parsed.configuration] }));
  workspace.serverState.rackCustomizationState = parsed.responseState;
  if (Array.isArray(parsed.responseState.autoDerivedResults)) {
    workspace.serverState.autoDerivedResults = structuredClone(parsed.responseState.autoDerivedResults);
  }
  workspace.serverState.rackCustomizationReady = [...ready, session.configurationId];
}

/** Operates only on a detached transaction draft; never acquires another lock. */
export async function configureDraft(rt: Runtime, session: ConfigSession,
  changes: Array<{ section: string; code: string; quantity: number }>,
  ctx: RequestCtx,
  workspace?: WorkspaceSession,): Promise<ConfigSession> {
const previousSelections = new Map(session.index.selected);
if (workspace) await prepareConfigIdsDraft(rt, workspace, ctx);
if (workspace) {
  const group = linkedGroup(workspace, session.configurationId);
  if (group.linked) return configureLinkedDraft(rt, workspace, session, changes, ctx, group);
}
if (workspace && session.raw.type === 'rack' && usesCtoWire(session.mode) &&
    workspace.rackArea.some(rack => rack.id === session.configurationId)) {
  await prepareRackCustomizationDraft(rt, workspace, session, ctx);
}
// Client-held fabric fields: keep across autoDerive, but do not post them
// in the derive body — DCSC rejects unknown/extra topology shapes (400).
const preservedTopologies = session.reduced.selectedTopologies ?? {};
const preservedRole = session.reduced.nodeRole ?? '';

const { reduced: forDerive, softwareEdit } = prepareConfigurationChanges(session, changes);

const updated = await autoDerive(rt, forDerive, {
  ctx,
  solution: session.solution,
  mode: session.mode,
  validationMode: session.validationMode,
  autoCorrect: session.autoCorrect,
  softwareEdit,
  sourceRaw: session.raw,
  ...(workspace ? { workspace } : {}),
});
if (!updated) {
  throw new Error('DCSC returned no configuration after applying the change.');
}

session.primed = true;
const updatedTopologies =
  typeof (updated as Record<string, unknown>)['selectedTopologies'] === 'object' &&
  (updated as Record<string, unknown>)['selectedTopologies'] !== null
    ? ((updated as Record<string, unknown>)['selectedTopologies'] as Record<string, unknown>)
    : undefined;
const updatedRole =
  typeof (updated as Record<string, unknown>)['nodeRole'] === 'string'
    ? ((updated as Record<string, unknown>)['nodeRole'] as string)
    : undefined;
const mergedUpdated = {
  ...preserveUnconfiguredSelections(session.raw, updated),
  quantity: session.raw.quantity ?? updated.quantity ?? 1,
  ...(Object.hasOwn(session.raw, 'selectedStorageNetwork')
    ? { selectedStorageNetwork: structuredClone(session.raw.selectedStorageNetwork) } : {}),
  hipoDerivedItems: updated.hipoDerivedItems ?? session.raw.hipoDerivedItems,
  hipoServiceCtoServices: updated.hipoServiceCtoServices ?? session.raw.hipoServiceCtoServices,
  selectedTopologies:
    updatedTopologies && Object.keys(updatedTopologies).length > 0
      ? updatedTopologies
      : preservedTopologies,
  nodeRole: updatedRole && updatedRole !== '' ? updatedRole : preservedRole,
};
session.raw = mergedUpdated;
rebuildDerived(session, session);
if (workspace) await prepareConfigIdsDraft(rt, workspace, ctx);
if (workspace) refreshRackMetadata(workspace, true);
if (workspace && (previousSelections.size !== session.index.selected.size ||
    [...previousSelections].some(([code, quantity]) => session.index.selected.get(code) !== quantity))) {
  invalidateConnectionGraph(workspace.serverState, 'Configuration selections changed. Regenerate connections before exporting or validating.');
}
if (workspace && managedStorageComponentIds(workspace.serverState).has(session.configurationId) &&
    [...storagePhysicalTemplateIds(workspace).values()].includes(session.configurationId)) {
  await refreshStorageLayoutDraft(rt, workspace, ctx);
}
session.intents.push({ at: Date.now(), changes });
return session;
}

/** Fan out the explicit updateConfigurationIds contract for GP and shared HPC node/chassis/switch/materialized-storage edits. */
async function configureLinkedDraft(rt: Runtime, workspace: WorkspaceSession, initiating: ConfigSession,
  changes: Array<{ section: string; code: string; quantity: number }>, ctx: RequestCtx, group: LinkedCloneGroup): Promise<ConfigSession> {
  const members = group.memberIds.map(id => [...workspace.configurations.values()].find(value => value.configurationId === id)!);
  const editor = members.find(member => member.configurationId === group.rootId)!;
  const hpcNodes = workspace.solution.solutionMode === 'HPC and AI - Systems' && members.every(member => member.raw.type === 'node');
  const hpcChassis = workspace.solution.solutionMode === 'HPC and AI - Systems' && members.every(member => member.raw.type === 'chassis');
  const managed = managedStorageComponentIds(workspace.serverState);
  const hpcSwitches = workspace.solution.solutionMode === 'HPC and AI - Systems' &&
    members.every(member => member.raw.type === 'switch' && !managed.has(member.configurationId));
  const physicalTemplates = storagePhysicalTemplateIds(workspace);
  const hpcStorage = workspace.solution.solutionMode === 'HPC and AI - Systems' &&
    members.every(member => member.raw.type === 'storage' && !managed.has(member.configurationId) &&
      (physicalTemplates.get(member.configurationId) ?? member.configurationId) === member.configurationId);
  const hpcLinked = hpcNodes || hpcChassis || hpcSwitches || hpcStorage;
  if ((!hpcLinked && workspace.solution.solutionMode !== 'General Purpose') || members.some(member =>
    !usesCtoWire(member.mode) || member.product.code !== initiating.product.code ||
    (member.raw.quantity ?? 1) !== 1 || member.validationMode !== initiating.validationMode || member.autoCorrect !== initiating.autoCorrect)) {
    throw new Error('Linked edits require matching General Purpose CTO configurations or HPC node/chassis/switch/materialized-storage configurations at quantity one with the same validation controls.');
  }
  const savedHistory = workspace.serverState.linkedConfigurationEdits;
  if (savedHistory !== undefined && (!savedHistory || typeof savedHistory !== 'object' || Array.isArray(savedHistory))) {
    throw new Error('Linked configuration history is malformed. Use workspace history or inspect recovery data.');
  }
  const histories = (savedHistory ?? {}) as Record<string, unknown>;
  const previousEdits = histories[group.rootId] ?? [];
  if (!Array.isArray(previousEdits)) throw new Error('Linked configuration history is malformed.');
  const beforeMembers = members.map(member => ({ configurationId: member.configurationId,
    revision: member.revision, intentCount: member.intents.length }));
  // Reject previously diverged commercial selections before posting a new linked edit.
  buildGroups(workspace);
  const prepared = members.map(member => ({ member, ...prepareConfigurationChanges(member, changes) }));
  const softwareEdit = prepared[0]!.softwareEdit;
  if (prepared.some(value => value.softwareEdit !== softwareEdit)) throw new Error('Linked members disagree on the selected editing context.');
  const body = buildAutoDeriveRequest(workspace, { validationMode: initiating.validationMode, autoCorrect: initiating.autoCorrect });
  body.customizingIds = [...group.memberIds];
  const byId = new Map(prepared.map(value => [value.member.configurationId, value.reduced]));
  body.configurations = (body.configurations as ReducedConfiguration[]).map(value => byId.get(value.id) ?? value);
  if (hpcLinked) {
    // Native HPC keeps shared configurations at clone roots. Repeated response
    // records may still occur after a fresh physical clone.
    const dependency = configurationCloneDependency(workspace);
    const ids = [...workspace.configurations.values()].map(member => member.configurationId);
    body.configurations = (body.configurations as ReducedConfiguration[]).filter(value =>
      resolveLinkedCloneGroup(dependency, ids, value.id).rootId === value.id);
  }

  const response = await rt.http.send({ endpoint: 'cto_autoDerive', method: 'POST', path: autoDerivePath('ctos'),
    query: { configurationId: editor.configurationId, ...(!hpcLinked ? { entranceFlag: 'customize' } : {}),
      ...(softwareEdit ? { isCustomizeOSSoftware: true, isCustomizeNewSoftwareEngine: true }
        : { guideMode: initiating.validationMode === 'guided' }) },
    body: { kind: 'json', value: body }, responseKind: 'json', timeoutClass: 'heavy',
    ctx: { ...ctx, locale: workspace.locale, solution: workspace.solution } });
  const result = response.raw as { configurations?: RawConfiguration[]; autoDerivedResults?: unknown };
  let projected: RawConfiguration[];
  if (hpcLinked) {
    const dependency = configurationCloneDependency(workspace);
    const ids = [...workspace.configurations.values()].map(member => member.configurationId);
    const allowedRoots = new Set([group.rootId]);
    const sharedChildRoots = new Set<string>();
    if (hpcSwitches || hpcStorage) {
      // Native linked switch/storage edits may return their containing rack.
      for (const rack of workspace.rackArea) {
        const items = Array.isArray(rack['rackItems']) ? rack['rackItems'] as Record<string, unknown>[] : [];
        if (!items.some(item => group.memberIds.includes(String(item['configurationId'] ?? item['id'])))) continue;
        allowedRoots.add(resolveLinkedCloneGroup(dependency, ids, String(rack['id'])).rootId);
        for (const item of items) {
          const id = String(item['configurationId'] ?? item['id']);
          if (hpcSwitches && item['type'] === 'switch' && ids.includes(id) && !managed.has(id)) {
            allowedRoots.add(resolveLinkedCloneGroup(dependency, ids, id).rootId);
          }
        }
      }
    }
    const physicalItems = [...workspace.rackArea.flatMap(rack => Array.isArray(rack['rackItems']) ? rack['rackItems'] as Record<string, unknown>[] : []), ...workspace.nonRackArea];
    for (const item of physicalItems) {
      const nodes = Array.isArray(item['nodes']) ? item['nodes'] as Record<string, unknown>[] : [];
      if (hpcChassis && item['type'] === 'chassis' && group.memberIds.includes(String(item['configurationId'] ?? item['id']))) {
        for (const node of nodes) {
          const childRoot = resolveLinkedCloneGroup(dependency, ids, String(node['configurationId'] ?? node['id'])).rootId;
          allowedRoots.add(childRoot); sharedChildRoots.add(childRoot);
        }
      }
      if (hpcNodes && item['type'] === 'chassis' && nodes.some(node => group.memberIds.includes(String(node['configurationId'] ?? node['id'])))) {
        allowedRoots.add(resolveLinkedCloneGroup(dependency, ids, String(item['configurationId'] ?? item['id'])).rootId);
      }
    }
    if (!Array.isArray(result.configurations)) throw new Error('DCSC omitted HPC linked configurations.');
    projected = projectHpcLinkedResponses(result.configurations, [...workspace.configurations.values()].map(member => member.raw),
      dependency, group.rootId, allowedRoots, sharedChildRoots);
  } else {
    const raw = result.configurations?.[0];
    if (!Array.isArray(result.configurations) || result.configurations.length !== 1 || !raw ||
      raw.id !== editor.configurationId || !Array.isArray(raw.tabs) || raw.type !== initiating.raw.type ||
      String(raw.code || raw.sliceCtoCode || '') !== initiating.product.code) {
      throw new Error('DCSC returned an unexpected linked-clone edit response. No linked configurations were committed.');
    }
    projected = projectLinkedCloneResponse(raw, group);
  }
  const dependentUpdates = projected.some(configuration => !group.memberIds.includes(String(configuration.id)));
  if (Array.isArray(result.autoDerivedResults)) workspace.serverState.autoDerivedResults = structuredClone(result.autoDerivedResults);
  acceptWorkspaceConfigurations(workspace, projected);
  const editAt = Date.now();
  for (const member of members) {
    member.primed = true;
    member.intents.push({ at: editAt, changes: structuredClone(changes) });
  }
  if (changes.length > 0) {
    workspace.serverState.linkedConfigurationEdits = { ...histories,
      [group.rootId]: [...previousEdits, { at: editAt, members: beforeMembers, ...(dependentUpdates ? { requiresWorkspaceUndo: true } : {}) }].slice(-10) };
  }
  await prepareConfigIdsDraft(rt, workspace, ctx);
  refreshRackMetadata(workspace, true);
  buildGroups(workspace);
  invalidateConnectionGraph(workspace.serverState, 'Linked configuration selections changed.');
  return initiating;
}

/** Website controls apply consistently to the complete workspace. */
export async function setConfigurationControls(rt: Runtime, handle: string, opts: {
  validationMode?: 'guided' | 'expert' | undefined;
  autoCorrect?: boolean | undefined;
  expectedRevision?: number | undefined;
  ctx: RequestCtx;
}): Promise<{ workspace: string; revision: number; validationMode: 'guided' | 'expert'; autoCorrect: boolean }> {
  const resolved = rt.sessions.resolveHandle(handle);
  if (!resolved?.workspace) throw new Error(`Session or workspace ${handle} not found.`);
  const transaction = { expectedRevision: opts.expectedRevision, keepEmptyWorkspace: true, remoteApplied: false,
    actionHistory: configurationControlsHistoryFactory() };
  await rt.sessions.transact(resolved.workspace.id, transaction, async (workspace) => {
    const mode = opts.validationMode ?? workspace.validationMode;
    if (mode === 'expert' && opts.autoCorrect === true) throw new Error('Auto-Correct cannot be enabled in Expert mode.');
    const autoCorrect = mode === 'expert' ? false : opts.autoCorrect
      ?? [...workspace.configurations.values()].every((session) => session.autoCorrect);
    workspace.validationMode = mode;
    for (const session of workspace.configurations.values()) {
      session.validationMode = mode;
      session.autoCorrect = autoCorrect;
    }
    const applied = new Set<string>();
    for (const session of workspace.configurations.values()) {
      if (!session.configurable || applied.has(session.configurationId)) continue;
      const group = linkedGroup(workspace, session.configurationId);
      await configureDraft(rt, session, [], { ...opts.ctx, locale: workspace.locale }, workspace);
      transaction.remoteApplied = true;
      for (const id of group.memberIds) applied.add(id);
    }
    workspace.serverState.configurationControls = { validationMode: mode, autoCorrect };
  });
  const workspace = rt.sessions.getWorkspace(resolved.workspace.id)!;
  const controls = workspace.serverState.configurationControls as { validationMode: 'guided' | 'expert'; autoCorrect: boolean };
  return { workspace: workspace.id, revision: workspace.revision, ...controls };
}

/**
 * Sets how many identical units of this configuration are wanted.
 */
export async function setQuantity(rt: Runtime, session: ConfigSession, quantity: number, expectedRevision?: number): Promise<ConfigSession> {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error('Quantity must be an integer from 1 to 99.');
  return rt.sessions.transact(session.id, { expectedRevision }, (workspace, draft) => {
    if (!draft) throw new Error('A configuration handle is required.');
    if (managedStorageComponentIds(workspace.serverState).has(draft.configurationId) && quantity !== 1) {
      throw new Error('Managed storage templates retain quantity one. Add or remove physical storage network placements to change installed quantities.');
    }
    const group = linkedGroup(workspace, draft.configurationId);
    if (group.linked && quantity !== 1) {
      throw new Error('Linked physical clones each have quantity one. Use dcsc_clone_configuration with placement="same-rack" to add physical instances, or close an unwanted clone configuration.');
    }
    draft.raw.quantity = quantity;
    return draft;
  });
}

export async function undo(rt: Runtime, session: ConfigSession, expectedRevision?: number): Promise<boolean> {
  return rt.sessions.transact(session.id, { history: 'restore', expectedRevision }, (workspace, draft) => {
    if (!draft) throw new Error('A configuration handle is required.');
    if ([...storagePhysicalTemplateIds(workspace).values()].includes(draft.configurationId)) {
      throw new Error('This storage configuration has physical instances. Use dcsc_workspace_history with action="undo" to restore its selections, physical instances, prices and connection graph together.');
    }
    const group = linkedGroup(workspace, draft.configurationId);
    if (group.linked) {
      const histories = workspace.serverState.linkedConfigurationEdits as Record<string, unknown> | undefined;
      const entries = histories?.[group.rootId];
      const marker = Array.isArray(entries) ? entries.at(-1) as {
        at?: unknown; requiresWorkspaceUndo?: boolean; members?: Array<{ configurationId: string; revision: number; intentCount: number }>;
      } | undefined : undefined;
      const message = 'No matching atomic linked edit can be undone. Use dcsc_workspace_history to restore the complete workspace.';
      if (!Array.isArray(entries) || !marker || marker.requiresWorkspaceUndo || typeof marker.at !== 'number' || !Array.isArray(marker.members) ||
        marker.members.some(member => !member || typeof member !== 'object' || typeof member.configurationId !== 'string') ||
        marker.members.length !== group.memberIds.length ||
        new Set(marker.members.map(member => member.configurationId)).size !== group.memberIds.length ||
        marker.members.some(member => !group.memberIds.includes(member.configurationId))) throw new Error(message);
      const targets = marker.members.map(previous => {
        const member = [...workspace.configurations.values()].find(value => value.configurationId === previous.configurationId)!;
        const snapshot = member.snapshots.at(-1);
        if (!snapshot || snapshot.revision !== previous.revision || !Number.isInteger(previous.intentCount) ||
          previous.intentCount < 0 || member.intents.length !== previous.intentCount + 1 ||
          member.intents.at(-1)?.at !== marker.at) throw new Error(message);
        return { member, snapshot, intentCount: previous.intentCount };
      });
      for (const { member, snapshot, intentCount } of targets) {
        member.snapshots.pop();
        member.raw = structuredClone(snapshot.raw);
        member.intents = member.intents.slice(0, intentCount);
      }
      buildGroups(workspace);
      workspace.serverState.linkedConfigurationEdits = { ...histories, [group.rootId]: entries.slice(0, -1) };
      refreshRackMetadata(workspace, true);
      invalidateConnectionGraph(workspace.serverState, 'Linked configuration selections were undone.');
      return true;
    }
    const snapshot = draft.snapshots.pop();
    if (!snapshot) return false;
    draft.raw = structuredClone(snapshot.raw);
    draft.intents.pop();
    refreshRackMetadata(workspace, true);
    invalidateConnectionGraph(workspace.serverState, 'Configuration selections were undone. Regenerate connections before exporting or validating.');
    return true;
  });
}

export async function closeSession(rt: Runtime, handle: string, expectedRevision?: number): Promise<boolean> {
  const resolved = rt.sessions.resolveHandle(handle);
  if (!resolved?.workspace) return false;
  if (resolved.kind === 'workspace') return rt.sessions.deleteWorkspace(resolved.workspace.id, expectedRevision);
  return rt.sessions.transact(handle, { expectedRevision, actionHistory: removeHistoryFactory(handle) }, (workspace, target) => {
    if (!target) {
      workspace.configurations.clear();
      return true;
    }
    const id = target.configurationId;
    const storageDefinitions = readStorageConnectionNetworks(workspace.serverState)
      .filter(network => [network.controller, network.mainSwitch].some(selection => selection?.id === id));
    if (storageDefinitions.length > 0) {
      throw new Error(`This managed component belongs to storage network ${storageDefinitions.map(network => `"${network.name}"`).join(', ')}. Use dcsc_edit_storage_network with action="remove" to remove the definition and its managed components together.`);
    }
    const physicalItems = [...workspace.rackArea, ...workspace.nonRackArea];
    for (const item of physicalItems) {
      if (item.id === id && physicalIds(item).size > 1) {
        throw new Error(`This ${item.type ?? 'container'} contains configurations. Use dcsc_edit_layout with an explicit contents disposition before closing it.`);
      }
      for (const field of ['rackItems', 'nodes']) {
        if (Array.isArray(item[field])) physicalItems.push(...item[field] as RackObject[]);
      }
    }
    workspace.configurations.delete(target.id);
    removeWorkspaceReferences(workspace, new Set([id]));
    workspace.rackSummaries = summariseRackArea(workspace.rackArea);
    return true;
  });
}
