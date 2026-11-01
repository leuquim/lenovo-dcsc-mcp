import { isDeepStrictEqual } from 'node:util';

import type { ActionHistoryFactory, NativeHistoryInput } from '../domain/actionHistory.js';
import type { Catalog } from '../domain/catalog.js';
import { hardwareModeFamily } from '../domain/modeFamily.js';
import { pciWizardOptions } from '../domain/pciWizard.js';
import type { AggregatedPower, PowerReport } from '../domain/power.js';
import type { RackObject, RackSummary } from '../domain/rack.js';
import {
  applyCatalogChange,
  reduceConfiguration,
  type ReducedConfiguration,
} from '../domain/reduce.js';
import { resolveLinkedCloneGroup } from '../domain/linkedCloneEdit.js';
import { configurationCloneDependency, readStorageConnectionNetworks } from '../domain/storagePreferences.js';
import {
  clearStorageRaidSections,
  isStorageRaidModeChange,
  storageWizardSections,
} from '../domain/storageWizard.js';
import { buildIndex, resolveSection, suggestSections } from '../model/index.js';
import type { RawConfiguration } from '../model/types.js';
import type { ConfigSession, WorkspaceSession } from '../model/session.js';
import { SessionConflictError, type SessionStore } from '../session/SessionStore.js';
import type { SolutionContext } from '../config/schema.js';

/** Resolves a configuration handle that belongs to a workspace, or fails with the caller's message. */
export function requireConfiguration(
  sessions: SessionStore,
  handle: string,
  message: string,
): { session: ConfigSession; workspace: WorkspaceSession } {
  const resolved = sessions.resolveHandle(handle);
  if (resolved?.kind !== 'configuration' || !resolved.workspace) throw new Error(message);
  return { session: resolved.session, workspace: resolved.workspace };
}

export function assertWorkspaceRevision(workspace: WorkspaceSession, expected: number | undefined): void {
  if (expected !== undefined && expected !== workspace.revision) {
    throw new SessionConflictError(expected, workspace.revision, 'workspace');
  }
}

export function linkedGroup(workspace: WorkspaceSession, configurationId: string) {
  return resolveLinkedCloneGroup(
    configurationCloneDependency(workspace),
    [...workspace.configurations.values()].map((session) => session.configurationId),
    configurationId,
  );
}

export function linkedMembers(workspace: WorkspaceSession, group: { memberIds: readonly string[] }): ConfigSession[] {
  return [...workspace.configurations.values()].filter((session) => group.memberIds.includes(session.configurationId));
}

/** Recomputes the fields derived from `raw` after it was edited. */
export function rebuildDerived(session: ConfigSession, owner: { solution: SolutionContext }): void {
  session.index = buildIndex(session.raw);
  session.reduced = reduceConfiguration(
    session.raw,
    session.configurationId,
    hardwareModeFamily(session.mode),
    owner.solution.solutionMode,
  );
}

const CATALOG_CODE_INDEX = new WeakMap<Catalog, ReadonlySet<string>>();

/**
 * Returns a cached uppercased product-code set for a Catalog object so
 * `modesContaining` resolves membership in O(1) per requested code instead of
 * scanning all catalog entries on every call.
 */
export function catalogCodeSet(catalog: Catalog): ReadonlySet<string> {
  const existing = CATALOG_CODE_INDEX.get(catalog);
  if (existing) return existing;
  const set = new Set<string>();
  for (const entry of catalog.entries) {
    set.add(entry.code.toUpperCase());
  }
  CATALOG_CODE_INDEX.set(catalog, set);
  return set;
}

/** Reduces a raw rackArea the same way customizeLayout does, without a round trip. */
export function summariseRackArea(rackArea: RackObject[]): RackSummary[] {
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
  const grid = Array.isArray(floor?.['floorGrid']) ? (floor.floorGrid as Array<Record<string, unknown>>) : [];
  const coordinate =
    historyString(grid.find((item) => item['id'] === rack.id)?.['coordinate']) ||
    historyString((rack as Record<string, unknown>)['coordinate']);
  return [historyItemLabel(rack) || 'Rack', coordinate].filter(Boolean).join(' ');
}

