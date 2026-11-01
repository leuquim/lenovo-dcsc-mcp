import {
  nativeManualSourceConfigurationId,
  stageNativeManualConnection,
  planNativeManualCableSelection,
  assertNativeConnectionsRetained,
  seedNativeManualRoutes,
  selectNativeManualSourcePort,
  selectNativeManualSourceGroup,
  stageNativeManualCableQuantity,
  filterNativeManualCableChoices,
  type NativeManualConnectionRequest,
} from '../domain/nativeManualCabling.js';
import { configurationListPrice } from '../domain/pricing.js';
import {
  inspectManualCabling as projectManualCabling,
  stageManualConnectionEdit,
  applyManualConnectionDistance,
  applyAcceptedManualCablePhysicalState,
  commitManualConnectionEdit,
  projectManualConnection,
  manualConnectionId,
  type ManualConnectionEdit,
  type ManualCablingInput,
} from '../domain/manualCabling.js';
import type { SolutionContext } from '../config/schema.js';
import { buildAutoDeriveRequest, type ReducedConfiguration } from '../domain/reduce.js';
import { buildSelectedTopologies } from '../domain/networkPreferences.js';
import { workspaceNetworkTypes } from '../domain/workspaceNetworkPreferences.js';
import { readStorageConnectionNetworks, configurationCloneDependency, storagePhysicalTemplateIds } from '../domain/storagePreferences.js';
import {
  mergeAutoConnectSettings,
  readConnectionGraph,
  projectConnectionGraph,
  invalidateConnectionGraph,
  assertCurrentConnectionGraph,
  type AutoConnectResult,
  type AutoConnectSettingsPatch,
} from '../domain/cabling.js';
import { buildFloorState } from '../domain/floorWire.js';
import { workspaceHardwareMode } from '../domain/workspaceWire.js';
import { type RequestCtx } from '../http/request.js';
import type { RawConfiguration } from '../model/types.js';
import { SessionConflictError } from '../session/SessionStore.js';
import type { CableLink, ConfigSession, WorkspaceSession } from '../model/session.js';
import {
  updateHistoryFactory,
  assertWorkspaceRevision,
  linkedGroup,
} from './serviceHelpers.js';
import { autoDerivePath } from '../domain/endpoints.js';
import type { Runtime } from './runtime.js';
import { workspaceId } from './runtime.js';
import { acceptDerivedWorkspaceConfigurations, autoConnectDraft, manualCablingInput, workspaceNetworkState } from './workspaceRefresh.js';
import { newId } from '../session/ids.js';
import { configureDraft } from './launch.js';
import { errorMessage } from '../util/coerce.js';

/**
 * Runs DCSC auto-connect and replaces the workspace cable list with the
 * server's connections. Manual port maps are not invented here.
 */
export async function runAutoConnect(rt: Runtime, sessionHandle: string, ctx: RequestCtx, expectedRevision?: number,
  settings?: AutoConnectSettingsPatch): Promise<AutoConnectResult> {
  return rt.sessions.transact(workspaceId(rt, sessionHandle), { expectedRevision, remoteApplied: true }, (workspace) => {
    if (settings !== undefined) {
      const merged = mergeAutoConnectSettings(workspaceNetworkState(workspace).autoConnectSettings, settings);
      workspace.serverState.autoConnectSettings = merged;
      const networking = workspace.serverState.networkingInformation as Record<string, unknown> | undefined;
      workspace.serverState.networkingInformation = { ...networking, autoConnectSettings: structuredClone(merged) };
    }
    return autoConnectDraft(rt, workspace, ctx);
  });
}

export function inspectManualCabling(rt: Runtime, handle: string, expectedWorkspaceRevision?: number) {
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error('Workspace not found.');
  assertWorkspaceRevision(workspace, expectedWorkspaceRevision);
  return { workspace: workspace.id, revision: workspace.revision,
    report: projectManualCabling(manualCablingInput(workspace)) };
}

