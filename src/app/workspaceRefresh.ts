import {
  planNativeManualCableSelection,
  assertNativeConnectionsRetained,
  stageNativeManualCableQuantity,
  importedManualCableSelections,
} from '../domain/nativeManualCabling.js';
import { resolveLinkedCloneGroup, projectHpcLinkedResponses } from '../domain/linkedCloneEdit.js';
import { preserveUnconfiguredSelections } from '../domain/unconfigured.js';
import { refreshStoragePhysicalFeatures, splitStoragePhysicalDerive } from '../domain/storagePhysicalDerive.js';
import { hardwareModeFamily, usesCtoWire } from '../domain/modeFamily.js';
import {
  buildAutoDeriveRequest,
  newConfigurationId,
  reduceConfiguration,
  type ReducedConfiguration,
} from '../domain/reduce.js';
import {
  buildRackItem,
  buildRackCustomizePayload,
  withDerivedPlacements,
  buildEnvelopeRequest,
  mergeDerivedConfigurations,
  customizeLayout,
  fetchEnvelopes,
  type CustomizeOptions,
  type LayoutResult,
  type RackObject,
} from '../domain/rack.js';
import { managedStorageComponentIds, configurationCloneDependency, storagePhysicalTemplateIds } from '../domain/storagePreferences.js';
import {
  autoConnect,
  readAutoConnectSettings,
  readConnectionGraph,
  readSwitchMap,
  projectConnectionGraph,
  type AutoConnectResult,
} from '../domain/cabling.js';
import { physicalIds } from '../domain/workspaceReferences.js';
import { buildFloorState } from '../domain/floorWire.js';
import { workspaceHardwareMode } from '../domain/workspaceWire.js';
import { buildSwitchCalculationRequest, parseSwitchCalculationResponse, buildGeneratedSwitch } from '../domain/switchProvisioning.js';
import { projectRackFiller, repriceRackFillers } from '../domain/rackFiller.js';
import { assignConfigIdFeatures, configIdTargetCodes } from '../domain/configIdFeatures.js';
import { projectAutoDerivedSelections } from '../domain/autoDerivedSelections.js';
import { assertAcceptedNestedEdit } from '../domain/nestedPhysical.js';
import { buildIndex } from '../model/index.js';
import { type RequestCtx } from '../http/request.js';
import type { RawConfiguration } from '../model/types.js';
import { stageConfiguration } from '../session/SessionStore.js';
import type { WorkspaceSession } from '../model/session.js';
import { summariseRackArea } from './serviceHelpers.js';
import { autoDerivePath, ctoLaunchPath } from '../domain/endpoints.js';
import { CATALOG_TTL_MS, type Runtime } from './runtime.js';

/**
 * Re-validates the workspace's layout and stores DCSC's corrected version.
 *
 * Every rack mutation funnels through here: DCSC may move items, reject
 * placements or push them out of the rack entirely, and its answer replaces
 * ours rather than merging with it.
 */