function findNestedHistoryItem(
  items: RackObject[],
  id: string,
  parent: RackObject,
  location: string,
): HistoryPhysicalContext | undefined {
  for (const item of items) {
    if (item.id === id) {
      return {
        item,
        location,
        parentId: historyString(parent.id),
        position: typeof item.position === 'number' ? item.position : undefined,
      };
    }
    const children = [
      ...(Array.isArray(item.rackItems) ? (item.rackItems as RackObject[]) : []),
      ...(Array.isArray(item.nodes) ? (item.nodes as RackObject[]) : []),
    ];
    const nested = findNestedHistoryItem(children, id, item, historyItemLabel(item));
    if (nested) return nested;
  }
  return undefined;
}

function findHistoryPhysical(workspace: WorkspaceSession, id: string): HistoryPhysicalContext | undefined {
  for (const rack of workspace.rackArea) {
    if (rack.id === id) {
      return {
        item: rack,
        location: 'Rack Area',
        parentId: 'RACK_AREA',
        position: typeof rack.position === 'number' ? rack.position : undefined,
      };
    }
    const nested = findNestedHistoryItem(
      Array.isArray(rack.rackItems) ? (rack.rackItems as RackObject[]) : [],
      id,
      rack,
      rackHistoryLocation(workspace, rack),
    );
    if (nested) return nested;
  }
  for (const item of workspace.nonRackArea) {
    if (item.id === id) {
      return {
        item,
        location: 'Non Rack Area',
        parentId: 'NON_RACK_AREA',
        position: typeof item.position === 'number' ? item.position : undefined,
      };
    }
    const children = [
      ...(Array.isArray(item.rackItems) ? (item.rackItems as RackObject[]) : []),
      ...(Array.isArray(item.nodes) ? (item.nodes as RackObject[]) : []),
    ];
    const nested = findNestedHistoryItem(children, id, item, historyItemLabel(item));
    if (nested) return nested;
  }
  return undefined;
}

function historyConfiguration(workspace: WorkspaceSession, id: string): ConfigSession | undefined {
  return (
    workspace.configurations.get(id) ??
    [...workspace.configurations.values()].find((session) => session.configurationId === id)
  );
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
  const code =
    historyString(item?.code) ||
    historyString(item?.sliceCtoCode) ||
    historyString(raw?.sliceCtoCode) ||
    session?.product.code ||
    '';
  return {
    command,
    type,
    code,
    description: item ? historyString(item.description) : '',
    location: physical?.location ?? (type === 'rack' ? 'Rack Area' : 'Non Rack Area'),
    asVLH: item?.asVLH === true || raw?.asVLH === true,
  };
}

export function addHistoryFactory(configurationId: string): ActionHistoryFactory {
  return (_before, after) => nativeHardwareEvent(after, configurationId, 'ADD');
}

export function replicateHistoryFactory(
  sourceId: string,
  command: 'COPY' | 'CLONE' | 'UNCLONE',
  quantity: number,
  resultId?: string,
): ActionHistoryFactory {
  return (before, after) => {
    const canonicalSourceId = historyConfigurationId(before, sourceId);
    const event =
      nativeHardwareEvent(before, canonicalSourceId, command) ??
      nativeHardwareEvent(after, canonicalSourceId, command);
    if (!event) return undefined;
    const source =
      historyConfiguration(before, canonicalSourceId) ??
      historyConfiguration(after, canonicalSourceId);
    const description = event.description || historyString(source?.raw.description);
    const result = resultId ? findHistoryPhysical(after, resultId) : undefined;
    return { ...event, description, quantity, ...(result ? { location: result.location } : {}) };
  };
}

function selectedEntries(workspace: WorkspaceSession, id: string): unknown[] | undefined {
  const session = historyConfiguration(workspace, id);
  if (!session) return undefined;
  const selected = [...buildIndex(session.raw).selected].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const scoped = (session.raw.tabs ?? [])
    .flatMap((tab, tabIndex) =>
      (tab.subTabs ?? []).flatMap((subTab, subTabIndex) =>
        (subTab.sections ?? []).flatMap((section, sectionIndex) =>
          (section.results ?? []).map((result) => [
            tab.type ?? tab.title ?? tabIndex,
            subTab.title ?? subTabIndex,
            section.name ?? section.title ?? sectionIndex,
            result.code ?? '',
            result.ctoCode ?? '',
            result.quantity ?? 0,
          ]),
        ),
      ),
    )
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return [
    selected,
    scoped,
    session.raw.selectedTopologies ?? {},
    session.raw.selectedStorageNetwork ?? '',
  ];
}

