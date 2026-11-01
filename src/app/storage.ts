import {
  storageWizardOptions,
  storageWizardOption,
  stageStorageWizardChange,
  type StorageWizardChange,
} from '../domain/storageWizard.js';
import {
  pciWizardOptions,
  stagePciWizardChange,
  acceptPciWizardValidation,
  withPciWizardOption,
  type PciWizardChange,
} from '../domain/pciWizard.js';
import { serializeSections } from '../domain/dcscWire.js';
import { resolveLinkedCloneGroup } from '../domain/linkedCloneEdit.js';
import { reconfigureStorageConnectionNetwork, type StorageNetworkChanges } from '../domain/storagePreferences.js';
import { hardwareModeFamily, usesCtoWire } from '../domain/modeFamily.js';
import { newConfigurationId, reduceConfiguration } from '../domain/reduce.js';
import { customizeLayout } from '../domain/rack.js';
import { extractPowerReport } from '../domain/power.js';
import {
  acceptPowerCalculation,
  buildPowerCalculationRequest,
  inspectPowerControls,
  stagePowerControls,
  type PowerControlChanges,
} from '../domain/powerControls.js';
import { storagePhysicalConfigurations } from '../domain/storagePhysicalState.js';
import { buildWorkspaceNetworkPreferences, type WorkspaceNetworkSelection } from '../domain/networkPreferences.js';
import { workspaceNetworkTypes } from '../domain/workspaceNetworkPreferences.js';
import { retainReplacedStorageComponents, type DetachedStorageComponent } from '../domain/storageComponentLifecycle.js';
import {
  addStorageConnectionNetwork,
  editStorageConnectionNetwork,
  readStorageConnectionNetworks,
  configurationCloneDependency,
  storagePhysicalTemplateIds,
  storageDependencyColors,
  type StorageNetworkInput,
} from '../domain/storagePreferences.js';
import {
  buildClusterPreferences,
  readAutoConnectSettings,
  readConnectionGraph,
  projectConnectionGraph,
  invalidateConnectionGraph,
} from '../domain/cabling.js';
import { physicalIds, removeWorkspaceReferences } from '../domain/workspaceReferences.js';
import { buildFloorState } from '../domain/floorWire.js';
import { buildStorageAssignmentRequest, parseStorageAssignmentResponse } from '../domain/storageAssignment.js';
import {
  stageStorageNetworkPlacement,
  parseStoragePlacementResponse,
  type AcceptedStoragePlacement,
  type StoragePlacementComponent,
} from '../domain/storagePlacement.js';
import { buildIndex } from '../model/index.js';
import { type RequestCtx } from '../http/request.js';
import type { RawConfiguration } from '../model/types.js';
import { stageConfiguration } from '../session/SessionStore.js';
import type { WorkspaceSession } from '../model/session.js';
import {
  networkChangeHistoryFactory,
  storageChangeHistoryFactory,
  summariseRackArea,
  updateHistoryFactory,
} from './serviceHelpers.js';
import { ctoLaunchPath } from '../domain/endpoints.js';
import type { Runtime } from './runtime.js';
import { configureDraft } from './launch.js';
import { acceptDerivedWorkspaceConfigurations, autoConnectDraft, prepareConfigIdsDraft, provisionSwitchesDraft, refreshRackMetadata, refreshStorageLayoutDraft, workspaceCablingPayload, workspaceNetworkState } from './workspaceRefresh.js';

export function inspectStorageWizard(rt: Runtime, handle: string, expectedWorkspaceRevision?: number) {
  const resolved = rt.sessions.resolveHandle(handle);
  if (resolved?.kind !== 'configuration' || !resolved.workspace) throw new Error('Storage wizard requires one configuration handle.');
  if (expectedWorkspaceRevision !== undefined && expectedWorkspaceRevision !== resolved.workspace.revision) {
    throw new Error('Workspace changed; refresh dcsc_storage_wizard choices.');
  }
  const group = resolveLinkedCloneGroup(configurationCloneDependency(resolved.workspace),
    [...resolved.workspace.configurations.values()].map(s => s.configurationId), resolved.session.configurationId);
  const options = storageWizardOptions(resolved.session.raw);
  const wizard = resolved.session.raw['storageWizard'] as Record<string, unknown> | undefined;
  return { session: resolved.session.id, workspace: resolved.workspace.id, workspaceRevision: resolved.workspace.revision,
    configurationRevision: resolved.session.revision, available: options.length > 0,
    affectedConfigurationIds: group.memberIds, options,
    errors: structuredClone(wizard?.['errors'] ?? []), warnings: structuredClone(wizard?.['warnings'] ?? []),
    notices: structuredClone(wizard?.['notices'] ?? []) };
}

