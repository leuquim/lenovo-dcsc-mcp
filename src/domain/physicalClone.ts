import type { RackObject } from './rack.js';

type Obj = Record<string, unknown>;

export interface RackedClonePlacement {
  configurationId: string;
  rackId: string;
  position: number;
}

export interface StageRackedCloneMultipleOptions {
  rackArea: RackObject[];
  nonRackArea: RackObject[];
  sourceId: string;
  cloneIds: string[];
  /** Each cloned chassis maps every source node ID to its new identity. */
  childCloneIds?: Record<string, Record<string, string>>;
  /**
   * The complete workspace mapping that will be sent in
   * `workspaceInformation.cloneDependency` on auto-derive.
   */
  cloneDependency?: unknown;
}

export interface StagedRackedCloneMultiple {
  rackArea: RackObject[];
  nonRackArea: RackObject[];
  cloneDependency: Record<string, string[]>;
  placements: RackedClonePlacement[];
}

function object(value: unknown): Obj | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Obj
    : undefined;
}

function objects(value: unknown): Obj[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Obj => object(entry) !== undefined)
    : [];
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function identity(item: Obj, label: string): string {
  const id = nonempty(item['id']);
  const configurationId = nonempty(item['configurationId']);
  if (id && configurationId && id !== configurationId) {
    throw new Error(`${label} has conflicting id and configurationId values.`);
  }
  const resolved = configurationId ?? id;
  if (!resolved) throw new Error(`${label} has no configuration identity.`);
  return resolved;
}

function assertSimpleRackItem(item: Obj, sourceId: string, rack?: Obj, additionalCount?: number): void {
  for (const key of ['nodes', 'children', 'rackItems']) {
    if (objects(item[key]).length > 0) {
      throw new Error(`Racked clone source ${sourceId} contains ${key}; nested physical cloning requires an authoritative contract.`);
    }
  }
  if (item['asVLH'] === true || nonempty(item['vlhId'])) {
    throw new Error(`Racked clone source ${sourceId} is a VLH item; VLH cloning requires an authoritative contract.`);
  }
  if (object(item['controllerExpansion']) || nonempty(item['controllerId'])) {
    throw new Error(`Racked clone source ${sourceId} has controller expansion metadata; controller cloning requires an authoritative contract.`);
  }
  if (nonempty(item['originalId'])) {
    throw new Error(`Racked clone source ${sourceId} already has originalId metadata; its identity semantics are not captured.`);
  }
  const rule = object(item['rule']);
  if (rule && (rule['mtMinMaxRule'] != null || rule['productMinMaxRule'] != null)) {
    if (!rack || additionalCount === undefined) {
      throw new Error(`Racked clone source ${sourceId} has placement rules that require authoritative placement.`);
    }
    for (const [key, identityKey] of [['mtMinMaxRule', 'machineType'], ['productMinMaxRule', 'code']] as const) {
      if (rule[key] == null) continue;
      const bounds = object(rule[key]);
      const min = bounds?.['min']; const max = bounds?.['max'];
      const value = nonempty(item[identityKey]);
      if (!value || typeof min !== 'number' || !Number.isSafeInteger(min) || min < 0 ||
          typeof max !== 'number' || !Number.isSafeInteger(max) || max < min) {
        throw new Error(`Racked clone source ${sourceId} has placement rules that require authoritative placement.`);
      }
      // The website treats a lone product 0..0 rule as unrestricted.
      if (key === 'productMinMaxRule' && !rule['mtMinMaxRule'] && min === 0 && max === 0) continue;
      const existing = objects(rack['rackItems']).filter(candidate => candidate[identityKey] === value).length;
      if (existing + additionalCount > max) {
        throw new Error(`Clone Multiple exceeds the rack ${identityKey} limit for ${value}: ${existing} existing + ${additionalCount} requested > ${max}.`);
      }
    }
  }
}

function occupiedPositions(rack: Obj, rackSize: number): Set<number> {
  const occupied = new Set<number>();
  for (const raw of objects(rack['rackItems'])) {
    const itemId = identity(raw, 'Rack item');
    const position = positiveInteger(raw['position']);
    const size = positiveInteger(raw['size']);
    if (!position || !size || position + size - 1 > rackSize) {
      throw new Error(`Rack item ${itemId} has incomplete or invalid placement metadata.`);
    }
    for (let u = position; u < position + size; u += 1) {
      if (occupied.has(u)) throw new Error(`Rack ${String(rack['id'])} has overlapping physical items at U${u}.`);
      occupied.add(u);
    }
  }
  const locked = rack['lockedSpace'];
  if (!Array.isArray(locked)) throw new Error(`Rack ${String(rack['id'])} has invalid lockedSpace metadata.`);
  for (const raw of locked) {
    const position = positiveInteger(raw);
    if (!position || position > rackSize) {
      throw new Error(`Rack ${String(rack['id'])} has unsupported locked-space metadata.`);
    }
    occupied.add(position);
  }
  return occupied;
}