export async function syncLayout(rt: Runtime, ws: WorkspaceSession,
  rackArea: RackObject[],
  ctx: RequestCtx,
  opts: CustomizeOptions & { cloneMultiple?: boolean; cloneHpcSwitch?: string; clonePopulatedChassis?: boolean; copyPopulatedChassisDependency?: unknown; copyConfigurationId?: string; lockMutation?: boolean;
    preserveImportedManualCables?: boolean;
    deletedLinkedRootConfigurations?: RawConfiguration[];
    nestedPhysicalEdit?: { configurations: RawConfiguration[]; cloneDependency: unknown } } = {},): Promise<LayoutResult> {
  const requestContext = { ...ctx, locale: ws.locale, solution: ws.solution };
  const mode = workspaceHardwareMode(ws.configurations.values());
  ws.rackArea = rackArea;
  delete ws.serverState.rackCustomizationReady;
  const importedCablePlans = opts.preserveImportedManualCables
    ? importedManualCableSelections(manualCablingInput(ws)) : [];
  const customize = async () => {
    const result = await customizeLayout(rt.http, requestContext,
      buildRackCustomizePayload({ ...workspaceNetworkState(ws),
        ...(opts.cloneMultiple || opts.copyConfigurationId || opts.deletedLinkedRootConfigurations
          ? { cloneDependency: {}, cloneDependencyColor: {} } : {}), rackArea: ws.rackArea,
        ...(opts.nestedPhysicalEdit ? { cloneDependency: opts.nestedPhysicalEdit.cloneDependency } : {}),
        ...(opts.copyPopulatedChassisDependency ? { cloneDependency: opts.copyPopulatedChassisDependency } : {}),
        nonRackArea: ws.nonRackArea }, opts.nestedPhysicalEdit?.configurations ??
        opts.deletedLinkedRootConfigurations ?? [...ws.configurations.values()].map((session) => session.raw)),
      { autoConnect: true, cogValidation: true, ...opts, mode });
    if (opts.cloneMultiple || opts.cloneHpcSwitch || opts.clonePopulatedChassis || opts.copyConfigurationId || opts.lockMutation || opts.deletedLinkedRootConfigurations || opts.nestedPhysicalEdit) {
      const state = result.rawState;
      if (!Array.isArray(state.rackArea) || !Array.isArray(state.nonRackArea) || !Array.isArray(state.connections)) {
        throw new Error('DCSC returned an incomplete physical layout. Workspace was not committed.');
      }
      if (result.errors.length || state.errors && (!Array.isArray(state.errors) || state.errors.length)) {
        throw new Error(`DCSC rejected the physical layout: ${JSON.stringify(state.errors ?? result.errors).slice(0, 1500)}`);
      }
      if (opts.nestedPhysicalEdit || opts.clonePopulatedChassis) assertAcceptedNestedEdit(ws, {
        rackArea: result.rawRackArea, nonRackArea: result.rawNonRackArea,
      });
    }
    return result;
  };
  let initial = await customize();
  ws.rackArea = initial.rawRackArea;
  ws.nonRackArea = initial.rawNonRackArea;
  if (opts.cloneHpcSwitch) {
    initial = await customize();
    ws.rackArea = initial.rawRackArea;
    ws.nonRackArea = initial.rawNonRackArea;
  }
  // Native layout recalculation marks active cables forAutoConnect and can
  // replace selected spare quantities with route counts. Restore the imported
  // physical quantities before deriving the commercial configurations.
  for (const plan of importedCablePlans) {
    const physical = stageNativeManualCableQuantity(manualCablingInput(ws), plan);
    ws.rackArea = physical.rackArea;
    ws.nonRackArea = physical.nonRackArea;
  }
  await prepareConfigIdsDraft(rt, ws, ctx);
  const hasStorageInstances = [...storagePhysicalTemplateIds(ws)].some(([id, template]) => id !== template);
  if (opts.clonePopulatedChassis) for (const rack of ws.rackArea) {
    const session = [...ws.configurations.values()].find(c => c.configurationId === rack.id);
    if (!session) throw new Error(`Cloned chassis rack ${rack.id} has no configuration.`);
    session.raw = repriceRackFillers(session.raw, projectRackFiller(rack, session.raw).configuration);
    session.index = buildIndex(session.raw);
    session.reduced = reduceConfiguration(session.raw, session.configurationId, hardwareModeFamily(session.mode), ws.solution.solutionMode);
  }

  // LFO import/layout only customizes the layout. The website derives LFO
  // options when the user enters configuration editing, not during import.
  // Native populated-chassis Clone Multiple customizes physical placement only.
  // Its linked product configurations are copied locally; an extra derive can
  // return the same child root twice because the IDs belong to one clone group.
  if (ws.configurations.size > 0 && mode === 'cto' && !opts.clonePopulatedChassis) {
  const body = buildAutoDeriveRequest(ws, { validationMode: ws.validationMode,
    autoCorrect: [...ws.configurations.values()].every((session) => session.autoCorrect) });
  if (opts.copyConfigurationId) {
    // Copy becomes a singleton in the settled export, but the observed
    // first derive still carries only the pre-copy dependency map.
    const information = body.workspaceInformation as Record<string, unknown>;
    const dependency = information.cloneDependency as Record<string, string[]>;
    delete dependency[opts.copyConfigurationId];
    body.customizingIds = [];
  }
  if (opts.lockMutation || opts.deletedLinkedRootConfigurations) body.customizingIds = [];
  if (hasStorageInstances || opts.nestedPhysicalEdit || opts.cloneHpcSwitch) delete body.customizingIds;
  if (opts.cloneHpcSwitch) {
    const dependency = configurationCloneDependency(ws);
    const ids = [...ws.configurations.values()].map(c => c.configurationId);
    body.configurations = (body.configurations as ReducedConfiguration[]).filter(c =>
      resolveLinkedCloneGroup(dependency, ids, c.id).rootId === c.id);
  }
  const derived = await rt.http.send({
    endpoint: 'workspace_autoDerive', method: 'POST', path: autoDerivePath('ctos'),
    query: { ...(hasStorageInstances || opts.nestedPhysicalEdit || opts.cloneHpcSwitch ? {} : {
      entranceFlag: opts.cloneMultiple || opts.copyConfigurationId || opts.lockMutation || opts.deletedLinkedRootConfigurations ? 'customize' : 'summary',
    }), guideMode: ws.validationMode === 'guided' },
    body: { kind: 'json', value: body },
    responseKind: 'json', timeoutClass: 'heavy', ctx: requestContext,
  });
  const response = derived.raw as { configurations?: unknown[] };
  const metadata = derived.raw as Record<string, unknown>;
  if (Array.isArray(metadata.autoDerivedResults)) ws.serverState.autoDerivedResults = structuredClone(metadata.autoDerivedResults);
  if (!Array.isArray(response.configurations)) {
    throw new Error('DCSC returned no configuration patch after the layout change. Workspace was not committed.');
  }
  if (opts.cloneHpcSwitch) {
    const dependency = configurationCloneDependency(ws);
    const current = [...ws.configurations.values()].map(c => c.raw);
    const ids = current.map(c => String(c.id));
    const roots = new Set(ids.map(id => resolveLinkedCloneGroup(dependency, ids, id).rootId));
    const projected = projectHpcLinkedResponses(response.configurations as RawConfiguration[], current,
      dependency, opts.cloneHpcSwitch, roots);
    acceptDerivedWorkspaceConfigurations(ws, { ...response, configurations: projected });
  } else acceptDerivedWorkspaceConfigurations(ws, response);
  }
  const result = mode === 'lfo' || opts.cloneHpcSwitch || opts.clonePopulatedChassis || opts.copyConfigurationId || opts.lockMutation || hasStorageInstances || opts.deletedLinkedRootConfigurations || opts.nestedPhysicalEdit ? initial : await customize();
  ws.rackArea = result.rawRackArea;
  ws.nonRackArea = result.rawNonRackArea;
  await prepareConfigIdsDraft(rt, ws, ctx);
  refreshRackMetadata(ws);
  ws.rackSummaries = result.racks;
  ws.serverState.connections = structuredClone(result.connections);
  if (Array.isArray(result.rawState.connections) && result.errors.length === 0 &&
      (!result.rawState.errors || Array.isArray(result.rawState.errors) && result.rawState.errors.length === 0)) {
    delete ws.serverState.connectionGraphInvalidation;
  }
  ws.cables = projectConnectionGraph(result.connections).cables;
  ws.serverState.layoutErrors = structuredClone(result.errors);
  ws.serverState.floorInformation = buildFloorState(ws).information;
  return result;
}