async function refreshManualCableChoices(rt: Runtime, input: ManualCablingInput, connectionId: string, ctx: RequestCtx & { solution: SolutionContext }) {
  const matches = input.connections.map((row, index) => ({ row: row as Record<string, unknown>, index }))
    .filter(({ row }) => manualConnectionId(row) === connectionId);
  if (matches.length !== 1) throw new Error('Choose one existing connection by its exact ID.');
  const { row, index } = matches[0]!;
  const topology = String(row['topology'] ?? '');
  if (!topology) throw new Error('Connection has no topology for cable discovery.');
  if (typeof row['sourceId'] !== 'string' || !row['sourceId'] || typeof row['destinationId'] !== 'string' || !row['destinationId']) {
    throw new Error('Connection has no complete physical endpoint identity.');
  }
  const request = { floorPreference: input.floorPreference ?? {}, floorItems: [...input.floorItems ?? []],
    from: String(row['sourceId']), to: String(row['destinationId']), network: topology };
  const response = await rt.http.send({ endpoint: 'manual_cabling_distance', method: 'POST', path: '/calculateDistance',
    body: { kind: 'json', value: request }, responseKind: 'json', timeoutClass: 'interactive', ctx });
  const fabric = await rt.fabricOptions(ctx, ctx.solution);
  const distance = filterNativeManualCableChoices(response.raw, topology, fabric.cables,
    row['category'] === 'BREAKOUT' && row['divider'] === 4 ? 'breakout-4' : 'point-to-point');
  const refreshed = applyManualConnectionDistance({ connectionId, index, before: row, staged: row,
    distanceRequest: request }, distance);
  return { ...input, connections: input.connections.map((value, i) => i === index ? refreshed.staged : value) };
}

export async function inspectManualCableChoices(rt: Runtime, handle: string, connectionId: string, expectedWorkspaceRevision: number | undefined, ctx: RequestCtx) {
  if (expectedWorkspaceRevision === undefined) throw new Error('expectedRevision is required to refresh cable choices.');
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error('Workspace not found.');
  if (workspace.revision !== expectedWorkspaceRevision) throw new SessionConflictError(expectedWorkspaceRevision, workspace.revision, 'workspace');
  assertCurrentConnectionGraph(workspace.serverState);
  const input = await refreshManualCableChoices(rt, structuredClone(manualCablingInput(workspace)), connectionId,
    { ...ctx, locale: workspace.locale, solution: workspace.solution });
  const current = rt.sessions.getWorkspace(workspace.id);
  if (!current) throw new Error('Workspace was removed while refreshing cable choices.');
  if (current.revision !== expectedWorkspaceRevision) throw new SessionConflictError(expectedWorkspaceRevision, current.revision, 'workspace');
  return { workspace: current.id, revision: current.revision, report: projectManualCabling(input) };
}