export async function setStorageWizard(rt: Runtime, handle: string, change: StorageWizardChange, expectedWorkspaceRevision: number, ctx: RequestCtx) {
  const resolved = rt.sessions.resolveHandle(handle);
  if (resolved?.kind !== 'configuration' || !resolved.workspace) throw new Error('Storage wizard requires one configuration handle.');
  const id = resolved.session.configurationId;
  await rt.sessions.transact(resolved.workspace.id, { expectedRevision: expectedWorkspaceRevision, remoteApplied: true,
    actionHistory: updateHistoryFactory(id) }, async workspace => {
    const group = resolveLinkedCloneGroup(configurationCloneDependency(workspace),
      [...workspace.configurations.values()].map(s => s.configurationId), id);
    const members = [...workspace.configurations.values()].filter(s => group.memberIds.includes(s.configurationId));
    const staged = members.map(session => ({ session, raw: stageStorageWizardChange(session.raw, change) }));
    for (const item of staged) {
      item.session.raw = item.raw;
      item.session.index = buildIndex(item.raw);
      item.session.reduced = reduceConfiguration(item.raw, item.session.configurationId,
        hardwareModeFamily(item.session.mode), workspace.solution.solutionMode);
    }
    await configureDraft(rt, members.find(s => s.configurationId === id)!, [],
      { ...ctx, locale: workspace.locale, solution: workspace.solution }, workspace);
    for (const member of members) {
      const option = storageWizardOption(member.raw);
      if (change.optionId === null ? option?.['activate'] !== false
        : option?.['configId'] !== change.optionId || option?.['userSelected'] !== true) {
        throw new Error('Lenovo did not retain the explicit storage wizard selection; the local edit was not committed.');
      }
    }
  });
  return inspectStorageWizard(rt, handle);
}

export function inspectPciWizard(rt: Runtime, handle: string, expectedWorkspaceRevision?: number) {
  const resolved = rt.sessions.resolveHandle(handle);
  if (resolved?.kind !== 'configuration' || !resolved.workspace) throw new Error('PCI wizard requires one configuration handle.');
  if (expectedWorkspaceRevision !== undefined && expectedWorkspaceRevision !== resolved.workspace.revision) {
    throw new Error('Workspace changed; refresh dcsc_pci_wizard choices.');
  }
  const group = resolveLinkedCloneGroup(configurationCloneDependency(resolved.workspace),
    [...resolved.workspace.configurations.values()].map(s => s.configurationId), resolved.session.configurationId);
  const options = pciWizardOptions(resolved.session.raw);
  return { session: resolved.session.id, workspace: resolved.workspace.id, workspaceRevision: resolved.workspace.revision,
    configurationRevision: resolved.session.revision, available: options.length > 0,
    affectedConfigurationIds: group.memberIds, options };
}

export async function setPciWizard(rt: Runtime, handle: string, change: PciWizardChange, expectedWorkspaceRevision: number, ctx: RequestCtx) {
  const resolved = rt.sessions.resolveHandle(handle);
  if (resolved?.kind !== 'configuration' || !resolved.workspace) throw new Error('PCI wizard requires one configuration handle.');
  const id = resolved.session.configurationId;
  await rt.sessions.transact(resolved.workspace.id, { expectedRevision: expectedWorkspaceRevision, remoteApplied: true,
    actionHistory: updateHistoryFactory(id) }, async workspace => {
    const group = resolveLinkedCloneGroup(configurationCloneDependency(workspace),
      [...workspace.configurations.values()].map(s => s.configurationId), id);
    const members = [...workspace.configurations.values()].filter(s => group.memberIds.includes(s.configurationId));
    const staged = members.map(session => ({ session, ...stagePciWizardChange(session.raw, change) }));
    const requestCtx = { ...ctx, locale: workspace.locale, solution: workspace.solution };
    for (const item of staged) {
      let option = item.option;
      if (item.operate) {
        const response = await rt.http.send({ endpoint: 'pci_wizard_validate_slot', method: 'POST',
          path: '/pci_wizard/validate/additional/slot',
          query: { ctoCode: String(item.session.raw.sliceCtoCode ?? item.session.raw.ctoCode ?? item.session.raw.code), _request: 'web' },
          body: { kind: 'json', value: { pciWizardOption: option,
            sections: serializeSections(item.session.raw).filter(section => section.subTabTitle !== 'Riser Card'),
            operate: item.operate, language: workspace.locale.language } },
          responseKind: 'json', timeoutClass: 'interactive', ctx: requestCtx });
        option = acceptPciWizardValidation(option, response.raw, item.operate);
      }
      item.session.raw = withPciWizardOption(item.session.raw, item.options, option);
      item.session.index = buildIndex(item.session.raw);
      item.session.reduced = reduceConfiguration(item.session.raw, item.session.configurationId,
        hardwareModeFamily(item.session.mode), workspace.solution.solutionMode);
    }
    await configureDraft(rt, members.find(s => s.configurationId === id)!, [], requestCtx, workspace);
    for (const member of members) {
      const active = pciWizardOptions(member.raw).filter(option => option['activate'] === true);
      if (active.length !== 1 || active[0]!['configId'] !== change.optionId) {
        throw new Error('Lenovo did not retain the selected PCI wizard option; the local edit was not committed.');
      }
    }
  });
  return inspectPciWizard(rt, handle);
}

