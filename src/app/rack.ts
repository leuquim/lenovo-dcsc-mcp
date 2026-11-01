import { configurationListPrice } from '../domain/pricing.js';
import { hardwareModeFamily, usesCtoWire } from '../domain/modeFamily.js';
import { buildGroups, newConfigurationId, reduceConfiguration } from '../domain/reduce.js';
import {
  buildRackItem,
  buildRackCustomizePayload,
  buildEnvelopeRequest,
  buildRackObject,
  customizeLayout,
  fetchRackCabinets,
  fetchEnvelopes,
  type LayoutResult,
  type RackObject,
} from '../domain/rack.js';
import { aggregatePower, extractPowerReport } from '../domain/power.js';
import { managedStorageComponentIds, storagePhysicalTemplateIds } from '../domain/storagePreferences.js';
import { projectConnectionGraph } from '../domain/cabling.js';
import { detachPhysicalItem, physicalIds, removeWorkspaceReferences } from '../domain/workspaceReferences.js';
import { buildFloorState } from '../domain/floorWire.js';
import { stageRackItemLock, stageRackSpaceLock } from '../domain/rackLocks.js';
import { placeRackOnFloor, type FloorPlacementResult } from '../domain/floor.js';
import {
  listPduCatalog,
  resolvePowerChange,
  selectedPowerLines,
  type PduCatalog,
  type PduOption,
} from '../domain/pdu.js';
import { findRackCapacity } from '../domain/rackCapacity.js';
import { cloneConfigurationRaw } from '../domain/configurationIdentity.js';
import { stageRackedCloneMultiple, type RackedClonePlacement } from '../domain/physicalClone.js';
import { stageRackedCopy } from '../domain/physicalCopy.js';
import {
  assertAcceptedNestedEdit,
  detachedNestedNodeIds,
  stageConfiguredNodeCopy,
  type NestedNodePlacement,
} from '../domain/nestedPhysical.js';
import { createCloneDependencyColor } from '../domain/cloneDependency.js';
import type { ActionHistoryFactory } from '../domain/actionHistory.js';
import { type RequestCtx } from '../http/request.js';
import type { RawConfiguration } from '../model/types.js';
import { stageConfiguration } from '../session/SessionStore.js';
import type { ConfigSession, PduSelection, WorkspaceSession } from '../model/session.js';
import {
  addHistoryFactory,
  floorMoveHistoryFactory,
  moveHistoryFactory,
  rackLockHistoryFactory,
  removeHistoryFactory,
  replicateHistoryFactory,
  updateHistoryFactory,
  type ScaleOutPlan,
  assertWorkspaceRevision,
  linkedGroup,
} from './serviceHelpers.js';
import { newId } from '../session/ids.js';
import type { Runtime } from './runtime.js';
import { configureDraft, prepareLaunch } from './launch.js';
import { syncLayout, workspaceNetworkState } from './workspaceRefresh.js';
import { workspaceId } from './runtime.js';

/**
 * Sizes a cluster built from one designed node.
 *
 * Rack capacity is established empirically rather than by dividing U heights:
 * DCSC enforces per-product position rules (an SR680a V3 may only occupy U3
 * to U35 of a 42U cabinet), so the usable slot count is always lower than the
 * arithmetic suggests. Nodes are placed one at a time until DCSC refuses,
 * and that refusal is the answer.
 *
 * This sizes and prices the cluster; it does not materialise every node as a
 * separate configuration.
 */
export async function scaleOut(rt: Runtime, opts: {
  sessionHandle: string;
  nodes: number;
  rackCode: string;
  ctx: RequestCtx;
}): Promise<ScaleOutPlan> {
  if (!Number.isInteger(opts.nodes) || opts.nodes < 1 || opts.nodes > 10000) throw new Error('Node count must be an integer from 1 to 10000.');
  const resolved = rt.sessions.resolveHandle(opts.sessionHandle);
  if (resolved?.kind === 'workspace' && resolved.workspace.configurations.size !== 1) {
    throw new Error('Choose a configuration session ID to size; this workspace has multiple possible node targets.');
  }
  const ws = resolved?.workspace;
  const node = resolved?.session;
  if (!ws || !node) throw new Error(`Session / Workspace ${opts.sessionHandle} not found`);

  const rctx = { ...opts.ctx, locale: ws.locale, solution: ws.solution };
  const envelopes = await fetchEnvelopes(rt.http, rctx, [
    { code: opts.rackCode, type: 'rack' },
    { code: node.reduced.sliceCtoCode, type: 'server' },
  ]);
  const rackEnv = envelopes.get(opts.rackCode.toUpperCase());
  const nodeEnv = envelopes.get(node.reduced.sliceCtoCode.toUpperCase());
  if (!rackEnv || !nodeEnv) {
    throw new Error('DCSC returned no physical data for the rack or the node.');
  }

  // DCSC auto-arranges exponential candidate batches. A returned partial
  // layout establishes its accepted boundary without one request per node.
  const probeRackId = newConfigurationId(ws.locale.country);
  const capacity = await findRackCapacity<LayoutResult>({
    physicalSizeU: nodeEnv.sizeU,
    requestBudget: opts.ctx.budget?.remaining ?? rt.config.pacing.perToolRequestBudget,
    maxProbeCount: 128,
    probe: async ({ requestedCount, positionForOrdinal }) => {
      const candidate = Array.from({ length: requestedCount }, (_, index) =>
        buildRackItem(nodeEnv, `${probeRackId}#${index}`, positionForOrdinal(index + 1)));
      const result = await customizeLayout(rt.http, rctx,
        { rackArea: [buildRackObject(rackEnv, probeRackId, candidate)], nonRackArea: [] },
        { autoArrange: true });
      const rack = result.racks[0];
      if (!rack) throw new Error('DCSC returned no rack while measuring capacity.');
      return { kind: 'layout', acceptedCount: rack.items.length, layout: result };
    },
  });
  const perRack = capacity.capacity;
  const acceptedRack = capacity.acceptedLayout?.racks[0];
  const rackSizeU = acceptedRack?.sizeU ?? rackEnv.sizeU;
  const probeEmptyWeightKg = acceptedRack?.emptyWeightKg;

  if (perRack === 0) {
    throw new Error(
      `DCSC would not place ${node.reduced.sliceCtoCode} in ${opts.rackCode} at all. ` +
        'Try a different rack cabinet from dcsc_rack_get.',
    );
  }

  const racksNeeded = Math.ceil(opts.nodes / perRack);
  // The cabinet's own mass; non_rack does not report it, customize does.
  const emptyRackWeightKg = probeEmptyWeightKg ?? rackEnv.weightKg;
  const power = extractPowerReport(node.raw);
  const unitPrice = node.raw.totalPrice;
  if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || node.raw.priceNotAvailable === true) throw new Error('DCSC did not return an available node price; a priced scenario cannot be calculated.');
  const fullestRackNodes = Math.min(perRack, opts.nodes);
  const lastRackNodes = (opts.nodes - 1) % perRack + 1;

  return {
    nodeCode: node.reduced.sliceCtoCode,
    nodeDescription: node.product.description,
    nodeSizeU: nodeEnv.sizeU,
    nodeWeightKg: nodeEnv.weightKg,
    rackCode: opts.rackCode,
    rackSizeU,
    nodes: opts.nodes,
    nodesPerRack: perRack,
    racksNeeded,
    totalListPrice: unitPrice * opts.nodes,
    currency: node.locale.currency,
    priceScope: 'configured-nodes-only',
    excludedCosts: ['rack cabinets', 'PDUs and cords', 'switches and cables', 'other workspace infrastructure'],
    lastRackNodes, fullestRackNodes,
    lastRackWeightKg: Math.round((emptyRackWeightKg + nodeEnv.weightKg * lastRackNodes) * 10) / 10,
    fullestRackWeightKg: Math.round((emptyRackWeightKg + nodeEnv.weightKg * fullestRackNodes) * 10) / 10,
    totalWeightKg:
      Math.round((nodeEnv.weightKg * opts.nodes + emptyRackWeightKg * racksNeeded) * 10) / 10,
    ...(power
      ? {
          powerPerNode: power,
          clusterPower: aggregatePower([{ report: power, quantity: opts.nodes }]),
          powerPerRack: aggregatePower([{ report: power, quantity: fullestRackNodes }]),
          lastRackPower: aggregatePower([{ report: power, quantity: lastRackNodes }]),
        }
      : {}),
  };
}