export async function createNativeManualCabling(rt: Runtime, handle: string, request: NativeManualConnectionRequest & { expectedRevision: number; ctx: RequestCtx }) {
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error('Workspace not found.');
  const transaction = { expectedRevision: request.expectedRevision, remoteApplied: false };
  let pinnedConnectionCount = 0;
  let additionalConnectionCount = 0;
  let sourceConfigurationIds: string[] = [];
  let destinationConfigurationIds: string[] = [];
  const connection = await rt.sessions.transact(workspace.id, transaction, async draft => {
    assertCurrentConnectionGraph(draft.serverState);
    if (workspaceHardwareMode(draft.configurations.values()) !== 'cto') throw new Error('Native manual creation requires CTO configurations.');
    const input = manualCablingInput(draft);
    const source = input.configurations.find(c => c.id === nativeManualSourceConfigurationId(request.source.configurationId, input.physicalTemplateIds));
    const topologies = source?.selectedTopologies as Record<string, { networkTechnology?: string }> | undefined;
    if (topologies?.[request.network]?.networkTechnology !== request.topology) {
      throw new Error('Source is not assigned to the requested network and topology. Configure its network preference first.');
    }
    const response = await rt.http.send({ endpoint: 'manual_cabling_distance', method: 'POST', path: '/calculateDistance',
      body: { kind: 'json', value: { floorPreference: input.floorPreference, floorItems: input.floorItems,
        from: request.source.configurationId, to: request.destination.configurationId, network: request.topology } },
      responseKind: 'json', timeoutClass: 'interactive', ctx: { ...request.ctx, locale: draft.locale, solution: draft.solution } });
    const fabric = await rt.fabricOptions({ ...request.ctx, locale: draft.locale }, draft.solution);
    const distance = filterNativeManualCableChoices(response.raw, request.topology, fabric.cables, request.connectionType);
    const row = stageNativeManualConnection(input, { ...request, distance });
    const retained = seedNativeManualRoutes(input.connections, request.pinExistingRoutes === true);
    pinnedConnectionCount = retained.pinnedConnectionCount;
    const seeds = [...retained.rows, row];
    const plan = planNativeManualCableSelection({ ...input, connections: seeds }, row);
    destinationConfigurationIds = plan.configurationIds ?? [plan.configurationId];
    const destination = [...draft.configurations.values()].find(c => c.configurationId === plan.configurationId)!;
    const sourceSelections = selectNativeManualSourceGroup(input.configurations, configurationCloneDependency(draft), row, input.physicalTemplateIds);
    sourceConfigurationIds = [...sourceSelections.keys()];
    for (const [id, selected] of sourceSelections) {
      input.configurations.find(configuration => configuration.id === id)!.selectedTopologies = selected;
    }
    transaction.remoteApplied = true;
    if (plan.quantity !== plan.previousQuantity) {
      const layout = stageNativeManualCableQuantity(input, plan);
      draft.rackArea = layout.rackArea;
      draft.nonRackArea = layout.nonRackArea;
      await configureDraft(rt, destination, [{ section: plan.section, code: plan.code, quantity: plan.quantity }], request.ctx, draft);
    }
    await autoConnectDraft(rt, draft, request.ctx, seeds, plan);
    assertNativeConnectionsRetained(seeds, readConnectionGraph(draft.serverState));
    for (const id of sourceSelections.keys()) {
      const actual = [...draft.configurations.values()].find(c => c.configurationId === id)!.raw;
      if (JSON.stringify(selectNativeManualSourcePort(actual, row)) !== JSON.stringify(actual.selectedTopologies)) {
        throw new Error('DCSC did not retain the manual source port across its linked group. Workspace was not committed.');
      }
    }
    additionalConnectionCount = readConnectionGraph(draft.serverState).length - seeds.length;
    const accepted = planNativeManualCableSelection(manualCablingInput(draft), row);
    if (accepted.previousQuantity < Math.max(plan.quantity, accepted.requiredQuantity)) {
      throw new Error('DCSC did not retain sufficient manual cable quantity. Workspace was not committed.');
    }
    return projectManualConnection(readConnectionGraph(draft.serverState).find(value => {
      try { assertNativeConnectionsRetained([row], [value]); return true; } catch { return false; }
    }));
  });
  return { workspace: workspace.id, revision: workspace.revision, connection, pinnedConnectionCount, sourceConfigurationIds, destinationConfigurationIds, additionalConnectionCount };
}

