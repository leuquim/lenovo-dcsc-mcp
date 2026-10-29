import { isDeepStrictEqual } from 'node:util';

import { resolveLinkedCloneGroup, projectLinkedCloneResponse, type LinkedCloneGroup } from '../domain/linkedCloneEdit.js';
import { configurationListPrice } from '../domain/pricing.js';
import { refreshStoragePhysicalFeatures, splitStoragePhysicalDerive } from '../domain/storagePhysicalDerive.js';
import { reconfigureStorageConnectionNetwork, type StorageNetworkChanges } from '../domain/storagePreferences.js';
import { inspectManualCabling as projectManualCabling, stageManualConnectionEdit, applyManualConnectionDistance, applyAcceptedManualCablePhysicalState,
  commitManualConnectionEdit, projectManualConnection, type ManualConnectionEdit } from '../domain/manualCabling.js';
import { hardwareModeFamily, hardwareEndpointFamily, usesCtoWire } from '../domain/modeFamily.js';
import type { ConfigMode } from '../config/constants.js';
import type { Config, Locale, SolutionContext } from '../config/schema.js';
import { applySoftwareDerivePatch, isSoftwareDerivePatch } from '../domain/softwareDerive.js';
import { BLUEPRINTS } from '../domain/blueprints.js';
import { fetchCatalog, type Catalog } from '../domain/catalog.js';
import {
  fetchSolutionModes,
  toSolutionContext,
  type SolutionModeInfo,
} from '../domain/context.js';
import {
  applyCatalogChange,
  buildAutoDeriveRequest,
  buildExportData,
  buildExportForm,
  buildGroups,
  newConfigurationId,
  reduceConfiguration,
  type ExportFileType,
  type ReducedConfiguration,
} from '../domain/reduce.js';
import { parseCfxml } from '../domain/import.js';
import { hydrateImportedLayout, mergeImportedState } from '../domain/importLayout.js';
import { parseStandaloneImportResponse } from '../domain/importStandalone.js';
import { assertConfigurationReconciliationAllowed, hasUnrepairedRecoveryData } from '../domain/workspaceIntegrity.js';
import { applyReconciliationProposal, canonicalWorkspaceHash, proposeLegacyReconciliation, RECONCILIATION_PROPOSALS_STATE_KEY, type ReconciliationProposal } from '../domain/reconciliation.js';
import {
  buildRackItem,
  buildRackCustomizePayload,
  withDerivedPlacements,
  buildEnvelopeRequest,
  mergeDerivedConfigurations,
  buildRackObject,
  customizeLayout,
  fetchEnvelopes,
  fetchRackCabinets,
  type CustomizeOptions,
  type LayoutResult,
  type RackCabinet,
  type RackObject,
  type RackSummary,
} from '../domain/rack.js';
import { fetchFabricOptions, type FabricOptions } from '../domain/fabric.js';
import { aggregatePower, extractPowerReport, type AggregatedPower, type PowerReport } from '../domain/power.js';
import { buildSelectedTopologies, buildWorkspaceNetworkPreferences, type WorkspaceNetworkSelection } from '../domain/networkPreferences.js';
import { workspaceNetworkTypes } from '../domain/workspaceNetworkPreferences.js';
import { retainReplacedStorageComponents, type DetachedStorageComponent } from '../domain/storageComponentLifecycle.js';
import { addStorageConnectionNetwork, editStorageConnectionNetwork, readStorageConnectionNetworks,
  managedStorageComponentIds, configurationCloneDependency, storagePhysicalTemplateIds, storageDependencyColors, type StorageNetworkInput } from '../domain/storagePreferences.js';
import { autoConnect, buildClusterPreferences, mergeAutoConnectSettings, readAutoConnectSettings, readConnectionGraph, readSwitchMap, projectConnectionGraph, invalidateConnectionGraph, assertCurrentConnectionGraph, type AutoConnectResult,
  type AutoConnectSettingsPatch } from '../domain/cabling.js';
import { detachPhysicalItem, physicalIds, removeWorkspaceReferences } from '../domain/workspaceReferences.js';
import { renderRackImage } from '../domain/rackImage.js';
import { buildFloorState } from '../domain/floorWire.js';
import { stageRackItemLock, stageRackSpaceLock } from '../domain/rackLocks.js';
import { workspaceHardwareMode } from '../domain/workspaceWire.js';
import { buildSwitchCalculationRequest, parseSwitchCalculationResponse, buildGeneratedSwitch } from '../domain/switchProvisioning.js';
import { buildRackRecustomizePlan, parseRackRecustomizeResult } from '../domain/rackRecustomize.js';
import { projectRackFiller } from '../domain/rackFiller.js';
import { assignConfigIdFeatures, configIdTargetCodes } from '../domain/configIdFeatures.js';
import { projectAutoDerivedSelections } from '../domain/autoDerivedSelections.js';
import { buildStorageAssignmentRequest, parseStorageAssignmentResponse } from '../domain/storageAssignment.js';
import { stageStorageNetworkPlacement, parseStoragePlacementResponse, type AcceptedStoragePlacement,
  type StoragePlacementComponent } from '../domain/storagePlacement.js';
import { buildLfoHardwareDeriveRequest } from '../domain/lfoWire.js';
import { placeRackOnFloor, type FloorPlacementResult } from '../domain/floor.js';
import {
  listPduCatalog,
  resolvePowerChange,
  selectedPowerLines,
  type PduCatalog,
  type PduOption,
} from '../domain/pdu.js';
import {
  collectExpansionMessages,
  summariseValidation,
  type ValidationReport,
} from '../domain/validate.js';
import { findRackCapacity } from '../domain/rackCapacity.js';
import { expandImportedClones } from '../domain/importClones.js';
import { cloneConfigurationRaw } from '../domain/configurationIdentity.js';
import { stageRackedCloneMultiple, type RackedClonePlacement } from '../domain/physicalClone.js';
import { stageRackedCopy } from '../domain/physicalCopy.js';
import { assertAcceptedNestedEdit, detachedNestedNodeIds, stageConfiguredNodeCopy, type NestedNodePlacement } from '../domain/nestedPhysical.js';
import { createCloneDependencyColor } from '../domain/cloneDependency.js';
import type { ActionHistoryFactory, NativeHistoryInput } from '../domain/actionHistory.js';
import { readValidationJobs, runValidationJob, validationResultFromJob, isValidationJobStale, validationPayloadSha256 } from '../domain/validationJobs.js';
import { fetchLocales, localeFromOption, type LocaleOption } from '../domain/locale.js';
import { fetchServicePortalCategories, type ServiceCategory } from '../domain/services-catalog.js';
import { diffConfigurations } from '../model/diff.js';
import { buildIndex, resolveSection, suggestSections } from '../model/index.js';
import { projectSummary } from '../model/project.js';
import { DcscHttpClient, RequestBudget, type RequestCtx } from '../http/request.js';
import { logger, newCorrId } from '../http/trace.js';
import type { RawConfiguration } from '../model/types.js';
import {
  SessionStore,
  stageConfiguration,
  SessionConflictError,
  type ConfigSession,
  type CreateSessionInput,
  type CableLink,
  type PduSelection,
  type WorkspaceSession,
} from '../session/SessionStore.js';
import { createPersistenceWriter, loadSessions, saveSessions } from '../session/persist.js';
import { ulid } from 'ulid';

interface LaunchOptions {
  expectedRevision?: number | undefined;
  productCode: string;
  mode: ConfigMode;
  solution: SolutionContext;
  ctx: RequestCtx;
  label?: string | undefined;
  workspaceId?: string | undefined;
}

/** Reduces a raw rackArea the same way customizeLayout does, without a round trip. */
function summariseRackArea(rackArea: RackObject[]): RackSummary[] {
  return rackArea.map((r) => {
    const items = ((r['rackItems'] as RackObject[] | undefined) ?? []).map((it) => {
      const sizeU = typeof it['size'] === 'number' ? it['size'] : Number(it['size']) || 1;
      const position =
        typeof it['position'] === 'number' ? it['position'] : Number(it['position']) || 0;
      return {
        id: String(it['id'] ?? ''),
        code: String(it['code'] ?? ''),
        description: typeof it['description'] === 'string' ? it['description'] : undefined,
        position,
        endPosition: position + sizeU - 1,
        sizeU,
      };
    });
    const sizeU = typeof r['size'] === 'number' ? r['size'] : Number(r['size']) || 0;
    const usedU = items.reduce((acc, i) => acc + i.sizeU, 0);
    const errors = Array.isArray(r['errors'])
      ? (r['errors'] as unknown[])
          .map((e) => {
            if (typeof e === 'string') return { message: e };
            if (typeof e === 'object' && e !== null) {
              const o = e as Record<string, unknown>;
              return {
                ...(typeof o['code'] === 'string' ? { code: o['code'] } : {}),
                message: String(o['message'] ?? o['code'] ?? 'error'),
              };
            }
            return { message: String(e) };
          })
          .filter((e) => e.message)
      : [];
    return {
      id: String(r['id'] ?? ''),
      code: String(r['code'] ?? ''),
      description: typeof r['description'] === 'string' ? r['description'] : undefined,
      sizeU,
      usedU,
      freeU: Math.max(0, sizeU - usedU),
      emptyWeightKg: typeof r['emptyRackWeight'] === 'number' ? r['emptyRackWeight'] : undefined,
      totalWeightKg: typeof r['totalWeight'] === 'number' ? r['totalWeight'] : undefined,
      stableStatus: typeof r['stableStatus'] === 'string' ? r['stableStatus'] : undefined,
      items,
      errors,
    };
  });
}

const SOLUTION_MODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

interface HistoryPhysicalContext {
  item: RackObject;
  location: string;
  parentId: string;
  position: number | undefined;
}

function historyString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function historyItemLabel(item: RackObject): string {
  const name = historyString(item.name);
  if (name) return name;
  const type = historyString(item.type);
  return type ? `${type.charAt(0).toUpperCase()}${type.slice(1)}` : historyString(item.description);
}

function rackHistoryLocation(workspace: WorkspaceSession, rack: RackObject): string {
  const floor = workspace.serverState.floorInformation as Record<string, unknown> | undefined;
  const grid = Array.isArray(floor?.['floorGrid']) ? floor.floorGrid as Array<Record<string, unknown>> : [];
  const coordinate = historyString(grid.find(item => item['id'] === rack.id)?.['coordinate']) ||
    historyString((rack as Record<string, unknown>)['coordinate']);
  return [historyItemLabel(rack) || 'Rack', coordinate].filter(Boolean).join(' ');
}

function findNestedHistoryItem(
  items: RackObject[], id: string, parent: RackObject, location: string,
): HistoryPhysicalContext | undefined {
  for (const item of items) {
    if (item.id === id) {
      return { item, location, parentId: historyString(parent.id),
        position: typeof item.position === 'number' ? item.position : undefined };
    }
    const children = [
      ...(Array.isArray(item.rackItems) ? item.rackItems as RackObject[] : []),
      ...(Array.isArray(item.nodes) ? item.nodes as RackObject[] : []),
    ];
    const nested = findNestedHistoryItem(children, id, item, historyItemLabel(item));
    if (nested) return nested;
  }
  return undefined;
}

function findHistoryPhysical(workspace: WorkspaceSession, id: string): HistoryPhysicalContext | undefined {
  for (const rack of workspace.rackArea) {
    if (rack.id === id) {
      return { item: rack, location: 'Rack Area', parentId: 'RACK_AREA',
        position: typeof rack.position === 'number' ? rack.position : undefined };
    }
    const nested = findNestedHistoryItem(
      Array.isArray(rack.rackItems) ? rack.rackItems as RackObject[] : [],
      id,
      rack,
      rackHistoryLocation(workspace, rack),
    );
    if (nested) return nested;
  }
  for (const item of workspace.nonRackArea) {
    if (item.id === id) {
      return { item, location: 'Non Rack Area', parentId: 'NON_RACK_AREA',
        position: typeof item.position === 'number' ? item.position : undefined };
    }
    const children = [
      ...(Array.isArray(item.rackItems) ? item.rackItems as RackObject[] : []),
      ...(Array.isArray(item.nodes) ? item.nodes as RackObject[] : []),
    ];
    const nested = findNestedHistoryItem(children, id, item, historyItemLabel(item));
    if (nested) return nested;
  }
  return undefined;
}

function historyConfiguration(workspace: WorkspaceSession, id: string): ConfigSession | undefined {
  return workspace.configurations.get(id) ?? [...workspace.configurations.values()].find(session =>
    session.configurationId === id);
}

function historyConfigurationId(workspace: WorkspaceSession, id: string): string {
  return historyConfiguration(workspace, id)?.configurationId ?? id;
}

function nativeHardwareEvent(
  workspace: WorkspaceSession,
  id: string,
  command: NativeHistoryInput['command'],
): NativeHistoryInput | undefined {
  const physical = findHistoryPhysical(workspace, id);
  const session = historyConfiguration(workspace, id);
  const raw = session?.raw;
  if (!physical && !raw) return undefined;
  const item = physical?.item;
  const type = historyString(item?.type) || historyString(raw?.type);
  const code = historyString(item?.code) || historyString(item?.sliceCtoCode) ||
    historyString(raw?.sliceCtoCode) || session?.product.code || '';
  return {
    command,
    type,
    code,
    // Before a newly launched item has a physical record, native ADD history
    // also lacks the description. Rack creation is resolved from its accepted
    // rackArea entry and therefore retains the cabinet description.
    description: item ? historyString(item.description) : '',
    location: physical?.location ?? (type === 'rack' ? 'Rack Area' : 'Non Rack Area'),
    asVLH: item?.asVLH === true || raw?.asVLH === true,
  };
}

function addHistoryFactory(configurationId: string): ActionHistoryFactory {
  return (_before, after) => nativeHardwareEvent(after, configurationId, 'ADD');
}

function replicateHistoryFactory(
  sourceId: string,
  command: 'COPY' | 'CLONE' | 'UNCLONE',
  quantity: number,
  resultId?: string,
): ActionHistoryFactory {
  return (before, after) => {
    const canonicalSourceId = historyConfigurationId(before, sourceId);
    const event = nativeHardwareEvent(before, canonicalSourceId, command) ??
      nativeHardwareEvent(after, canonicalSourceId, command);
    if (!event) return undefined;
    const source = historyConfiguration(before, canonicalSourceId) ?? historyConfiguration(after, canonicalSourceId);
    const description = event.description || historyString(source?.raw.description);
    const result = resultId ? findHistoryPhysical(after, resultId) : undefined;
    return { ...event, description, quantity, ...(result ? { location: result.location } : {}) };
  };
}