export function inspectWorkspacePowerControls(rt: Runtime, handle: string, expectedWorkspaceRevision?: number) {
  const resolved = rt.sessions.resolveHandle(handle);
  if (resolved?.kind !== 'configuration' || !resolved.workspace) throw new Error('Power controls require one configuration handle from dcsc_session_list.');
  if (expectedWorkspaceRevision !== undefined && expectedWorkspaceRevision !== resolved.workspace.revision) {
    throw new Error('Workspace changed. Call dcsc_power_controls again without a revision to refresh the available choices.');
  }
  const group = resolveLinkedCloneGroup(configurationCloneDependency(resolved.workspace),
    [...resolved.workspace.configurations.values()].map(session => session.configurationId), resolved.session.configurationId);
  return { workspace: resolved.workspace.id, workspaceRevision: resolved.workspace.revision,
    session: resolved.session.id, configurationRevision: resolved.session.revision,
    affectedConfigurationIds: group.memberIds, ...inspectPowerControls(resolved.session.raw) };
}

/** Mirrors the Engineering Power Report dialog's calculate + Save, in one durable transaction. */
export async function setPowerControls(rt: Runtime, handle: string, changes: PowerControlChanges, expectedWorkspaceRevision: number, ctx: RequestCtx) {
  const resolved = rt.sessions.resolveHandle(handle);
  if (resolved?.kind !== 'configuration' || !resolved.workspace) throw new Error('Power controls require one configuration handle from dcsc_session_list.');
  const configurationId = resolved.session.configurationId;
  const transaction = { expectedRevision: expectedWorkspaceRevision, remoteApplied: false };
  await rt.sessions.transact(resolved.workspace.id, transaction, async workspace => {
    const group = resolveLinkedCloneGroup(configurationCloneDependency(workspace),
      [...workspace.configurations.values()].map(session => session.configurationId), configurationId);
    const members = [...workspace.configurations.values()].filter(session => group.memberIds.includes(session.configurationId));
    const staged = members.map(session => ({ session, raw: stagePowerControls(session.raw, changes),
      physical: storagePhysicalConfigurations(workspace, session.configurationId, session.raw)
        .map(item => ({ ...item, raw: stagePowerControls(item.raw, changes) })),
    }));
    const calculate = async (raw: RawConfiguration) => {
      const response = await rt.http.send({ endpoint: 'power_calculate', method: 'POST',
        path: '/powercalculation/powercalculate', body: { kind: 'json', value: buildPowerCalculationRequest(raw) },
        responseKind: 'json', timeoutClass: 'interactive', ctx: { ...ctx, locale: workspace.locale, solution: workspace.solution } });
      transaction.remoteApplied = true;
      return acceptPowerCalculation(raw, response.raw);
    };
    for (const item of staged) {
      item.session.raw = await calculate(item.raw);
      item.session.index = buildIndex(item.session.raw);
      item.session.reduced = reduceConfiguration(item.session.raw, item.session.configurationId,
        hardwareModeFamily(item.session.mode), workspace.solution.solutionMode);
      for (const physical of item.physical) {
        const accepted = await calculate(physical.raw);
        workspace.serverState.storagePhysicalConfigurations = {
          ...(workspace.serverState.storagePhysicalConfigurations as Record<string, unknown> | undefined),
          [physical.physicalId]: accepted,
        };
      }
    }
    refreshRackMetadata(workspace, true);
  });
  return { ...inspectWorkspacePowerControls(rt, handle), report: extractPowerReport(rt.sessions.get(handle)!.raw) };
}