/**
 * Adds a rack cabinet and returns DCSC's validated layout.
 *
 * A rack is a configurable product in its own right, not just a container:
 * it is launched as a configuration in the workspace so that it carries its
 * own price, PDUs and rails. Exports reference racks by configuration id, and
 * a rackArea entry pointing at an id with no matching configuration makes the
 * export endpoint fail with "Index 0 out of bounds for length 0".
 */
export async function addRack(rt: Runtime, sessionHandle: string, rackCode: string, ctx: RequestCtx, expectedRevision?: number): Promise<LayoutResult> {
  const ws = rt.sessions.getWorkspace(sessionHandle);
  if (!ws) throw new Error(`Session / Workspace ${sessionHandle} not found`);
  // Avoid unnecessary launch requests on an already-stale call. Atomic creation
  // checks again under the workspace lock after remote preparation.
  assertWorkspaceRevision(ws, expectedRevision);

  const prepared = await prepareLaunch(rt, {
    productCode: rackCode,
    mode: 'cto',
    solution: ws.solution,
    ctx,
    workspaceId: ws.id,
  });

  const envelopes = await fetchEnvelopes(
    rt.http,
    { ...ctx, locale: ws.locale, solution: ws.solution },
    [{ code: rackCode, type: 'rack' }],
  );
  const envelope = envelopes.get(rackCode.toUpperCase());
  if (!envelope) {
    throw new Error(
      `DCSC returned no physical data for rack ${rackCode}. Use dcsc_rack_get for valid codes.`,
    );
  }

  let result: LayoutResult | undefined;
  await rt.sessions.createManyAtomic([prepared], {
    remoteApplied: true,
    actionHistory: addHistoryFactory(prepared.configurationId),
    workspaceHandle: ws.id, expectedRevision,
    prepare: async (draft, created) => {
      const rackSession = created[0]!;
      const next = [...draft.rackArea, buildRackObject(envelope, rackSession.configurationId)];
      result = await syncLayout(rt, draft, next, ctx);
    },
  });
  if (!result) throw new Error('Rack creation did not produce a layout.');
  return result;
}

/**
 * Places a configured product into a rack at a given U position.
 *
 * Omit `position` to let DCSC arrange it — the placement rules are per
 * product and per rack (a SR680a V3 cannot sit below U3 in a 42U cabinet),
 * so guessing a slot client-side mostly produces rejections.
 */
