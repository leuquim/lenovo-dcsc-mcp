import type { RawConfiguration } from '../model/types.js';
import { cloneConfigurationRaw } from './configurationIdentity.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : undefined;

type CloneDependency = Record<string, string[]>;

function cloneMembers(root: string, value: unknown, label: string): string[] {
  if (!root.trim() || !Array.isArray(value) || value.length === 0 ||
      value.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error(`${label} ${root || '(empty root)'} must be a nonempty identity array.`);
  }
  const members = value as string[];
  if (!members.includes(root) || new Set(members).size !== members.length) {
    throw new Error(`${label} ${root} must contain its root exactly once and cannot contain duplicate identities.`);
  }
  // Membership order is server-owned and is forwarded on linked edits. The
  // root only has to be present; do not silently move it to the first slot.
  return [...members];
}

function cloneGroups(value: unknown, label: string): CloneDependency | undefined {
  if (value === undefined) return undefined;
  const source = object(value);
  if (!source) throw new Error(`${label} must be an object of identity arrays.`);
  const result: CloneDependency = {};
  const owners = new Map<string, string>();
  for (const [root, rawMembers] of Object.entries(source)) {
    const members = cloneMembers(root, rawMembers, label);
    for (const id of members) {
      const owner = owners.get(id);
      if (owner && owner !== root) {
        throw new Error(`${label} identity ${id} belongs to overlapping roots ${owner} and ${root}.`);
      }
      owners.set(id, root);
    }
    result[root] = members;
  }
  return result;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function importedStorageOwnership(payload: Obj): {
  aliases: Map<string, string>;
  templates: Set<string>;
} {
  const networking = object(payload.networkingInformation);
  const networkSource = payload.storageConnectionNetworks ?? networking?.storageConnectionNetworks ??
    networking?.storageNetworks;
  const storageCodes = new Set<string>();
  const switchCodes = new Set<string>();
  const templates = new Set<string>();
  if (Array.isArray(networkSource)) for (const value of networkSource) {
    const network = object(value);
    if (!network) continue;
    const controller = object(network.controller);
    const controllerCode = nonemptyString(controller?.option)?.toUpperCase();
    if (controllerCode) storageCodes.add(controllerCode);
    const controllerId = nonemptyString(controller?.id);
    if (controllerId) templates.add(controllerId);
    const mainSwitch = object(network.mainSwitch);
    const switchCode = nonemptyString(mainSwitch?.option)?.toUpperCase();
    if (switchCode) switchCodes.add(switchCode);
    const switchId = nonemptyString(mainSwitch?.id);
    if (switchId) templates.add(switchId);
  }

  const physicalIds = new Set<string>();
  const visit = (value: unknown): void => {
    const item = object(value);
    if (!item) throw new Error('Imported physical storage hierarchy contains a non-object item.');
    const id = nonemptyString(item.configurationId ?? item.id);
    if (id) physicalIds.add(id);
    for (const child of Array.isArray(item.children) ? item.children : []) visit(child);
  };
  const workspace = object(payload.workspace);
  for (const item of [
    ...(Array.isArray(workspace?.rackArea) ? workspace.rackArea : []),
    ...(Array.isArray(workspace?.nonRackArea) ? workspace.nonRackArea : []),
  ]) visit(item);

  const result = new Map<string, string>();
  if (!Array.isArray(payload.configuration)) return { aliases: result, templates };
  for (const value of payload.configuration) {
    const raw = object(value);
    const id = nonemptyString(raw?.id ?? raw?.configurationId);
    const code = nonemptyString(raw?.sliceCtoCode ?? raw?.code)?.toUpperCase();
    const type = nonemptyString(raw?.type)?.toLowerCase();
    if (!id || !code || !physicalIds.has(id)) continue;
    if (type === 'storage' && storageCodes.has(code) || type === 'switch' && switchCodes.has(code)) {
      result.set(id, `${type}:${code}`);
    }
  }
  return { aliases: result, templates };
}

function colorGroups(
  value: unknown,
  dependency: CloneDependency,
  activeConfigurationIds: ReadonlySet<string>,
  storageAliases: ReadonlyMap<string, string>,
  storageTemplateIds: ReadonlySet<string>,
): CloneDependency | undefined {
  if (value === undefined) return undefined;
  const source = object(value);
  if (!source) throw new Error('Imported cloneDependencyColor must be an object.');
  const memberships: Record<string, unknown> = {};
  const storageOwners = new Map<string, string>();
  for (const [root, rawColor] of Object.entries(source)) {
    const color = object(rawColor);
    if (!color) throw new Error(`Imported cloneDependencyColor ${root} must be an object.`);
    if (color.dependBy === undefined) continue;
    if (!root.trim() || !Array.isArray(color.dependBy) ||
        color.dependBy.some(id => typeof id !== 'string' || !id.trim()) ||
        new Set(color.dependBy).size !== color.dependBy.length) {
      throw new Error(`Imported clone color group ${root || '(empty root)'} has malformed ownership.`);
    }
    const members = color.dependBy as string[];
    const dependencyTouchesRoot = Object.entries(dependency)
      .some(([owner, owned]) => owner === root || owned.includes(root));
    if (members.length === 0) {
      if (!storageTemplateIds.has(root) && (activeConfigurationIds.has(root) || dependencyTouchesRoot)) {
        throw new Error(`Imported clone color group ${root} cannot have empty ownership for an active clone identity.`);
      }
      // Native storage imports can retain a presentation color whose managed
      // template was not returned. It owns no identity and is not clone evidence.
      continue;
    }
    const allStorageAliases = members.every(member => storageAliases.has(member));
    if (allStorageAliases) {
      const signatures = new Set(members.map(member => storageAliases.get(member)));
      if (signatures.size !== 1) {
        throw new Error(`Imported storage color group ${root} mixes different managed component types or product codes.`);
      }
      if (activeConfigurationIds.has(root) && !storageAliases.has(root) && !storageTemplateIds.has(root)) {
        throw new Error(`Imported storage color group ${root} conflicts with an active configuration.`);
      }
      const touchingDependency = touchingGroups(dependency, new Set(members));
      if (touchingDependency.length > 0) {
        const exact = touchingDependency.length === 1 &&
          storageTemplateIds.has(touchingDependency[0]![0]) &&
          sameMembers(touchingDependency[0]![1].filter(member => storageAliases.has(member)), members) &&
          touchingDependency[0]![1].every(member => storageAliases.has(member) || member === touchingDependency[0]![0]);
        if (!exact) {
          throw new Error(`Imported storage color group ${root} conflicts with explicit clone dependency ownership.`);
        }
      }
      for (const member of members) {
        const owner = storageOwners.get(member);
        if (owner && owner !== root) {
          throw new Error(`Imported storage color identity ${member} belongs to overlapping roots ${owner} and ${root}.`);
        }
        storageOwners.set(member, root);
      }
      // Physical storage color groups may omit a managed template that the
      // import response did not return. Preserve the raw color metadata, but do
      // not treat physical aliases as editable configuration clones.
      continue;
    }
    if (members.some(member => storageAliases.has(member))) {
      throw new Error(`Imported clone color group ${root} mixes managed storage aliases with ordinary clone identities.`);
    }
    memberships[root] = members;
  }
  return cloneGroups(memberships, 'Imported clone color group');
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(id => right.includes(id));
}

function touchingGroups(groups: CloneDependency, ids: ReadonlySet<string>): Array<[string, string[]]> {
  return Object.entries(groups).filter(([, members]) => members.some(id => ids.has(id)));
}

/**
 * A compressed native import is stronger evidence than singleton fallback
 * dependency records: its originalIds, quantity and configuration identity have
 * already been validated together. Promote that exact ownership while refusing
 * partial or overlapping groups.
 */
function promoteExpansion(dependency: CloneDependency, sourceId: string, rawIds: readonly string[]): void {
  const members = [...rawIds];
  const ids = new Set(members);
  const touching = touchingGroups(dependency, ids);
  if (touching.length === 0) {
    dependency[sourceId] = members;
    return;
  }
  if (touching.length === 1 && touching[0]![0] === sourceId && sameMembers(touching[0]![1], members)) {
    dependency[sourceId] = members;
    return;
  }
  // Older MCP imports could retain only one singleton per expanded identity.
  // The validated compressed source proves these exact identities are one group,
  // so this one legacy shape can be repaired without guessing from product codes.
  if (touching.length === members.length && touching.every(([root, group]) =>
    ids.has(root) && group.length === 1 && group[0] === root)) {
    for (const [root] of touching) delete dependency[root];
    dependency[sourceId] = members;
    return;
  }
  throw new Error(
    `Imported clone dependency conflicts with validated expansion ${sourceId}. ` +
    'Re-export the configuration from DCSC or reconcile clone ownership before importing.',
  );
}

function assertMatchingColors(dependency: CloneDependency, colors: CloneDependency | undefined): void {
  if (!colors) return;
  for (const [root, members] of Object.entries(dependency)) {
    const touching = touchingGroups(colors, new Set(members));
    if (touching.length === 0) continue;
    if (touching.length !== 1 || touching[0]![0] !== root ||
        !sameMembers(touching[0]![1], members)) {
      throw new Error(
        `Imported clone color ownership conflicts with clone dependency ${root}. ` +
        'Re-export the configuration from DCSC or reconcile clone ownership before importing.',
      );
    }
  }
}

/**
 * CFXML imports compress identical loose products into one configuration and an
 * originalIds list. The captured SPA expands those IDs into physical instances
 * before customization. A group quantity alone is not enough to invent IDs.
 */
export function expandImportedClones<T extends Obj>(source: T): T {
  const payload = structuredClone(source);
  const workspace = object(payload.workspace);
  if (!workspace || !Array.isArray(payload.configuration) || !Array.isArray(workspace.nonRackArea)) return payload;
  const configurations = payload.configuration as RawConfiguration[];
  const dependency = cloneGroups(payload.cloneDependency, 'Imported clone dependency') ?? {};
  const activeConfigurationIds = new Set(configurations.map(raw => String(raw.id ?? raw.configurationId ?? ''))
    .filter(Boolean));
  const storage = importedStorageOwnership(payload);
  const colors = colorGroups(payload.cloneDependencyColor, dependency, activeConfigurationIds,
    storage.aliases, storage.templates);
  const byId = new Map(configurations.map(raw => [String(raw.id), raw]));
  const expansions: Array<{ sourceId: string; original: Obj; ids: string[] }> = [];
  const generated = new Set<string>();
  const expandedItems: Obj[] = [];
  for (const value of workspace.nonRackArea) {
    const item = object(value);
    if (!item) throw new Error('Imported non-rack item is not an object.');
    const ids = item.originalIds;
    if (!Array.isArray(ids) || ids.length < 2) { expandedItems.push(item); continue; }
    const sourceId = String(item.configurationId ?? item.id ?? '');
    const raw = byId.get(sourceId);
    if (!raw || ids.some(id => typeof id !== 'string' || !id.trim()) ||
        new Set(ids).size !== ids.length || !ids.includes(sourceId) ||
        Number(item.quantity) !== ids.length || Number(raw.quantity ?? 1) !== 1) {
      throw new Error(`Imported clone group ${sourceId} has inconsistent identities or quantities. No workspace was committed.`);
    }
    if (item.type === 'rack' || item.asVLH === true || (Array.isArray(item.children) && item.children.length > 0)) {
      throw new Error('Cloned racks and nested containers require a captured expansion contract.');
    }
    for (const id of ids as string[]) {
      if (generated.has(id) || (id !== sourceId && byId.has(id))) {
        throw new Error(`Imported clone identity ${id} collides with another configuration.`);
      }
      generated.add(id);
      if (id !== sourceId) configurations.push(cloneConfigurationRaw(raw, sourceId, id));
      expandedItems.push({ ...structuredClone(item), id, configurationId: id, quantity: 1, originalIds: [id] });
    }
    expansions.push({ sourceId, original: structuredClone(item), ids: ids as string[] });
  }
  if (expansions.length > 0) {
    for (const expansion of expansions) promoteExpansion(dependency, expansion.sourceId, expansion.ids);
    assertMatchingColors(dependency, colors);
    workspace.nonRackArea = expandedItems;
    (payload as Obj).cloneDependency = dependency;
    // Preserve the compressed source records for inspection/recovery.
    (payload as Obj).importCloneExpansion = expansions;
  } else assertMatchingColors(dependency, colors);
  return payload;
}