/** The rack + Storage Network action installs physical instances of managed templates. */
export async function placeStorageNetwork(rt: Runtime, handle: string, opts: {
  name: string; rackId: string; expectedRevision?: number | undefined; ctx: RequestCtx;
}): Promise<{ workspace: string; revision: number; storageName: string;
  placements: AcceptedStoragePlacement[]; templates: Array<{ session: string; configurationId: string; created: boolean }> }> {
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error(`Workspace ${handle} not found.`);
  const transaction = { expectedRevision: opts.expectedRevision, remoteApplied: false };
  const result = await rt.sessions.transact(workspace.id, transaction, async draft => {
    if (draft.solution.solutionMode !== 'HPC and AI - Systems') {
      throw new Error('Physical storage network placement currently requires HPC and AI - Systems; General Purpose placement has a separate configuration-copy contract.');
    }
    if (!draft.rackArea.some(rack => rack.id === opts.rackId)) throw new Error(`Rack ${opts.rackId} does not belong to this workspace.`);
    const networks = readStorageConnectionNetworks(draft.serverState);
    const matches = networks.filter(network => network.name === opts.name);
    if (matches.length !== 1) throw new Error('Choose an existing storage definition by its exact name.');
    const selected = matches[0]!;
    if (typeof selected.expansion?.option === 'string' && selected.expansion.option.trim()) {
      throw new Error('Physical expansion placement requires a currently available expansion catalog contract.');
    }
    const networkState = workspaceNetworkState(draft);
    if (readAutoConnectSettings(draft.serverState).autoAddPDU === true &&
        (!Array.isArray(networkState.powerPreference) || networkState.powerPreference.length === 0)) {
      throw new Error('Automated Rack PDU is enabled without a PDU preference. Set dcsc_add_cabling settings.autoAddPDU=false before placing storage, or configure a PDU preference.');
    }
    const components: StoragePlacementComponent[] = [];
    const templates: Array<{ session: string; configurationId: string; created: boolean }> = [];
    for (const role of ['controller', 'mainSwitch'] as const) {
      if (role === 'mainSwitch' && !selected.mainSwitch?.option) continue;
      const opened = await ensureStorageComponentDraft(rt, draft, opts, role, transaction);
      const session = draft.configurations.get(opened.session)!;
      components.push({ role, physicalId: newConfigurationId(draft.locale.country), configuration: session.raw });
      templates.push({ session: session.id, configurationId: session.configurationId, created: opened.created });
    }
    const staged = stageStorageNetworkPlacement({ rackArea: draft.rackArea, nonRackArea: draft.nonRackArea,
      storageConnectionNetworks: readStorageConnectionNetworks(draft.serverState),
      cloneDependency: workspaceNetworkState(draft).cloneDependency, rackId: opts.rackId,
      networkName: opts.name, components });
    draft.rackArea = staged.rackArea;
    draft.nonRackArea = staged.nonRackArea;
    draft.serverState.cloneDependency = staged.cloneDependency;
    transaction.remoteApplied = true;
    const layout = await customizeLayout(rt.http, { ...opts.ctx, locale: draft.locale, solution: draft.solution },
      workspaceCablingPayload(draft), { autoArrange: true, autoConnect: true, cogValidation: true });
    const placements = parseStoragePlacementResponse(layout.rawState, staged);
    const errors = layout.rawState.errors;
    if (layout.errors.length > 0 || errors && (!Array.isArray(errors) || errors.length > 0)) {
      throw new Error(`DCSC rejected the storage placement: ${JSON.stringify(errors ?? layout.errors).slice(0, 1500)}`);
    }
    draft.rackArea = layout.rawRackArea;
    draft.nonRackArea = layout.rawNonRackArea;
    draft.rackSummaries = layout.racks;
    draft.serverState.storagePlacementState = structuredClone(layout.rawState);
    draft.serverState.cloneDependencyColor = storageDependencyColors(draft);
    draft.serverState.connections = structuredClone(layout.connections);
    draft.serverState.layoutErrors = structuredClone(layout.errors);
    draft.serverState.floorInformation = buildFloorState(draft).information;
    delete draft.serverState.connectionGraphInvalidation;
    delete draft.serverState.rackCustomizationReady;
    draft.cables = projectConnectionGraph(layout.connections).cables;
    return { placements, templates };
  });
  return { workspace: workspace.id, revision: workspace.revision, storageName: opts.name, ...result };
}

export async function openStorageController(rt: Runtime, handle: string, opts: {
  name: string; expectedRevision?: number | undefined; ctx: RequestCtx;
}) {
  const { componentId, ...result } = await openStorageComponent(rt, handle, opts, 'controller');
  return { ...result, controllerId: componentId };
}

export async function openStorageSwitch(rt: Runtime, handle: string, opts: {
  name: string; expectedRevision?: number | undefined; ctx: RequestCtx;
}) {
  const { componentId, ...result } = await openStorageComponent(rt, handle, opts, 'mainSwitch');
  return { ...result, switchId: componentId };
}