export async function inspectNativeManualCabling(rt: Runtime, handle: string, request: Omit<NativeManualConnectionRequest, 'cablePart'> & { expectedRevision: number; ctx: RequestCtx }) {
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error('Workspace not found.');
  if (workspace.revision !== request.expectedRevision) throw new SessionConflictError(request.expectedRevision, workspace.revision, 'workspace');
  assertCurrentConnectionGraph(workspace.serverState);
  if (workspaceHardwareMode(workspace.configurations.values()) !== 'cto') throw new Error('Native manual creation requires CTO configurations.');
  const physicalTemplates = storagePhysicalTemplateIds(workspace);
  const destinationId = nativeManualSourceConfigurationId(request.destination.configurationId, physicalTemplates);
  const destination = [...workspace.configurations.values()].find(c => c.configurationId === destinationId);
  if (!destination) throw new Error('Manual cable destination must resolve to one configuration or managed template.');
  const destinationGroup = linkedGroup(workspace, destination.configurationId);
  const input = structuredClone(manualCablingInput(workspace));
  const source = input.configurations.find(c => c.id === nativeManualSourceConfigurationId(request.source.configurationId, input.physicalTemplateIds));
  const networks = source?.selectedTopologies as Record<string, { networkTechnology?: string }> | undefined;
  if (networks?.[request.network]?.networkTechnology !== request.topology) throw new Error('Source is not assigned to the requested network and topology.');
  const sourceSelections = selectNativeManualSourceGroup(input.configurations, configurationCloneDependency(workspace), {
    sourceId: request.source.configurationId, network: request.network, topology: request.topology,
    sourcePortName: request.source.portName, sourcePortNumber: request.source.portNumber }, input.physicalTemplateIds);
  const response = await rt.http.send({ endpoint: 'manual_cabling_distance', method: 'POST', path: '/calculateDistance',
    body: { kind: 'json', value: { floorPreference: input.floorPreference, floorItems: input.floorItems,
      from: request.source.configurationId, to: request.destination.configurationId, network: request.topology } },
    responseKind: 'json', timeoutClass: 'interactive', ctx: { ...request.ctx, locale: workspace.locale, solution: workspace.solution } });
  const fabric = await rt.fabricOptions({ ...request.ctx, locale: workspace.locale }, workspace.solution);
  if (workspace.revision !== request.expectedRevision) throw new SessionConflictError(request.expectedRevision, workspace.revision, 'workspace');
  const distance = filterNativeManualCableChoices(response.raw, request.topology, fabric.cables, request.connectionType);
  const choices = (Array.isArray(distance.compatibleCables) ? distance.compatibleCables : []).map(value => {
    const cable = value as Record<string, unknown>;
    try {
      const row = stageNativeManualConnection(input, { ...request, cablePart: String(cable.featureCode), distance });
      const plan = planNativeManualCableSelection({ ...input, connections: [...input.connections, row] }, row);
      return { part: plan.code, description: cable.description ?? null, option: cable.optionCode ?? null,
        price: cable.price ?? null, length: cable.length ?? null, selection: plan };
    } catch { return null; }
  }).filter(value => value !== null);
  return { workspace: workspace.id, revision: workspace.revision, report: { totalDistance: distance.totalDistance, choices, destinationConfigurationIds: destinationGroup.memberIds, sourceConfigurationIds: [...sourceSelections.keys()],
    pinnableConnectionCount: seedNativeManualRoutes(input.connections, true).pinnedConnectionCount,
    routePreservation: 'Set pinExistingRoutes=true to convert existing AUTO network rows to MANUAL and preserve their routes. Without pinning, native rerouting causes rollback.' } };
}

type ManualConnectionPlan = ReturnType<typeof stageManualConnectionEdit>;
type CableReplacement = NonNullable<ManualConnectionPlan['cableReplacement']>;
type CableTransaction = { expectedRevision: number; remoteApplied: boolean };