function selectedEntries(workspace: WorkspaceSession, id: string): unknown[] | undefined {
  const session = historyConfiguration(workspace, id);
  if (!session) return undefined;
  const selected = [...buildIndex(session.raw).selected].sort(([left], [right]) => left.localeCompare(right));
  // Keep section identity as well as the aggregate code map. The same feature
  // code can occur in more than one service/software section, and moving a
  // quantity between those sections is still a native customization.
  const scoped = (session.raw.tabs ?? []).flatMap((tab, tabIndex) =>
    (tab.subTabs ?? []).flatMap((subTab, subTabIndex) =>
      (subTab.sections ?? []).flatMap((section, sectionIndex) =>
        (section.results ?? []).map(result => [
          tab.type ?? tab.title ?? tabIndex,
          subTab.title ?? subTabIndex,
          section.name ?? section.title ?? sectionIndex,
          result.code ?? '',
          result.ctoCode ?? '',
          result.quantity ?? 0,
        ])))).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return [
    selected,
    scoped,
    session.raw.selectedTopologies ?? {},
    session.raw.selectedStorageNetwork ?? '',
  ];
}

function updateHistoryFactory(configurationId: string): ActionHistoryFactory {
  return (before, after) => {
    const previous = selectedEntries(before, configurationId);
    const current = selectedEntries(after, configurationId);
    if (!previous || !current || isDeepStrictEqual(previous, current)) return undefined;
    return nativeHardwareEvent(after, configurationId, 'UPDATE');
  };
}

function moveHistoryFactory(id: string): ActionHistoryFactory {
  return (before, after) => {
    const configurationId = historyConfigurationId(before, id);
    const previous = findHistoryPhysical(before, id) ?? findHistoryPhysical(before, configurationId);
    const current = findHistoryPhysical(after, id) ?? findHistoryPhysical(after, configurationId);
    if (!current) return undefined;
    if (previous && previous.parentId === current.parentId && previous.position === current.position) return undefined;
    return nativeHardwareEvent(after, historyString(current.item.id), 'MOVE');
  };
}

function removeHistoryFactory(id: string): ActionHistoryFactory {
  return (before, after) => {
    const configurationId = historyConfigurationId(before, id);
    const previous = findHistoryPhysical(before, id) ?? findHistoryPhysical(before, configurationId);
    if (!previous) {
      // A freshly launched configuration can be closed before the website has
      // materialized its minimal non-rack envelope. Treat deletion of that raw
      // configuration as REMOVE, while a retained raw-only configuration is a
      // physical no-op (for example, an invalid detach target).
      return historyConfiguration(after, configurationId)
        ? undefined
        : nativeHardwareEvent(before, configurationId, 'REMOVE');
    }
    const previousId = historyString(previous.item.id);
    const retained = findHistoryPhysical(after, previousId);
    if (retained) return undefined;
    return nativeHardwareEvent(before, previousId, 'REMOVE');
  };
}

function networkChangeHistoryFactory(): ActionHistoryFactory {
  return (before, after) => {
    const prior = Array.isArray(before.serverState.networkTypes)
      ? before.serverState.networkTypes as Array<Record<string, unknown>> : [];
    const current = Array.isArray(after.serverState.networkTypes)
      ? after.serverState.networkTypes as Array<Record<string, unknown>> : [];
    const byId = new Map(prior.map(item => [historyString(item['id']), item]));
    const names = current.filter(item =>
      !isDeepStrictEqual(byId.get(historyString(item['id'])), item))
      .map(item => historyString(item['name'])).filter(Boolean);
    if (names.length === 0) return undefined;
    return { command: 'CHANGE', description: `Modified Data networks: ${names.map(name => `${name}, `).join('')}` };
  };
}

function storageChangeHistoryFactory(): ActionHistoryFactory {
  return (before, after) => {
    const prior = readStorageConnectionNetworks(before.serverState);
    const current = readStorageConnectionNetworks(after.serverState);
    if (isDeepStrictEqual(prior, current)) return undefined;
    const names = current.filter((network, index) => !isDeepStrictEqual(prior[index], network))
      .map(network => `${network.name}, `).join('');
    return { command: 'CHANGE', description: `Modified storage groups: ${names}` };
  };
}

function configurationControlsHistoryFactory(): ActionHistoryFactory {
  return (before, after) => {
    const previousAutoCorrect = [...before.configurations.values()].every(session => session.autoCorrect);
    const currentAutoCorrect = [...after.configurations.values()].every(session => session.autoCorrect);
    if (before.validationMode === after.validationMode && previousAutoCorrect === currentAutoCorrect) return undefined;
    return { command: 'CHANGE', description: 'Rule settings modified' };
  };
}

function floorCoordinate(workspace: WorkspaceSession, rackId: string): string | undefined {
  const floor = workspace.serverState.floorInformation as Record<string, unknown> | undefined;
  const grid = Array.isArray(floor?.['floorGrid']) ? floor.floorGrid as Array<Record<string, unknown>> : [];
  return historyString(grid.find(item => item['id'] === rackId)?.['coordinate']) || undefined;
}

function floorMoveHistoryFactory(rackId: string): ActionHistoryFactory {
  return (before, after) => {
    const previous = floorCoordinate(before, rackId);
    const current = floorCoordinate(after, rackId);
    if (!current || previous === current) return undefined;
    const event = nativeHardwareEvent(after, rackId, 'MOVE');
    // The floor-grid handler passes the former rack cell as the item and the
    // empty destination cell as the target. That source has no `code`, and the
    // target resolver falls through to its coordinate description (including
    // the native trailing space).
    return event ? { ...event, code: '', location: `${current} ` } : undefined;
  };
}

function rackLockHistoryFactory(
  target: { itemId: string } | { rackId: string; position: number },
  locked: boolean,
): ActionHistoryFactory {
  return (before, after) => {
    const item = 'itemId' in target ? findHistoryPhysical(before, target.itemId) : undefined;
    const acceptedItem = 'itemId' in target ? findHistoryPhysical(after, target.itemId) : undefined;
    if (item && acceptedItem && (item.item.lock === true) === (acceptedItem.item.lock === true)) return undefined;
    const rackId = item?.parentId ?? ('rackId' in target ? target.rackId : undefined);
    if (!rackId) return undefined;
    const rack = after.rackArea.find(value => value.id === rackId);
    if (!rack) return undefined;
    const position = item?.position ?? ('position' in target ? target.position : undefined);
    if (position === undefined) return undefined;
    if (!item) {
      const priorRack = before.rackArea.find(value => value.id === rackId);
      const hadLock = Array.isArray(priorRack?.lockedSpace) && priorRack.lockedSpace.includes(position);
      const hasLock = Array.isArray(rack.lockedSpace) && rack.lockedSpace.includes(position);
      if (hadLock === hasLock) return undefined;
    }
    const occupied = item
      ? `occupied by ${historyString(item.item.code)} ${historyString(item.item.description)}`
      : '';
    return {
      command: 'LOCK',
      description: `${locked ? 'Locked' : 'Unlocked'} position ${position} ${occupied}`,
      location: rackHistoryLocation(after, rack),
    };
  };
}

/** A part DCSC could not carry across an import, as it reports it. */
export interface ImportPart {
  productCode: string;
  description?: string;
  quantity?: number;
}

export interface ImportDiagnostics {
  /** Parts in the file that DCSC could not resolve at all. */
  missingParts: ImportPart[];
  /** Parts dropped because of rule changes or withdrawal. */
  removedParts: ImportPart[];
  /** Parts DCSC substituted for a successor. */
  replacedParts: ImportPart[];
  /** DCSC flagged one or more parts as export-controlled. Informational. */
  eccnRestricted: boolean;
  warnings?: string[];
}

/** Sizing for a cluster built by replicating one designed node. */
export interface ScaleOutPlan {
  nodeCode: string;
  nodeDescription: string;
  nodeSizeU: number;
  nodeWeightKg: number;
  rackCode: string;
  rackSizeU: number;
  nodes: number;
  /** How many DCSC actually accepted per cabinet, not the arithmetic maximum. */
  nodesPerRack: number;
  racksNeeded: number;
  totalListPrice: number;
  currency: string;
  priceScope: 'configured-nodes-only';
  excludedCosts: string[];
  lastRackNodes: number;
  fullestRackNodes: number;
  lastRackWeightKg: number;
  fullestRackWeightKg: number;
  totalWeightKg: number;
  powerPerNode?: PowerReport;
  clusterPower?: AggregatedPower;
  powerPerRack?: AggregatedPower;
  lastRackPower?: AggregatedPower;
}

export interface ImportResult {
  workspaceId: string;
  sessions: ConfigSession[];
  diagnostics: ImportDiagnostics;
  standaloneKind?: 'software' | 'service' | 'hardware';
}

/** The subset of /multiple/cfxml_import's response that we depend on. */
interface RawImportResponse extends Record<string, unknown> {
  configuration?: RawConfiguration[] | null;
  missingParts?: unknown;
  removedParts?: unknown;
  differentPartMap?: unknown;
  eccnRestricted?: boolean | null;
}

function toImportParts(value: unknown): ImportPart[] {
  if (!Array.isArray(value)) return [];
  const out: ImportPart[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const code = e['productCode'] ?? e['code'];
    if (typeof code !== 'string' || code === '') continue;
    const description = e['description'];
    const quantity = Number(e['quantity'] ?? e['productQuantity']);
    out.push({
      productCode: code,
      ...(typeof description === 'string' ? { description } : {}),
      ...(Number.isFinite(quantity) ? { quantity } : {}),
    });
  }
  return out;
}

/**
 * `differentPartMap` is keyed by configuration id and is the only place the
 * import reports substitutions, so replacements are gathered from there.
 */
function collectReplacedParts(value: unknown): ImportPart[] {
  if (typeof value !== 'object' || value === null) return [];
  const out: ImportPart[] = [];
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    out.push(...toImportParts((entry as Record<string, unknown>)['replacedParts']));
  }
  return out;
}

interface Cached<T> {
  value: T;
  at: number;
}

/**
 * Holds the pieces that outlive a single tool call: the HTTP client, the
 * long-TTL metadata caches, and the session store.
 */
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

export class DcscService {
  readonly http: DcscHttpClient;
  readonly sessions = new SessionStore();

  #modes: Cached<SolutionModeInfo[]> | undefined;
  #catalog = new Map<string, Cached<Catalog>>();
  #fabric = new Map<string, Cached<FabricOptions>>();
  #mipCatalog = new Map<string, Cached<unknown>>();
  #closing: Promise<void> | undefined;


  constructor(readonly config: Config) {
    this.http = new DcscHttpClient(config);
    const restored = loadSessions(this.sessions, config);
    this.sessions.setPersistenceWriter(createPersistenceWriter(config));
    if (restored > 0) {
      logger().info({ workspaces: restored }, 'Restored persisted workspaces');
    }
  }

  /** Compatibility for unmigrated mutations; transactions persist before publication. */
  persist(): void {
    saveSessions(this.sessions, this.config);
  }

  get locale(): Locale {
    return this.#localeOverride ?? this.config.locale;
  }

  #localeOverride: Locale | undefined;

  /** Overrides the process locale for subsequent newCtx/launch calls. */
  setLocale(locale: Locale): void {
    this.#localeOverride = locale;
  }

  /** A fresh request context with its own correlation id and request budget. */
  newCtx(overrides: { locale?: Locale; solution?: SolutionContext } = {}): RequestCtx {
    return {
      corrId: newCorrId(),
      locale: overrides.locale ?? this.locale,
      ...(overrides.solution !== undefined ? { solution: overrides.solution } : {}),
      budget: new RequestBudget(this.config.pacing.perToolRequestBudget),
    };
  }

  async solutionModes(ctx: RequestCtx): Promise<SolutionModeInfo[]> {
    if (this.#modes && Date.now() - this.#modes.at < SOLUTION_MODE_TTL_MS) {
      return this.#modes.value;
    }
    const value = await fetchSolutionModes(this.http, ctx);
    this.#modes = { value, at: Date.now() };
    return value;
  }