export function updateHistoryFactory(configurationId: string): ActionHistoryFactory {
  return (before, after) => {
    const previous = selectedEntries(before, configurationId);
    const current = selectedEntries(after, configurationId);
    if (!previous || !current || isDeepStrictEqual(previous, current)) return undefined;
    return nativeHardwareEvent(after, configurationId, 'UPDATE');
  };
}

export function moveHistoryFactory(id: string): ActionHistoryFactory {
  return (before, after) => {
    const configurationId = historyConfigurationId(before, id);
    const previous =
      findHistoryPhysical(before, id) ?? findHistoryPhysical(before, configurationId);
    const current = findHistoryPhysical(after, id) ?? findHistoryPhysical(after, configurationId);
    if (!current) return undefined;
    if (
      previous &&
      previous.parentId === current.parentId &&
      previous.position === current.position
    )
      return undefined;
    return nativeHardwareEvent(after, historyString(current.item.id), 'MOVE');
  };
}

export function removeHistoryFactory(id: string): ActionHistoryFactory {
  return (before, after) => {
    const configurationId = historyConfigurationId(before, id);
    const previous =
      findHistoryPhysical(before, id) ?? findHistoryPhysical(before, configurationId);
    if (!previous) {
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

export function networkChangeHistoryFactory(): ActionHistoryFactory {
  return (before, after) => {
    const prior = Array.isArray(before.serverState.networkTypes)
      ? (before.serverState.networkTypes as Array<Record<string, unknown>>)
      : [];
    const current = Array.isArray(after.serverState.networkTypes)
      ? (after.serverState.networkTypes as Array<Record<string, unknown>>)
      : [];
    const byId = new Map(prior.map((item) => [historyString(item['id']), item]));
    const names = current
      .filter((item) => !isDeepStrictEqual(byId.get(historyString(item['id'])), item))
      .map((item) => historyString(item['name']))
      .filter(Boolean);
    if (names.length === 0) return undefined;
    return {
      command: 'CHANGE',
      description: `Modified Data networks: ${names.map((name) => `${name}, `).join('')}`,
    };
  };
}

export function storageChangeHistoryFactory(): ActionHistoryFactory {
  return (before, after) => {
    const prior = readStorageConnectionNetworks(before.serverState);
    const current = readStorageConnectionNetworks(after.serverState);
    if (isDeepStrictEqual(prior, current)) return undefined;
    const names = current
      .filter((network, index) => !isDeepStrictEqual(prior[index], network))
      .map((network) => `${network.name}, `)
      .join('');
    return { command: 'CHANGE', description: `Modified storage groups: ${names}` };
  };
}

export function configurationControlsHistoryFactory(): ActionHistoryFactory {
  return (before, after) => {
    const previousAutoCorrect = [...before.configurations.values()].every(
      (session) => session.autoCorrect,
    );
    const currentAutoCorrect = [...after.configurations.values()].every(
      (session) => session.autoCorrect,
    );
    if (
      before.validationMode === after.validationMode &&
      previousAutoCorrect === currentAutoCorrect
    )
      return undefined;
    return { command: 'CHANGE', description: 'Rule settings modified' };
  };
}

function floorCoordinate(workspace: WorkspaceSession, rackId: string): string | undefined {
  const floor = workspace.serverState.floorInformation as Record<string, unknown> | undefined;
  const grid = Array.isArray(floor?.['floorGrid'])
    ? (floor.floorGrid as Array<Record<string, unknown>>)
    : [];
  return historyString(grid.find((item) => item['id'] === rackId)?.['coordinate']) || undefined;
}

export function floorMoveHistoryFactory(rackId: string): ActionHistoryFactory {
  return (before, after) => {
    const previous = floorCoordinate(before, rackId);
    const current = floorCoordinate(after, rackId);
    if (!current || previous === current) return undefined;
    const event = nativeHardwareEvent(after, rackId, 'MOVE');
    return event ? { ...event, code: '', location: `${current} ` } : undefined;
  };
}

export function rackLockHistoryFactory(
  target: { itemId: string } | { rackId: string; position: number },
  locked: boolean,
): ActionHistoryFactory {
  return (before, after) => {
    const item = 'itemId' in target ? findHistoryPhysical(before, target.itemId) : undefined;
    const acceptedItem =
      'itemId' in target ? findHistoryPhysical(after, target.itemId) : undefined;
    if (
      item &&
      acceptedItem &&
      (item.item.lock === true) === (acceptedItem.item.lock === true)
    )
      return undefined;
    const rackId = item?.parentId ?? ('rackId' in target ? target.rackId : undefined);
    if (!rackId) return undefined;
    const rack = after.rackArea.find((value) => value.id === rackId);
    if (!rack) return undefined;
    const position = item?.position ?? ('position' in target ? target.position : undefined);
    if (position === undefined) return undefined;
    if (!item) {
      const priorRack = before.rackArea.find((value) => value.id === rackId);
      const hadLock =
        Array.isArray(priorRack?.lockedSpace) && priorRack.lockedSpace.includes(position);
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
export interface RawImportResponse extends Record<string, unknown> {
  configuration?: RawConfiguration[] | null;
  missingParts?: unknown;
  removedParts?: unknown;
  differentPartMap?: unknown;
  eccnRestricted?: boolean | null;
}

export function toImportParts(value: unknown): ImportPart[] {
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
export function collectReplacedParts(value: unknown): ImportPart[] {
  if (typeof value !== 'object' || value === null) return [];
  const out: ImportPart[] = [];
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    out.push(...toImportParts((entry as Record<string, unknown>)['replacedParts']));
  }
  return out;
}

export function prepareConfigurationChanges(
  session: ConfigSession,
  changes: Array<{ section: string; code: string; quantity: number }>,
) {
  let reduced = reduceConfiguration(
    session.raw,
    session.configurationId,
    hardwareModeFamily(session.mode),
    session.solution.solutionMode,
  );
  const editKinds = new Set<string>();
  let ordinaryStorageEdit = false;
  let raidModeChange = false;
  for (const change of changes) {
    const ref = resolveSection(session.index, change.section);
    if (!ref) {
      throw new Error(
        `Unknown section "${change.section}" for feature ${change.code}. ` +
          `Candidates: ${suggestSections(session.index, change.section).join('; ')}`,
      );
    }
    if (ref.subTab === 'Riser Card' && pciWizardOptions(session.raw).length > 0) {
      throw new Error(
        'Use dcsc_pci_wizard and dcsc_set_pci_wizard for riser slots on this configuration; ordinary feature edits do not apply native PCI wizard selections.',
      );
    }
    if (ref.subTab === 'Controller and Backplane') ordinaryStorageEdit = true;
    if (
      ref.name === 'RAID_CONFIG' &&
      change.quantity > 0 &&
      isStorageRaidModeChange(session.raw, change.code)
    ) {
      if (changes.length !== 1)
        throw new Error(
          'Switch RAID mode separately: this removes previous drives, backplanes and controllers. Apply new storage choices afterward.',
        );
      if (hardwareModeFamily(session.mode) === 'lfo')
        throw new Error(
          'LFO RAID-mode switching requires fixed/preselected storage restoration that is not yet supported. Use the website for this action.',
        );
      raidModeChange = true;
      ordinaryStorageEdit = true;
    }
    const tabType = session.raw.tabs?.find((tab) => tab.title === ref.tab)?.type;
    if (tabType === 'UNCONFIGURED_TAB') {
      throw new Error(
        'Use dcsc_set_unconfigured for Unconfigured selections; these are native client-held options and must not be sent through hardware derivation. Load choices with dcsc_load_unconfigured first.',
      );
    }
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

  if (editKinds.size > 1)
    throw new Error(
      'Apply software edits separately from hardware/service edits so DCSC receives the correct editing context.',
    );
  if (raidModeChange) reduced.sections = clearStorageRaidSections(session.raw, reduced.sections);
  if (ordinaryStorageEdit) reduced.storageWizardOption = null;
  else reduced.sections = storageWizardSections(session.raw, reduced.sections, true);
  const reducedForDerive: ReducedConfiguration = {
    ...reduced,
    selectedTopologies: {},
    nodeRole: '',
  };

  return { reduced: reducedForDerive, softwareEdit: editKinds.has('software') };
}