export function workspaceNetworkState(ws: WorkspaceSession): Record<string, unknown> {
  const floor = buildFloorState(ws);
  const state = ws.serverState;
  const previous = (state.autoConnectState ?? {}) as Record<string, unknown>;
  const networking = (state.networkingInformation ?? {}) as Record<string, unknown>;
  const retained: Record<string, unknown> = {
    controllerExpansionMap: {}, clusterPreference: [], powerPreference: [], storageConnectionNetworks: [],
    cloneRackMapping: {}, connections: [], autoConnectSettings: {}, switchMap: [],
    virtualContainerIdMapping: {}, virtualContainerRule2ConfigMapping: {},
    virtualContainerInvalidRuleIdMapping: {}, vlhItems: [],
    cloneDependency: Object.fromEntries([...ws.configurations.values()].map((session) => [session.configurationId, [session.configurationId]])),
  };
  for (const key of Object.keys(retained)) {
    const value = state[key] ?? previous[key] ?? networking[key];
    if (value !== undefined) retained[key] = structuredClone(value);
  }
  if (state.storageConnectionNetworks === undefined && networking.storageNetworks !== undefined) {
    retained.storageConnectionNetworks = structuredClone(networking.storageNetworks);
  }
  retained.connections = readConnectionGraph(state);
  retained.switchMap = readSwitchMap(state);
  retained.autoConnectSettings = readAutoConnectSettings(state);
  return { ...retained, floorItems: floor.items, floorPreference: floor.information.floorPreference };
}