async function replaceSharedCableSelection(
  rt: Runtime,
  draft: WorkspaceSession,
  ctx: RequestCtx,
  transaction: CableTransaction,
  { input, plan, replacement, shared, previous }: {
    input: ManualCablingInput;
    plan: ManualConnectionPlan;
    replacement: CableReplacement;
    shared: NonNullable<CableReplacement['sharedSelection']>;
    previous: ConfigSession;
  },
): Promise<void> {
  const seeds = commitManualConnectionEdit(input.connections, plan);
  const selections = [
    { code: replacement.oldCode, quantity: replacement.targetQuantities.oldCode },
    { code: replacement.newCode, quantity: replacement.targetQuantities.newCode },
  ].map(selection => ({ ...selection, configurationId: replacement.configurationId,
    configurationIds: shared.configurationIds, physicalDestinationIds: shared.physicalDestinationIds,
    section: replacement.sectionName, previousQuantity: previous.index.selected.get(selection.code) ?? 0,
    retainAsSpare: !seeds.some(value => {
      const row = value as Record<string, unknown>;
      return row.cablePart === selection.code && shared.physicalDestinationIds.includes(String(row.destinationId));
    }), requiredQuantity: 0 }));
  for (const selection of selections) {
    if (selection.retainAsSpare) {
      // Explicitly retained spares must stop being native auto-connect selections.
      // Otherwise targeted derive drops them when their last route is replaced.
      for (const id of shared.configurationIds) {
        const member = [...draft.configurations.values()].find(c => c.configurationId === id)!;
        for (const section of (member.raw.tabs ?? []).flatMap(t => t.subTabs ?? []).flatMap(t => t.sections ?? [])) {
          if (section.name !== selection.section) continue;
          for (const result of section.results ?? []) if (result.code === selection.code) result.forAutoConnect = false;
        }
      }
    }
    const layout = stageNativeManualCableQuantity(manualCablingInput(draft), selection);
    draft.rackArea = layout.rackArea;
    draft.nonRackArea = layout.nonRackArea;
  }
  transaction.remoteApplied = true;
  await configureDraft(rt, previous, selections.map(({ section, code, quantity }) => ({ section, code, quantity })), ctx, draft);
  await autoConnectDraft(rt, draft, ctx, seeds, selections);
  const acceptedGraph = readConnectionGraph(draft.serverState);
  assertNativeConnectionsRetained(seeds, acceptedGraph);
  if (acceptedGraph.length !== seeds.length) throw new Error('Cable replacement added unexpected routes. Workspace was not committed.');
  for (const id of shared.configurationIds) {
    const member = [...draft.configurations.values()].find(session => session.configurationId === id);
    if (!member || selections.some(selection => (member.index.selected.get(selection.code) ?? 0) !== selection.quantity)) {
      throw new Error('DCSC did not retain shared cable quantities. Workspace was not committed.');
    }
  }
}

async function replaceCablePartOnce(
  rt: Runtime,
  draft: WorkspaceSession,
  ctx: RequestCtx,
  transaction: CableTransaction,
  replacement: CableReplacement,
): Promise<void> {
  draft.rackArea = replacement.rackArea;
  draft.nonRackArea = replacement.nonRackArea;
  const body = buildAutoDeriveRequest(draft, { validationMode: draft.validationMode,
    autoCorrect: [...draft.configurations.values()].every(session => session.autoCorrect) });
  body.configurations = (body.configurations as ReducedConfiguration[]).map(configuration =>
    configuration.id === replacement.configurationId ? replacement.reducedConfiguration : configuration);
  body.customizingIds = replacement.customizingIds;
  transaction.remoteApplied = true;
  const response = await rt.http.send({ endpoint: 'manual_cabling_replacement', method: 'POST', path: autoDerivePath('ctos'),
    query: { ...replacement.query, guideMode: draft.validationMode === 'guided' },
    body: { kind: 'json', value: body }, responseKind: 'json', timeoutClass: 'heavy',
    ctx: { ...ctx, locale: draft.locale, solution: draft.solution } });
  const metadata = response.raw as Record<string, unknown>;
  if (Array.isArray(metadata.autoDerivedResults)) draft.serverState.autoDerivedResults = structuredClone(metadata.autoDerivedResults);
  acceptDerivedWorkspaceConfigurations(draft, response.raw);
  const target = [...draft.configurations.values()].find(session => session.configurationId === replacement.configurationId);
  if (!target || (target.index.selected.get(replacement.newCode) ?? 0) !== replacement.targetQuantities.newCode ||
      (target.index.selected.get(replacement.oldCode) ?? 0) !== replacement.targetQuantities.oldCode) {
    throw new Error('DCSC did not accept the cable-part replacement. Workspace was not committed.');
  }
  const physical = applyAcceptedManualCablePhysicalState({ ...replacement,
    rackArea: draft.rackArea, nonRackArea: draft.nonRackArea }, target.raw, response.raw);
  draft.rackArea = physical.rackArea;
  draft.nonRackArea = physical.nonRackArea;
}