/** Launch or reuse a managed template inside the caller's workspace transaction. */
async function ensureStorageComponentDraft(rt: Runtime, draft: WorkspaceSession, opts: {
  name: string; ctx: RequestCtx;
}, component: 'controller' | 'mainSwitch', transaction: { remoteApplied: boolean }): Promise<{
  componentId: string; session: string; created: boolean;
}> {
  const hardwareType = component === 'controller' ? 'storage' : 'switch';
  const label = component === 'controller' ? 'controller' : 'SAN switch';
  const displayName = component === 'controller' ? 'Controller' : 'Switch';
  const networks = readStorageConnectionNetworks(draft.serverState);
  const matches = networks.filter(network => network.name === opts.name);
  if (matches.length !== 1) throw new Error(`Choose one existing storage network by its exact name: ${networks.map(network => network.name).join(', ') || 'none'}.`);
  const network = matches[0]!;
  const controller = network[component];
  const option = typeof controller?.option === 'string' ? controller.option.trim() : '';
  if (!option || controller.hardwareType !== hardwareType) throw new Error(`Storage network "${opts.name}" has no valid ${label} selection.`);
  if ([...draft.configurations.values()].some(session => !usesCtoWire(session.mode))) {
    throw new Error(`Storage ${label} customization requires a CTO workspace.`);
  }
  const savedId = typeof controller.id === 'string' ? controller.id.trim() : '';
  const existing = savedId ? [...draft.configurations.values()].find(session => session.configurationId === savedId) : undefined;
  if (existing) {
    if (existing.product.code !== option || existing.raw.type !== hardwareType) {
      throw new Error(`Storage ${label} ${savedId} refers to a different configured product. Reconcile the storage definition before opening it.`);
    }
    const selectedBase = typeof controller.featureCode === 'string' ? controller.featureCode.trim() : '';
    if (selectedBase && !existing.reduced.sections.some(section => section.results.some(result =>
      result.code === selectedBase && Number(result.quantity) > 0))) {
      throw new Error(`${displayName} ${option} no longer has requested feature ${selectedBase} selected. Reconcile the storage definition before opening it.`);
    }
    return { componentId: savedId, session: existing.id, created: false };
  }
  const componentId = savedId || newConfigurationId(draft.locale.country);
  if ([...draft.rackArea, ...draft.nonRackArea].some(item => physicalIds(item).has(componentId))) {
    throw new Error(`Storage ${label} ${componentId} collides with a physical item that has no matching configuration.`);
  }
  const context = { ...opts.ctx, locale: draft.locale, solution: draft.solution };
  const launched = await rt.http.send({ endpoint: component === 'controller' ? 'storage_controller_launch' : 'storage_switch_launch', method: 'POST',
    path: ctoLaunchPath(option),
    query: { serviceCto: true, serviceType: 'servicecto', controlExpressModal: false },
    body: { kind: 'json', value: {} }, responseKind: 'json', timeoutClass: 'interactive', ctx: context });
  transaction.remoteApplied = true;
  const raw = launched.raw as RawConfiguration;
  if (!raw || !Array.isArray(raw.tabs) || raw.type !== hardwareType ||
      String(raw.code || raw.sliceCtoCode || '') !== option) {
    throw new Error(`DCSC returned no matching ${hardwareType} configuration for ${option}. Workspace was not committed.`);
  }
  const configuration = { ...structuredClone(raw), id: componentId, workspaceId: componentId, name: displayName };
  const reduced = reduceConfiguration(configuration, componentId, 'cto', draft.solution.solutionMode);
  const featureCode = typeof controller.featureCode === 'string' ? controller.featureCode.trim() : '';
  // The website launches feature-specific controllers normally. Their base
  // choice is already selected in unSelectableCharacters, without a derive.
  // An available catalog feature alone is not proof of that selection.
  if (featureCode && !reduced.sections.some(section => section.results.some(result =>
    result.code === featureCode && Number(result.quantity) > 0))) {
    throw new Error(`${displayName} ${option} did not return requested feature ${featureCode} as selected. Workspace was not committed.`);
  }
  const session = stageConfiguration(draft, { locale: draft.locale, solution: draft.solution,
    mode: 'cto', configurationId: componentId, raw: configuration,
    reduced,
    validationMode: draft.validationMode, primed: true, configurable: true });
  network[component] = { ...controller, id: componentId };
  draft.serverState.storageConnectionNetworks = networks;
  const networking = draft.serverState.networkingInformation as Record<string, unknown> | undefined;
  draft.serverState.networkingInformation = { ...networking, storageNetworks: structuredClone(networks) };
  return { componentId, session: session.id, created: true };
}

/** Captured storage Edit Item lifecycle; both products are nonphysical templates. */
async function openStorageComponent(rt: Runtime, handle: string, opts: {
  name: string; expectedRevision?: number | undefined; ctx: RequestCtx;
}, component: 'controller' | 'mainSwitch'): Promise<{ workspace: string; revision: number; storageName: string;
  componentId: string; session: string; created: boolean }> {
  const label = component === 'controller' ? 'controller' : 'SAN switch';
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error(`Workspace ${handle} not found.`);
  const transaction = { expectedRevision: opts.expectedRevision, remoteApplied: false };
  const opened = await rt.sessions.transact(workspace.id, transaction, async draft => {
    const opened = await ensureStorageComponentDraft(rt, draft, opts, component, transaction);
    if (!opened.created) return opened;
    const context = { ...opts.ctx, locale: draft.locale, solution: draft.solution };
    const layout = await customizeLayout(rt.http, context, workspaceCablingPayload(draft),
      { autoArrange: true, autoConnect: true, cogValidation: true });
    if (!Array.isArray(layout.rawState.rackArea) || !Array.isArray(layout.rawState.nonRackArea) ||
        !Array.isArray(layout.rawState.connections)) {
      throw new Error(`DCSC returned an incomplete storage ${label} layout. Workspace was not committed.`);
    }
    const topErrors = layout.rawState.errors;
    if (layout.errors.length || topErrors && (!Array.isArray(topErrors) || topErrors.length)) {
      throw new Error(`DCSC rejected the storage ${label} layout: ${JSON.stringify(topErrors ?? layout.errors).slice(0, 1500)}`);
    }
    draft.rackArea = layout.rawRackArea;
    draft.nonRackArea = layout.rawNonRackArea;
    draft.rackSummaries = layout.racks;
    draft.serverState[component === 'controller' ? 'storageControllerState' : 'storageSwitchState'] = structuredClone(layout.rawState);
    draft.serverState.connections = structuredClone(layout.connections);
    delete draft.serverState.connectionGraphInvalidation;
    draft.serverState.layoutErrors = structuredClone(layout.errors);
    draft.cables = projectConnectionGraph(layout.connections).cables;
    draft.serverState.floorInformation = buildFloorState(draft).information;
    delete draft.serverState.rackCustomizationReady;
    return opened;
  });
  return { workspace: workspace.id, revision: workspace.revision, storageName: opts.name, ...opened };
}

