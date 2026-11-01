import { isDeepStrictEqual } from 'node:util';

import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import type { FloorItem, WorkspaceSession } from '../session/SessionStore.js';
import { nonemptyCode } from './dcscWire.js';
import { readConnectionGraph, projectConnectionGraph } from './cabling.js';
import { fetchEnvelopes, type PhysicalEnvelope, type RackObject } from './rack.js';
import { hydrateLockedSpaceFromSpa } from './rackLocks.js';
import { buildFloorState } from './floorWire.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const objects = (value: unknown): Obj[] => Array.isArray(value)
  ? value.filter((entry): entry is Obj => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
  : [];

/** Retains the complete import envelope without replacing canonical workspace identity/settings. */
export function mergeImportedState(workspace: WorkspaceSession, payload: Obj): void {
  assertImportContext(workspace, payload);
  assertConfigurationIdentities(workspace, payload);
  const incoming = structuredClone(payload);
  // Normalize both sides before merging; a previous live graph must not hide an
  // incoming graph stored only in the browser's export envelope.
  const hasGraph = (state: Obj) => ['connections', 'autoConnectResults'].some(key => Array.isArray(state[key])) ||
    Array.isArray(object(state['networkingInformation'])['autoConnectResults']);
  const previous = structuredClone(workspace.serverState);
  if (hasGraph(previous)) previous['connections'] = readConnectionGraph(previous);
  if (hasGraph(incoming)) incoming['connections'] = readConnectionGraph(incoming);
  workspace.serverState = mergeValue(previous, incoming, []) as Obj;
  const graph = readConnectionGraph(workspace.serverState);
  workspace.cables = projectConnectionGraph(graph).cables;
}

/** Hydrates the import's slim physical hierarchy from DCSC envelope data. */
export async function hydrateImportedLayout(
  http: DcscHttpClient, ctx: RequestCtx, workspace: WorkspaceSession, payload: Obj,
): Promise<void> {
  const imported = object(payload['workspace']);
  const racks = objects(imported['rackArea']);
  const loose = objects(imported['nonRackArea']);
  if (racks.length === 0 && loose.length === 0) return;

  const configurations = new Map(
    [...workspace.configurations.values()].map((session) => [session.configurationId, session]),
  );
  const floorGrid = objects(object(payload['floorInformation'])['floorGrid']);
  const workspaceFloorItems = objects(imported['floorItems']);
  const initializeFloor = payload['floorInformation'] == null && workspaceFloorItems.length === 0;
  const hierarchyItems: Obj[] = [];
  const collect = (item: Obj, depth: number): void => {
    assertSupportedPhysicalShape(item, depth);
    hierarchyItems.push(item);
    for (const child of objects(item['children'])) collect(child, depth + 1);
  };
  for (const rack of racks) collect(rack, 0);
  for (const item of loose) collect(item, 0);

  const identities = new Set<string>();
  const requests = new Map<string, { code: string; type: string }>();
  for (const item of hierarchyItems) {
    const id = hierarchyId(item);
    if (identities.has(id)) throw new Error(`Imported layout contains duplicate identity ${id}.`);
    identities.add(id);
    const session = configurations.get(id);
    if (!session) throw new Error(`Imported layout references missing configuration ${id}.`);
    const code = nonemptyCode(session.raw.lfoCode, session.raw.sliceCtoCode, session.raw.code);
    const type = hardwareType(item, session.raw as Obj);
    requests.set(`${type}\u0000${code.toUpperCase()}`, { code, type });
  }

  const envelopes = await fetchEnvelopes(http, ctx, [...requests.values()]);
  const envelopeFor = (item: Obj): { id: string; envelope: PhysicalEnvelope } => {
    const id = hierarchyId(item);
    const session = configurations.get(id)!;
    const code = nonemptyCode(session.raw.lfoCode, session.raw.sliceCtoCode, session.raw.code);
    const envelope = envelopes.get(code.toUpperCase());
    if (!envelope) throw new Error(`DCSC returned no physical envelope for imported ${code}.`);
    return { id, envelope };
  };

  // Stage every value. A late missing position/envelope must leave the draft untouched.
  const stagedRacks: RackObject[] = [];
  const stagedLoose: RackObject[] = [];
  const stagedFloor: FloorItem[] = [];
  const incomingRackIds = new Set<string>();
  // The SPA's buildWorkspaceImportData decodes U_POSITION results, then
  // constructFloorGrid initializes client-side cells when no floor was supplied.
  const initializedCells = initializeFloor ? objects(buildFloorState({ ...workspace,
    rackArea: [...workspace.rackArea, ...racks.map(rack => ({ ...rack, id: hierarchyId(rack) }))],
  }).information['floorGrid']) : [];

  for (const rack of racks) {
    const { id, envelope } = envelopeFor(rack);
    if (incomingRackIds.has(id) || layoutHasId(workspace, id)) {
      throw new Error(`Imported layout identity ${id} already exists in this workspace.`);
    }
    incomingRackIds.add(id);
    const cell = uniqueByIdentity(initializeFloor ? initializedCells : floorGrid, id, 'floor-grid rack');
    const cellId = nonemptyString(cell['id']);
    if (!cellId) throw new Error(`Imported rack ${id} has no floor-grid identity.`);
    const row = nonnegativeInteger(cell['row']);
    const col = nonnegativeInteger(cell['col']);
    if (row === undefined || col === undefined) throw new Error(`Imported rack ${id} has no usable floor position.`);
    const floorItem = matchingWorkspaceFloorItem(workspaceFloorItems, id);
    if (floorItem) {
      const floorRow = nonnegativeInteger(floorItem['row']);
      const floorCol = nonnegativeInteger(floorItem['col']);
      if (floorRow !== undefined && floorCol !== undefined && (floorRow !== row || floorCol !== col)) {
        throw new Error(`Imported rack ${id} has conflicting floor positions.`);
      }
    }
    if ([...workspace.floorItems, ...stagedFloor].some((item) => item.x === col && item.y === row)) {
      throw new Error(`Imported rack ${id} conflicts with an occupied floor cell (${col}, ${row}).`);
    }

    const children = objects(rack['children']);
    const locations = initializeFloor ? children.map(child => ({ id: hierarchyId(child), position: importedHierarchyPosition(child) }))
      : objects(cell['items']);
    const rackItems = children.map((child) => restoreRackItem(child, locations, envelopeFor));
    assertNoUnknownLocations(locations, children, id);
    stagedRacks.push({
      ...structuredClone(envelope.raw), ...structuredClone(rack),
      id, configurationId: id, code: envelope.code, sliceCtoCode: envelope.code,
      type: 'rack', quantity: quantity(rack), rackItems,
      lockedSpace: cell['lockedSpace'] !== undefined && cell['lockedSpace'] !== null
        ? hydrateLockedSpaceFromSpa(cell['lockedSpace'], envelope.sizeU)
        : structuredClone(rack['lockedSpace'] ?? []),
    });
    // Captured imports use the rack id as the grid cell id; preserve that server identity.
    stagedFloor.push({ id: cellId, rackId: id, x: col, y: row });
  }

  for (const item of loose) {
    const { id, envelope } = envelopeFor(item);
    if (layoutHasId(workspace, id) || stagedLoose.some((entry) => entry['id'] === id)) {
      throw new Error(`Imported layout identity ${id} already exists in this workspace.`);
    }
    const hierarchyNodes = objects(item['children']);
    const parentType = hardwareType(item, envelope.raw);
    if (hierarchyNodes.length > 0 && parentType !== 'chassis') {
      throw new Error(`Imported container ${id} with nested nodes is not a chassis.`);
    }
    const nodes = hierarchyNodes.map(node => restoreLooseNestedNode(node, envelopeFor, id));
    const restored: RackObject = {
      ...structuredClone(envelope.raw), ...structuredClone(item),
      id, configurationId: id, code: envelope.code, sliceCtoCode: envelope.code,
      type: parentType, quantity: quantity(item),
    };
    delete restored['children'];
    restored['nodes'] = nodes;
    stagedLoose.push(restored);
  }

  workspace.rackArea = [...workspace.rackArea, ...stagedRacks];
  workspace.nonRackArea = [...workspace.nonRackArea, ...stagedLoose];
  workspace.floorItems = [...workspace.floorItems, ...stagedFloor];
}

function restoreLooseNestedNode(
  item: Obj,
  envelopeFor: (item: Obj) => { id: string; envelope: PhysicalEnvelope },
  chassisId: string,
): RackObject {
  const { id, envelope } = envelopeFor(item);
  if (objects(item['children']).length > 0) unsupportedContainer(id);
  const occupiedBay = positiveInteger(envelope.raw['occupiedBay']) ?? positiveInteger(item['size']);
  if (occupiedBay === undefined) {
    throw new Error(`Imported node ${id} in loose chassis ${chassisId} has no usable occupied bay.`);
  }
  const type = hardwareType(item, envelope.raw);
  if (type !== 'node') throw new Error(`Imported child ${id} in loose chassis ${chassisId} is not a node.`);
  const restored: RackObject = {
    ...structuredClone(envelope.raw), ...structuredClone(item),
    id, configurationId: id, code: envelope.code, sliceCtoCode: envelope.code,
    type, quantity: quantity(item), occupiedBay,
  };
  delete restored['children'];
  restored['nodes'] = [];
  return restored;
}

/** Inverse of buildItemHierarchy's native 32xx placement code, in wire U units. */
function importedHierarchyPosition(item: Obj): number {
  const placements = objects(item['derivedResults']).filter(result => /^32\d{2}$/.test(String(result['featureCode'])));
  if (placements.length !== 1 || Number(placements[0]!['quantity'] ?? 1) !== 1 ||
      Array.isArray(item['originalIds']) && item['originalIds'].length > 1) {
    throw new Error(`Imported item ${hierarchyId(item)} has no unambiguous native U-position; grouped positions require expansion.`);
  }
  const position = Number(String(placements[0]!['featureCode']).slice(2));
  if (!Number.isInteger(position) || position < 1) throw new Error(`Imported item ${hierarchyId(item)} has no usable physical position.`);
  return position;
}

function restoreRackItem(
  item: Obj, locations: Obj[],
  envelopeFor: (item: Obj) => { id: string; envelope: PhysicalEnvelope },
): RackObject {
  const { id, envelope } = envelopeFor(item);
  const location = uniqueByIdentity(locations, id, 'rack item');
  const position = positiveInteger(location['position']);
  if (position === undefined) throw new Error(`Imported item ${id} has no usable physical position.`);
  const hierarchyNodes = objects(item['children']);
  const physicalNodes = objects(location['nodes']);
  const parentType = hardwareType(item, location, envelope.raw);
  if ((hierarchyNodes.length > 0 || physicalNodes.length > 0) && parentType !== 'chassis') {
    throw new Error(`Imported container ${id} with nested nodes is not a chassis.`);
  }
  const nodes = hierarchyNodes.map((node) => restoreNestedNode(node, physicalNodes, envelopeFor, id));
  assertNoUnknownLocations(physicalNodes, hierarchyNodes, id, 'node');
  const restored: RackObject = {
    ...structuredClone(envelope.raw), ...structuredClone(item), ...structuredClone(location),
    id, configurationId: id, code: envelope.code, sliceCtoCode: envelope.code,
    type: parentType, quantity: quantity(item), position,
    endPosition: position + envelope.sizeU - 1,
  };
  delete restored['children'];
  restored['nodes'] = nodes;
  return restored;
}

function restoreNestedNode(
  item: Obj, locations: Obj[],
  envelopeFor: (item: Obj) => { id: string; envelope: PhysicalEnvelope },
  chassisId: string,
): RackObject {
  const { id, envelope } = envelopeFor(item);
  if (objects(item['children']).length > 0) unsupportedContainer(id);
  // Native CFXML import can omit the chassis `nodes` placement collection
  // entirely even though its canonical workspace hierarchy contains the node.
  // The SPA forwards that slim child (size, but no occupiedBay) to customize,
  // which returns the authoritative bay. Retain strict identity matching as
  // soon as the server supplies any physical node locations.
  const location = locations.length === 0
    ? {}
    : uniqueByIdentity(locations, id, `node in chassis ${chassisId}`);
  if (objects(location['nodes']).length > 0) unsupportedContainer(id);
  const occupiedBay = positiveInteger(location['occupiedBay']) ?? positiveInteger(envelope.raw['occupiedBay']) ??
    positiveInteger(item['size']);
  if (occupiedBay === undefined) {
    throw new Error(`Imported node ${id} in chassis ${chassisId} has no usable occupied bay.`);
  }
  const type = hardwareType(item, location, envelope.raw);
  if (type !== 'node') throw new Error(`Imported child ${id} in chassis ${chassisId} is not a node.`);
  const restored: RackObject = {
    ...structuredClone(envelope.raw), ...structuredClone(item), ...structuredClone(location),
    id, configurationId: id, code: envelope.code, sliceCtoCode: envelope.code,
    type, quantity: quantity(item), occupiedBay,
  };
  delete restored['children'];
  restored['nodes'] = [];
  return restored;
}

function assertSupportedPhysicalShape(item: Obj, depth: number): void {
  const id = String(item['configurationId'] ?? item['id'] ?? '(unknown)');
  if (item['asVLH'] === true || nonemptyString(item['vlhId'])) {
    throw new Error(`Imported VLH item ${id} requires a captured VLH hydration contract.`);
  }
  if (depth >= 2 && objects(item['children']).length > 0) unsupportedContainer(id);
}

function unsupportedContainer(id: string): never {
  throw new Error(`Imported container ${id} requires a captured chassis child-placement contract.`);
}

function hierarchyId(item: Obj): string {
  const id = nonemptyString(item['id']);
  const configurationId = nonemptyString(item['configurationId']);
  if (id && configurationId && id !== configurationId) {
    throw new Error(`Imported layout has conflicting identities ${id} and ${configurationId}.`);
  }
  const resolved = configurationId ?? id;
  if (!resolved) throw new Error('Imported layout item has no configuration identity.');
  return resolved;
}

function uniqueByIdentity(entries: Obj[], id: string, label: string): Obj {
  const matches = entries.filter((entry) => entry['id'] === id || entry['sourceId'] === id);
  if (matches.length !== 1) {
    throw new Error(`Imported ${label} ${id} has ${matches.length === 0 ? 'no' : 'ambiguous'} placement metadata.`);
  }
  return matches[0]!;
}

function matchingWorkspaceFloorItem(entries: Obj[], id: string): Obj | undefined {
  const matches = entries.filter((entry) => object(entry['rackItem'])['id'] === id);
  if (matches.length > 1) throw new Error(`Imported rack ${id} has ambiguous workspace floor metadata.`);
  return matches[0];
}

function assertNoUnknownLocations(
  locations: Obj[], children: Obj[], containerId: string, childKind = 'item',
): void {
  const childIds = new Set(children.map(hierarchyId));
  for (const location of locations) {
    const id = nonemptyString(location['id']);
    if (!id || !childIds.has(id)) {
      throw new Error(`Imported container ${containerId} contains placement metadata for an unknown ${childKind} "${id}".`);
    }
  }
}

function layoutHasId(workspace: WorkspaceSession, id: string): boolean {
  const visit = (entry: RackObject): boolean => {
    if (entry['id'] === id || entry['configurationId'] === id) return true;
    return objects(entry['rackItems']).some(visit) || objects(entry['children']).some(visit) ||
      objects(entry['nodes']).some(visit);
  };
  return workspace.rackArea.some(visit) || workspace.nonRackArea.some(visit);
}

function assertImportContext(workspace: WorkspaceSession, payload: Obj): void {
  const expected: Array<[string, unknown, unknown]> = [
    ['country', workspace.locale.country, payload['country']],
    ['language', workspace.locale.language, payload['language']],
    ['currency', workspace.locale.currency, payload['currency']],
  ];
  for (const [name, actual, imported] of expected) {
    if (nonemptyString(imported) && imported !== actual) {
      throw new Error(`Imported ${name} ${String(imported)} conflicts with workspace ${String(actual)}.`);
    }
  }
  const mode = object(payload['configurationMode']);
  const importedMode = nonemptyString(mode['mode']);
  if (importedMode && importedMode !== workspace.solution.solutionMode) {
    throw new Error(`Imported solution mode ${importedMode} conflicts with workspace ${workspace.solution.solutionMode}.`);
  }
  // Native Excel imports return the selected mode with an empty slices list.
  // That omits catalog metadata; it does not contradict the resolved mode.
  if (Array.isArray(mode['masterSlices']) && mode['masterSlices'].length > 0 &&
    !mode['masterSlices'].every((slice) => typeof slice === 'string' && workspace.solution.masterSlices.includes(slice))) {
    throw new Error('Imported master slices conflict with the workspace solution context.');
  }
}

function assertConfigurationIdentities(workspace: WorkspaceSession, payload: Obj): void {
  // Independent-service configuration entries are catalogs, not hardware trees.
  if (payload['type'] === 'service') return;
  const byId = new Map([...workspace.configurations.values()].map((session) => [session.configurationId, session]));
  for (const imported of objects(payload['configuration'])) {
    const id = nonemptyString(imported['id']) ?? nonemptyString(imported['configurationId']);
    if (!id) throw new Error('Imported configuration has no identity.');
    const session = byId.get(id);
    if (!session) throw new Error(`Imported configuration ${id} is missing from the workspace candidate.`);
    const importedCode = nonemptyCode(imported['lfoCode'], imported['sliceCtoCode'], imported['code']);
    const localCode = nonemptyCode(session.raw.lfoCode, session.raw.sliceCtoCode, session.raw.code);
    if (importedCode.toUpperCase() !== localCode.toUpperCase()) {
      throw new Error(`Imported configuration ${id} conflicts with workspace product ${localCode}.`);
    }
  }
}

function mergeValue(existing: unknown, incoming: unknown, path: string[]): unknown {
  if (existing === undefined) return structuredClone(incoming);
  if (incoming === undefined) return structuredClone(existing);
  if (isDeepStrictEqual(existing, incoming)) return structuredClone(existing);
  if (protectedSetting(path)) throw new Error(`Imported setting ${path.join('.')} conflicts with the existing workspace.`);
  if (isObject(existing) && isObject(incoming)) {
    const out: Obj = {};
    for (const key of new Set([...Object.keys(existing), ...Object.keys(incoming)])) {
      out[key] = mergeValue(existing[key], incoming[key], [...path, key]);
    }
    return out;
  }
  if (Array.isArray(existing) && Array.isArray(incoming)) return mergeArrays(existing, incoming, path);
  return structuredClone(incoming);
}

function mergeArrays(existing: unknown[], incoming: unknown[], path: string[]): unknown[] {
  if (existing.length === 0) return structuredClone(incoming);
  if (incoming.length === 0) return structuredClone(existing);
  const out = structuredClone(existing);
  for (const value of incoming) {
    if (out.some((current) => isDeepStrictEqual(current, value))) continue;
    const identity = isObject(value) ? recordIdentity(value, path) : undefined;
    if (identity) {
      const collision = out.find((current) => isObject(current) && recordIdentity(current, path) === identity);
      if (collision) throw new Error(`Imported identity ${identity} conflicts at ${path.join('.')}.`);
    }
    out.push(structuredClone(value));
  }
  return out;
}

function recordIdentity(value: Obj, path: string[]): string | undefined {
  if (['connections', 'autoConnectResults'].includes(path.at(-1) ?? '') && value['sourceId'] && value['destinationId']) {
    return JSON.stringify(['network', 'sourceId', 'sourcePortName', 'sourcePortNumber',
      'destinationId', 'destinationPortName', 'destinationPortNumber'].map(key => value[key] ?? null));
  }
  if (path.at(-1) === 'floorItems') return nonemptyString(object(value['rackItem'])['id']);
  if (path.at(-1) === 'powerSelection') return nonemptyString(value['rack']);
  if (path.at(-1) === 'floorGrid') {
    const row = nonnegativeInteger(value['row']);
    const col = nonnegativeInteger(value['col']);
    return row === undefined || col === undefined ? nonemptyString(value['id']) : `${row}:${col}`;
  }
  return nonemptyString(value['configurationId']) ?? nonemptyString(value['id']) ?? nonemptyString(value['sourceId']);
}

function protectedSetting(path: string[]): boolean {
  const joined = path.join('.');
  return joined === 'country' || joined === 'language' || joined === 'currency' ||
    joined === 'configurationMode' || joined === 'operationMode' ||
    joined === 'floorInformation.floorGridSettings' || joined === 'floorInformation.floorPreference';
}

function hardwareType(...sources: Obj[]): string {
  for (const source of sources) {
    const value = nonemptyString(source['hardwareType']) ?? nonemptyString(source['type']);
    if (value) return value.toLowerCase();
  }
  throw new Error('Imported item has no DCSC hardware type.');
}

function quantity(item: Obj): number {
  const value = Number(item['quantity'] ?? 1);
  if (!Number.isInteger(value) || value < 1) throw new Error('Imported item has an invalid quantity.');
  return value;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : undefined;
}
function nonnegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}
function isObject(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