export async function editManualCabling(rt: Runtime, handle: string, edit: ManualConnectionEdit & { expectedRevision: number; ctx: RequestCtx }) {
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error('Workspace not found.');
  const transaction = { expectedRevision: edit.expectedRevision, remoteApplied: false };
  let configurationChange: { session: string; configurationId: string; previousTotalPrice: number | null;
    totalPrice: number | null; priceDelta: number | null; currency: string; priceScope: 'editable-configuration' } | undefined;
  const accepted = await rt.sessions.transact(workspace.id, transaction, async draft => {
    assertCurrentConnectionGraph(draft.serverState);
    let input: ManualCablingInput = manualCablingInput(draft);
    const existing = input.connections.find(row => manualConnectionId(row) === edit.connectionId) as Record<string, unknown> | undefined;
    const savedDistance = existing?.['cableDistance'] as Record<string, unknown> | undefined;
    const savedChoices = savedDistance?.['compatibleCables'];
    const offered = Array.isArray(savedChoices) && savedChoices.some(choice => choice && typeof choice === 'object' &&
      (choice['featureCode'] ?? choice['code']) === edit.cablePart);
    if (edit.cablePart && !offered) {
      input = await refreshManualCableChoices(rt, input, edit.connectionId,
        { ...edit.ctx, locale: draft.locale, solution: draft.solution });
    }
    let plan = stageManualConnectionEdit(input, edit);
    if (plan.distanceRequest) {
      const response = await rt.http.send({ endpoint: 'manual_cabling_distance', method: 'POST', path: '/calculateDistance',
        body: { kind: 'json', value: plan.distanceRequest }, responseKind: 'json', timeoutClass: 'interactive',
        ctx: { ...edit.ctx, locale: draft.locale, solution: draft.solution } });
      plan = applyManualConnectionDistance(plan, response.raw);
    }
    if (plan.cableReplacement) {
      if (workspaceHardwareMode(draft.configurations.values()) !== 'cto') {
        throw new Error('Cable-part replacement requires CTO hardware configurations.');
      }
      const replacement = plan.cableReplacement;
      const previous = [...draft.configurations.values()].find(session => session.configurationId === replacement.configurationId)!;
      const previousTotalPrice = configurationListPrice(previous.raw);
      if (replacement.sharedSelection) {
        await replaceSharedCableSelection(rt, draft, edit.ctx, transaction, { input, plan, replacement, shared: replacement.sharedSelection, previous });
      } else {
        await replaceCablePartOnce(rt, draft, edit.ctx, transaction, replacement);
      }
      const target = [...draft.configurations.values()].find(session => session.configurationId === replacement.configurationId)!;
      const physicalConfigurations = draft.serverState.storagePhysicalConfigurations as Record<string, RawConfiguration> | undefined;
      const checked = replacement.sharedSelection
        ? [...replacement.sharedSelection.configurationIds.map(id => [...draft.configurations.values()].find(c => c.configurationId === id)!.raw),
          ...replacement.sharedSelection.physicalDestinationIds.map(id => {
            const raw = physicalConfigurations?.[id] ?? [...draft.configurations.values()].find(c => c.configurationId === id)?.raw;
            if (!raw) throw new Error(`DCSC omitted physical cable configuration ${id}. Workspace was not committed.`);
            return raw;
          })]
        : [target.raw];
      const cableErrors = checked.flatMap(configuration => (configuration.tabs ?? []).flatMap(t => t.subTabs ?? [])
        .flatMap(t => t.sections ?? []).filter(section => section.name === replacement.sectionName).flatMap(section => section.errors ?? []));
      if (cableErrors.length) throw new Error(`DCSC rejected cable quantities: ${JSON.stringify(cableErrors).slice(0, 2400)}. Supply valid cableQuantities; workspace was not committed.`);
      for (const configuration of checked) {
        const results = (configuration.tabs ?? []).flatMap(t => t.subTabs ?? []).flatMap(t => t.sections ?? [])
          .filter(section => section.name === replacement.sectionName).flatMap(section => section.results ?? []);
        for (const [code, quantity] of [[replacement.oldCode, replacement.targetQuantities.oldCode],
          [replacement.newCode, replacement.targetQuantities.newCode]] as const) {
          const matches = results.filter(result => result.code === code);
          if (matches.length > 1 || (matches[0]?.quantity ?? 0) !== quantity) {
            throw new Error(`DCSC did not retain ${code}=${quantity} on every cable destination. Workspace was not committed.`);
          }
        }
      }
      const totalPrice = configurationListPrice(target.raw);
      configurationChange = { session: target.id, configurationId: target.configurationId,
        previousTotalPrice, totalPrice, priceDelta: previousTotalPrice !== null && totalPrice !== null
          ? Math.round((totalPrice - previousTotalPrice) * 100) / 100 : null,
        currency: draft.locale.currency, priceScope: 'editable-configuration' };
    }
    const connections = commitManualConnectionEdit(input.connections, plan);
    draft.serverState.connections = connections;
    draft.serverState.autoConnectResults = structuredClone(connections);
    const networking = draft.serverState.networkingInformation as Record<string, unknown> | undefined;
    draft.serverState.networkingInformation = { ...networking, autoConnectResults: structuredClone(connections) };
    const autoConnectState = draft.serverState.autoConnectState as Record<string, unknown> | undefined;
    if (autoConnectState) draft.serverState.autoConnectState = { ...autoConnectState, connections: structuredClone(connections) };
    draft.cables = projectConnectionGraph(connections).cables;
    draft.serverState.floorInformation = buildFloorState(draft).information;
    return { connection: projectManualConnection(plan.staged),
      ...(plan.relatedChanges?.length ? { updatedConnections: plan.relatedChanges.map(change => projectManualConnection(change.staged)) } : {}),
      ...(plan.collisionSwaps?.length ? {
        swappedConnections: plan.collisionSwaps.map(swap => projectManualConnection(swap.staged)),
      } : {}) };
  });
  return { workspace: workspace.id, revision: workspace.revision, ...accepted,
    ...(configurationChange ? { configurationChange } : {}) };
}