/** Applies the website's server-to-storage selection in full workspace context. */
export async function assignStorageNetwork(rt: Runtime, handle: string, opts: {
  networkName: string | null;
  expectedRevision?: number | undefined;
  autoConnect?: boolean | undefined;
  ctx: RequestCtx;
}): Promise<{ workspace: string; session: string; configurationId: string; revision: number;
  configurationRevision: number; selectedStorageNetwork: string; autoConnectRequired: boolean;
  connectionCount?: number; connectionGraphStale: boolean }> {
  const resolved = rt.sessions.resolveHandle(handle);
  if (resolved?.kind !== 'configuration') {
    throw new Error('Storage assignment requires a configuration handle from dcsc_session_list.');
  }
  const session = resolved.session;
  let connectionCount: number | undefined;
  await rt.sessions.transact(session.id, { expectedRevision: opts.expectedRevision, remoteApplied: true,
    actionHistory: updateHistoryFactory(session.configurationId) }, async (workspace, draft) => {
    if (!draft) throw new Error('Storage assignment requires one configuration.');
    await prepareConfigIdsDraft(rt, workspace, opts.ctx);
    const request = buildStorageAssignmentRequest(workspace, draft.configurationId, opts.networkName);
    const response = await rt.http.send({ ...request, body: { kind: 'json', value: request.body },
      responseKind: 'json', timeoutClass: 'heavy', ctx: { ...opts.ctx, locale: workspace.locale, solution: workspace.solution } });
    const parsed = parseStorageAssignmentResponse(response.raw, draft.configurationId, opts.networkName);
    if (String(draft.raw.selectedStorageNetwork ?? '') !== String(parsed.configuration.selectedStorageNetwork ?? '')) {
      invalidateConnectionGraph(workspace.serverState, 'Storage assignment changed without recalculating connections.');
    }
    workspace.serverState.storageAssignmentState = parsed.responseState;
    if (Array.isArray(parsed.responseState.autoDerivedResults)) {
      workspace.serverState.autoDerivedResults = structuredClone(parsed.responseState.autoDerivedResults);
    }
    // This is an explicit accepted edit, so replace the client-owned value
    // before the generic partial-response merge preserves that value.
    draft.raw.selectedStorageNetwork = parsed.configuration.selectedStorageNetwork;
    acceptDerivedWorkspaceConfigurations(workspace, response.raw);
    const assignments = workspace.serverState.selectedStorageNetwork;
    if (assignments && typeof assignments === 'object' && !Array.isArray(assignments)) {
      workspace.serverState.selectedStorageNetwork = { ...assignments,
        [draft.configurationId]: parsed.configuration.selectedStorageNetwork };
    }
    if (opts.autoConnect) connectionCount = (await autoConnectDraft(rt, workspace, opts.ctx)).connections.length;
  });
  const workspace = rt.sessions.getWorkspace(session.id)!;
  return { workspace: workspace.id, session: session.id, configurationId: session.configurationId,
    revision: workspace.revision, configurationRevision: session.revision,
    selectedStorageNetwork: String(session.raw.selectedStorageNetwork ?? ''),
    autoConnectRequired: opts.autoConnect !== true,
    connectionGraphStale: workspace.serverState.connectionGraphInvalidation !== undefined,
    ...(connectionCount !== undefined ? { connectionCount } : {}) };
}

export async function addStorageNetwork(rt: Runtime, handle: string, opts: {
  input: Omit<StorageNetworkInput, 'controllerId'> & { controllerId?: string | undefined };
  expectedRevision?: number | undefined;
  ctx: RequestCtx;
}): Promise<{ workspace: string; revision: number; storageNetworkCount: number }> {
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error(`Workspace ${handle} not found.`);
  let storageNetworkCount = 0;
  await rt.sessions.transact(workspace.id, { expectedRevision: opts.expectedRevision,
    actionHistory: storageChangeHistoryFactory() }, async draft => {
    const fabric = await rt.fabricOptions({ ...opts.ctx, locale: draft.locale }, draft.solution);
    const controllerId = opts.input.controllerId ?? fabric.storageControllers[0]?.id;
    if (!controllerId) throw new Error('DCSC returned no storage controller choices for this workspace.');
    const networks = addStorageConnectionNetwork(readStorageConnectionNetworks(draft.serverState), fabric,
      { ...opts.input, controllerId });
    draft.serverState.storageConnectionNetworks = networks;
    const previous = draft.serverState.networkingInformation as Record<string, unknown> | undefined;
    draft.serverState.networkingInformation = { ...previous, storageNetworks: structuredClone(networks) };
    storageNetworkCount = networks.length;
  });
  return { workspace: workspace.id, revision: workspace.revision, storageNetworkCount };
}