export async function placeInRack(rt: Runtime, sessionHandle: string,
  opts: { rackId: string; sessionId: string; chassisId?: string | undefined; position?: number | undefined; expectedRevision?: number | undefined; ctx: RequestCtx },): Promise<LayoutResult & { nestedPlacement?: NestedNodePlacement & { session: string } }> {
  if (opts.chassisId !== undefined) return copyNodeIntoChassis(rt, sessionHandle, { ...opts, chassisId: opts.chassisId });
  return rt.sessions.transact(workspaceId(rt, sessionHandle), {
    expectedRevision: opts.expectedRevision,
    remoteApplied: true,
    actionHistory: moveHistoryFactory(opts.sessionId),
  }, async (ws) => {
  const aliasTemplateId = storagePhysicalTemplateIds(ws).get(opts.sessionId);
  const target = ws.configurations.get(opts.sessionId) ?? [...ws.configurations.values()].find((session) =>
    session.configurationId === (aliasTemplateId ?? opts.sessionId));
  if (!target) throw new Error(`Configuration or physical item ${opts.sessionId} does not belong to this workspace.`);
  if (!aliasTemplateId && managedStorageComponentIds(ws.serverState).has(target.configurationId)) {
    throw new Error('Use dcsc_storage_set to instantiate a managed storage template. To move an existing instance, pass its physical ID from dcsc_workspace_get.');
  }
  const physicalId = aliasTemplateId ? opts.sessionId : target.configurationId;
  if (opts.position !== undefined && (!Number.isInteger(opts.position) || opts.position < 1)) {
    throw new Error('Rack position must be a positive integer.');
  }
  if (ws.rackArea.some((rack) => rack.id === target.configurationId)) {
    throw new Error('A rack cabinet cannot be placed inside another rack.');
  }

  const productCode = target.reduced.sliceCtoCode;
  const envelopes = await fetchEnvelopes(
    rt.http,
    { ...opts.ctx, locale: ws.locale, solution: ws.solution },
    [buildEnvelopeRequest(target.raw)],
  );
  const envelope = envelopes.get(productCode.toUpperCase());
  if (!envelope) {
    throw new Error(`DCSC returned no physical data for ${productCode}.`);
  }

  const rackIndex = ws.rackArea.findIndex((r) => String(r['id']) === opts.rackId);
  if (rackIndex < 0) {
    throw new Error(`Rack ${opts.rackId} not found in this workspace. Add one with dcsc_rack_add.`);
  }

  const previous = detachPhysicalItem(ws, physicalId);
  if (previous?.lock === true) throw new Error('This physical item is locked. Unlock it before moving.');
  const rack = ws.rackArea[rackIndex]!;
  const existing = (rack['rackItems'] as RackObject[] | undefined) ?? [];
  // Position 1 is a common default that most products reject; when the
  // caller does not care, hand the decision to DCSC's arranger.
  const position = opts.position ?? 1;
  const item = previous
    ? { ...previous, position, endPosition: position + Number(previous.size ?? envelope.sizeU) - 1 }
    : buildRackItem(envelope, physicalId, position, 1);
  if (opts.position !== undefined) {
    const end = Number(item.endPosition);
    if (Number(rack.size) > 0 && end > Number(rack.size)) throw new Error('Placement extends beyond the rack capacity.');
    if (Array.isArray(rack.lockedSpace) && rack.lockedSpace.some(value =>
      typeof value === 'number' && value >= position && value <= end)) {
      throw new Error('Placement overlaps locked rack space. Unlock that U position or choose another location.');
    }
    if (existing.some((other) => position <= Number(other.position) + Number(other.size ?? 1) - 1
      && end >= Number(other.position))) throw new Error('Placement overlaps an existing item. Choose free U positions.');
  }

  const nextRack = { ...rack, rackItems: [...existing, item] };
  const next = [...ws.rackArea];
  next[rackIndex] = nextRack;

  const result = await syncLayout(rt, ws, next, opts.ctx, {
    autoArrange: opts.position === undefined,
  });
  const accepted = result.racks.find((entry) => entry.id === opts.rackId)?.items
    .find((entry) => entry.id === physicalId);
  if (!accepted || (opts.position !== undefined && accepted.position !== opts.position)) {
    throw new Error('DCSC did not accept the requested rack placement. Workspace was not changed.');
  }
  return result;
  });
}

/** Website Add Node -> Already Configured Nodes -> As Copy. */
async function copyNodeIntoChassis(rt: Runtime, handle: string, opts: {
  rackId: string; sessionId: string; chassisId: string; position?: number | undefined;
  expectedRevision?: number | undefined; ctx: RequestCtx;
}): Promise<LayoutResult & { nestedPlacement: NestedNodePlacement & { session: string } }> {
  let copiedConfigurationId: string | undefined;
  const transaction: {
    expectedRevision: number | undefined;
    remoteApplied: boolean;
    actionHistory: ActionHistoryFactory;
  } = {
    expectedRevision: opts.expectedRevision,
    remoteApplied: false,
    actionHistory: (before, after) => copiedConfigurationId
      ? replicateHistoryFactory(opts.sessionId, 'COPY', 1, copiedConfigurationId)(before, after)
      : undefined,
  };
  return rt.sessions.transact(workspaceId(rt, handle), transaction, async workspace => {
    if (opts.position !== undefined) throw new Error('Nested node copies use the chassis bay layout; omit uPosition.');
    const source = workspace.configurations.get(opts.sessionId) ?? [...workspace.configurations.values()]
      .find(session => session.configurationId === opts.sessionId);
    if (!source) throw new Error('Choose a configured node belonging to this workspace.');
    if (!usesCtoWire(source.mode)) throw new Error('Nested node placement requires a CTO configuration.');
    if (detachedNestedNodeIds(workspace).has(source.configurationId)) {
      throw new Error('This node was physically detached. Undo detach and use unplace before copying it into a chassis.');
    }
    const context = { ...opts.ctx, locale: workspace.locale, solution: workspace.solution };
    let nonRackArea = workspace.nonRackArea;
    if (!nonRackArea.some(item => item.id === source.configurationId)) {
      if ([...workspace.rackArea, ...nonRackArea].some(item => physicalIds(item).has(source.configurationId))) {
        throw new Error('Nested node copy requires a loose source node; this node is already physically placed.');
      }
      const targetRack = workspace.rackArea.find(item => item.id === opts.rackId);
      if (!(targetRack?.rackItems as RackObject[] | undefined)?.some(item => item.id === opts.chassisId)) {
        throw new Error('The selected chassis does not belong to the requested rack.');
      }
      const request = buildEnvelopeRequest(source.raw);
      if (request.type !== 'node') throw new Error('Nested node copy source is not a node.');
      const envelopes = await fetchEnvelopes(rt.http, context, [request]);
      const envelope = envelopes.get(request.code.toUpperCase());
      if (!envelope || envelope.type !== 'node') throw new Error('DCSC returned no node physical metadata for the source configuration.');
      // Fresh launches have no physical layout entry yet. Retain the native
      // envelope (including bay size and quantity) and project selected parts
      // before cloning it under an identity absent from the configuration list.
      nonRackArea = buildRackCustomizePayload({ ...workspaceNetworkState(workspace),
        rackArea: workspace.rackArea,
        nonRackArea: [...nonRackArea, { ...structuredClone(envelope.raw), id: source.configurationId }],
      }, [...workspace.configurations.values()].map(session => session.raw)).nonRackArea;
    }
    const configurationId = newConfigurationId(workspace.locale.country);
    copiedConfigurationId = configurationId;
    const staged = stageConfiguredNodeCopy({ rackArea: workspace.rackArea, nonRackArea,
      chassisId: opts.chassisId, sourceNodeId: source.configurationId, copyId: configurationId });
    if (staged.placement.rackId !== opts.rackId) throw new Error('The selected chassis does not belong to the requested rack.');
    const chassisGroup = linkedGroup(workspace, opts.chassisId);
    if (chassisGroup.linked) throw new Error('DCSC does not allow Add Node into a linked cloned chassis.');
    const rack = workspace.rackArea.find(item => item.id === opts.rackId)!;
    const chassis = (rack.rackItems as RackObject[]).find(item => item.id === opts.chassisId)!;
    for (const [parent, child, type] of [[rack, chassis, 'chassis'],
      [chassis, { code: source.reduced.sliceCtoCode }, 'node']] as const) {
      const compatible = await fetchRackCabinets(rt.http, { ...context, solution: workspace.solution }, String(parent.code), type);
      if (!compatible.some(item => item.code.toUpperCase() === String(child.code).toUpperCase())) {
        throw new Error(`DCSC does not list ${String(child.code)} as compatible with ${String(parent.code)}. ` +
          `Use dcsc_rack_get with productCode="${String(parent.code)}" and hardwareType="${type}" for supported products.`);
      }
    }
    transaction.remoteApplied = true;
    const result = await customizeLayout(rt.http, context,
      buildRackCustomizePayload({ ...workspaceNetworkState(workspace), rackArea: staged.rackArea,
        nonRackArea: staged.nonRackArea }, [...workspace.configurations.values()].map(session => session.raw)),
      { autoArrange: true, autoConnect: true, cogValidation: true, mode: 'cto' });
    const acceptedRack = result.rawRackArea.find(item => item.id === opts.rackId);
    const acceptedChassis = (acceptedRack?.rackItems as RackObject[] | undefined)?.find(item => item.id === opts.chassisId);
    const accepted = (acceptedChassis?.nodes as RackObject[] | undefined)?.find(item => item.id === configurationId);
    if (!Array.isArray(result.rawState.rackArea) || !Array.isArray(result.rawState.nonRackArea) ||
        !Array.isArray(result.rawState.connections) || result.errors.length || !accepted ||
        result.rawState.errors && (!Array.isArray(result.rawState.errors) || result.rawState.errors.length) ||
        !result.rawNonRackArea.some(item => item.id === source.configurationId)) {
      throw new Error('DCSC did not retain the nested copy and its original node. Workspace was not committed.');
    }
    // The native client copies the configuration only after accepting the layout;
    // the customize request carries the original configurations, with no derive.
    const raw = cloneConfigurationRaw(source.raw, source.configurationId, configurationId);
    raw.autoDerivedResultId = null;
    const copyName = `Copy_${typeof source.raw.name === 'string' && source.raw.name ? source.raw.name : 'Node'}`;
    raw.name = copyName;
    if (Array.isArray(raw.expansionMessages)) {
      raw.expansionMessages = raw.expansionMessages.map(message => message && typeof message === 'object'
        ? { ...message, value: null } : message);
    }
    const copy = stageConfiguration(workspace, { locale: source.locale, solution: source.solution,
      mode: source.mode, raw, configurationId,
      reduced: reduceConfiguration(raw, configurationId, hardwareModeFamily(source.mode), source.solution.solutionMode),
      validationMode: source.validationMode, autoCorrect: source.autoCorrect,
      primed: source.primed, configurable: source.configurable, label: copyName });
    copy.pricedAt = source.pricedAt;
    workspace.serverState.cloneDependency = {
      ...workspaceNetworkState(workspace).cloneDependency as Record<string, string[]>, [configurationId]: [configurationId],
    };
    workspace.serverState.cloneDependencyColor = {
      ...workspace.serverState.cloneDependencyColor as Record<string, unknown>,
      [configurationId]: createCloneDependencyColor(configurationId),
    };
    workspace.rackArea = result.rawRackArea;
    workspace.nonRackArea = result.rawNonRackArea;
    workspace.rackSummaries = result.racks;
    workspace.serverState.connections = structuredClone(result.connections);
    workspace.serverState.layoutErrors = structuredClone(result.errors);
    delete workspace.serverState.connectionGraphInvalidation;
    workspace.cables = projectConnectionGraph(result.connections).cables;
    workspace.serverState.floorInformation = buildFloorState(workspace).information;
    buildGroups(workspace);
    return { ...result, nestedPlacement: { ...staged.placement, session: copy.id } };
  });
}