export interface CablingCandidate extends Omit<NativeManualConnectionRequest, 'cablePart' | 'pinExistingRoutes'> {
  expectedRevision: number;
}

/** Reads the cable configuration panel: the connection list, one connection's refreshed cable choices, or the cable choices for a new connection. */
export async function inspectCabling(rt: Runtime, handle: string, opts: {
  expectedRevision?: number | undefined; refreshConnectionId?: string | undefined;
  candidate?: Omit<CablingCandidate, 'expectedRevision'> | undefined; ctx: RequestCtx;
}) {
  if (opts.candidate !== undefined && opts.refreshConnectionId !== undefined) {
    throw new Error('Pass either candidate or refreshConnectionId, not both.');
  }
  if (opts.candidate !== undefined) {
    if (opts.expectedRevision === undefined) throw new Error('expectedRevision is required to look up cable choices for a new connection.');
    return inspectNativeManualCabling(rt, handle, { ...opts.candidate, expectedRevision: opts.expectedRevision, ctx: opts.ctx });
  }
  if (opts.refreshConnectionId !== undefined) {
    return inspectManualCableChoices(rt, handle, opts.refreshConnectionId, opts.expectedRevision, opts.ctx);
  }
  return inspectManualCabling(rt, handle, opts.expectedRevision);
}

export type CablingChange =
  | ({ action: 'create' } & NativeManualConnectionRequest)
  | ({ action: 'edit' } & ManualConnectionEdit);

/** Applies connection changes in order, each against the revision the previous one produced. */
export async function applyCablingChanges(rt: Runtime, handle: string, changes: readonly CablingChange[],
  expectedRevision: number, ctx: RequestCtx) {
  let revision = expectedRevision;
  const results: Array<{ action: CablingChange['action'];
    result: Awaited<ReturnType<typeof createNativeManualCabling>> | Awaited<ReturnType<typeof editManualCabling>> }> = [];
  for (const [index, change] of changes.entries()) {
    try {
      const result = change.action === 'create'
        ? await createNativeManualCabling(rt, handle, { ...omitAction(change), expectedRevision: revision, ctx })
        : await editManualCabling(rt, handle, { ...omitAction(change), expectedRevision: revision, ctx });
      revision = result.revision;
      results.push({ action: change.action, result });
    } catch (error) {
      if (index === 0) throw error;
      throw new Error(`Change ${index + 1} of ${changes.length} failed after ${index} were applied ` +
        `(workspace revision now ${revision}): ${errorMessage(error)}`);
    }
  }
  return { workspace: workspaceId(rt, handle), revision, results };
}