export function workspaceCablingPayload(ws: WorkspaceSession) {
  return buildRackCustomizePayload({
    ...workspaceNetworkState(ws), rackArea: ws.rackArea, nonRackArea: ws.nonRackArea,
  }, [...ws.configurations.values()].map(session => session.raw));
}

async function deriveNetworkDraft(rt: Runtime, ws: WorkspaceSession, ctx: RequestCtx): Promise<void> {
  await prepareConfigIdsDraft(rt, ws, ctx);
  const body = buildAutoDeriveRequest(ws, { validationMode: ws.validationMode,
    autoCorrect: [...ws.configurations.values()].every(session => session.autoCorrect) });
  if ([...storagePhysicalTemplateIds(ws)].some(([id, template]) => id !== template)) delete body.customizingIds;
  const response = await rt.http.send({ endpoint: 'workspace_autoDerive', method: 'POST',
    path: autoDerivePath('ctos'), query: { guideMode: ws.validationMode === 'guided' },
    body: { kind: 'json', value: body }, responseKind: 'json', timeoutClass: 'heavy',
    ctx: { ...ctx, locale: ws.locale, solution: ws.solution } });
  const derived = response.raw as Record<string, unknown>;
  ws.serverState.workspaceDeriveState = structuredClone(derived);
  if (Array.isArray(derived.autoDerivedResults)) {
    ws.serverState.autoDerivedResults = structuredClone(derived.autoDerivedResults);
  }
  acceptDerivedWorkspaceConfigurations(ws, response.raw);
}

export async function refreshStorageLayoutDraft(rt: Runtime, ws: WorkspaceSession, ctx: RequestCtx): Promise<void> {
  await provisionSwitchesDraft(rt, ws, ctx, { deferLayout: true });
  const result = await customizeLayout(rt.http, { ...ctx, locale: ws.locale, solution: ws.solution }, workspaceCablingPayload(ws),
    { autoArrange: true, autoConnect: true, cogValidation: true });
  if (!Array.isArray(result.rawState.rackArea) || !Array.isArray(result.rawState.nonRackArea) ||
      !Array.isArray(result.rawState.connections) || result.errors.length ||
      result.rawState.errors && (!Array.isArray(result.rawState.errors) || result.rawState.errors.length)) {
    throw new Error('DCSC did not accept the updated storage layout. Workspace was not committed.');
  }
  ws.rackArea = result.rawRackArea;
  ws.nonRackArea = result.rawNonRackArea;
  ws.rackSummaries = result.racks;
  ws.serverState.connections = structuredClone(result.connections);
  ws.serverState.layoutErrors = structuredClone(result.errors);
  ws.serverState.floorInformation = buildFloorState(ws).information;
  ws.cables = projectConnectionGraph(result.connections).cables;
  delete ws.serverState.connectionGraphInvalidation;
}