type LayoutEditOptions = {
  action: 'unplace' | 'remove' | 'detach' | 'arrange';
  configurationId?: string | undefined;
  contents?: 'unplace' | 'delete' | undefined;
  expectedRevision?: number | undefined;
  ctx: RequestCtx;
};

type NestedPhysicalEdit = { configurations: RawConfiguration[]; cloneDependency: unknown };

interface StagedLayoutEdit {
  deletedLinkedRootConfigurations?: RawConfiguration[] | undefined;
  nestedPhysicalEdit?: NestedPhysicalEdit | undefined;
  /** Set when staging already reconciled the layout with DCSC. */
  result?: LayoutResult | undefined;
}

function captureNestedPhysicalEdit(draft: WorkspaceSession): NestedPhysicalEdit {
  return { configurations: [...draft.configurations.values()].map(session => structuredClone(session.raw)),
    cloneDependency: structuredClone(workspaceNetworkState(draft).cloneDependency) };
}

function isNestedNode(items: RackObject[], id: string): boolean {
  return items.some(item =>
    item.type === 'chassis' && Array.isArray(item.nodes) &&
      (item.nodes as RackObject[]).some(node => node.id === id) ||
    Array.isArray(item.rackItems) && isNestedNode(item.rackItems as RackObject[], id));
}

function markNestedNodeDetached(draft: WorkspaceSession, id: string): void {
  const marked = draft.serverState.detachedNestedNodeIds;
  draft.serverState.detachedNestedNodeIds = [...new Set([
    ...(Array.isArray(marked) ? marked.filter(id => typeof id === 'string') : []), id,
  ])];
  const dependency = structuredClone(workspaceNetworkState(draft).cloneDependency) as Record<string, unknown>;
  delete dependency[id];
  draft.serverState.cloneDependency = dependency;
  const colors = draft.serverState.cloneDependencyColor as Record<string, unknown> | undefined;
  if (colors) delete colors[id];
}

function deleteRackOrChassisContents(
  draft: WorkspaceSession,
  id: string,
  physical: RackObject | undefined,
  contents: LayoutEditOptions['contents'],
): void {
  const removed = new Set([id]);
  if (physical?.type === 'rack' || physical?.type === 'chassis') {
    const childrenField = physical.type === 'rack' ? physical.rackItems : physical.nodes;
    const children = Array.isArray(childrenField) ? childrenField as RackObject[] : [];
    if (contents === 'delete') {
      for (const childId of physicalIds(physical)) removed.add(childId);
    } else draft.nonRackArea.push(...children);
  }
  for (const [sessionId, session] of draft.configurations) {
    if (removed.has(session.configurationId)) draft.configurations.delete(sessionId);
  }
  removeWorkspaceReferences(draft, removed);
}