function omitAction<T extends { action: string }>(change: T): Omit<T, 'action'> {
  const { action: _action, ...rest } = change;
  return rest;
}

/** Local planning annotation; excluded from the authoritative export connection graph. */
export async function addManualCabling(rt: Runtime, sessionHandle: string, cable: Omit<CableLink, 'id'>, expectedRevision?: number): Promise<CableLink> {
  return rt.sessions.transact(workspaceId(rt, sessionHandle), { expectedRevision }, (workspace) => {
    const ids = new Set([...workspace.configurations.values()].map((session) => session.configurationId));
    if (!ids.has(cable.fromConfigId) || !ids.has(cable.toConfigId)) {
      throw new Error('Both cable endpoints must belong to this workspace. Use configuration IDs from dcsc_session_list.');
    }
    const link = { ...cable, id: newId('cable') };
    workspace.cables.push(link);
    return link;
  });
}

/**
 * Applies a network topology shortName to a configuration and optionally
 * re-runs auto-connect so DCSC can recompute cabling for the fabric choice.
 */
export async function applyTopology(rt: Runtime, opts: {
  sessionHandle: string;
  topology: string;
  networkName?: string | undefined;
  connectorIds?: string[] | undefined;
  ports?: string[] | undefined;
  expectedRevision?: number | undefined;
  autoConnect?: boolean | undefined;
  ctx: RequestCtx;
}): Promise<{
  session: string;
  topology: string;
  selectedTopologies: Record<string, unknown>;
  autoConnect?: AutoConnectResult | undefined;
}> {
  const session = rt.sessions.get(opts.sessionHandle);
  if (!session) throw new Error(`Session ${opts.sessionHandle} not found`);
  const inWorkspace = workspaceId(rt, opts.sessionHandle);

  const fabric = await rt.fabricOptions(opts.ctx, session.solution);
  const match = fabric.topologies.find(
    (t) => t.shortName.toLowerCase() === opts.topology.toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `Unknown topology "${opts.topology}". Use dcsc_network_get for valid shortNames ` +
        `(e.g. ${fabric.topologies
          .slice(0, 8)
          .map((t) => t.shortName)
          .join(', ')}).`,
    );
  }

  const transaction = { expectedRevision: opts.expectedRevision, remoteApplied: false,
    actionHistory: updateHistoryFactory(session.configurationId) };
  return rt.sessions.transact(inWorkspace, transaction, async (workspace) => {
    const draft = workspace.configurations.get(session.id);
    if (!draft) throw new Error('Choose a configuration handle for topology selection.');
    const selected = buildSelectedTopologies(draft.raw, { ...fabric,
      networkTypes: workspaceNetworkTypes(fabric, workspace.serverState) }, {
      topology: match.shortName, networkName: opts.networkName,
      connectorIds: opts.connectorIds, ports: opts.ports,
    }, readStorageConnectionNetworks(workspace.serverState).map(network => network.name));
    if (JSON.stringify(draft.raw.selectedTopologies ?? {}) !== JSON.stringify(selected)) {
      invalidateConnectionGraph(workspace.serverState, 'Network connector selections changed. Regenerate connections.');
    }
    draft.raw.selectedTopologies = selected;
    let connected: AutoConnectResult | undefined;
    if (opts.autoConnect !== false && (workspace.rackArea.length > 0 || workspace.nonRackArea.length > 0)) {
      transaction.remoteApplied = true;
      connected = await autoConnectDraft(rt, workspace, opts.ctx);
    }
    return { session: draft.id, topology: match.shortName, selectedTopologies: selected,
      ...(connected ? { autoConnect: connected } : {}) };
  });
}