export async function provisionSwitchesDraft(rt: Runtime, ws: WorkspaceSession, ctx: RequestCtx, opts: { deferLayout?: boolean } = {}): Promise<void> {
  const request = buildSwitchCalculationRequest(workspaceCablingPayload(ws));
  const context = { ...ctx, locale: ws.locale, solution: ws.solution };
  const response = await rt.http.send({ endpoint: 'switch_calculation', method: 'POST',
    path: '/switch_calculation', query: { autoArrange: true, autoConnect: true, cogValidation: true },
    body: { kind: 'json', value: request }, responseKind: 'json', timeoutClass: 'heavy', ctx: context });
  const requirements = parseSwitchCalculationResponse(response.raw, request);
  if (requirements.length === 0) return;
  const switchMap = readSwitchMap(ws.serverState);
  const cloneDependency = structuredClone(workspaceNetworkState(ws).cloneDependency) as Record<string, string[]>;
  const generatedIds = new Set<string>();
  for (const requirement of requirements) {
    for (let index = 0; index < requirement.quantity; index += 1) {
      const launched = await rt.http.send({ endpoint: 'automatic_switch_launch', method: 'POST',
        path: ctoLaunchPath(requirement.option),
        query: { serviceCto: true, serviceType: 'servicecto', controlExpressModal: false },
        body: { kind: 'json', value: {} }, responseKind: 'json', timeoutClass: 'interactive', ctx: context });
      const raw = launched.raw as RawConfiguration;
      if (!raw || !Array.isArray(raw.tabs)) throw new Error('DCSC returned no configuration tree for the calculated switch.');
      const id = newConfigurationId(ws.locale.country);
      const ordinal = switchMap.filter(value => value && typeof value === 'object' &&
        (value as Record<string, unknown>).network === requirement.network &&
        (value as Record<string, unknown>).type === requirement.usage).length + 1;
      const generated = buildGeneratedSwitch(requirement, raw, { id, ordinal });
      generatedIds.add(id);
      stageConfiguration(ws, { locale: ws.locale, solution: ws.solution, mode: 'cto',
        configurationId: id, raw: generated.configuration,
        reduced: reduceConfiguration(generated.configuration, id, 'cto', ws.solution.solutionMode),
        validationMode: ws.validationMode, primed: true, configurable: true });
      const rack = ws.rackArea.find(value => value.id === generated.rackId)!;
      rack.rackItems = [...(Array.isArray(rack.rackItems) ? rack.rackItems : []), generated.rackItem];
      switchMap.push(generated.switchMapEntry);
      Object.assign(cloneDependency, generated.cloneDependency);
    }
  }
  ws.serverState.switchMap = switchMap;
  ws.serverState.cloneDependency = cloneDependency;
  if (opts.deferLayout) return;
  const layout = await customizeLayout(rt.http, context, workspaceCablingPayload(ws),
    { autoArrange: true, autoConnect: true, cogValidation: true });
  if (!Array.isArray(layout.rawState.rackArea) || !Array.isArray(layout.rawState.nonRackArea) ||
      !Array.isArray(layout.rawState.connections) || layout.errors.length > 0 ||
      layout.rawState.errors && (!Array.isArray(layout.rawState.errors) || layout.rawState.errors.length > 0)) {
    throw new Error('DCSC rejected or returned an incomplete generated switch layout. Workspace was not committed.');
  }
  for (const id of generatedIds) {
    const count = (items: RackObject[]): number => items.reduce((total, item) => total + (item.id === id ? 1 : 0) +
      count(Array.isArray(item.rackItems) ? item.rackItems as RackObject[] : []) +
      count(Array.isArray(item.nodes) ? item.nodes as RackObject[] : []), 0);
    const occurrences = count([...layout.rawRackArea, ...layout.rawNonRackArea]);
    if (occurrences !== 1) throw new Error(`DCSC did not retain generated switch ${id} exactly once. Workspace was not committed.`);
  }
  ws.rackArea = layout.rawRackArea;
  ws.nonRackArea = layout.rawNonRackArea;
  ws.rackSummaries = layout.racks;
  ws.serverState.connections = structuredClone(layout.connections);
  ws.cables = projectConnectionGraph(layout.connections).cables;
  await deriveNetworkDraft(rt, ws, ctx);
}