  /** Resolves the solution context, fetching modes if they are not cached. */
  async resolveSolution(ctx: RequestCtx, preferred?: string): Promise<SolutionContext> {
    const modes = await this.solutionModes(ctx);
    return toSolutionContext(modes, preferred);
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
  async modesContaining(ctx: RequestCtx, codes: string[]): Promise<Map<string, string[]>> {
    const wanted = new Set(codes.map((c) => c.toUpperCase()));
    const out = new Map<string, string[]>();
    for (const code of wanted) out.set(code, []);
    if (wanted.size === 0) return out;

    for (const info of await this.solutionModes(ctx)) {
      const solution = await this.resolveSolution(ctx, info.mode);
      const catalog = await this.catalog(ctx, solution);
      for (const entry of catalog.entries) {
        const code = entry.code.toUpperCase();
        if (wanted.has(code)) {
          const modes = out.get(code)!;
          if (!modes.includes(info.mode)) modes.push(info.mode);
        }
      }
    }
    return out;
  }

  async blueprintAvailability(ctx: RequestCtx) {
    const modes = await this.solutionModes(ctx);
    const catalogs = await Promise.all(modes.map(async info => {
      const solution = toSolutionContext(modes, info.mode);
      return { mode: info.mode, catalog: await this.catalog(ctx, solution) };
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

  async catalog(ctx: RequestCtx, solution: SolutionContext): Promise<Catalog> {
    const key = `${ctx.locale.country}|${ctx.locale.language}|${ctx.locale.currency}|${solution.solutionMode}`;
    const hit = this.#catalog.get(key);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.value;

    const value = await fetchCatalog(this.http, { ...ctx, solution });
    this.#catalog.set(key, { value, at: Date.now() });
    return value;
  }

  /**
   * Launches a configuration and opens a session within a workspace.
   */
  async launch(opts: LaunchOptions): Promise<ConfigSession> {
    const workspace = opts.workspaceId ? this.sessions.getWorkspace(opts.workspaceId) : undefined;
    if (opts.workspaceId && !workspace) throw new Error(`Workspace ${opts.workspaceId} not found`);
    if (opts.expectedRevision !== undefined && !workspace) throw new Error('expectedRevision requires an existing workspace.');
    if (workspace && opts.expectedRevision !== undefined && workspace.revision !== opts.expectedRevision) {
      throw new SessionConflictError(opts.expectedRevision, workspace.revision, 'workspace');
    }
    const prepared = await this.#prepareLaunch({ ...opts, ...(workspace ? { workspaceId: workspace.id } : {}) });
    const result = await this.sessions.createManyAtomic([prepared], {
      remoteApplied: true,
      actionHistory: addHistoryFactory(prepared.configurationId),
      ...(workspace ? { workspaceHandle: workspace.id, expectedRevision: opts.expectedRevision } : {}),
    });
    return result.sessions[0]!;
  }

  async #prepareLaunch(opts: LaunchOptions): Promise<CreateSessionInput> {
    const { productCode, mode, solution, ctx } = opts;
    const encoded = encodeURIComponent(productCode);

    const path =
      mode === 'lfo'
        ? `/lfos/${encoded}/as_lfo_launch`
        : mode === 'lfo-as-cto'
          ? `/lfos/${encoded}/as_cto_launch`
          : mode === 'lfo-add-options'
            ? `/lfos/${encoded}/add_options_launch`
            : `/ctos/${encoded}/launch`;

    const res = await this.http.send({
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
      const derived = await this.#autoDerive(reduced, {
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
          { productCode, mode, err: err instanceof Error ? err.message : String(err) },
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

  async #autoDerive(
    reduced: ReducedConfiguration,
    opts: {
      ctx: RequestCtx;
      solution: SolutionContext;
      mode: ConfigMode;
      validationMode: 'guided' | 'expert';
      autoCorrect?: boolean;
      softwareEdit?: boolean;
      sourceRaw?: RawConfiguration;
      workspace?: WorkspaceSession;
    },
  ): Promise<RawConfiguration | undefined> {
    const isLfo = !usesCtoWire(opts.mode);
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
    const res = await this.http.send({
      endpoint: isLfo ? 'lfo_autoDerive' : 'cto_autoDerive',
      method: 'POST',
      path: isLfo ? '/lfos/autoDerive' : '/ctos/autoDerive',
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
      this.#acceptDerivedWorkspaceConfigurations(opts.workspace, metadata);
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
  async configure(
    session: ConfigSession,
    changes: Array<{ section: string; code: string; quantity: number }>,
    ctx: RequestCtx,
    expectedRevision?: number,
  ): Promise<ConfigSession> {
    return this.sessions.transact(session.id, {
      expectedRevision,
      remoteApplied: true,
      actionHistory: updateHistoryFactory(session.configurationId),
    }, async (workspace, draft) => {
      if (!draft) throw new Error('A configuration handle is required.');
      return this.#configureDraft(draft, changes, ctx, workspace);
    });
  }

  async #prepareRackCustomizationDraft(workspace: WorkspaceSession, session: ConfigSession, ctx: RequestCtx): Promise<void> {
    const ready = Array.isArray(workspace.serverState.rackCustomizationReady)
      ? workspace.serverState.rackCustomizationReady as string[] : [];
    if (ready.includes(session.configurationId)) return;
    const plan = buildRackRecustomizePlan(workspace, session.configurationId);
    const response = await this.http.send({ ...plan, body: { kind: 'json', value: plan.body },
      responseKind: 'json', timeoutClass: 'heavy',
      ctx: { ...ctx, locale: workspace.locale, solution: workspace.solution } });
    const parsed = parseRackRecustomizeResult(response.raw, session.configurationId);
    if (Array.isArray(parsed.responseState.autoDerivedResults)) {
      workspace.serverState.autoDerivedResults = structuredClone(parsed.responseState.autoDerivedResults);
    }
    this.#acceptWorkspaceConfigurations(workspace, mergeDerivedConfigurations(
      [...workspace.configurations.values()].map(value => value.raw), { configurations: [parsed.configuration] }));
    workspace.serverState.rackCustomizationState = parsed.responseState;
    if (Array.isArray(parsed.responseState.autoDerivedResults)) {
      workspace.serverState.autoDerivedResults = structuredClone(parsed.responseState.autoDerivedResults);
    }
    workspace.serverState.rackCustomizationReady = [...ready, session.configurationId];
  }

  /** Operates only on a detached transaction draft; never acquires another lock. */
  async #configureDraft(
    session: ConfigSession,
    changes: Array<{ section: string; code: string; quantity: number }>,
    ctx: RequestCtx,
    workspace?: WorkspaceSession,
  ): Promise<ConfigSession> {
  const previousSelections = new Map(session.index.selected);
  if (workspace) await this.#prepareConfigIdsDraft(workspace, ctx);
  if (workspace) {
    const group = resolveLinkedCloneGroup(configurationCloneDependency(workspace),
      [...workspace.configurations.values()].map(value => value.configurationId), session.configurationId);
    if (group.linked) return this.#configureLinkedDraft(workspace, session, changes, ctx, group);
  }
  if (workspace && session.raw.type === 'rack' && usesCtoWire(session.mode) &&
      workspace.rackArea.some(rack => rack.id === session.configurationId)) {
    await this.#prepareRackCustomizationDraft(workspace, session, ctx);
  }
  // Client-held fabric fields: keep across autoDerive, but do not post them
  // in the derive body — DCSC rejects unknown/extra topology shapes (400).
  const preservedTopologies = session.reduced.selectedTopologies ?? {};
  const preservedRole = session.reduced.nodeRole ?? '';

  const { reduced: forDerive, softwareEdit } = prepareConfigurationChanges(session, changes);

  const updated = await this.#autoDerive(forDerive, {
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
    ...updated,
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
  session.index = buildIndex(session.raw);
  session.reduced = reduceConfiguration(session.raw, session.configurationId,
    hardwareModeFamily(session.mode), session.solution.solutionMode);
  if (workspace) await this.#prepareConfigIdsDraft(workspace, ctx);
  if (workspace) this.#refreshRackMetadata(workspace, true);
  if (workspace && (previousSelections.size !== session.index.selected.size ||
      [...previousSelections].some(([code, quantity]) => session.index.selected.get(code) !== quantity))) {
    invalidateConnectionGraph(workspace.serverState, 'Configuration selections changed. Regenerate connections before exporting or validating.');
  }
  if (workspace && managedStorageComponentIds(workspace.serverState).has(session.configurationId) &&
      [...storagePhysicalTemplateIds(workspace).values()].includes(session.configurationId)) {
    await this.#refreshStorageLayoutDraft(workspace, ctx);
  }
  session.intents.push({ at: Date.now(), changes });
  return session;
  }

  /** Fan out only the explicit updateConfigurationIds contract captured from GP Clone Multiple. */
  async #configureLinkedDraft(workspace: WorkspaceSession, initiating: ConfigSession,
    changes: Array<{ section: string; code: string; quantity: number }>, ctx: RequestCtx, group: LinkedCloneGroup): Promise<ConfigSession> {
    const members = group.memberIds.map(id => [...workspace.configurations.values()].find(value => value.configurationId === id)!);
    const editor = members.find(member => member.configurationId === group.rootId)!;
    if (workspace.solution.solutionMode !== 'General Purpose' || members.some(member =>
      !usesCtoWire(member.mode) || member.product.code !== initiating.product.code ||
      (member.raw.quantity ?? 1) !== 1 || member.validationMode !== initiating.validationMode || member.autoCorrect !== initiating.autoCorrect)) {
      throw new Error('Linked edits currently require matching General Purpose CTO configurations at quantity one with the same validation controls.');
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
    const response = await this.http.send({ endpoint: 'cto_autoDerive', method: 'POST', path: '/ctos/autoDerive',
      query: { configurationId: editor.configurationId, entranceFlag: 'customize',
        ...(softwareEdit ? { isCustomizeOSSoftware: true, isCustomizeNewSoftwareEngine: true }
          : { guideMode: initiating.validationMode === 'guided' }) },
      body: { kind: 'json', value: body }, responseKind: 'json', timeoutClass: 'heavy',
      ctx: { ...ctx, locale: workspace.locale, solution: workspace.solution } });
    const result = response.raw as { configurations?: RawConfiguration[]; autoDerivedResults?: unknown };
    const raw = result.configurations?.[0];
    if (!Array.isArray(result.configurations) || result.configurations.length !== 1 || !raw ||
      raw.id !== editor.configurationId || !Array.isArray(raw.tabs) || raw.type !== initiating.raw.type ||
      String(raw.code || raw.sliceCtoCode || '') !== initiating.product.code) {
      throw new Error('DCSC returned an unexpected linked-clone edit response. No linked configurations were committed.');
    }
    const projected = projectLinkedCloneResponse(raw, group);
    if (Array.isArray(result.autoDerivedResults)) workspace.serverState.autoDerivedResults = structuredClone(result.autoDerivedResults);
    this.#acceptWorkspaceConfigurations(workspace, projected);
    const editAt = Date.now();
    for (const member of members) {
      member.primed = true;
      member.intents.push({ at: editAt, changes: structuredClone(changes) });
    }
    if (changes.length > 0) {
      workspace.serverState.linkedConfigurationEdits = { ...histories,
        [group.rootId]: [...previousEdits, { at: editAt, members: beforeMembers }].slice(-10) };
    }
    await this.#prepareConfigIdsDraft(workspace, ctx);
    this.#refreshRackMetadata(workspace, true);
    buildGroups(workspace);
    invalidateConnectionGraph(workspace.serverState, 'Linked configuration selections changed.');
    return initiating;
  }

  assertTrustedWorkspace(handle: string): void {
    const workspace = this.sessions.getWorkspace(handle);
    if (!workspace) throw new Error(`Workspace for ${handle} not found.`);
    if (workspace.integrity !== 'verified' || hasUnrepairedRecoveryData(workspace)) {
      if (workspace.integrity === 'damaged' || hasUnrepairedRecoveryData(workspace)) {
        throw new Error(`Workspace ${workspace.id} has damaged or quarantined data. Export recovery records and repair or re-import complete CFXML before export or manufacturing validation. Configuration-only reconciliation cannot restore missing configurations or layout.`);
      }
      throw new Error(`Workspace ${workspace.id} is ${workspace.integrity}. Re-import a complete CFXML or use dcsc_reconcile_workspace to review and explicitly accept a current derive before export or manufacturing validation. Existing selections remain readable.`);
    }
  }

  async proposeReconciliation(handle: string, ctx: RequestCtx): Promise<ReconciliationProposal> {
    const live = this.sessions.getWorkspace(handle);
    if (!live) throw new Error(`Workspace for ${handle} not found.`);
    assertConfigurationReconciliationAllowed(live);
    const workspace = structuredClone(live);
    if (workspace.configurations.size === 0) throw new Error('Configuration reconciliation requires hardware. Re-import standalone state from CFXML.');
    const modes = new Set([...workspace.configurations.values()].map(session => hardwareEndpointFamily(session.mode)));
    if (modes.size !== 1) throw new Error('Reconcile CTO and LFO hardware in separate workspaces.');
    const sourceHash = canonicalWorkspaceHash(workspace);
    const result = await this.http.send({
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
    await this.sessions.recordReconciliationProposal(workspace.id, proposal, {
      remoteApplied: true,
      operation: 'reconciliation proposal',
      recoveryHint: 'The current derive succeeded but its proposal was not saved. Correct persistence and explicitly request a fresh proposal; no local design change was published.',
    });
    return proposal;
  }

  reconciliationProposal(handle: string, proposalId: string): ReconciliationProposal {
    const workspace = this.sessions.getWorkspace(handle);
    if (!workspace) throw new Error(`Workspace for ${handle} not found.`);
    const proposals = workspace.serverState[RECONCILIATION_PROPOSALS_STATE_KEY];
    const proposal = Array.isArray(proposals)
      ? (proposals as ReconciliationProposal[]).find(candidate => candidate.id === proposalId) : undefined;
    if (!proposal) throw new Error(`Reconciliation proposal ${proposalId} not found. Create a new proposal.`);
    return structuredClone(proposal);
  }

  async acceptReconciliation(handle: string, proposalId: string): Promise<{ workspace: string; revision: number; integrity: string }> {
    const proposal = this.reconciliationProposal(handle, proposalId);
    await this.sessions.transact(proposal.workspaceId, { expectedRevision: proposal.sourceRevision }, draft => {
      const reconciled = applyReconciliationProposal(draft, proposal, { proposalId, acceptedAt: Date.now() });
      Object.assign(draft, reconciled);
    });
    const workspace = this.sessions.getWorkspace(handle)!;
    return { workspace: workspace.id, revision: workspace.revision, integrity: workspace.integrity };
  }

  /** Website controls apply consistently to the complete workspace. */
  async setConfigurationControls(handle: string, opts: {
    validationMode?: 'guided' | 'expert' | undefined;
    autoCorrect?: boolean | undefined;
    expectedRevision?: number | undefined;
    ctx: RequestCtx;
  }): Promise<{ workspace: string; revision: number; validationMode: 'guided' | 'expert'; autoCorrect: boolean }> {
    const resolved = this.sessions.resolveHandle(handle);
    if (!resolved?.workspace) throw new Error(`Session or workspace ${handle} not found.`);
    const transaction = { expectedRevision: opts.expectedRevision, keepEmptyWorkspace: true, remoteApplied: false,
      actionHistory: configurationControlsHistoryFactory() };
    await this.sessions.transact(resolved.workspace.id, transaction, async (workspace) => {
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
        const group = resolveLinkedCloneGroup(configurationCloneDependency(workspace),
          [...workspace.configurations.values()].map(value => value.configurationId), session.configurationId);
        await this.#configureDraft(session, [], { ...opts.ctx, locale: workspace.locale }, workspace);
        transaction.remoteApplied = true;
        for (const id of group.memberIds) applied.add(id);
      }
      workspace.serverState.configurationControls = { validationMode: mode, autoCorrect };
    });
    const workspace = this.sessions.getWorkspace(resolved.workspace.id)!;
    const controls = workspace.serverState.configurationControls as { validationMode: 'guided' | 'expert'; autoCorrect: boolean };
    return { workspace: workspace.id, revision: workspace.revision, ...controls };
  }

  /**
   * Sets how many identical units of this configuration are wanted.
   */
  async setQuantity(session: ConfigSession, quantity: number, expectedRevision?: number): Promise<ConfigSession> {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error('Quantity must be an integer from 1 to 99.');
    return this.sessions.transact(session.id, { expectedRevision }, (workspace, draft) => {
      if (!draft) throw new Error('A configuration handle is required.');
      if (managedStorageComponentIds(workspace.serverState).has(draft.configurationId) && quantity !== 1) {
        throw new Error('Managed storage templates retain quantity one. Add or remove physical storage network placements to change installed quantities.');
      }
      const group = resolveLinkedCloneGroup(configurationCloneDependency(workspace),
        [...workspace.configurations.values()].map(value => value.configurationId), draft.configurationId);
      if (group.linked && quantity !== 1) {
        throw new Error('Linked physical clones each have quantity one. Use dcsc_clone_configuration with placement="same-rack" to add physical instances, or close an unwanted clone configuration.');
      }
      draft.raw.quantity = quantity;
      return draft;
    });
  }

  async undo(session: ConfigSession, expectedRevision?: number): Promise<boolean> {
    return this.sessions.transact(session.id, { history: 'restore', expectedRevision }, (workspace, draft) => {
      if (!draft) throw new Error('A configuration handle is required.');
      if ([...storagePhysicalTemplateIds(workspace).values()].includes(draft.configurationId)) {
        throw new Error('This storage configuration has physical instances. Use dcsc_workspace_history with action="undo" to restore its selections, physical instances, prices and connection graph together.');
      }
      const group = resolveLinkedCloneGroup(configurationCloneDependency(workspace),
        [...workspace.configurations.values()].map(value => value.configurationId), draft.configurationId);
      if (group.linked) {
        const histories = workspace.serverState.linkedConfigurationEdits as Record<string, unknown> | undefined;
        const entries = histories?.[group.rootId];
        const marker = Array.isArray(entries) ? entries.at(-1) as {
          at?: unknown; members?: Array<{ configurationId: string; revision: number; intentCount: number }>;
        } | undefined : undefined;
        const message = 'No matching atomic linked edit can be undone. Use dcsc_workspace_history to restore the complete workspace.';
        if (!Array.isArray(entries) || !marker || typeof marker.at !== 'number' || !Array.isArray(marker.members) ||
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
        this.#refreshRackMetadata(workspace, true);
        invalidateConnectionGraph(workspace.serverState, 'Linked configuration selections were undone.');
        return true;
      }
      const snapshot = draft.snapshots.pop();
      if (!snapshot) return false;
      draft.raw = structuredClone(snapshot.raw);
      draft.intents.pop();
      this.#refreshRackMetadata(workspace, true);
      invalidateConnectionGraph(workspace.serverState, 'Configuration selections were undone. Regenerate connections before exporting or validating.');
      return true;
    });
  }

  async closeSession(handle: string, expectedRevision?: number): Promise<boolean> {
    const resolved = this.sessions.resolveHandle(handle);
    if (!resolved?.workspace) return false;
    if (resolved.kind === 'workspace') return this.sessions.deleteWorkspace(resolved.workspace.id, expectedRevision);
    return this.sessions.transact(handle, { expectedRevision, actionHistory: removeHistoryFactory(handle) }, (workspace, target) => {
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

  /** Rack cabinets available in the workspace's solution mode. */
  async rackCabinets(ctx: RequestCtx, solution: SolutionContext, masterCode?: string,
    hardwareType: 'rack' | 'chassis' | 'node' = 'rack'): Promise<RackCabinet[]> {
    return fetchRackCabinets(this.http, { ...ctx, solution }, masterCode, hardwareType);
  }

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
  async scaleOut(opts: {
    sessionHandle: string;
    nodes: number;
    rackCode: string;
    ctx: RequestCtx;
  }): Promise<ScaleOutPlan> {
    if (!Number.isInteger(opts.nodes) || opts.nodes < 1 || opts.nodes > 10000) throw new Error('Node count must be an integer from 1 to 10000.');
    const resolved = this.sessions.resolveHandle(opts.sessionHandle);
    if (resolved?.kind === 'workspace' && resolved.workspace.configurations.size !== 1) {
      throw new Error('Choose a configuration session ID to size; this workspace has multiple possible node targets.');
    }
    const ws = resolved?.workspace;
    const node = resolved?.session;
    if (!ws || !node) throw new Error(`Session / Workspace ${opts.sessionHandle} not found`);

    const rctx = { ...opts.ctx, locale: ws.locale, solution: ws.solution };
    const envelopes = await fetchEnvelopes(this.http, rctx, [
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
      requestBudget: opts.ctx.budget?.remaining ?? this.config.pacing.perToolRequestBudget,
      maxProbeCount: 128,
      probe: async ({ requestedCount, positionForOrdinal }) => {
        const candidate = Array.from({ length: requestedCount }, (_, index) =>
          buildRackItem(nodeEnv, `${probeRackId}#${index}`, positionForOrdinal(index + 1)));
        const result = await customizeLayout(this.http, rctx,
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
          'Try a different rack cabinet from dcsc_list_racks.',
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
   * The fabric vocabulary: network topologies, node roles and storage switches.
   *
   * Cached for the same reason the catalog is — these lists change on Lenovo's
   * release cadence, not within a session.
   */
  async fabricOptions(ctx: RequestCtx, solution: SolutionContext): Promise<FabricOptions> {
    const key = `${ctx.locale.country}|${solution.solutionMode}`;
    const hit = this.#fabric.get(key);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.value;

    const value = await fetchFabricOptions(this.http, { ...ctx, solution });
    this.#fabric.set(key, { value, at: Date.now() });
    return value;
  }

  /**
   * Re-validates the workspace's layout and stores DCSC's corrected version.
   *
   * Every rack mutation funnels through here: DCSC may move items, reject
   * placements or push them out of the rack entirely, and its answer replaces
   * ours rather than merging with it.
   */
  async #syncLayout(
    ws: WorkspaceSession,
    rackArea: RackObject[],
    ctx: RequestCtx,
    opts: CustomizeOptions & { cloneMultiple?: boolean; copyConfigurationId?: string; lockMutation?: boolean;
      deletedLinkedRootConfigurations?: RawConfiguration[];
      nestedPhysicalEdit?: { configurations: RawConfiguration[]; cloneDependency: unknown } } = {},
  ): Promise<LayoutResult> {
    const requestContext = { ...ctx, locale: ws.locale, solution: ws.solution };
    const mode = workspaceHardwareMode(ws.configurations.values());
    ws.rackArea = rackArea;
    delete ws.serverState.rackCustomizationReady;
    const customize = async () => {
      const result = await customizeLayout(this.http, requestContext,
        buildRackCustomizePayload({ ...this.#networkState(ws),
          ...(opts.cloneMultiple || opts.copyConfigurationId || opts.deletedLinkedRootConfigurations
            ? { cloneDependency: {}, cloneDependencyColor: {} } : {}), rackArea: ws.rackArea,
          ...(opts.nestedPhysicalEdit ? { cloneDependency: opts.nestedPhysicalEdit.cloneDependency } : {}),
          nonRackArea: ws.nonRackArea }, opts.nestedPhysicalEdit?.configurations ??
          opts.deletedLinkedRootConfigurations ?? [...ws.configurations.values()].map((session) => session.raw)),
        { autoConnect: true, cogValidation: true, ...opts, mode });
      if (opts.cloneMultiple || opts.copyConfigurationId || opts.lockMutation || opts.deletedLinkedRootConfigurations || opts.nestedPhysicalEdit) {
        const state = result.rawState;
        if (!Array.isArray(state.rackArea) || !Array.isArray(state.nonRackArea) || !Array.isArray(state.connections)) {
          throw new Error('DCSC returned an incomplete physical layout. Workspace was not committed.');
        }
        if (result.errors.length || state.errors && (!Array.isArray(state.errors) || state.errors.length)) {
          throw new Error(`DCSC rejected the physical layout: ${JSON.stringify(state.errors ?? result.errors).slice(0, 1500)}`);
        }
        if (opts.nestedPhysicalEdit) assertAcceptedNestedEdit(ws, {
          rackArea: result.rawRackArea, nonRackArea: result.rawNonRackArea,
        });
      }
      return result;
    };
    const initial = await customize();
    ws.rackArea = initial.rawRackArea;
    ws.nonRackArea = initial.rawNonRackArea;
    await this.#prepareConfigIdsDraft(ws, ctx);
    const hasStorageInstances = [...storagePhysicalTemplateIds(ws)].some(([id, template]) => id !== template);
    // LFO import/layout only customizes the layout. The website derives LFO
    // options when the user enters configuration editing, not during import.
    if (ws.configurations.size > 0 && mode === 'cto') {
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
    if (hasStorageInstances || opts.nestedPhysicalEdit) delete body.customizingIds;
    const derived = await this.http.send({
      endpoint: 'workspace_autoDerive', method: 'POST', path: '/ctos/autoDerive',
      query: { ...(hasStorageInstances || opts.nestedPhysicalEdit ? {} : {
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
    this.#acceptDerivedWorkspaceConfigurations(ws, response);
    }
    const result = mode === 'lfo' || opts.copyConfigurationId || opts.lockMutation || hasStorageInstances || opts.deletedLinkedRootConfigurations || opts.nestedPhysicalEdit ? initial : await customize();
    ws.rackArea = result.rawRackArea;
    ws.nonRackArea = result.rawNonRackArea;
    await this.#prepareConfigIdsDraft(ws, ctx);
    this.#refreshRackMetadata(ws);
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

  #networkState(ws: WorkspaceSession): Record<string, unknown> {
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

  /**
   * Adds a rack cabinet and returns DCSC's validated layout.
   *
   * A rack is a configurable product in its own right, not just a container:
   * it is launched as a configuration in the workspace so that it carries its
   * own price, PDUs and rails. Exports reference racks by configuration id, and
   * a rackArea entry pointing at an id with no matching configuration makes the
   * export endpoint fail with "Index 0 out of bounds for length 0".
   */
  async addRack(sessionHandle: string, rackCode: string, ctx: RequestCtx, expectedRevision?: number): Promise<LayoutResult> {
    const ws = this.sessions.getWorkspace(sessionHandle);
    if (!ws) throw new Error(`Session / Workspace ${sessionHandle} not found`);
    // Avoid unnecessary launch requests on an already-stale call. Atomic creation
    // checks again under the workspace lock after remote preparation.
    if (expectedRevision !== undefined && ws.revision !== expectedRevision) {
      throw new SessionConflictError(expectedRevision, ws.revision, 'workspace');
    }

    const prepared = await this.#prepareLaunch({
      productCode: rackCode,
      mode: 'cto',
      solution: ws.solution,
      ctx,
      workspaceId: ws.id,
    });

    const envelopes = await fetchEnvelopes(
      this.http,
      { ...ctx, locale: ws.locale, solution: ws.solution },
      [{ code: rackCode, type: 'rack' }],
    );
    const envelope = envelopes.get(rackCode.toUpperCase());
    if (!envelope) {
      throw new Error(
        `DCSC returned no physical data for rack ${rackCode}. Use dcsc_list_racks for valid codes.`,
      );
    }

    let result: LayoutResult | undefined;
    await this.sessions.createManyAtomic([prepared], {
      remoteApplied: true,
      actionHistory: addHistoryFactory(prepared.configurationId),
      workspaceHandle: ws.id, expectedRevision,
      prepare: async (draft, created) => {
        const rackSession = created[0]!;
        const next = [...draft.rackArea, buildRackObject(envelope, rackSession.configurationId)];
        result = await this.#syncLayout(draft, next, ctx);
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
  async placeInRack(
    sessionHandle: string,
    opts: { rackId: string; sessionId: string; chassisId?: string | undefined; position?: number | undefined; expectedRevision?: number | undefined; ctx: RequestCtx },
  ): Promise<LayoutResult & { nestedPlacement?: NestedNodePlacement & { session: string } }> {
    if (opts.chassisId !== undefined) return this.#copyNodeIntoChassis(sessionHandle, { ...opts, chassisId: opts.chassisId });
    return this.sessions.transact(this.#workspaceId(sessionHandle), {
      expectedRevision: opts.expectedRevision,
      remoteApplied: true,
      actionHistory: moveHistoryFactory(opts.sessionId),
    }, async (ws) => {
    const aliasTemplateId = storagePhysicalTemplateIds(ws).get(opts.sessionId);
    const target = ws.configurations.get(opts.sessionId) ?? [...ws.configurations.values()].find((session) =>
      session.configurationId === (aliasTemplateId ?? opts.sessionId));
    if (!target) throw new Error(`Configuration or physical item ${opts.sessionId} does not belong to this workspace.`);
    if (!aliasTemplateId && managedStorageComponentIds(ws.serverState).has(target.configurationId)) {
      throw new Error('Use dcsc_place_storage_network to instantiate a managed storage template. To move an existing instance, pass its physical ID from dcsc_workspace_layout.');
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
      this.http,
      { ...opts.ctx, locale: ws.locale, solution: ws.solution },
      [buildEnvelopeRequest(target.raw)],
    );
    const envelope = envelopes.get(productCode.toUpperCase());
    if (!envelope) {
      throw new Error(`DCSC returned no physical data for ${productCode}.`);
    }

    const rackIndex = ws.rackArea.findIndex((r) => String(r['id']) === opts.rackId);
    if (rackIndex < 0) {
      throw new Error(`Rack ${opts.rackId} not found in this workspace. Add one with dcsc_add_rack.`);
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

    const result = await this.#syncLayout(ws, next, opts.ctx, {
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
  async #copyNodeIntoChassis(handle: string, opts: {
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
    return this.sessions.transact(this.#workspaceId(handle), transaction, async workspace => {
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
        const envelopes = await fetchEnvelopes(this.http, context, [request]);
        const envelope = envelopes.get(request.code.toUpperCase());
        if (!envelope || envelope.type !== 'node') throw new Error('DCSC returned no node physical metadata for the source configuration.');
        // Fresh launches have no physical layout entry yet. Retain the native
        // envelope (including bay size and quantity) and project selected parts
        // before cloning it under an identity absent from the configuration list.
        nonRackArea = buildRackCustomizePayload({ ...this.#networkState(workspace),
          rackArea: workspace.rackArea,
          nonRackArea: [...nonRackArea, { ...structuredClone(envelope.raw), id: source.configurationId }],
        }, [...workspace.configurations.values()].map(session => session.raw)).nonRackArea;
      }
      const configurationId = newConfigurationId(workspace.locale.country);
      copiedConfigurationId = configurationId;
      const staged = stageConfiguredNodeCopy({ rackArea: workspace.rackArea, nonRackArea,
        chassisId: opts.chassisId, sourceNodeId: source.configurationId, copyId: configurationId });
      if (staged.placement.rackId !== opts.rackId) throw new Error('The selected chassis does not belong to the requested rack.');
      const chassisGroup = resolveLinkedCloneGroup(configurationCloneDependency(workspace),
        [...workspace.configurations.values()].map(session => session.configurationId), opts.chassisId);
      if (chassisGroup.linked) throw new Error('DCSC does not allow Add Node into a linked cloned chassis.');
      const rack = workspace.rackArea.find(item => item.id === opts.rackId)!;
      const chassis = (rack.rackItems as RackObject[]).find(item => item.id === opts.chassisId)!;
      for (const [parent, child, type] of [[rack, chassis, 'chassis'],
        [chassis, { code: source.reduced.sliceCtoCode }, 'node']] as const) {
        const compatible = await this.rackCabinets(context, workspace.solution, String(parent.code), type);
        if (!compatible.some(item => item.code.toUpperCase() === String(child.code).toUpperCase())) {
          throw new Error(`DCSC does not list ${String(child.code)} as compatible with ${String(parent.code)}. ` +
            `Use dcsc_list_racks with productCode="${String(parent.code)}" and hardwareType="${type}" for supported products.`);
        }
      }
      transaction.remoteApplied = true;
      const result = await customizeLayout(this.http, context,
        buildRackCustomizePayload({ ...this.#networkState(workspace), rackArea: staged.rackArea,
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
        ...this.#networkState(workspace).cloneDependency as Record<string, string[]>, [configurationId]: [configurationId],
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

  /** Reconcile physical edits using the sequence captured for the affected shape. */
  async editLayout(handle: string, opts: {
    action: 'unplace' | 'remove' | 'detach' | 'arrange';
    configurationId?: string | undefined;
    contents?: 'unplace' | 'delete' | undefined;
    expectedRevision?: number | undefined;
    ctx: RequestCtx;
  }): Promise<LayoutResult> {
    const workspace = this.sessions.getWorkspace(handle);
    if (!workspace) throw new Error(`Workspace ${handle} not found.`);
    return this.sessions.transact(workspace.id, {
      expectedRevision: opts.expectedRevision,
      keepEmptyWorkspace: true,
      remoteApplied: true,
      ...(opts.configurationId && opts.action !== 'arrange'
        ? { actionHistory: opts.action === 'unplace'
            ? moveHistoryFactory(opts.configurationId)
            : removeHistoryFactory(opts.configurationId) }
        : {}),
    }, async (draft) => {
      let deletedLinkedRootConfigurations: RawConfiguration[] | undefined;
      let nestedPhysicalEdit: { configurations: RawConfiguration[]; cloneDependency: unknown } | undefined;
      if (opts.action !== 'arrange') {
        const storageAliases = storagePhysicalTemplateIds(draft);
        const mappedTemplate = opts.configurationId ? storageAliases.get(opts.configurationId) : undefined;
        const aliasTemplate = mappedTemplate !== opts.configurationId ? mappedTemplate : undefined;
        const target = [...draft.configurations.values()].find((session) =>
          session.id === opts.configurationId || session.configurationId === (aliasTemplate ?? opts.configurationId));
        if (!target) throw new Error('Choose a configuration belonging to this workspace.');
        if (opts.action === 'remove' && !aliasTemplate) {
          const group = resolveLinkedCloneGroup(configurationCloneDependency(draft),
            [...draft.configurations.values()].map(session => session.configurationId), target.configurationId);
          if (group.linked && group.rootId === target.configurationId) {
            deletedLinkedRootConfigurations = [...draft.configurations.values()].map(session => structuredClone(session.raw));
          }
        }
        const managed = managedStorageComponentIds(draft.serverState).has(target.configurationId);
        if (managed && !aliasTemplate && opts.action === 'remove') {
          throw new Error('Remove a storage definition with dcsc_edit_storage_network, or pass a physical instance ID to remove only that placement.');
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
          return this.#syncLayout(draft, draft.rackArea, opts.ctx, { autoArrange: true });
        }
        const id = aliasTemplate ? opts.configurationId! : target.configurationId;
        const isNestedNode = (items: RackObject[]): boolean => items.some(item =>
          item.type === 'chassis' && Array.isArray(item.nodes) &&
            (item.nodes as RackObject[]).some(node => node.id === id) ||
          Array.isArray(item.rackItems) && isNestedNode(item.rackItems as RackObject[]));
        const nestedNode = isNestedNode([...draft.rackArea, ...draft.nonRackArea]);
        if (opts.action === 'detach' && !nestedNode) {
          throw new Error('Detach matches DCSC Delete Node and requires a node inside a chassis. Use unplace to retain a loose physical item, or remove to delete its configuration.');
        }
        if (opts.action === 'detach') {
          const group = resolveLinkedCloneGroup(configurationCloneDependency(draft),
            [...draft.configurations.values()].map(session => session.configurationId), id);
          if (group.linked) throw new Error('Detach of a linked nested node is not yet verified. Use unplace to preserve its physical and clone identities.');
        }
        if (nestedNode && (opts.action === 'detach' || opts.action === 'unplace')) {
          nestedPhysicalEdit = { configurations: [...draft.configurations.values()].map(session => structuredClone(session.raw)),
            cloneDependency: structuredClone(this.#networkState(draft).cloneDependency) };
        }
        const physical = detachPhysicalItem(draft, id);
        if (physical?.lock === true) throw new Error('The item is locked. Unlock it before editing its placement.');
        if (opts.action === 'detach') {
          const marked = draft.serverState.detachedNestedNodeIds;
          draft.serverState.detachedNestedNodeIds = [...new Set([
            ...(Array.isArray(marked) ? marked.filter(id => typeof id === 'string') : []), id,
          ])];
          const dependency = structuredClone(this.#networkState(draft).cloneDependency) as Record<string, unknown>;
          delete dependency[id];
          draft.serverState.cloneDependency = dependency;
          const colors = draft.serverState.cloneDependencyColor as Record<string, unknown> | undefined;
          if (colors) delete colors[id];
        }
        if (opts.action === 'unplace') {
          if (!physical) throw new Error('This configuration has no physical placement to move.');
          if (physical.type === 'rack') throw new Error('Use remove with contents="unplace" to remove a rack and retain its products.');
          draft.nonRackArea.push(physical);
        } else if (opts.action !== 'detach') {
          const removed = new Set([id]);
          if (physical?.type === 'chassis') {
            nestedPhysicalEdit = { configurations: [...draft.configurations.values()].map(session => structuredClone(session.raw)),
              cloneDependency: structuredClone(this.#networkState(draft).cloneDependency) };
          }
          if (physical?.type === 'rack' || physical?.type === 'chassis') {
            const childrenField = physical.type === 'rack' ? physical.rackItems : physical.nodes;
            const children = Array.isArray(childrenField) ? childrenField as RackObject[] : [];
            if (opts.contents === 'delete') {
              for (const childId of physicalIds(physical)) removed.add(childId);
            } else draft.nonRackArea.push(...children);
          }
          for (const [sessionId, session] of draft.configurations) {
            if (removed.has(session.configurationId)) draft.configurations.delete(sessionId);
          }
          removeWorkspaceReferences(draft, removed);
        }
      }
      const expectedNestedLayout = nestedPhysicalEdit
        ? structuredClone({ rackArea: draft.rackArea, nonRackArea: draft.nonRackArea }) : undefined;
      const result = await this.#syncLayout(draft, draft.rackArea, opts.ctx, { autoArrange: opts.action === 'arrange' || nestedPhysicalEdit !== undefined,
        ...(nestedPhysicalEdit ? { nestedPhysicalEdit } : {}),
        ...(deletedLinkedRootConfigurations ? { deletedLinkedRootConfigurations } : {}) });
      if (expectedNestedLayout) assertAcceptedNestedEdit(expectedNestedLayout, draft);
      return result;
    });
  }

  /**
   * Runs DCSC auto-connect and replaces the workspace cable list with the
   * server's connections. Manual port maps are not invented here.
   */
  async runAutoConnect(sessionHandle: string, ctx: RequestCtx, expectedRevision?: number,
    settings?: AutoConnectSettingsPatch): Promise<AutoConnectResult> {
    return this.sessions.transact(this.#workspaceId(sessionHandle), { expectedRevision, remoteApplied: true }, (workspace) => {
      if (settings !== undefined) {
        const merged = mergeAutoConnectSettings(this.#networkState(workspace).autoConnectSettings, settings);
        workspace.serverState.autoConnectSettings = merged;
        const networking = workspace.serverState.networkingInformation as Record<string, unknown> | undefined;
        workspace.serverState.networkingInformation = { ...networking, autoConnectSettings: structuredClone(merged) };
      }
      return this.#autoConnectDraft(workspace, ctx);
    });
  }

  #cablingPayload(ws: WorkspaceSession) {
    return buildRackCustomizePayload({
      ...this.#networkState(ws), rackArea: ws.rackArea, nonRackArea: ws.nonRackArea,
    }, [...ws.configurations.values()].map(session => session.raw));
  }

  async #deriveNetworkDraft(ws: WorkspaceSession, ctx: RequestCtx): Promise<void> {
    await this.#prepareConfigIdsDraft(ws, ctx);
    const body = buildAutoDeriveRequest(ws, { validationMode: ws.validationMode,
      autoCorrect: [...ws.configurations.values()].every(session => session.autoCorrect) });
    if ([...storagePhysicalTemplateIds(ws)].some(([id, template]) => id !== template)) delete body.customizingIds;
    const response = await this.http.send({ endpoint: 'workspace_autoDerive', method: 'POST',
      path: '/ctos/autoDerive', query: { guideMode: ws.validationMode === 'guided' },
      body: { kind: 'json', value: body }, responseKind: 'json', timeoutClass: 'heavy',
      ctx: { ...ctx, locale: ws.locale, solution: ws.solution } });
    const derived = response.raw as Record<string, unknown>;
    ws.serverState.workspaceDeriveState = structuredClone(derived);
    if (Array.isArray(derived.autoDerivedResults)) {
      ws.serverState.autoDerivedResults = structuredClone(derived.autoDerivedResults);
    }
    this.#acceptDerivedWorkspaceConfigurations(ws, response.raw);
  }

  async #refreshStorageLayoutDraft(ws: WorkspaceSession, ctx: RequestCtx): Promise<void> {
    await this.#provisionSwitchesDraft(ws, ctx, { deferLayout: true });
    const result = await customizeLayout(this.http, { ...ctx, locale: ws.locale, solution: ws.solution }, this.#cablingPayload(ws),
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

  async #provisionSwitchesDraft(ws: WorkspaceSession, ctx: RequestCtx, opts: { deferLayout?: boolean } = {}): Promise<void> {
    const request = buildSwitchCalculationRequest(this.#cablingPayload(ws));
    const context = { ...ctx, locale: ws.locale, solution: ws.solution };
    const response = await this.http.send({ endpoint: 'switch_calculation', method: 'POST',
      path: '/switch_calculation', query: { autoArrange: true, autoConnect: true, cogValidation: true },
      body: { kind: 'json', value: request }, responseKind: 'json', timeoutClass: 'heavy', ctx: context });
    const requirements = parseSwitchCalculationResponse(response.raw, request);
    if (requirements.length === 0) return;
    const switchMap = readSwitchMap(ws.serverState);
    const cloneDependency = structuredClone(this.#networkState(ws).cloneDependency) as Record<string, string[]>;
    const generatedIds = new Set<string>();
    for (const requirement of requirements) {
      for (let index = 0; index < requirement.quantity; index += 1) {
        const launched = await this.http.send({ endpoint: 'automatic_switch_launch', method: 'POST',
          path: `/ctos/${encodeURIComponent(requirement.option)}/launch`,
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
    const layout = await customizeLayout(this.http, context, this.#cablingPayload(ws),
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
    await this.#deriveNetworkDraft(ws, ctx);
  }

  async #autoConnectDraft(ws: WorkspaceSession, ctx: RequestCtx): Promise<AutoConnectResult> {
    const settings = readAutoConnectSettings(ws.serverState);
    const automaticSwitches = settings.autoAddSwitch === true && ws.solution.solutionMode === 'HPC and AI - Systems';
    if (automaticSwitches) await this.#provisionSwitchesDraft(ws, ctx);
    const floor = buildFloorState(ws);
    const result = await autoConnect(this.http, { ...ctx, locale: ws.locale, solution: ws.solution },
      this.#cablingPayload(ws), ws.solution.solutionMode === 'HPC and AI - Systems'
        ? { autoArrange: true, autoConnect: true, cogValidation: true } : undefined);
    if (!Array.isArray(result.rawState.connections) || result.rawState.errors && !Array.isArray(result.rawState.errors)) {
      throw new Error('DCSC returned an incomplete connection graph. Workspace was not committed.');
    }
    if (result.errors.length > 0) {
      throw new Error(`DCSC rejected auto-connect: ${JSON.stringify(result.errors).slice(0, 1500)}`);
    }
    ws.rackArea = result.rawRackArea;
    ws.nonRackArea = result.rawNonRackArea;
    ws.rackSummaries = summariseRackArea(result.rawRackArea);
    ws.cables = result.cables;
    ws.serverState.autoConnectState = structuredClone(result.rawState);
    ws.serverState.connections = structuredClone(result.rawConnections);
    ws.serverState.floorInformation = floor.information;
    const returnedConfigurations = result.rawState.configurations;
    if (Array.isArray(returnedConfigurations)) this.#acceptWorkspaceConfigurations(ws, returnedConfigurations);
    if (result.rawConnections.length > 0 && workspaceHardwareMode(ws.configurations.values()) === 'cto') {
      await this.#deriveNetworkDraft(ws, ctx);
    }
    delete ws.serverState.connectionGraphInvalidation;
    return result;
  }

  /** Adds the SPA-owned CONFIG_ID metadata; only detached drafts may be passed. */
  async #prepareConfigIdsDraft(ws: WorkspaceSession, ctx: RequestCtx): Promise<void> {
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
      const hit = this.#mipCatalog.get(key);
      if (hit && Date.now() - hit.at < CATALOG_TTL_MS) catalog = hit.value;
      else {
        const response = await this.http.send({ endpoint: 'rmp_mip', method: 'GET', path: '/rmp/mip',
          responseKind: 'json', timeoutClass: 'fast', ctx: context });
        catalog = response.raw;
        this.#mipCatalog.set(key, { at: Date.now(), value: catalog });
      }
      const placedIds = new Set([...ws.rackArea, ...ws.nonRackArea].flatMap(item => [...physicalIds(item)]));
      const managedControllers = managedStorageComponentIds(ws.serverState);
      const missing = eligible.filter(session => !placedIds.has(session.configurationId) && !managedControllers.has(session.configurationId));
      if (missing.length > 0) {
        const envelopes = await fetchEnvelopes(this.http, context, missing.map(session => buildEnvelopeRequest(session.raw)));
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

  #refreshRackMetadata(ws: WorkspaceSession, refreshFeatures = false): void {
    const sessions = new Map([...ws.configurations.values()].map(session => [session.configurationId, session]));
    if (refreshFeatures) {
      const physical = buildRackCustomizePayload({ ...this.#networkState(ws), rackArea: ws.rackArea,
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

  #acceptDerivedWorkspaceConfigurations(ws: WorkspaceSession, response: unknown): void {
    if (response && typeof response === 'object' && Array.isArray((response as Record<string, unknown>).configurations)) {
      const wrapper = response as Record<string, unknown>;
      response = { ...wrapper, configurations: (wrapper.configurations as RawConfiguration[])
        .map(configuration => configuration && typeof configuration === 'object' && !Array.isArray(configuration)
          ? withDerivedPlacements(configuration, wrapper) : configuration) };
    }
    const aliases = new Map([...storagePhysicalTemplateIds(ws)].filter(([id, template]) => id !== template));
    const current = [...ws.configurations.values()].map(session => session.raw);
    if (aliases.size === 0) {
      this.#acceptWorkspaceConfigurations(ws, mergeDerivedConfigurations(current, response));
      return;
    }
    const split = splitStoragePhysicalDerive(current, response, aliases);
    const updatedTemplates = new Set(split.configurations.map(configuration => configuration.id));
    const stored = ws.serverState.storagePhysicalConfigurations as Record<string, RawConfiguration> | undefined;
    const retained = Object.fromEntries(Object.entries(stored ?? {}).filter(([id]) =>
      aliases.has(id) && !updatedTemplates.has(aliases.get(id)!)));
    ws.serverState.storagePhysicalConfigurations = { ...retained, ...split.physicalConfigurations };
    this.#acceptWorkspaceConfigurations(ws, split.configurations);
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

  #acceptWorkspaceConfigurations(ws: WorkspaceSession, values: unknown[]): void {
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
      session.raw = { ...projectAutoDerivedSelections(raw, ws.serverState.autoDerivedResults).configuration,
        quantity: session.raw.quantity ?? 1,
        ...Object.fromEntries(['selectedStorageNetwork', 'selectedTopologies', 'nodeRole', 'name']
          .filter(key => Object.hasOwn(session.raw, key)).map(key => [key, structuredClone(session.raw[key])])),
      };
      session.index = buildIndex(session.raw);
      session.reduced = reduceConfiguration(session.raw, id, hardwareModeFamily(session.mode), ws.solution.solutionMode);
    }
    this.#refreshRackMetadata(ws);
  }

  /** Current physical endpoints and floor geometry for the website's existing-row editor. */
  #manualCablingInput(workspace: WorkspaceSession) {
    const floor = buildFloorState(workspace);
    return { connections: readConnectionGraph(workspace.serverState),
      configurations: [...workspace.configurations.values()].map(session => session.raw),
      rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
      floorItems: floor.items, floorPreference: floor.information.floorPreference as Record<string, unknown>,
      physicalTemplateIds: storagePhysicalTemplateIds(workspace),
      mode: workspaceHardwareMode(workspace.configurations.values()), solutionMode: workspace.solution.solutionMode };
  }

  inspectManualCabling(handle: string, expectedWorkspaceRevision?: number) {
    const workspace = this.sessions.getWorkspace(handle);
    if (!workspace) throw new Error('Workspace not found.');
    if (expectedWorkspaceRevision !== undefined && workspace.revision !== expectedWorkspaceRevision) {
      throw new SessionConflictError(expectedWorkspaceRevision, workspace.revision, 'workspace');
    }
    return { workspace: workspace.id, revision: workspace.revision,
      report: projectManualCabling(this.#manualCablingInput(workspace)) };
  }

  async editManualCabling(handle: string, edit: ManualConnectionEdit & { expectedRevision: number; ctx: RequestCtx }) {
    const workspace = this.sessions.getWorkspace(handle);
    if (!workspace) throw new Error('Workspace not found.');
    const transaction = { expectedRevision: edit.expectedRevision, remoteApplied: false };
    let configurationChange: { session: string; configurationId: string; previousTotalPrice: number | null;
      totalPrice: number | null; priceDelta: number | null; currency: string; priceScope: 'editable-configuration' } | undefined;
    const accepted = await this.sessions.transact(workspace.id, transaction, async draft => {
      assertCurrentConnectionGraph(draft.serverState);
      const input = this.#manualCablingInput(draft);
      let plan = stageManualConnectionEdit(input, edit);
      if (plan.distanceRequest) {
        const response = await this.http.send({ endpoint: 'manual_cabling_distance', method: 'POST', path: '/calculateDistance',
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
        draft.rackArea = replacement.rackArea;
        draft.nonRackArea = replacement.nonRackArea;
        const body = buildAutoDeriveRequest(draft, { validationMode: draft.validationMode,
          autoCorrect: [...draft.configurations.values()].every(session => session.autoCorrect) });
        body.configurations = (body.configurations as ReducedConfiguration[]).map(configuration =>
          configuration.id === replacement.configurationId ? replacement.reducedConfiguration : configuration);
        body.customizingIds = replacement.customizingIds;
        transaction.remoteApplied = true;
        const response = await this.http.send({ endpoint: 'manual_cabling_replacement', method: 'POST', path: '/ctos/autoDerive',
          query: { ...replacement.query, guideMode: draft.validationMode === 'guided' },
          body: { kind: 'json', value: body }, responseKind: 'json', timeoutClass: 'heavy',
          ctx: { ...edit.ctx, locale: draft.locale, solution: draft.solution } });
        const metadata = response.raw as Record<string, unknown>;
        if (Array.isArray(metadata.autoDerivedResults)) draft.serverState.autoDerivedResults = structuredClone(metadata.autoDerivedResults);
        this.#acceptDerivedWorkspaceConfigurations(draft, response.raw);
        const target = [...draft.configurations.values()].find(session => session.configurationId === replacement.configurationId);
        if (!target || (target.index.selected.get(replacement.newCode) ?? 0) !== replacement.targetQuantities.newCode ||
            (target.index.selected.get(replacement.oldCode) ?? 0) !== replacement.targetQuantities.oldCode) {
          throw new Error('DCSC did not accept the cable-part replacement. Workspace was not committed.');
        }
        const physical = applyAcceptedManualCablePhysicalState({ ...replacement,
          rackArea: draft.rackArea, nonRackArea: draft.nonRackArea }, target.raw, response.raw);
        draft.rackArea = physical.rackArea;
        draft.nonRackArea = physical.nonRackArea;
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
        ...(plan.collisionSwaps?.length ? {
          swappedConnections: plan.collisionSwaps.map(swap => projectManualConnection(swap.staged)),
        } : {}) };
    });
    return { workspace: workspace.id, revision: workspace.revision, ...accepted,
      ...(configurationChange ? { configurationChange } : {}) };
  }

  /** Local planning annotation; excluded from the authoritative export connection graph. */
  async addManualCabling(sessionHandle: string, cable: Omit<CableLink, 'id'>, expectedRevision?: number): Promise<CableLink> {
    return this.sessions.transact(this.#workspaceId(sessionHandle), { expectedRevision }, (workspace) => {
      const ids = new Set([...workspace.configurations.values()].map((session) => session.configurationId));
      if (!ids.has(cable.fromConfigId) || !ids.has(cable.toConfigId)) {
        throw new Error('Both cable endpoints must belong to this workspace. Use configuration IDs from dcsc_session_list.');
      }
      const link = { ...cable, id: `cable_${ulid().slice(-8).toLowerCase()}` };
      workspace.cables.push(link);
      return link;
    });
  }

  /** @deprecated Use runAutoConnect or addManualCabling. */
  addCabling(sessionHandle: string, cable: Omit<CableLink, 'id'>): Promise<CableLink> {
    return this.addManualCabling(sessionHandle, cable);
  }

  /**
   * Places a rack on the floor grid.
   *
   * Client-side only — see domain/floor.ts. Validates the rack exists in the
   * workspace and that the tile is free; does not invent DCSC validation.
   */
  async placeOnFloor(
    sessionHandle: string, rackId: string, x: number, y: number, expectedRevision?: number,
  ): Promise<FloorPlacementResult> {
    return this.sessions.transact(this.#workspaceId(sessionHandle), { expectedRevision,
      actionHistory: floorMoveHistoryFactory(rackId) }, (workspace) => {
      const result = placeRackOnFloor({ rackArea: workspace.rackArea, rackId, x, y,
        existing: workspace.floorItems, newId: `floor_${ulid().slice(-6).toLowerCase()}` });
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
  async setRackLock(handle: string, opts: {
    target: { itemId: string } | { rackId: string; position: number };
    locked: boolean; expectedRevision?: number | undefined; ctx: RequestCtx;
  }): Promise<{ rackId: string; itemId?: string; position: number; locked: boolean; layout: LayoutResult }> {
    const transaction = { expectedRevision: opts.expectedRevision, remoteApplied: false,
      actionHistory: rackLockHistoryFactory(opts.target, opts.locked) };
    return this.sessions.transact(this.#workspaceId(handle), transaction, async workspace => {
      const change = 'itemId' in opts.target
        ? stageRackItemLock(workspace.rackArea, opts.target.itemId, opts.locked)
        : stageRackSpaceLock(workspace.rackArea, opts.target.rackId, opts.target.position, opts.locked);
      transaction.remoteApplied = true;
      const layout = await this.#syncLayout(workspace, change.rackArea, opts.ctx,
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
  async copyRackItem(handle: string, opts: {
    expectedRevision?: number | undefined; ctx: RequestCtx;
  }): Promise<{ source: ConfigSession; copy: ConfigSession; placement: RackedClonePlacement }> {
    const resolved = this.sessions.resolveHandle(handle);
    if (resolved?.kind !== 'configuration') throw new Error('Copy requires an explicit configuration handle.');
    const transaction = { expectedRevision: opts.expectedRevision, remoteApplied: false,
      actionHistory: replicateHistoryFactory(resolved.session.configurationId, 'COPY', 1) };
    return this.sessions.transact(resolved.session.workspaceId, transaction, async workspace => {
      const source = workspace.configurations.get(resolved.session.id);
      if (!source) throw new Error('The source configuration no longer belongs to this workspace.');
      if (workspace.solution.solutionMode !== 'General Purpose' || source.mode !== 'cto' ||
          (source.raw.quantity ?? 1) !== 1 || managedStorageComponentIds(workspace.serverState).has(source.configurationId)) {
        throw new Error('Rack Copy currently requires an ordinary General Purpose CTO item with quantity one.');
      }
      const configurationId = newConfigurationId(workspace.locale.country);
      const staged = stageRackedCopy({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
        sourceId: source.configurationId, copyId: configurationId, cloneDependency: workspace.serverState.cloneDependency,
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
      const result = await this.#syncLayout(workspace, staged.rackArea, opts.ctx, {
        autoArrange: false, copyConfigurationId: configurationId,
      });
      const rack = result.racks.find(rack => rack.id === staged.placement.rackId);
      const item = rack?.items.find(item => item.id === configurationId);
      if (!rack || !item || result.errors.length) {
        throw new Error('DCSC did not retain the copied item in the source rack. Workspace was not committed.');
      }
      buildGroups(workspace);
      return { source, copy, placement: { configurationId, rackId: rack.id, position: item.position } };
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
  async cloneConfiguration(opts: {
    sessionHandle: string; count: number; labelPrefix?: string | undefined; expectedRevision?: number | undefined;
    placement?: 'none' | 'same-rack' | undefined; ctx?: RequestCtx | undefined;
  }): Promise<{ source: ConfigSession; clones: ConfigSession[]; placements?: RackedClonePlacement[] }> {
    if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > 99) throw new Error('Clone count must be an integer from 1 to 99.');
    const resolved = this.sessions.resolveHandle(opts.sessionHandle);
    if (resolved?.kind === 'workspace' && resolved.workspace.configurations.size !== 1) {
      throw new Error('Cloning requires one configuration target. Pass its configuration session ID.');
    }
    const original = resolved?.session;
    if (!original) throw new Error('Choose a configuration handle to clone.');
    const transaction = { expectedRevision: opts.expectedRevision, remoteApplied: false,
      actionHistory: replicateHistoryFactory(original.configurationId,
        opts.placement === 'same-rack' ? 'CLONE' : 'COPY', opts.count) };
    return this.sessions.transact(original.workspaceId, transaction, async (workspace) => {
      const source = workspace.configurations.get(original.id);
      if (!source) throw new Error('The source configuration no longer belongs to this workspace.');
      if (opts.placement === 'same-rack' && (!opts.ctx || !usesCtoWire(source.mode) ||
          (source.raw.quantity ?? 1) !== 1 || managedStorageComponentIds(workspace.serverState).has(source.configurationId))) {
        throw new Error('Physical Clone Multiple requires an ordinary CTO configuration with quantity one and a request context.');
      }
      const clones: ConfigSession[] = [];
      for (let i = 0; i < opts.count; i++) {
        const clone = structuredClone(source);
        const configurationId = newConfigurationId(source.locale.country);
        clone.id = `sess_${source.product.code}_${ulid().slice(-6).toLowerCase()}`;
        clone.configurationId = configurationId;
        clone.raw = cloneConfigurationRaw(source.raw, source.configurationId, configurationId);
        clone.revision = 1;
        clone.snapshots = [];
        clone.intents = [];
        clone.createdAt = Date.now();
        clone.label = opts.labelPrefix ? `${opts.labelPrefix} ${i + 2}` : `${source.label ?? source.product.description} (copy ${i + 1})`;
        clone.reduced = reduceConfiguration(clone.raw, configurationId, hardwareModeFamily(clone.mode), workspace.solution.solutionMode);
        workspace.configurations.set(clone.id, clone);
        clones.push(clone);
      }
      if (opts.placement === 'same-rack') {
        const staged = stageRackedCloneMultiple({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
          sourceId: source.configurationId, cloneIds: clones.map(clone => clone.configurationId),
          cloneDependency: workspace.serverState.cloneDependency });
        workspace.nonRackArea = staged.nonRackArea;
        workspace.serverState.cloneDependency = staged.cloneDependency;
        transaction.remoteApplied = true;
        const result = await this.#syncLayout(workspace, staged.rackArea, opts.ctx!, { autoArrange: false, cloneMultiple: true });
        const placements = clones.map(clone => {
          const rack = result.racks.find(rack => rack.items.some(item => item.id === clone.configurationId));
          const item = rack?.items.find(item => item.id === clone.configurationId);
          if (!rack || !item || rack.id !== staged.placements.find(placement => placement.configurationId === clone.configurationId)?.rackId) {
            throw new Error(`DCSC did not retain clone ${clone.configurationId} in the source rack. Workspace was not committed.`);
          }
          return { configurationId: clone.configurationId, rackId: rack.id, position: item.position };
        });
        if (result.errors.length) throw new Error(`DCSC rejected the cloned layout: ${JSON.stringify(result.errors).slice(0, 1500)}`);
        return { source, clones, placements };
      }
      return { source, clones };
    });
  }

  pduCatalog(sessionHandle: string, rackId: string): { catalog: PduCatalog; rackSession: ConfigSession } {
    const ws = this.sessions.getWorkspace(sessionHandle);
    if (!ws) throw new Error(`Session / Workspace ${sessionHandle} not found`);
    const rackSession = this.sessions.findByConfigurationId(ws.id, rackId);
    if (!rackSession) {
      throw new Error(
        `Rack ${rackId} has no configuration session. Racks from dcsc_add_rack are launched as configurations; ` +
          'pass the rackId returned by dcsc_add_rack / dcsc_workspace_layout.',
      );
    }
    const rackObject = ws.rackArea.find((r) => String(r['id']) === rackId);
    return {
      catalog: listPduCatalog({ index: rackSession.index, rackObject }),
      rackSession,
    };
  }

  /**
   * Selects a PDU / power cord on a rack via DCSC autoDerive.
   *
   * The accepted quantities and price come from the server response — we do
   * not store a local selection unless DCSC confirmed it.
   */
  async configurePdu(
    sessionHandle: string,
    rackId: string,
    opts: {
      expectedRevision?: number | undefined;
      pduCode?: string | undefined;
      cordCode?: string | undefined;
      quantity?: number | undefined;
      ctx: RequestCtx;
    },
  ): Promise<{
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
    return this.sessions.transact(this.#workspaceId(sessionHandle), {
      expectedRevision: opts.expectedRevision,
      remoteApplied: true,
      actionHistory: updateHistoryFactory(rackId),
    }, async (ws) => {
    const rackSession = [...ws.configurations.values()].find((candidate) => candidate.configurationId === rackId);
    if (!rackSession) {
      throw new Error(
        `Rack ${rackId} has no configuration session. Add the rack with dcsc_add_rack first.`,
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

    const updated = await this.#configureDraft(rackSession, changes, opts.ctx, ws);
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
            'Check min/max with dcsc_configure_pdu without a code, or dcsc_list_options on the rack session.',
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
                      .join('; ')}. Apply with dcsc_configure_pdu(cordCode).`
                  : 'No LINECORD options are on the rack tree — check dcsc_list_options(rackSession, tab: "Power").'),
            }),
      },
    };
    });
  }

  /**
   * Imports a CFXML through DCSC's own import endpoint.
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
  async importConfig(opts: {
    content: string;
    ctx: RequestCtx;
    mode?: ConfigMode;
    workspaceId?: string;
    fileName?: string;
    solutionMode?: string;
    expectedRevision?: number | undefined;
  }): Promise<ImportResult> {
    // Parsed locally only to recover the declared solution mode for the query
    // preamble, and to fail fast on a file that is not CFXML at all. Note that
    // DCSC stamps "General Purpose" into every export's Configuration Type
    // regardless of the mode it was built in, so this is a weak default.
    const existing = opts.workspaceId ? this.sessions.getWorkspace(opts.workspaceId) : undefined;
    if (opts.workspaceId && !existing) throw new Error(`Workspace ${opts.workspaceId} not found.`);
    const ctx = existing ? { ...opts.ctx, locale: existing.locale } : opts.ctx;
    const parsed = parseCfxml(opts.content);
    const solution = await this.resolveSolution(ctx, opts.solutionMode ?? existing?.solution.solutionMode ?? parsed.solutionMode);

    const res = await this.http.send({
      endpoint: 'cfxml_import',
      method: 'POST',
      path: '/multiple/cfxml_import',
      query: { entranceFlag: 'homePage', serviceCto: true, controlExpressModal: true },
      body: {
        kind: 'multipart',
        parts: [
          {
            name: 'cfxmlFile',
            filename: opts.fileName ?? 'configuration.xml',
            contentType: 'text/xml',
            content: opts.content,
          },
        ],
      },
      responseKind: 'json',
      timeoutClass: 'heavy',
      ctx: { ...ctx, solution },
    });

    // The endpoint answers with a single-element array in every case we have
    // observed, but tolerate a bare object.
    const importedPayload = (Array.isArray(res.raw) ? res.raw[0] : res.raw) as RawImportResponse | undefined;
    if (!importedPayload || typeof importedPayload !== 'object') {
      throw new Error('DCSC returned an unrecognised response to the CFXML import.');
    }
    const payload = expandImportedClones(importedPayload);

    const diagnostics: ImportDiagnostics = {
      missingParts: toImportParts(payload.missingParts),
      removedParts: toImportParts(payload.removedParts),
      replacedParts: collectReplacedParts(payload.differentPartMap),
      eccnRestricted: payload.eccnRestricted === true,
    };

    const standalone = parseStandaloneImportResponse(payload);
    if (standalone) diagnostics.warnings = standalone.diagnostics.warnings;
    const configurations = standalone?.kind === 'service' ? []
      : Array.isArray(payload.configuration) ? payload.configuration : [];

    if (configurations.length === 0 && !standalone) {
      const missing = diagnostics.missingParts.map((p) => p.productCode).join(', ');
      const others = (await this.solutionModes(opts.ctx))
        .map((m) => m.mode)
        .filter((m) => m !== solution.solutionMode);
      throw new Error(
        `DCSC rejected every product in this CFXML${missing ? ` (missing: ${missing})` : ''}. ` +
          `The import ran in solution mode "${solution.solutionMode}"; a model that is not in ` +
          'that mode\'s catalog is dropped even though the file itself is valid. ' +
          (others.length > 0
            ? `Retry with solutionMode set to one of: ${others.join(', ')}.`
            : 'Check that the model is available in this mode.'),
      );
    }

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
    const result = await this.sessions.createManyAtomic(inputs, {
      remoteApplied: true,
      workspaceHandle: opts.workspaceId,
      expectedRevision: opts.expectedRevision,
      workspaceContext: { locale: ctx.locale, solution },
      actionHistory: () => ({ command: 'IMPORT', fileName: opts.fileName ?? 'configuration.xml' }),
      prepare: async (workspace) => {
        if (standalone?.kind === 'service' && (workspace.configurations.size > 0 || workspace.serverState.standaloneSoftwareState)) {
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
        if (importedHardware) workspace.serverState.standaloneHardwareState = importedHardware;
        if (standalone && standalone.kind !== 'hardware') {
          const key = standalone.kind === 'software' ? 'standaloneSoftwareState' : 'standaloneServiceState';
          workspace.serverState[key] = standalone.state;
        }
        if (standalone) {
          workspace.integrityWarnings.push(...standalone.diagnostics.warnings);
        }
        await hydrateImportedLayout(this.http, { ...ctx, locale: workspace.locale, solution }, workspace, payload);
        if (workspace.rackArea.length > 0 || workspace.nonRackArea.length > 0) {
          await this.#syncLayout(workspace, workspace.rackArea, ctx);
        } else workspace.rackSummaries = summariseRackArea(workspace.rackArea);
      },
    });
    return { workspaceId: result.workspace.id, sessions: result.sessions, diagnostics,
      ...(standalone ? { standaloneKind: standalone.kind } : {}) };
  }

  /**
   * Validates a configuration against DCSC's LMC validation endpoint.
   *
   * The SPA posts the export payload to /lmc_validation and receives a
   * manufacturing handoff (build entity + deep link). Local expansionMessages
   * from autoDerive are merged in so callers still see rule text that is
   * already on the tree.
   */
  async validate(sessionHandle: string, ctx: RequestCtx, opts: { deadlineMs?: number | undefined } = {}): Promise<ValidationReport & {
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
      scope: 'configuration' | 'workspace';
      configurations: number;
      racksInSolution: number;
      racksValidated: number;
      covers: string;
    };
    warning?: string | undefined;
  }> {
    this.assertTrustedWorkspace(sessionHandle);
    const resolved = this.sessions.resolveHandle(sessionHandle);
    if (!resolved) throw new Error(`Session / Workspace ${sessionHandle} not found`);

    // Same scope rule as export: a configuration handle validates that
    // configuration, not everything sharing its workspace.
    const scope: 'configuration' | 'workspace' =
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
      : buildExportData({
          raw: session!.raw,
          config: reduceConfiguration(session!.raw, session!.configurationId,
            hardwareModeFamily(session!.mode), solution.solutionMode),
          solution, fileTypes: ['XML'], validationMode,
        });

    const messages = collectExpansionMessages(
      targets.map((s) => ({
        configurationId: s.configurationId,
        raw: s.raw as Record<string, unknown>,
      })),
    );

    // Grouped by configuration: a flat array repeats "Memory 32/32" once per
    // node with nothing to say which node, and hides the one row that matters.
    const headroom = targets.map((s) => {
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

    const racksInSolution = workspace?.rackArea.length ?? 0;
    const racksValidated = rackDataOmitted ? 0 : racksInSolution;
    const covers =
      scope === 'configuration'
        ? `One configuration (${session?.product.code ?? 'unknown'}). Other products in the workspace were not sent.`
        : racksInSolution === 0
          ? `${targets.length} configuration(s). No racks in this solution.`
          : racksValidated === 0
            ? `${targets.length} configuration(s) only. ${racksInSolution} rack(s) present but NOT validated — ` +
              'their layout, PDU sufficiency, weight and stability were not checked by DCSC.'
            : `${targets.length} configuration(s) and ${racksValidated} rack(s).`;
    const projection = {
      localDiagnostics: messages,
      headroom,
      rackDataOmitted,
      validatedScope: {
        scope,
        configurations: targets.length,
        racksInSolution,
        racksValidated,
        covers,
      },
    };

    const job = await runValidationJob(this.http,
      { ...ctx, locale: workspace?.locale ?? session!.locale, solution }, exportPayload, mode, {
        validatedRevision, target: { handle: sessionHandle, scope }, deadlineMs: opts.deadlineMs,
        onUpdate: (snapshot) => this.sessions.recordValidationJob(sessionHandle, {
          ...snapshot,
          projection: structuredClone(projection),
        }, {
          remoteApplied: snapshot.descriptors.length > 0, operation: 'validation',
          recoveryHint: 'The validation result was not saved. Correct persistence and request fresh validation; do not reuse the descriptor.',
        }),
      });
    const current = this.sessions.resolveHandle(sessionHandle);
    const currentWorkspace = scope === 'workspace' ? current?.workspace : undefined;
    const currentSession = current?.session;
    const currentRevision = currentWorkspace?.revision ?? currentSession?.revision ?? -1;
    let currentHash: string | undefined;
    if (currentWorkspace) {
      currentHash = validationPayloadSha256(buildExportData({ workspace: currentWorkspace, solution,
        fileTypes: ['XML'], validationMode: currentWorkspace.validationMode }), mode);
    } else if (currentSession) {
      currentHash = validationPayloadSha256(buildExportData({ raw: currentSession.raw,
        config: reduceConfiguration(currentSession.raw, currentSession.configurationId,
          hardwareModeFamily(currentSession.mode), solution.solutionMode),
        solution, fileTypes: ['XML'], validationMode: currentSession.validationMode }), mode);
    }
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
      validatedScope: {
        scope,
        configurations: targets.length,
        racksInSolution,
        racksValidated,
        covers,
      },
      ...(warning !== undefined ? { warning } : {}),
    };
  }

  /** Saved reports are inspectable without making another result request. */
  validationJobs(handle: string) {
    const workspace = this.sessions.getWorkspace(handle);
    if (!workspace) throw new Error(`Session / Workspace ${handle} not found`);
    return readValidationJobs(workspace.serverState).reverse().map(job => {
      const target = job.target && this.sessions.resolveHandle(job.target.handle);
      const sameWorkspace = target?.workspace?.id === workspace.id;
      let hash: string | undefined;
      let revision = -1;
      if (sameWorkspace && target?.kind === job.target?.scope) {
        try {
          if (target.kind === 'workspace') {
            revision = target.workspace.revision;
            hash = validationPayloadSha256(buildExportData({ workspace: target.workspace,
              solution: target.workspace.solution, fileTypes: ['XML'], validationMode: target.workspace.validationMode }), job.mode);
          } else {
            const session = target.session;
            revision = session.revision;
            hash = validationPayloadSha256(buildExportData({ raw: session.raw,
              config: reduceConfiguration(session.raw, session.configurationId,
                hardwareModeFamily(session.mode), session.solution.solutionMode),
              solution: session.solution, fileTypes: ['XML'], validationMode: session.validationMode }), job.mode);
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

  async listLocales(ctx: RequestCtx): Promise<LocaleOption[]> {
    return fetchLocales(this.http, ctx);
  }

  /**
   * Resolves a country (and optional language) against /locales into a Locale.
   * Does not mutate server config; callers pass the result into newCtx/launch.
   */
  async resolveLocale(
    ctx: RequestCtx,
    countryCode: string,
    languageCode?: string,
  ): Promise<Locale> {
    const locales = await this.listLocales(ctx);
    const match = locales.find(
      (l) => l.countryCode.toUpperCase() === countryCode.toUpperCase() && !l.countryInvalid,
    );
    if (!match) {
      const sample = locales
        .filter((l) => !l.countryInvalid)
        .slice(0, 12)
        .map((l) => l.countryCode)
        .join(', ');
      throw new Error(
        `Unknown or invalid country "${countryCode}". Examples: ${sample}${locales.length > 12 ? ', …' : ''}.`,
      );
    }
    return localeFromOption(match, languageCode);
  }

  async servicePortalCategories(ctx: RequestCtx, solution: SolutionContext): Promise<ServiceCategory | undefined> {
    return fetchServicePortalCategories(this.http, { ...ctx, solution });
  }

  /**
   * Applies a network topology shortName to a configuration and optionally
   * re-runs auto-connect so DCSC can recompute cabling for the fabric choice.
   */
  async applyTopology(opts: {
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
    const session = this.sessions.get(opts.sessionHandle);
    if (!session) throw new Error(`Session ${opts.sessionHandle} not found`);

    const fabric = await this.fabricOptions(opts.ctx, session.solution);
    const match = fabric.topologies.find(
      (t) => t.shortName.toLowerCase() === opts.topology.toLowerCase(),
    );
    if (!match) {
      throw new Error(
        `Unknown topology "${opts.topology}". Use dcsc_fabric_options for valid shortNames ` +
          `(e.g. ${fabric.topologies
            .slice(0, 8)
            .map((t) => t.shortName)
            .join(', ')}).`,
      );
    }

    const transaction = { expectedRevision: opts.expectedRevision, remoteApplied: false,
      actionHistory: updateHistoryFactory(session.configurationId) };
    return this.sessions.transact(session.id, transaction, async (workspace, draft) => {
      if (!draft) throw new Error('Choose a configuration handle for topology selection.');
      const selected = buildSelectedTopologies(draft.raw, { ...fabric,
        networkTypes: workspaceNetworkTypes(fabric, workspace.serverState) }, {
        topology: match.shortName, networkName: opts.networkName,
        connectorIds: opts.connectorIds, ports: opts.ports,
      });
      if (JSON.stringify(draft.raw.selectedTopologies ?? {}) !== JSON.stringify(selected)) {
        invalidateConnectionGraph(workspace.serverState, 'Network connector selections changed. Regenerate connections.');
      }
      draft.raw.selectedTopologies = selected;
      let connected: AutoConnectResult | undefined;
      if (opts.autoConnect !== false && (workspace.rackArea.length > 0 || workspace.nonRackArea.length > 0)) {
        transaction.remoteApplied = true;
        connected = await this.#autoConnectDraft(workspace, opts.ctx);
      }
      return { session: draft.id, topology: match.shortName, selectedTopologies: selected,
        ...(connected ? { autoConnect: connected } : {}) };
    });
  }

  /** The rack + Storage Network action installs physical instances of managed templates. */
  async placeStorageNetwork(handle: string, opts: {
    name: string; rackId: string; expectedRevision?: number | undefined; ctx: RequestCtx;
  }): Promise<{ workspace: string; revision: number; storageName: string;
    placements: AcceptedStoragePlacement[]; templates: Array<{ session: string; configurationId: string; created: boolean }> }> {
    const workspace = this.sessions.getWorkspace(handle);
    if (!workspace) throw new Error(`Workspace ${handle} not found.`);
    const transaction = { expectedRevision: opts.expectedRevision, remoteApplied: false };
    const result = await this.sessions.transact(workspace.id, transaction, async draft => {
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
      const networkState = this.#networkState(draft);
      if (readAutoConnectSettings(draft.serverState).autoAddPDU === true &&
          (!Array.isArray(networkState.powerPreference) || networkState.powerPreference.length === 0)) {
        throw new Error('Automated Rack PDU is enabled without a PDU preference. Set dcsc_add_cabling settings.autoAddPDU=false before placing storage, or configure a PDU preference.');
      }
      const components: StoragePlacementComponent[] = [];
      const templates: Array<{ session: string; configurationId: string; created: boolean }> = [];
      for (const role of ['controller', 'mainSwitch'] as const) {
        if (role === 'mainSwitch' && !selected.mainSwitch?.option) continue;
        const opened = await this.#ensureStorageComponentDraft(draft, opts, role, transaction);
        const session = draft.configurations.get(opened.session)!;
        components.push({ role, physicalId: newConfigurationId(draft.locale.country), configuration: session.raw });
        templates.push({ session: session.id, configurationId: session.configurationId, created: opened.created });
      }
      const staged = stageStorageNetworkPlacement({ rackArea: draft.rackArea, nonRackArea: draft.nonRackArea,
        storageConnectionNetworks: readStorageConnectionNetworks(draft.serverState),
        cloneDependency: this.#networkState(draft).cloneDependency, rackId: opts.rackId,
        networkName: opts.name, components });
      draft.rackArea = staged.rackArea;
      draft.nonRackArea = staged.nonRackArea;
      draft.serverState.cloneDependency = staged.cloneDependency;
      transaction.remoteApplied = true;
      const layout = await customizeLayout(this.http, { ...opts.ctx, locale: draft.locale, solution: draft.solution },
        this.#cablingPayload(draft), { autoArrange: true, autoConnect: true, cogValidation: true });
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

  async openStorageController(handle: string, opts: {
    name: string; expectedRevision?: number | undefined; ctx: RequestCtx;
  }) {
    const { componentId, ...result } = await this.#openStorageComponent(handle, opts, 'controller');
    return { ...result, controllerId: componentId };
  }

  async openStorageSwitch(handle: string, opts: {
    name: string; expectedRevision?: number | undefined; ctx: RequestCtx;
  }) {
    const { componentId, ...result } = await this.#openStorageComponent(handle, opts, 'mainSwitch');
    return { ...result, switchId: componentId };
  }

  /** Launch or reuse a managed template inside the caller's workspace transaction. */
  async #ensureStorageComponentDraft(draft: WorkspaceSession, opts: {
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
    const launched = await this.http.send({ endpoint: component === 'controller' ? 'storage_controller_launch' : 'storage_switch_launch', method: 'POST',
      path: `/ctos/${encodeURIComponent(option)}/launch`,
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
  async #openStorageComponent(handle: string, opts: {
    name: string; expectedRevision?: number | undefined; ctx: RequestCtx;
  }, component: 'controller' | 'mainSwitch'): Promise<{ workspace: string; revision: number; storageName: string;
    componentId: string; session: string; created: boolean }> {
    const label = component === 'controller' ? 'controller' : 'SAN switch';
    const workspace = this.sessions.getWorkspace(handle);
    if (!workspace) throw new Error(`Workspace ${handle} not found.`);
    const transaction = { expectedRevision: opts.expectedRevision, remoteApplied: false };
    const opened = await this.sessions.transact(workspace.id, transaction, async draft => {
      const opened = await this.#ensureStorageComponentDraft(draft, opts, component, transaction);
      if (!opened.created) return opened;
      const context = { ...opts.ctx, locale: draft.locale, solution: draft.solution };
      const layout = await customizeLayout(this.http, context, this.#cablingPayload(draft),
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
  async assignStorageNetwork(handle: string, opts: {
    networkName: string | null;
    expectedRevision?: number | undefined;
    autoConnect?: boolean | undefined;
    ctx: RequestCtx;
  }): Promise<{ workspace: string; session: string; configurationId: string; revision: number;
    configurationRevision: number; selectedStorageNetwork: string; autoConnectRequired: boolean;
    connectionCount?: number; connectionGraphStale: boolean }> {
    const resolved = this.sessions.resolveHandle(handle);
    if (resolved?.kind !== 'configuration') {
      throw new Error('Storage assignment requires a configuration handle from dcsc_session_list.');
    }
    const session = resolved.session;
    let connectionCount: number | undefined;
    await this.sessions.transact(session.id, { expectedRevision: opts.expectedRevision, remoteApplied: true,
      actionHistory: updateHistoryFactory(session.configurationId) }, async (workspace, draft) => {
      if (!draft) throw new Error('Storage assignment requires one configuration.');
      await this.#prepareConfigIdsDraft(workspace, opts.ctx);
      const request = buildStorageAssignmentRequest(workspace, draft.configurationId, opts.networkName);
      const response = await this.http.send({ ...request, body: { kind: 'json', value: request.body },
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
      this.#acceptDerivedWorkspaceConfigurations(workspace, response.raw);
      const assignments = workspace.serverState.selectedStorageNetwork;
      if (assignments && typeof assignments === 'object' && !Array.isArray(assignments)) {
        workspace.serverState.selectedStorageNetwork = { ...assignments,
          [draft.configurationId]: parsed.configuration.selectedStorageNetwork };
      }
      if (opts.autoConnect) connectionCount = (await this.#autoConnectDraft(workspace, opts.ctx)).connections.length;
    });
    const workspace = this.sessions.getWorkspace(session.id)!;
    return { workspace: workspace.id, session: session.id, configurationId: session.configurationId,
      revision: workspace.revision, configurationRevision: session.revision,
      selectedStorageNetwork: String(session.raw.selectedStorageNetwork ?? ''),
      autoConnectRequired: opts.autoConnect !== true,
      connectionGraphStale: workspace.serverState.connectionGraphInvalidation !== undefined,
      ...(connectionCount !== undefined ? { connectionCount } : {}) };
  }

  async addStorageNetwork(handle: string, opts: {
    input: Omit<StorageNetworkInput, 'controllerId'> & { controllerId?: string | undefined };
    expectedRevision?: number | undefined;
    ctx: RequestCtx;
  }): Promise<{ workspace: string; revision: number; storageNetworkCount: number }> {
    const workspace = this.sessions.getWorkspace(handle);
    if (!workspace) throw new Error(`Workspace ${handle} not found.`);
    let storageNetworkCount = 0;
    await this.sessions.transact(workspace.id, { expectedRevision: opts.expectedRevision,
      actionHistory: storageChangeHistoryFactory() }, async draft => {
      const fabric = await this.fabricOptions({ ...opts.ctx, locale: draft.locale }, draft.solution);
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

  async editStorageNetwork(handle: string, opts: {
    action: 'rename' | 'remove'; name: string; newName?: string | undefined;
    clearAssignments?: boolean | undefined; expectedRevision?: number | undefined;
  }): Promise<{ workspace: string; revision: number; storageNetworkCount: number; updatedAssignments: number; removedConfigurations: number }> {
    const workspace = this.sessions.getWorkspace(handle);
    if (!workspace) throw new Error(`Workspace ${handle} not found.`);
    let storageNetworkCount = 0;
    let updatedAssignments = 0;
    let removedConfigurations = 0;
    await this.sessions.transact(workspace.id, { expectedRevision: opts.expectedRevision,
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

  async reconfigureStorageNetwork(handle: string, opts: {
    name: string; changes: StorageNetworkChanges; expectedRevision: number;
    autoConnect?: boolean | undefined; ctx: RequestCtx;
  }): Promise<{ workspace: string; revision: number; storageNetworkCount: number;
    connectionGraphStale: boolean; autoConnectRequired: boolean; connectionCount?: number;
    retainedComponents: Array<Omit<DetachedStorageComponent, 'physicalIds'> & { physicalCount: number }> }> {
    const workspace = this.sessions.getWorkspace(handle);
    if (!workspace) throw new Error(`Workspace ${handle} not found.`);
    const transaction = { expectedRevision: opts.expectedRevision, remoteApplied: false,
      actionHistory: storageChangeHistoryFactory() };
    let connectionCount: number | undefined;
    let preferencesChanged = false;
    let retainedComponents: DetachedStorageComponent[] = [];
    await this.sessions.transact(workspace.id, transaction, async draft => {
      const fabric = await this.fabricOptions({ ...opts.ctx, locale: draft.locale }, draft.solution);
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
        await this.#refreshStorageLayoutDraft(draft, opts.ctx);
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

  async setNetworkPreferences(handle: string, opts: {
    selections: WorkspaceNetworkSelection[];
    expectedRevision?: number | undefined;
    autoConnect?: boolean | undefined;
    ctx: RequestCtx;
  }): Promise<{ workspace: string; revision: number; selections: unknown[]; connectionCount?: number;
    connectionGraphStale: boolean; autoConnectRequired: boolean }> {
    const workspace = this.sessions.getWorkspace(handle);
    if (!workspace) throw new Error(`Workspace ${handle} not found.`);
    let connectionCount: number | undefined;
    let preferencesChanged = false;
    const transaction = {
      expectedRevision: opts.expectedRevision,
      remoteApplied: false,
      actionHistory: (before: WorkspaceSession, after: WorkspaceSession) => preferencesChanged
        ? networkChangeHistoryFactory()(before, after) : undefined,
    };
    const selections = await this.sessions.transact(workspace.id, transaction, async (draft) => {
      const fabric = await this.fabricOptions({ ...opts.ctx, locale: draft.locale }, draft.solution);
      const previous = workspaceNetworkTypes(fabric, draft.serverState);
      const preferences = buildWorkspaceNetworkPreferences({ ...fabric,
        networkTypes: previous,
      }, opts.selections);
      const updates = new Map(preferences.networkTypes.map((network) => [network.id, network]));
      const networkTypes = previous.map((network) => updates.get(network.id) ?? network);
      for (const network of preferences.networkTypes) if (!previous.some((item) => item.id === network.id)) networkTypes.push(network);
      draft.serverState.networkTypes = structuredClone(networkTypes);
      const retainedCluster = this.#networkState(draft).clusterPreference;
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
        connectionCount = (await this.#autoConnectDraft(draft, opts.ctx)).connections.length;
      } else if (preferencesChanged && draft.rackArea.length > 0 &&
          draft.solution.solutionMode === 'HPC and AI - Systems' &&
          readAutoConnectSettings(draft.serverState).autoAddSwitch === true) {
        // Preferences Close provisions required switches even before the user
        // regenerates P2P cabling. Keep the previous graph explicitly stale.
        transaction.remoteApplied = true;
        await this.#provisionSwitchesDraft(draft, opts.ctx);
      }
      return preferences.selections;
    });
    return { workspace: workspace.id, revision: workspace.revision, selections,
      connectionGraphStale: workspace.serverState.connectionGraphInvalidation !== undefined,
      autoConnectRequired: workspace.serverState.connectionGraphInvalidation !== undefined ||
        preferencesChanged && opts.autoConnect !== true,
      ...(connectionCount !== undefined ? { connectionCount } : {}) };
  }

  diffSessions(sessionHandleA: string, sessionHandleB: string) {
    const sA = this.sessions.get(sessionHandleA);
    const sB = this.sessions.get(sessionHandleB);
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
  async exportZip(
    sessionHandle: string,
    opts: {
      fileTypes: ExportFileType[];
      fileName: string;
      ctx: RequestCtx;
      scope?: 'auto' | 'configuration' | 'workspace' | undefined;
      /** Retained for compatibility; rack data is always included for workspace export. */
      attemptRackPayload?: boolean | undefined;
    },
  ): Promise<{
    stream: NodeJS.ReadableStream;
    contentDisposition: string | undefined;
    rackDataOmitted: boolean;
    scope: 'configuration' | 'workspace';
    configurationsExported: number;
    manualPlanningLinksOmitted: number;
  }> {
    this.assertTrustedWorkspace(sessionHandle);
    const resolved = this.sessions.resolveHandle(sessionHandle);
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
    const isLfo = scope === 'workspace'
      ? workspaceHardwareMode(workspace!.configurations.values()) === 'lfo'
      : !usesCtoWire(session!.mode);

    const hasRacks = (workspace?.rackArea.length ?? 0) > 0;
    const includeRacks = hasRacks;
    const useWorkspace = scope === 'workspace' && workspace !== undefined;

    const stripped = workspace;
    if (stripped) await this.#prepareConfigIdsDraft(stripped, opts.ctx);
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

    const res = await this.http.send({
      endpoint: isLfo ? 'lfo_export_zip' : 'cto_export_zip',
      method: 'POST',
      path: isLfo ? '/lfos/export_zip' : '/ctos/export_zip',
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
    };
  }

  /** Workspace-wide mutations compare the workspace revision even for configuration handles. */
  #workspaceId(handle: string): string {
    const workspace = this.sessions.getWorkspace(handle);
    if (!workspace) throw new Error(`Session / Workspace ${handle} not found`);
    return workspace.id;
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      await this.sessions.drain();
      await this.http.close();
      await this.sessions.drain();
    })();
    return this.#closing;
  }
}

function prepareConfigurationChanges(session: ConfigSession, changes: Array<{ section: string; code: string; quantity: number }>) {
  // Callers pass back whichever section identifier they were last shown —
  // our synthetic id, DCSC's internal name, or the display title. Only the
  // internal name matches the reduced model, so resolve here and refuse
  // outright when it cannot be resolved: an unresolved section produced a
  // request DCSC accepted and ignored, which is indistinguishable from
  // success at the tool boundary.
  let reduced = reduceConfiguration(session.raw, session.configurationId,
    hardwareModeFamily(session.mode), session.solution.solutionMode);
  const editKinds = new Set<string>();
  for (const change of changes) {
    const ref = resolveSection(session.index, change.section);
    if (!ref) {
      throw new Error(
        `Unknown section "${change.section}" for feature ${change.code}. ` +
          `Candidates: ${suggestSections(session.index, change.section).join('; ')}`,
      );
    }
    const tabType = session.raw.tabs?.find((tab) => tab.title === ref.tab)?.type;
    editKinds.add(tabType === 'software' ? 'software' : 'hardware');
    const known = session.index.byCode.get(change.code) ?? [];
    if (known.length > 0 && !known.some((f) => f.section === ref.id)) {
      const where = known.map((f) => f.section).join(', ');
      throw new Error(
        `Feature ${change.code} does not belong to section "${ref.title}" (${ref.id}). ` +
          `It lives in: ${where}.`,
      );
    }
    reduced = applyCatalogChange(reduced, session.raw, {
      sectionName: ref.name,
      code: change.code,
      quantity: change.quantity,
    });
  }

  if (editKinds.size > 1) throw new Error('Apply software edits separately from hardware/service edits so DCSC receives the correct editing context.');
  const reducedForDerive: ReducedConfiguration = {
    ...reduced,
    selectedTopologies: {},
    nodeRole: '',
  };

  return { reduced: reducedForDerive, softwareEdit: editKinds.has('software') };
}