export async function editStorageNetwork(rt: Runtime, handle: string, opts: {
  action: 'rename' | 'remove'; name: string; newName?: string | undefined;
  clearAssignments?: boolean | undefined; expectedRevision?: number | undefined;
}): Promise<{ workspace: string; revision: number; storageNetworkCount: number; updatedAssignments: number; removedConfigurations: number }> {
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error(`Workspace ${handle} not found.`);
  let storageNetworkCount = 0;
  let updatedAssignments = 0;
  let removedConfigurations = 0;
  await rt.sessions.transact(workspace.id, { expectedRevision: opts.expectedRevision,
    actionHistory: storageChangeHistoryFactory() }, draft => {
    const previousNetworks = readStorageConnectionNetworks(draft.serverState);
    const physicalStorage = opts.action === 'remove' ? storagePhysicalTemplateIds(draft) : new Map<string, string>();
    const networks = editStorageConnectionNetwork(previousNetworks, opts);
    const assigned = [...draft.configurations.values()].filter(session => session.raw.selectedStorageNetwork === opts.name);
    if (opts.action === 'remove' && assigned.length > 0 && opts.clearAssignments !== true) {
      throw new Error(`Storage network "${opts.name}" is assigned to ${assigned.length} configurations. Set clearAssignments=true to remove it and clear those references.`);
    }
    const nextName = opts.action === 'rename' ? opts.newName!.trim() : '';
    if (opts.action === 'remove' && assigned.length > 0) {
      invalidateConnectionGraph(draft.serverState, 'An assigned storage definition was removed.');
    }
    for (const session of assigned) session.raw.selectedStorageNetwork = nextName;
    const assignments = draft.serverState.selectedStorageNetwork;
    if (assignments && typeof assignments === 'object' && !Array.isArray(assignments)) {
      draft.serverState.selectedStorageNetwork = Object.fromEntries(Object.entries(assignments)
        .map(([id, name]) => [id, name === opts.name ? nextName : name]));
    }
    draft.serverState.storageConnectionNetworks = networks;
    const previous = draft.serverState.networkingInformation as Record<string, unknown> | undefined;
    draft.serverState.networkingInformation = { ...previous, storageNetworks: structuredClone(networks) };
    if (opts.action === 'remove') {
      const removedDefinition = previousNetworks.find(network => network.name === opts.name)!;
      for (const component of ['controller', 'mainSwitch'] as const) {
        const selection = removedDefinition[component];
        const id = selection?.id;
        const shared = typeof id === 'string' && networks.some(network =>
          [network.controller, network.expansion, network.mainSwitch].some(other => other?.id === id));
        if (typeof id !== 'string' || !id || shared) continue;
        const target = [...draft.configurations.values()].find(session => session.configurationId === id);
        const expectedType = component === 'controller' ? 'storage' : 'switch';
        if (target && (target.raw.type !== expectedType || target.product.code !== selection.option)) {
          throw new Error(`Storage definition "${opts.name}" references a different configured product. Reconcile it before removal.`);
        }
        if (target) {
          draft.configurations.delete(target.id);
          removedConfigurations += 1;
        }
        const removedIds = new Set([id, ...[...physicalStorage]
          .filter(([, templateId]) => templateId === id).map(([physicalId]) => physicalId)]);
        if (removedIds.size > 1) invalidateConnectionGraph(draft.serverState, 'Physical storage instances were removed with their definition.');
        removeWorkspaceReferences(draft, removedIds);
      }
      draft.rackSummaries = summariseRackArea(draft.rackArea);
    }
    storageNetworkCount = networks.length;
    updatedAssignments = assigned.length;
  });
  return { workspace: workspace.id, revision: workspace.revision, storageNetworkCount, updatedAssignments, removedConfigurations };
}

export async function reconfigureStorageNetwork(rt: Runtime, handle: string, opts: {
  name: string; changes: StorageNetworkChanges; expectedRevision: number;
  autoConnect?: boolean | undefined; ctx: RequestCtx;
}): Promise<{ workspace: string; revision: number; storageNetworkCount: number;
  connectionGraphStale: boolean; autoConnectRequired: boolean; connectionCount?: number;
  retainedComponents: Array<Omit<DetachedStorageComponent, 'physicalIds'> & { physicalCount: number }> }> {
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error(`Workspace ${handle} not found.`);
  const transaction = { expectedRevision: opts.expectedRevision, remoteApplied: false,
    actionHistory: storageChangeHistoryFactory() };
  let connectionCount: number | undefined;
  let preferencesChanged = false;
  let retainedComponents: DetachedStorageComponent[] = [];
  await rt.sessions.transact(workspace.id, transaction, async draft => {
    const fabric = await rt.fabricOptions({ ...opts.ctx, locale: draft.locale }, draft.solution);
    const previous = readStorageConnectionNetworks(draft.serverState);
    const rackIds = new Set(draft.rackArea.flatMap(rack => [...physicalIds(rack)]));
    const racked = new Map([...storagePhysicalTemplateIds(draft)].filter(([id]) => rackIds.has(id)));
    const networks = reconfigureStorageConnectionNetwork(previous, fabric, opts.name, opts.changes,
      new Set(racked.values()));
    const transition = retainReplacedStorageComponents({ workspace: draft,
      previousNetworks: previous, nextNetworks: networks, definitionName: opts.name });
    for (const component of transition.retained) {
      const template = [...draft.configurations.values()].find(session => session.configurationId === component.templateId);
      if (!template || template.raw.type !== component.type || template.product.code !== component.code) {
        throw new Error(`Storage definition "${opts.name}" references a different or missing configured product. Reconcile it before replacement.`);
      }
    }
    draft.serverState.detachedStorageComponents = transition.detachedStorageComponents;
    retainedComponents = transition.retained;
    draft.serverState.storageConnectionNetworks = networks;
    const networking = draft.serverState.networkingInformation as Record<string, unknown> | undefined;
    draft.serverState.networkingInformation = { ...networking, storageNetworks: structuredClone(networks) };
    preferencesChanged = JSON.stringify(previous) !== JSON.stringify(networks);
    if (preferencesChanged) {
      invalidateConnectionGraph(draft.serverState, 'Storage network preferences changed. Regenerate the connection graph.');
    }
    if (opts.autoConnect) {
      transaction.remoteApplied = true;
      await refreshStorageLayoutDraft(rt, draft, opts.ctx);
      connectionCount = readConnectionGraph(draft.serverState).length;
    }
  });
  return { workspace: workspace.id, revision: workspace.revision,
    storageNetworkCount: readStorageConnectionNetworks(workspace.serverState).length,
    connectionGraphStale: workspace.serverState.connectionGraphInvalidation !== undefined,
    autoConnectRequired: workspace.serverState.connectionGraphInvalidation !== undefined ||
      preferencesChanged && opts.autoConnect !== true,
    retainedComponents: retainedComponents.map(({ physicalIds, ...component }) => ({ ...component, physicalCount: physicalIds.length })),
    ...(connectionCount !== undefined ? { connectionCount } : {}) };
}