export async function autoConnectDraft(rt: Runtime, ws: WorkspaceSession, ctx: RequestCtx, seedConnections?: readonly unknown[],
  manualCableSelection?: ReturnType<typeof planNativeManualCableSelection> | Array<ReturnType<typeof planNativeManualCableSelection>>): Promise<AutoConnectResult> {
  const settings = readAutoConnectSettings(ws.serverState);
  const automaticSwitches = settings.autoAddSwitch === true && ws.solution.solutionMode === 'HPC and AI - Systems';
  if (automaticSwitches && seedConnections === undefined) await provisionSwitchesDraft(rt, ws, ctx);
  const floor = buildFloorState(ws);
  // Manual cable distance was calculated against current placement. Native arrange
  // can move devices while retaining stale row geometry, breaking later imports.
  const selectedCableLayout = manualCableSelection
    ? structuredClone({ rackArea: ws.rackArea, nonRackArea: ws.nonRackArea }) : undefined;
  const result = await autoConnect(rt.http, { ...ctx, locale: ws.locale, solution: ws.solution },
    workspaceCablingPayload(ws), ws.solution.solutionMode === 'HPC and AI - Systems'
      ? { autoArrange: seedConnections === undefined, autoConnect: true, cogValidation: true } : undefined, seedConnections);
  if (!Array.isArray(result.rawState.connections) || result.rawState.errors && !Array.isArray(result.rawState.errors)) {
    throw new Error('DCSC returned an incomplete connection graph. Workspace was not committed.');
  }
  if (result.errors.length > 0) {
    throw new Error(`DCSC rejected auto-connect: ${JSON.stringify(result.errors).slice(0, 1500)}`);
  }
  if (seedConnections !== undefined) assertNativeConnectionsRetained(seedConnections, result.rawConnections);
  ws.rackArea = result.rawRackArea;
  ws.nonRackArea = result.rawNonRackArea;
  ws.rackSummaries = summariseRackArea(result.rawRackArea);
  ws.cables = result.cables;
  ws.serverState.autoConnectState = structuredClone(result.rawState);
  ws.serverState.connections = structuredClone(result.rawConnections);
  ws.serverState.floorInformation = floor.information;
  const returnedConfigurations = result.rawState.configurations;
  if (Array.isArray(returnedConfigurations)) acceptWorkspaceConfigurations(ws, returnedConfigurations);
  for (const selection of manualCableSelection ? (Array.isArray(manualCableSelection) ? manualCableSelection : [manualCableSelection]) : []) {
    const input = manualCablingInput(ws);
    const row = readConnectionGraph(ws.serverState).find(value => {
      const connection = value as Record<string, unknown>;
      return selection.physicalDestinationIds.includes(String(connection.destinationId)) && connection.cablePart === selection.code;
    }) as Record<string, unknown> | undefined;

    // Shared source-port selection can add an AUTO route for a linked sibling.
    // Cover the accepted graph, not only the explicitly requested seed rows.
    const requiredQuantity = row ? planNativeManualCableSelection(input, row).requiredQuantity : 0;
    const layout = stageNativeManualCableQuantity(input, { ...selection,
      quantity: Math.max(selection.quantity, requiredQuantity) }, selectedCableLayout);
    ws.rackArea = layout.rackArea;
    ws.nonRackArea = layout.nonRackArea;
  }
  if (result.rawConnections.length > 0 && workspaceHardwareMode(ws.configurations.values()) === 'cto') {
    await deriveNetworkDraft(rt, ws, ctx);
  }
  delete ws.serverState.connectionGraphInvalidation;
  return result;
}