function firstFreePosition(
  occupied: Set<number>, size: number, lowest: number, highest: number,
): number | undefined {
  const lastStart = highest - size + 1;
  for (let position = lowest; position <= lastStart; position += 1) {
    if (Array.from({ length: size }, (_, offset) => position + offset)
      .every((value) => !occupied.has(value))) return position;
  }
  return undefined;
}

function normalizeDependency(value: unknown): Record<string, string[]> {
  if (value === undefined) return {};
  const source = object(value);
  if (!source) throw new Error('cloneDependency must be an object of identity arrays.');
  const normalized: Record<string, string[]> = {};
  const owners = new Map<string, string>();
  for (const [root, rawMembers] of Object.entries(source)) {
    if (!nonempty(root) || !Array.isArray(rawMembers) || rawMembers.length === 0) {
      throw new Error('cloneDependency contains an invalid identity group.');
    }
    const members: string[] = [];
    for (const raw of rawMembers) {
      const member = nonempty(raw);
      if (!member) throw new Error(`cloneDependency group ${root} contains an invalid identity.`);
      const owner = owners.get(member);
      if (owner && owner !== root) throw new Error(`cloneDependency identity ${member} belongs to multiple groups.`);
      owners.set(member, root);
      if (!members.includes(member)) members.push(member);
    }
    normalized[root] = members.includes(root) ? [root, ...members.filter(member => member !== root)] : [root, ...members];
  }
  return normalized;
}

function extendDependency(
  value: unknown, sourceId: string, cloneIds: string[], rackId: string,
): Record<string, string[]> {
  const dependency = normalizeDependency(value);
  const containing = Object.entries(dependency).filter(([, members]) => members.includes(sourceId));
  if (containing.length > 1) throw new Error(`Clone source ${sourceId} belongs to multiple dependency groups.`);
  const root = containing[0]?.[0] ?? sourceId;
  const members = dependency[root] ?? [sourceId];
  if (!members.includes(sourceId)) members.push(sourceId);
  for (const cloneId of cloneIds) {
    const owner = Object.entries(dependency).find(([, group]) => group.includes(cloneId));
    if (owner) throw new Error(`Clone identity ${cloneId} already belongs to dependency group ${owner[0]}.`);
    members.push(cloneId);
  }
  dependency[root] = root === sourceId
    ? [sourceId, ...members.filter(member => member !== sourceId)]
    : [root, ...members.filter(member => member !== root)];
  dependency[rackId] ??= [rackId];
  return dependency;
}

/**
 * Stages the browser's captured `Clone Multiple` physical operation for a
 * direct rack item with supported capacity bounds. The returned clone has a new identity,
 * `newHardware: true`, and the first free contiguous rack position. DCSC must
 * still accept the staged layout through rack customize/auto-derive.
 *
 * Populated chassis require explicit per-parent child identity mappings.
 * Copy, non-rack items, VLH, and complex placement rules are
 * deliberately rejected because their current browser contracts are not yet
 * verified.
 */