async function stageLayoutEdit(rt: Runtime, draft: WorkspaceSession, opts: LayoutEditOptions): Promise<StagedLayoutEdit> {
  let deletedLinkedRootConfigurations: RawConfiguration[] | undefined;
  let nestedPhysicalEdit: NestedPhysicalEdit | undefined;
  const storageAliases = storagePhysicalTemplateIds(draft);
  const mappedTemplate = opts.configurationId ? storageAliases.get(opts.configurationId) : undefined;
  const aliasTemplate = mappedTemplate !== opts.configurationId ? mappedTemplate : undefined;
  const target = [...draft.configurations.values()].find((session) =>
    session.id === opts.configurationId || session.configurationId === (aliasTemplate ?? opts.configurationId));
  if (!target) throw new Error('Choose a configuration belonging to this workspace.');
  if (opts.action === 'remove' && !aliasTemplate) {
    const group = linkedGroup(draft, target.configurationId);
    if (group.linked && group.rootId === target.configurationId) {
      deletedLinkedRootConfigurations = [...draft.configurations.values()].map(session => structuredClone(session.raw));
    }
  }
  const managed = managedStorageComponentIds(draft.serverState).has(target.configurationId);
  if (managed && !aliasTemplate && opts.action === 'remove') {
    throw new Error('Remove a storage definition with dcsc_storage_set, or pass a physical instance ID to remove only that placement.');
  }
  if (managed && !aliasTemplate && opts.action === 'unplace') {
    const instances = [...storageAliases].filter(([, template]) => template === target.configurationId);
    if (instances.length === 0) throw new Error('This storage template has no physical placements to move.');
    for (const [physicalId] of instances) {
      const physical = detachPhysicalItem(draft, physicalId);
      if (!physical) throw new Error(`Storage placement ${physicalId} is missing.`);
      if (physical.lock === true) throw new Error('A storage instance is locked. Unlock it before moving the group.');
      draft.nonRackArea.push(physical);
    }
    return { result: await syncLayout(rt, draft, draft.rackArea, opts.ctx, { autoArrange: true }) };
  }
  const id = aliasTemplate ? opts.configurationId! : target.configurationId;
  const nestedNode = isNestedNode([...draft.rackArea, ...draft.nonRackArea], id);
  if (opts.action === 'detach' && !nestedNode) {
    throw new Error('Detach matches DCSC Delete Node and requires a node inside a chassis. Use unplace to retain a loose physical item, or remove to delete its configuration.');
  }
  if (opts.action === 'detach') {
    const group = linkedGroup(draft, id);
    if (group.linked) throw new Error('Detach of a linked nested node is not yet verified. Use unplace to preserve its physical and clone identities.');
  }
  if (nestedNode && (opts.action === 'detach' || opts.action === 'unplace')) {
    nestedPhysicalEdit = captureNestedPhysicalEdit(draft);
  }
  const physical = detachPhysicalItem(draft, id);
  if (physical?.lock === true) throw new Error('The item is locked. Unlock it before editing its placement.');
  if (opts.action === 'detach') markNestedNodeDetached(draft, id);
  if (opts.action === 'unplace') {
    if (!physical) throw new Error('This configuration has no physical placement to move.');
    if (physical.type === 'rack') throw new Error('Use remove with contents="unplace" to remove a rack and retain its products.');
    draft.nonRackArea.push(physical);
  } else if (opts.action !== 'detach') {
    if (physical?.type === 'chassis') nestedPhysicalEdit = captureNestedPhysicalEdit(draft);
    deleteRackOrChassisContents(draft, id, physical, opts.contents);
  }
  return { deletedLinkedRootConfigurations, nestedPhysicalEdit };
}

/** Reconcile physical edits using the sequence captured for the affected shape. */
export async function editLayout(rt: Runtime, handle: string, opts: LayoutEditOptions): Promise<LayoutResult> {
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error(`Workspace ${handle} not found.`);
  return rt.sessions.transact(workspace.id, {
    expectedRevision: opts.expectedRevision,
    keepEmptyWorkspace: true,
    remoteApplied: true,
    ...(opts.configurationId && opts.action !== 'arrange'
      ? { actionHistory: opts.action === 'unplace'
          ? moveHistoryFactory(opts.configurationId)
          : removeHistoryFactory(opts.configurationId) }
      : {}),
  }, async (draft) => {
    const staged: StagedLayoutEdit = opts.action === 'arrange' ? {} : await stageLayoutEdit(rt, draft, opts);
    if (staged.result) return staged.result;
    const { deletedLinkedRootConfigurations, nestedPhysicalEdit } = staged;
    const expectedNestedLayout = nestedPhysicalEdit
      ? structuredClone({ rackArea: draft.rackArea, nonRackArea: draft.nonRackArea }) : undefined;
    const result = await syncLayout(rt, draft, draft.rackArea, opts.ctx, { autoArrange: opts.action === 'arrange' || nestedPhysicalEdit !== undefined,
      ...(nestedPhysicalEdit ? { nestedPhysicalEdit } : {}),
      ...(deletedLinkedRootConfigurations ? { deletedLinkedRootConfigurations } : {}) });
    if (expectedNestedLayout) assertAcceptedNestedEdit(expectedNestedLayout, draft);
    return result;
  });
}

/**
 * Places a rack on the floor grid.
 *
 * Client-side only — see domain/floor.ts. Validates the rack exists in the
 * workspace and that the tile is free; does not invent DCSC validation.
 */
export async function placeOnFloor(rt: Runtime, sessionHandle: string, rackId: string, x: number, y: number, expectedRevision?: number,): Promise<FloorPlacementResult> {
  return rt.sessions.transact(workspaceId(rt, sessionHandle), { expectedRevision,
    actionHistory: floorMoveHistoryFactory(rackId) }, (workspace) => {
    const result = placeRackOnFloor({ rackArea: workspace.rackArea, rackId, x, y,
      existing: workspace.floorItems, newId: newId('floor') });
    workspace.floorItems = workspace.floorItems.filter((item) => item.rackId !== rackId).concat(result.item);
    const info = (workspace.serverState.floorInformation ?? {}) as Record<string, unknown>;
    const grid = Array.isArray(info.floorGrid) ? info.floorGrid as Record<string, unknown>[] : [];
    const previous = grid.find((item) => item.id === rackId) ?? {};
    const rack = workspace.rackArea.find((item) => item.id === rackId)!;
    const cell = { ...previous, id: rackId, sourceId: rackId, row: y, col: x,
      coordinate: `${String.fromCharCode(65 + y)}${x + 1}`, type: 'rack', facing: previous.facing ?? 'N',
      description: rack.description, depth: rack.depth, width: rack.width,
      lockedSpace: rack.lockedSpace ?? [], items: rack.rackItems ?? [],
    };
    workspace.serverState.floorInformation = { ...info,
      floorGrid: grid.filter((item) => item.id !== rackId && !(item.row === y && item.col === x)).concat(cell),
    };
    return result;
  });
}