/** Adds the SPA-owned CONFIG_ID metadata; only detached drafts may be passed. */
export async function prepareConfigIdsDraft(rt: Runtime, ws: WorkspaceSession, ctx: RequestCtx): Promise<void> {
  const sessions = [...ws.configurations.values()];
  const eligible = sessions.filter(session => configIdTargetCodes(session.raw).length > 0);
  const hasMetadata = (items: RackObject[]): boolean => items.some(item =>
    Array.isArray(item.configIdFeatures) && item.configIdFeatures.length > 0 ||
    hasMetadata((Array.isArray(item.rackItems) ? item.rackItems : []) as RackObject[]) ||
    hasMetadata((Array.isArray(item.nodes) ? item.nodes : []) as RackObject[]));
  if (eligible.length === 0 && !hasMetadata([...ws.rackArea, ...ws.nonRackArea])) return;
  const context = { ...ctx, locale: ws.locale, solution: ws.solution };
  const key = JSON.stringify([ws.locale, ws.solution.solutionMode]);
  let catalog: unknown = {};
  if (eligible.length > 0) {
    const hit = rt.mipCatalogCache.get(key);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) catalog = hit.value;
    else {
      const response = await rt.http.send({ endpoint: 'rmp_mip', method: 'GET', path: '/rmp/mip',
        responseKind: 'json', timeoutClass: 'fast', ctx: context });
      catalog = response.raw;
      rt.mipCatalogCache.set(key, { at: Date.now(), value: catalog });
    }
    const placedIds = new Set([...ws.rackArea, ...ws.nonRackArea].flatMap(item => [...physicalIds(item)]));
    const managedControllers = managedStorageComponentIds(ws.serverState);
    const missing = eligible.filter(session => !placedIds.has(session.configurationId) && !managedControllers.has(session.configurationId));
    if (missing.length > 0) {
      const envelopes = await fetchEnvelopes(rt.http, context, missing.map(session => buildEnvelopeRequest(session.raw)));
      for (const session of missing) {
        const code = buildEnvelopeRequest(session.raw).code;
        const envelope = envelopes.get(code.toUpperCase());
        if (!envelope) throw new Error(`DCSC returned no physical metadata for configuration-ID product ${code}.`);
        ws.nonRackArea.push(buildRackItem(envelope, session.configurationId, 1, session.raw.quantity ?? 1));
      }
    }
  }
  const cloneRoots: Record<string, string> = {};
  const dependencies = ws.serverState.cloneDependency;
  if (dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
    for (const [root, ids] of Object.entries(dependencies)) {
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') cloneRoots[id] = root;
    }
  }
  const projected = assignConfigIdFeatures({ rackData: ws.rackArea, nonRackData: ws.nonRackArea,
    configurations: sessions.map(session => ({ ...session.raw, id: session.configurationId })),
    mipCatalog: catalog, cloneRoots });
  ws.rackArea = projected.rackData;
  ws.nonRackArea = projected.nonRackData;
}

export function refreshRackMetadata(ws: WorkspaceSession, refreshFeatures = false): void {
  const sessions = new Map([...ws.configurations.values()].map(session => [session.configurationId, session]));
  if (refreshFeatures) {
    const physical = buildRackCustomizePayload({ ...workspaceNetworkState(ws), rackArea: ws.rackArea,
      nonRackArea: ws.nonRackArea }, [...sessions.values()].map(session => ({ ...session.raw, id: session.configurationId })));
    ws.rackArea = physical.rackArea;
    ws.nonRackArea = physical.nonRackArea;
  }
  ws.rackArea = ws.rackArea.map(rack => {
    const session = sessions.get(String(rack.id));
    return session && usesCtoWire(session.mode)
      ? projectRackFiller(rack, { ...session.raw, id: session.configurationId }).rack : rack;
  });
}