export function stageRackedCloneMultiple(
  options: StageRackedCloneMultipleOptions,
): StagedRackedCloneMultiple {
  const sourceId = nonempty(options.sourceId);
  if (!sourceId) throw new Error('Racked clone sourceId is required.');
  if (options.cloneIds.length === 0) throw new Error('Clone Multiple requires at least one clone identity.');
  const cloneIds = options.cloneIds.map((id) => {
    const normalized = nonempty(id);
    if (!normalized) throw new Error('Clone Multiple received an empty clone identity.');
    return normalized;
  });
  if (new Set(cloneIds).size !== cloneIds.length || cloneIds.includes(sourceId)) {
    throw new Error('Clone Multiple identities must be unique and differ from the source.');
  }

  const rackArea = structuredClone(options.rackArea);
  const nonRackArea = structuredClone(options.nonRackArea);
  if (nonRackArea.some(item => identity(item, 'Non-rack item') === sourceId)) {
    throw new Error(`Clone source ${sourceId} is not racked; non-rack clone placement is not captured.`);
  }

  const allIdentities = new Set<string>();
  let match: { rack: RackObject; item: Obj } | undefined;
  for (const rack of rackArea) {
    const rackId = identity(rack, 'Rack');
    if (allIdentities.has(rackId)) throw new Error(`Physical identity ${rackId} is duplicated.`);
    allIdentities.add(rackId);
    if (rackId === sourceId) throw new Error('Rack cabinets cannot be cloned with the captured item contract.');
    for (const item of objects(rack['rackItems'])) {
      const itemId = identity(item, 'Rack item');
      if (allIdentities.has(itemId)) throw new Error(`Physical identity ${itemId} is duplicated.`);
      allIdentities.add(itemId);
      if (itemId === sourceId) {
        if (match) throw new Error(`Clone source ${sourceId} occurs more than once in the layout.`);
        match = { rack, item };
      }
    }
  }
  for (const item of nonRackArea) {
    const itemId = identity(item, 'Non-rack item');
    if (allIdentities.has(itemId)) throw new Error(`Physical identity ${itemId} is duplicated.`);
    allIdentities.add(itemId);
  }
  if (!match) throw new Error(`Racked clone source ${sourceId} was not found.`);
  for (const cloneId of cloneIds) {
    if (allIdentities.has(cloneId)) throw new Error(`Clone identity ${cloneId} already exists in the physical layout.`);
  }

  const sourceNodes = objects(match.item['nodes']);
  if (sourceNodes.length > 0 && match.item['type'] === 'chassis') {
    assertSimpleRackItem({ ...match.item, nodes: [] }, sourceId, match.rack, cloneIds.length);
    for (const node of sourceNodes) {
      if (node['type'] !== 'node') throw new Error('Chassis cloning requires direct node children.');
      assertSimpleRackItem(node, identity(node, 'Chassis node'));
    }
  } else assertSimpleRackItem(match.item, sourceId, match.rack, cloneIds.length);
  const allNodeIds = new Set<string>();
  for (const item of [...rackArea.flatMap(rack => objects(rack['rackItems'])), ...nonRackArea]) {
    for (const node of objects(item['nodes'])) {
      const id = identity(node, 'Chassis node');
      if (allIdentities.has(id) || allNodeIds.has(id)) throw new Error(`Physical identity ${id} is duplicated.`);
      allNodeIds.add(id);
    }
  }
  for (const id of cloneIds) if (allNodeIds.has(id)) throw new Error(`Clone identity ${id} already exists in the physical layout.`);
  const sourceNodeIds = sourceNodes.map(node => identity(node, 'Chassis node'));
  const childCloneIds = options.childCloneIds ?? {};
  if (Object.keys(childCloneIds).some(id => !cloneIds.includes(id))) throw new Error('Child mapping references an unknown chassis clone.');
  const generatedChildren = new Set<string>();
  for (const parent of cloneIds) {
    const mapping = childCloneIds[parent] ?? {};
    if (Object.keys(mapping).length !== sourceNodeIds.length || sourceNodeIds.some(id => !nonempty(mapping[id]))) {
      throw new Error('Every cloned chassis requires exactly one new identity for every source node.');
    }
    for (const childId of Object.values(mapping)) {
      if (allIdentities.has(childId) || allNodeIds.has(childId) || cloneIds.includes(childId) || generatedChildren.has(childId)) {
        throw new Error(`Clone child identity ${childId} already exists or is duplicated.`);
      }
      generatedChildren.add(childId);
    }
  }
  const rackId = identity(match.rack, 'Rack');
  const rackSize = positiveInteger(match.rack['size']);
  const itemSize = positiveInteger(match.item['size']);
  const lowest = positiveInteger(match.item['lowestPosition']);
  const highest = positiveInteger(match.item['highestPosition']);
  if (!rackSize || !itemSize || !lowest || !highest || lowest > highest || highest > rackSize) {
    throw new Error(`Racked clone source ${sourceId} has incomplete placement bounds.`);
  }
  const occupied = occupiedPositions(match.rack, rackSize);
  const items = objects(match.rack['rackItems']);
  const placements: RackedClonePlacement[] = [];
  for (const cloneId of cloneIds) {
    const position = firstFreePosition(occupied, itemSize, lowest, highest);
    if (position === undefined) {
      throw new Error(`Rack ${rackId} has no captured-contract placement for clone ${cloneId}; authoritative placement is required.`);
    }
    const clone = structuredClone(match.item);
    clone['id'] = cloneId;
    if (Object.hasOwn(clone, 'configurationId')) clone['configurationId'] = cloneId;
    delete clone['originalId'];
    if (sourceNodes.length > 0) clone['nodes'] = sourceNodes.map(node => {
      const child = structuredClone(node);
      const childId = childCloneIds[cloneId]![identity(node, 'Chassis node')]!;
      child['id'] = childId;
      if (Object.hasOwn(child, 'configurationId')) child['configurationId'] = childId;
      return child;
    });
    clone['position'] = position;
    clone['lock'] = false;
    clone['newHardware'] = true;
    items.push(clone);
    for (let offset = 0; offset < itemSize; offset += 1) occupied.add(position + offset);
    placements.push({ configurationId: cloneId, rackId, position });
  }
  match.rack['rackItems'] = items;

  let dependency = extendDependency(options.cloneDependency, sourceId, cloneIds, rackId);
  for (const childId of sourceNodeIds) {
    dependency = extendDependency(dependency, childId, cloneIds.map(parent => childCloneIds[parent]![childId]!), rackId);
  }
  return {
    rackArea,
    nonRackArea,
    cloneDependency: dependency,
    placements,
  };
}