/** Lock an existing item or reserve an empty U using the website physical mutation. */
export async function setRackLock(rt: Runtime, handle: string, opts: {
  target: { itemId: string } | { rackId: string; position: number };
  locked: boolean; expectedRevision?: number | undefined; ctx: RequestCtx;
}): Promise<{ rackId: string; itemId?: string; position: number; locked: boolean; layout: LayoutResult }> {
  const transaction = { expectedRevision: opts.expectedRevision, remoteApplied: false,
    actionHistory: rackLockHistoryFactory(opts.target, opts.locked) };
  return rt.sessions.transact(workspaceId(rt, handle), transaction, async workspace => {
    const change = 'itemId' in opts.target
      ? stageRackItemLock(workspace.rackArea, opts.target.itemId, opts.locked)
      : stageRackSpaceLock(workspace.rackArea, opts.target.rackId, opts.target.position, opts.locked);
    transaction.remoteApplied = true;
    const layout = await syncLayout(rt, workspace, change.rackArea, opts.ctx,
      { autoArrange: false, lockMutation: true });
    const rack = workspace.rackArea.find(value => value.id === change.rackId);
    if (!rack) throw new Error('DCSC did not retain the rack after locking. Workspace was not committed.');
    if ('itemId' in opts.target) {
      const itemId = opts.target.itemId;
      const item = (Array.isArray(rack.rackItems) ? rack.rackItems as RackObject[] : []).find(value => value.id === itemId);
      if (!item || item.lock !== opts.locked || item.position !== change.position) {
        throw new Error('DCSC did not accept the item lock at its existing position. Workspace was not committed.');
      }
    } else if (!Array.isArray(rack.lockedSpace) || rack.lockedSpace.includes(change.position) !== opts.locked) {
      throw new Error('DCSC did not accept the empty-U lock. Workspace was not committed.');
    }
    return { rackId: change.rackId, ...('itemId' in opts.target ? { itemId: opts.target.itemId } : {}),
      position: change.position, locked: opts.locked, layout };
  });
}

/** The distinct website Copy action creates an independent item in the same rack. */
export async function copyRackItem(rt: Runtime, handle: string, opts: {
  expectedRevision?: number | undefined; ctx: RequestCtx;
}): Promise<{ source: ConfigSession; copy: ConfigSession; placement: RackedClonePlacement; nestedCopies: ConfigSession[] }> {
  const resolved = rt.sessions.resolveHandle(handle);
  if (resolved?.kind !== 'configuration') throw new Error('Copy requires an explicit configuration handle.');
  const transaction = { expectedRevision: opts.expectedRevision, remoteApplied: false,
    actionHistory: replicateHistoryFactory(resolved.session.configurationId, 'COPY', 1) };
  return rt.sessions.transact(resolved.session.workspaceId, transaction, async workspace => {
    const source = workspace.configurations.get(resolved.session.id);
    if (!source) throw new Error('The source configuration no longer belongs to this workspace.');
    const physical = workspace.rackArea.flatMap(rack => Array.isArray(rack['rackItems']) ? rack['rackItems'] as Record<string, unknown>[] : [])
      .find(item => (item['configurationId'] ?? item['id']) === source.configurationId);
    const nodes = physical?.['type'] === 'chassis' && Array.isArray(physical['nodes'])
      ? physical['nodes'] as Record<string, unknown>[] : [];
    if ((workspace.solution.solutionMode !== 'General Purpose' &&
        !(workspace.solution.solutionMode === 'HPC and AI - Systems' && nodes.length > 0)) || source.mode !== 'cto' ||
        (source.raw.quantity ?? 1) !== 1 || managedStorageComponentIds(workspace.serverState).has(source.configurationId)) {
      throw new Error('Rack Copy requires an ordinary quantity-one CTO item in General Purpose or a populated HPC chassis.');
    }
    const configurationId = newConfigurationId(workspace.locale.country);
    const priorDependency = structuredClone(workspace.serverState.cloneDependency);
    const nestedCopies: ConfigSession[] = [];
    const childCloneIds: Record<string, Record<string, string>> = {};
    for (const node of nodes) {
      const id = String(node['configurationId'] ?? node['id']);
      const template = [...workspace.configurations.values()].find(config => config.configurationId === id);
      if (!template || template.mode !== 'cto' || (template.raw.quantity ?? 1) !== 1 ||
          managedStorageComponentIds(workspace.serverState).has(id)) {
        throw new Error(`Chassis node ${id} has no ordinary quantity-one CTO configuration.`);
      }
      const childId = newConfigurationId(workspace.locale.country);
      if (typeof template.raw.name !== 'string' || !template.raw.name.trim() || template.raw.name !== node['name']) {
        throw new Error(`Chassis node ${id} requires matching configuration and physical names for Copy.`);
      }
      const name = `Copy_${template.raw.name}`;
      const childRaw = { ...cloneConfigurationRaw(template.raw, id, childId), name };
      const child = stageConfiguration(workspace, { locale: template.locale, solution: template.solution,
        mode: template.mode, raw: childRaw, configurationId: childId,
        reduced: reduceConfiguration(childRaw, childId, 'cto', template.solution.solutionMode),
        validationMode: template.validationMode, autoCorrect: template.autoCorrect,
        primed: template.primed, configurable: template.configurable, label: name });
      child.pricedAt = template.pricedAt;
      nestedCopies.push(child);
      (childCloneIds[configurationId] ??= {})[id] = childId;
    }
    const staged = stageRackedCopy({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
      sourceId: source.configurationId, copyId: configurationId, childCloneIds,
      cloneDependency: workspace.serverState.cloneDependency,
      sourceName: typeof source.raw.name === 'string' ? source.raw.name : undefined });
    const raw = { ...cloneConfigurationRaw(source.raw, source.configurationId, configurationId), name: staged.copyName };
    const copy = stageConfiguration(workspace, { locale: source.locale, solution: source.solution,
      mode: source.mode, raw, configurationId,
      reduced: reduceConfiguration(raw, configurationId, 'cto', source.solution.solutionMode),
      validationMode: source.validationMode, autoCorrect: source.autoCorrect,
      primed: source.primed, configurable: source.configurable, label: staged.copyName });
    copy.pricedAt = source.pricedAt;
    workspace.nonRackArea = staged.nonRackArea;
    workspace.serverState.cloneDependency = staged.cloneDependency;
    transaction.remoteApplied = true;
    const result = await syncLayout(rt, workspace, staged.rackArea, opts.ctx, {
      autoArrange: false, ...(nodes.length > 0
        ? { clonePopulatedChassis: true, copyPopulatedChassisDependency: priorDependency }
        : { copyConfigurationId: configurationId }),
    });
    const rack = result.racks.find(rack => rack.id === staged.placement.rackId);
    const item = rack?.items.find(item => item.id === configurationId);
    if (!rack || !item || result.errors.length) {
      throw new Error('DCSC did not retain the copied item in the source rack. Workspace was not committed.');
    }
    buildGroups(workspace);
    return { source, copy, nestedCopies, placement: { configurationId, rackId: rack.id, position: item.position } };
  });
}