export function acceptDerivedWorkspaceConfigurations(ws: WorkspaceSession, response: unknown): void {
  if (response && typeof response === 'object' && Array.isArray((response as Record<string, unknown>).configurations)) {
    const wrapper = response as Record<string, unknown>;
    response = { ...wrapper, configurations: (wrapper.configurations as RawConfiguration[])
      .map(configuration => configuration && typeof configuration === 'object' && !Array.isArray(configuration)
        ? withDerivedPlacements(configuration, wrapper) : configuration) };
  }
  const aliases = new Map([...storagePhysicalTemplateIds(ws)].filter(([id, template]) => id !== template));
  const current = [...ws.configurations.values()].map(session => session.raw);
  if (aliases.size === 0) {
    acceptWorkspaceConfigurations(ws, mergeDerivedConfigurations(current, response));
    return;
  }
  const split = splitStoragePhysicalDerive(current, response, aliases);
  const updatedTemplates = new Set(split.configurations.map(configuration => configuration.id));
  const stored = ws.serverState.storagePhysicalConfigurations as Record<string, RawConfiguration> | undefined;
  const retained = Object.fromEntries(Object.entries(stored ?? {}).filter(([id]) =>
    aliases.has(id) && !updatedTemplates.has(aliases.get(id)!)));
  ws.serverState.storagePhysicalConfigurations = { ...retained, ...split.physicalConfigurations };
  acceptWorkspaceConfigurations(ws, split.configurations);
  const templates = new Map(split.configurations.map(configuration => [configuration.id, configuration]));
  const refreshPhysical = (item: RackObject): RackObject => {
    const templateId = aliases.get(String(item.id));
    const template = templateId ? templates.get(templateId) : undefined;
    const refreshed = template ? refreshStoragePhysicalFeatures(item, template, response) : item;
    for (const key of ['rackItems', 'nodes'] as const) {
      if (Array.isArray(refreshed[key])) refreshed[key] = (refreshed[key] as RackObject[]).map(refreshPhysical);
    }
    return refreshed;
  };
  ws.rackArea = ws.rackArea.map(refreshPhysical);
  ws.nonRackArea = ws.nonRackArea.map(refreshPhysical);
}

export function acceptWorkspaceConfigurations(ws: WorkspaceSession, values: unknown[]): void {
  const byId = new Map([...ws.configurations.values()].map((session) => [session.configurationId, session]));
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== 'object') throw new Error('DCSC returned an invalid workspace configuration.');
    const raw = value as RawConfiguration;
    const id = String(raw.id ?? '');
    const session = byId.get(id);
    if (!session || seen.has(id) || !Array.isArray(raw.tabs)) {
      throw new Error(`DCSC returned an unknown, duplicate or incomplete configuration ${id}. Workspace was not committed.`);
    }
    seen.add(id);
    if (Array.isArray(ws.serverState.rackCustomizationReady)) {
      ws.serverState.rackCustomizationReady = ws.serverState.rackCustomizationReady.filter(value => value !== id);
    }
    session.raw = { ...preserveUnconfiguredSelections(session.raw,
      projectAutoDerivedSelections(raw, ws.serverState.autoDerivedResults).configuration),
      quantity: session.raw.quantity ?? 1,
      ...Object.fromEntries(['selectedStorageNetwork', 'selectedTopologies', 'nodeRole', 'name']
        .filter(key => Object.hasOwn(session.raw, key)).map(key => [key, structuredClone(session.raw[key])])),
    };
    session.index = buildIndex(session.raw);
    session.reduced = reduceConfiguration(session.raw, id, hardwareModeFamily(session.mode), ws.solution.solutionMode);
  }
  refreshRackMetadata(ws);
}

/** Current physical endpoints and floor geometry for the website's existing-row editor. */
export function manualCablingInput(workspace: WorkspaceSession) {
  const floor = buildFloorState(workspace);
  return { connections: readConnectionGraph(workspace.serverState), cloneDependency: configurationCloneDependency(workspace),
    configurations: [...workspace.configurations.values()].map(session => session.raw),
    rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
    floorItems: floor.items, floorPreference: floor.information.floorPreference as Record<string, unknown>,
    physicalTemplateIds: storagePhysicalTemplateIds(workspace),
    mode: workspaceHardwareMode(workspace.configurations.values()), solutionMode: workspace.solution.solutionMode };
}