export async function setNetworkPreferences(rt: Runtime, handle: string, opts: {
  selections: WorkspaceNetworkSelection[];
  expectedRevision?: number | undefined;
  autoConnect?: boolean | undefined;
  ctx: RequestCtx;
}): Promise<{ workspace: string; revision: number; selections: unknown[]; connectionCount?: number;
  connectionGraphStale: boolean; autoConnectRequired: boolean }> {
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error(`Workspace ${handle} not found.`);
  let connectionCount: number | undefined;
  let preferencesChanged = false;
  const transaction = {
    expectedRevision: opts.expectedRevision,
    remoteApplied: false,
    actionHistory: (before: WorkspaceSession, after: WorkspaceSession) => preferencesChanged
      ? networkChangeHistoryFactory()(before, after) : undefined,
  };
  const selections = await rt.sessions.transact(workspace.id, transaction, async (draft) => {
    const fabric = await rt.fabricOptions({ ...opts.ctx, locale: draft.locale }, draft.solution);
    const previous = workspaceNetworkTypes(fabric, draft.serverState);
    const preferences = buildWorkspaceNetworkPreferences({ ...fabric,
      networkTypes: previous,
    }, opts.selections);
    const updates = new Map(preferences.networkTypes.map((network) => [network.id, network]));
    const networkTypes = previous.map((network) => updates.get(network.id) ?? network);
    for (const network of preferences.networkTypes) if (!previous.some((item) => item.id === network.id)) networkTypes.push(network);
    draft.serverState.networkTypes = structuredClone(networkTypes);
    const retainedCluster = workspaceNetworkState(draft).clusterPreference;
    const priorCluster = new Map((Array.isArray(retainedCluster) ? retainedCluster : [])
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map(entry => [entry.name, entry]));
    draft.serverState.clusterPreference = buildClusterPreferences(fabric.networkDevices, networkTypes)
      .map(entry => ({ ...priorCluster.get(entry.name), ...entry }));
    const retained = Array.isArray(draft.serverState.networkSelections) ? draft.serverState.networkSelections as Array<Record<string, unknown>> : [];
    draft.serverState.networkSelections = [...retained.filter((item) => !updates.has(String(item.networkTypeId))), ...preferences.selections];
    const networkState = draft.serverState.networkingInformation as Record<string, unknown> | undefined;
    draft.serverState.networkingInformation = { ...networkState, clusterPreference: draft.serverState.clusterPreference };
    preferencesChanged = JSON.stringify(previous) !== JSON.stringify(networkTypes);
    if (preferencesChanged) {
      invalidateConnectionGraph(draft.serverState, 'Network preferences changed. Regenerate connections.');
    }
    if (opts.autoConnect) {
      transaction.remoteApplied = true;
      connectionCount = (await autoConnectDraft(rt, draft, opts.ctx)).connections.length;
    } else if (preferencesChanged && draft.rackArea.length > 0 &&
        draft.solution.solutionMode === 'HPC and AI - Systems' &&
        readAutoConnectSettings(draft.serverState).autoAddSwitch === true) {
      // Preferences Close provisions required switches even before the user
      // regenerates P2P cabling. Keep the previous graph explicitly stale.
      transaction.remoteApplied = true;
      await provisionSwitchesDraft(rt, draft, opts.ctx);
    }
    return preferences.selections;
  });
  return { workspace: workspace.id, revision: workspace.revision, selections,
    connectionGraphStale: workspace.serverState.connectionGraphInvalidation !== undefined,
    autoConnectRequired: workspace.serverState.connectionGraphInvalidation !== undefined ||
      preferencesChanged && opts.autoConnect !== true,
    ...(connectionCount !== undefined ? { connectionCount } : {}) };
}