/**
 * Copies an already-configured product N times inside the same workspace.
 *
 * A multi-node solution needs N configurations, not one with quantity N:
 * quantity extends the price and the export line but places a single item in
 * a rack. Rebuilding each node with launch + configure costs a round trip per
 * option per node and lets them drift apart silently, so the copy is made
 * locally from the source's own post-autoDerive tree.
 *
 * Each clone gets a fresh DCSC configuration id — placements, topologies and
 * cabling are all keyed by it, so sharing one would alias the nodes together.
 */
export async function cloneConfiguration(rt: Runtime, opts: {
  sessionHandle: string; count: number; labelPrefix?: string | undefined; expectedRevision?: number | undefined;
  placement?: 'none' | 'same-rack' | undefined; ctx?: RequestCtx | undefined;
}): Promise<{ source: ConfigSession; clones: ConfigSession[]; placements?: RackedClonePlacement[]; nestedConfigurations?: ConfigSession[] }> {
  if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > 99) throw new Error('Clone count must be an integer from 1 to 99.');
  const resolved = rt.sessions.resolveHandle(opts.sessionHandle);
  if (resolved?.kind === 'workspace' && resolved.workspace.configurations.size !== 1) {
    throw new Error('Cloning requires one configuration target. Pass its configuration session ID.');
  }
  const original = resolved?.session;
  if (!original) throw new Error('Choose a configuration handle to clone.');
  const transaction = { expectedRevision: opts.expectedRevision, remoteApplied: false,
    actionHistory: replicateHistoryFactory(original.configurationId,
      opts.placement === 'same-rack' ? 'CLONE' : 'COPY', opts.count) };
  return rt.sessions.transact(original.workspaceId, transaction, async (workspace) => {
    const source = workspace.configurations.get(original.id);
    if (!source) throw new Error('The source configuration no longer belongs to this workspace.');
    if (opts.placement === 'same-rack' && (!opts.ctx || !usesCtoWire(source.mode) ||
        (source.raw.quantity ?? 1) !== 1 || managedStorageComponentIds(workspace.serverState).has(source.configurationId))) {
      throw new Error('Physical Clone Multiple requires an ordinary CTO configuration with quantity one and a request context.');
    }
    const clones: ConfigSession[] = [];
    const copy = (template: ConfigSession, index: number): ConfigSession => {
      const clone = structuredClone(template);
      const configurationId = newConfigurationId(template.locale.country);
      clone.id = newId('sess', template.product.code);
      clone.configurationId = configurationId;
      clone.raw = cloneConfigurationRaw(template.raw, template.configurationId, configurationId);
      clone.revision = 1;
      clone.snapshots = [];
      clone.intents = [];
      clone.createdAt = Date.now();
      clone.label = opts.labelPrefix && template === source ? `${opts.labelPrefix} ${index + 2}`
        : `${template.label ?? template.product.description} (copy ${index + 1})`;
      clone.reduced = reduceConfiguration(clone.raw, configurationId, hardwareModeFamily(clone.mode), workspace.solution.solutionMode);
      workspace.configurations.set(clone.id, clone);
      return clone;
    };
    for (let i = 0; i < opts.count; i++) clones.push(copy(source, i));
    if (opts.placement === 'same-rack') {
      const physical = workspace.rackArea.flatMap(rack => Array.isArray(rack['rackItems']) ? rack['rackItems'] as Record<string, unknown>[] : [])
        .find(item => (item['configurationId'] ?? item['id']) === source.configurationId);
      const nodes = physical?.['type'] === 'chassis' && Array.isArray(physical['nodes'])
        ? physical['nodes'] as Record<string, unknown>[] : [];
      const childCloneIds: Record<string, Record<string, string>> = {};
      const nestedConfigurations: ConfigSession[] = [];
      for (const node of nodes) {
        const id = String(node['configurationId'] ?? node['id']);
        const template = [...workspace.configurations.values()].find(config => config.configurationId === id);
        if (!template || !usesCtoWire(template.mode) || (template.raw.quantity ?? 1) !== 1 ||
            managedStorageComponentIds(workspace.serverState).has(id)) {
          throw new Error(`Chassis node ${id} has no ordinary quantity-one CTO configuration.`);
        }
        nestedConfigurations.push(template);
        for (const [index, parent] of clones.entries()) {
          const child = copy(template, index);
          (childCloneIds[parent.configurationId] ??= {})[id] = child.configurationId;
          nestedConfigurations.push(child);
        }
      }
      const staged = stageRackedCloneMultiple({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
        sourceId: source.configurationId, cloneIds: clones.map(clone => clone.configurationId), childCloneIds,
        cloneDependency: workspace.serverState.cloneDependency });
      workspace.nonRackArea = staged.nonRackArea;
      workspace.serverState.cloneDependency = staged.cloneDependency;
      transaction.remoteApplied = true;
      const hpcSwitch = workspace.solution.solutionMode === 'HPC and AI - Systems' && source.raw.type === 'switch';
      const result = await syncLayout(rt, workspace, staged.rackArea, opts.ctx!, { autoArrange: hpcSwitch,
        ...(nodes.length > 0 ? { clonePopulatedChassis: true } : hpcSwitch ? { cloneHpcSwitch: linkedGroup(workspace, source.configurationId).rootId } : { cloneMultiple: true }) });
      const placements = clones.map(clone => {
        const rack = result.racks.find(rack => rack.items.some(item => item.id === clone.configurationId));
        const item = rack?.items.find(item => item.id === clone.configurationId);
        if (!rack || !item || rack.id !== staged.placements.find(placement => placement.configurationId === clone.configurationId)?.rackId) {
          throw new Error(`DCSC did not retain clone ${clone.configurationId} in the source rack. Workspace was not committed.`);
        }
        return { configurationId: clone.configurationId, rackId: rack.id, position: item.position };
      });
      for (const parent of clones) {
        const accepted = workspace.rackArea.flatMap(rack => Array.isArray(rack['rackItems']) ? rack['rackItems'] as Record<string, unknown>[] : [])
          .find(item => (item['configurationId'] ?? item['id']) === parent.configurationId);
        const actual = Array.isArray(accepted?.['nodes']) ? accepted['nodes'] as Record<string, unknown>[] : [];
        const expected = Object.values(childCloneIds[parent.configurationId] ?? {});
        if (actual.length !== expected.length || expected.some(id => !actual.some(node => (node['configurationId'] ?? node['id']) === id))) {
          throw new Error(`DCSC did not retain the exact child identities in cloned chassis ${parent.configurationId}. Workspace was not committed.`);
        }
      }
      if (result.errors.length) throw new Error(`DCSC rejected the cloned layout: ${JSON.stringify(result.errors).slice(0, 1500)}`);
      return { source, clones, placements, ...(nestedConfigurations.length ? { nestedConfigurations } : {}) };
    }
    return { source, clones };
  });
}

/**
 * Selects a PDU / power cord on a rack via DCSC autoDerive.
 *
 * The accepted quantities and price come from the server response — we do
 * not store a local selection unless DCSC confirmed it.
 */
export async function configurePdu(rt: Runtime, sessionHandle: string,
  rackId: string,
  opts: {
    expectedRevision?: number | undefined;
    pduCode?: string | undefined;
    cordCode?: string | undefined;
    quantity?: number | undefined;
    ctx: RequestCtx;
  },): Promise<{
  rackId: string;
  rackSessionId: string;
  selection: PduSelection;
  selected: ReturnType<typeof selectedPowerLines>;
  totalPrice: number | null;
  catalog?: PduCatalog | undefined;
  /**
   * Whether the rack can actually be connected to facility power.
   *
   * A PDU with no LINECORD cannot reach the facility feed, and DCSC neither
   * requires one nor complains: the rack prices, validates and exports
   * happily while being unorderable. Jumper cords do not substitute — they
   * connect equipment to PDU outlets, not the PDU to the building.
   */
  powerReadiness?:
    | {
        hasPdu: boolean;
        hasLineCord: boolean;
        complete: boolean;
        availableLineCords: PduOption[];
        warning?: string | undefined;
      }
    | undefined;
}> {
  return rt.sessions.transact(workspaceId(rt, sessionHandle), {
    expectedRevision: opts.expectedRevision,
    remoteApplied: true,
    actionHistory: updateHistoryFactory(rackId),
  }, async (ws) => {
  const rackSession = [...ws.configurations.values()].find((candidate) => candidate.configurationId === rackId);
  if (!rackSession) {
    throw new Error(
      `Rack ${rackId} has no configuration session. Add the rack with dcsc_rack_add first.`,
    );
  }

  const qty = opts.quantity ?? 1;
  const changes: Array<{ section: string; code: string; quantity: number }> = [];
  if (opts.pduCode) {
    changes.push(resolvePowerChange(rackSession.index, opts.pduCode, qty));
  }
  if (opts.cordCode) {
    changes.push(resolvePowerChange(rackSession.index, opts.cordCode, qty));
  }

  if (changes.length === 0) {
    const catalog = listPduCatalog({ index: rackSession.index, rackObject: ws.rackArea.find((rack) => rack.id === rackId) });
    return {
      rackId,
      rackSessionId: rackSession.id,
      selection: { rackId },
      selected: selectedPowerLines(rackSession.index),
      totalPrice: configurationListPrice(rackSession.raw),
      catalog,
    };
  }

  const updated = await configureDraft(rt, rackSession, changes, opts.ctx, ws);
  const selected = selectedPowerLines(updated.index);
  const pduLine = selected.find((s) => s.section.toUpperCase() === 'PDU');
  const cordLine = selected.find(
    (s) =>
      s.section.toUpperCase() === 'LINECORD' || s.section.toUpperCase() === 'RACK_POWERCABLE',
  );
  const selection: PduSelection = {
    rackId,
    ...(pduLine ? { pduCode: pduLine.code } : {}),
    ...(cordLine ? { cordCode: cordLine.code } : {}),
  };


  // Did DCSC actually take the request?
  for (const ch of changes) {
    const got = updated.index.selected.get(ch.code) ?? 0;
    if (got < ch.quantity || ch.quantity === 0 && got !== 0) {
      throw new Error(
        `DCSC did not accept ${ch.code} x${ch.quantity} on the rack (selected quantity is ${got}). ` +
          'Check min/max with dcsc_rack_get (with rackId), or dcsc_configuration_get on the rack session.',
      );
    }
  }

  ws.powerSelections = ws.powerSelections.filter((item) => item.rackId !== rackId).concat(selection);

  // Re-read the catalog after the change so the line cords offered reflect
  // the PDU actually installed.
  const rackObject = ws.rackArea.find((r) => String(r['id']) === rackId);
  const catalogAfter = listPduCatalog({ index: updated.index, rackObject });
  const availableLineCords = catalogAfter.options.filter(
    (o) => o.section.toUpperCase() === 'LINECORD',
  );
  const hasPdu = selected.some((s) => s.section.toUpperCase() === 'PDU');
  const hasLineCord = selected.some((s) => s.section.toUpperCase() === 'LINECORD');
  const complete = !hasPdu || hasLineCord;

  return {
    rackId,
    rackSessionId: updated.id,
    selection,
    selected,
    totalPrice: configurationListPrice(updated.raw),
    powerReadiness: {
      hasPdu,
      hasLineCord,
      complete,
      availableLineCords,
      ...(complete
        ? {}
        : {
            warning:
              'This rack has PDUs but no LINECORD. A PDU with no line cord cannot be connected ' +
              'to facility power, and the rack is not orderable as it stands. ' +
              (availableLineCords.length > 0
                ? `Choose one of: ${availableLineCords
                    .slice(0, 6)
                    .map((c) => `${c.code} (${c.description})`)
                    .join('; ')}. Apply with dcsc_pdu_set (cordCode).`
                : 'No LINECORD options are on the rack tree — check dcsc_configuration_get (rack session, tab "Power").'),
          }),
    },
  };
  });
}
