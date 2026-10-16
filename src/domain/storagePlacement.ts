import { buildRackConfigurations, type RackConfigurationWire, type RackObject } from './rack.js';
import type { StorageConnectionNetwork } from './storagePreferences.js';

type Obj = Record<string, unknown>;

export type StoragePlacementRole = 'controller' | 'mainSwitch';

export interface StoragePlacementComponent {
  role: StoragePlacementRole;
  /** Fresh identity for this physical instance. The managed template keeps its own id. */
  physicalId: string;
  /** Full managed-template configuration, after launch/configuration. */
  configuration: RackObject;
}

export interface StageStorageNetworkPlacementOptions {
  rackArea: RackObject[];
  nonRackArea: RackObject[];
  storageConnectionNetworks: readonly StorageConnectionNetwork[];
  cloneDependency?: unknown;
  rackId: string;
  networkName: string;
  components: StoragePlacementComponent[];
}

export interface StoragePhysicalItem {
  role: StoragePlacementRole;
  templateId: string;
  physicalId: string;
  rackId: string;
  requestedPosition: number;
  raw: RackObject;
  originalId?: string | undefined;
  controllerExpansion?: RackObject | undefined;
}

export interface StagedStorageNetworkPlacement {
  rackArea: RackObject[];
  nonRackArea: RackObject[];
  cloneDependency: Record<string, string[]>;
  /** Only managed template configurations belong in the customize request. */
  wireConfigurations: RackConfigurationWire[];
  templateConfigurationIds: string[];
  physicalItems: StoragePhysicalItem[];
  physicalToTemplate: Record<string, string>;
}

export interface AcceptedStoragePlacement {
  role: StoragePlacementRole;
  templateId: string;
  physicalId: string;
  rackId: string;
  position: number;
  size: number;
  quantity: number;
  raw: RackObject;
  originalId?: string | undefined;
  controllerExpansion?: RackObject | undefined;
}

export interface ResolvedStoragePhysicalAlias {
  physicalId: string;
  templateId: string;
  roles: StoragePlacementRole[];
  networkNames: string[];
  area: 'rack' | 'non-rack';
  rackId?: string | undefined;
  raw: RackObject;
  originalId?: string | undefined;
  controllerExpansion?: RackObject | undefined;
}

/** Managed templates retained outside an active storage definition.
 *
 * The website keeps a configured SAN template and its physical aliases when
 * the definition is changed to Direct Attached. Callers provide these roots
 * separately so they remain managed without being exposed as active networks.
 */
export interface AdditionalStorageManagedTemplate {
  templateId: string;
  code: string;
  type: 'storage' | 'switch';
  roles: StoragePlacementRole[];
  networkNames?: string[] | undefined;
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

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required.`);
  return value;
}

function identity(value: Obj, label: string): string {
  const id = typeof value['id'] === 'string' && value['id'].trim() ? value['id'] : undefined;
  const configurationId = typeof value['configurationId'] === 'string' && value['configurationId'].trim()
    ? value['configurationId']
    : undefined;
  if (id && configurationId && id !== configurationId) {
    throw new Error(`${label} has conflicting id and configurationId values.`);
  }
  return requiredString(configurationId ?? id, `${label} identity`);
}

function productCode(value: Obj, label: string): string {
  return requiredString(value['code'] ?? value['sliceCtoCode'] ?? value['lfoCode'], `${label} code`);
}

function normalizeDependency(value: unknown): Record<string, string[]> {
  if (value === undefined) return {};
  const source = object(value);
  if (!source) throw new Error('cloneDependency must be an object of identity arrays.');
  const output: Record<string, string[]> = {};
  const owners = new Map<string, string>();
  for (const [root, rawMembers] of Object.entries(source)) {
    requiredString(root, 'cloneDependency root');
    if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
      throw new Error(`cloneDependency group ${root} must be a nonempty identity array.`);
    }
    const members = rawMembers.map((member) => requiredString(member, `cloneDependency member of ${root}`));
    if (new Set(members).size !== members.length) {
      throw new Error(`cloneDependency group ${root} contains duplicate identities.`);
    }
    for (const member of members) {
      const owner = owners.get(member);
      if (owner && owner !== root) throw new Error(`cloneDependency identity ${member} belongs to multiple groups.`);
      owners.set(member, root);
    }
    output[root] = [...members];
  }
  return output;
}

function appendAlias(dependency: Record<string, string[]>, templateId: string, physicalId: string): void {
  for (const [root, members] of Object.entries(dependency)) {
    if (root === physicalId || members.includes(physicalId)) {
      throw new Error(`Physical storage identity ${physicalId} already belongs to dependency group ${root}.`);
    }
  }
  const foreignRoot = Object.entries(dependency)
    .find(([root, members]) => root !== templateId && members.includes(templateId));
  if (foreignRoot) {
    throw new Error(`Storage template ${templateId} is nested under dependency root ${foreignRoot[0]}; ` +
      'the captured storage placement contract requires the template to be the group root.');
  }
  const members = dependency[templateId] ?? [templateId];
  if (members[0] !== templateId || !members.includes(templateId)) {
    throw new Error(`Storage template dependency group ${templateId} must begin with its template identity.`);
  }
  dependency[templateId] = [...members, physicalId];
}

function allPhysicalIds(rackArea: RackObject[], nonRackArea: RackObject[]): Set<string> {
  const ids = new Set<string>();
  const add = (value: Obj, label: string): void => {
    const id = identity(value, label);
    if (ids.has(id)) throw new Error(`Physical identity ${id} occurs more than once in the workspace.`);
    ids.add(id);
  };
  for (const rack of rackArea) {
    add(rack, 'Rack');
    for (const item of objects(rack['rackItems'])) add(item, 'Rack item');
  }
  for (const item of nonRackArea) add(item, 'Non-rack item');
  return ids;
}

function selectedComponents(network: StorageConnectionNetwork): Array<{
  role: StoragePlacementRole; templateId: string; option: string; type: 'storage' | 'switch';
}> {
  const expansion = object(network.expansion);
  if (typeof expansion?.['option'] === 'string' && expansion['option'].trim()) {
    throw new Error('Physical storage expansion placement is not captured yet. Choose a definition with no expansion.');
  }
  const selected: Array<{
    role: StoragePlacementRole; templateId: string; option: string; type: 'storage' | 'switch';
  }> = [];
  for (const [role, type] of [['controller', 'storage'], ['mainSwitch', 'switch']] as const) {
    const component = object(network[role]);
    const option = typeof component?.['option'] === 'string' ? component['option'].trim() : '';
    if (!option) {
      if (role === 'controller') throw new Error(`Storage network "${network.name}" has no controller selection.`);
      continue;
    }
    if (component?.['hardwareType'] !== type) {
      throw new Error(`Storage network "${network.name}" has invalid ${role} hardwareType.`);
    }
    selected.push({ role, type, option, templateId: requiredString(component['id'], `${role} template id`) });
  }
  return selected;
}

function physicalMetadata(value: RackObject): Pick<StoragePhysicalItem, 'originalId' | 'controllerExpansion'> {
  const originalId = typeof value['originalId'] === 'string' && value['originalId'].trim()
    ? value['originalId']
    : undefined;
  const controllerExpansion = object(value['controllerExpansion']);
  return {
    ...(originalId ? { originalId } : {}),
    ...(controllerExpansion ? { controllerExpansion: structuredClone(controllerExpansion) } : {}),
  };
}

/**
 * Stages the browser's `+ Storage Network` rack action.
 *
 * The managed controller/SAN-switch configurations remain templates. Each action creates fresh
 * physical aliases at requested U1, extends cloneDependency from template to physical identity,
 * and lets `/ctos/racks/customize` authoritatively size and arrange them.
 */
export function stageStorageNetworkPlacement(
  options: StageStorageNetworkPlacementOptions,
): StagedStorageNetworkPlacement {
  const rackArea = structuredClone(options.rackArea);
  const nonRackArea = structuredClone(options.nonRackArea);
  const rackMatches = rackArea.filter((rack) => identity(rack, 'Rack') === options.rackId);
  if (rackMatches.length !== 1) {
    throw new Error(`Rack ${options.rackId} is ${rackMatches.length ? 'ambiguous' : 'unknown'}.`);
  }
  const networkMatches = options.storageConnectionNetworks.filter((network) => network.name === options.networkName);
  if (networkMatches.length !== 1) {
    throw new Error(`Storage network "${options.networkName}" is ${networkMatches.length ? 'ambiguous' : 'unknown'}.`);
  }
  const selected = selectedComponents(networkMatches[0]!);
  if (options.components.length !== selected.length) {
    throw new Error(`Storage network "${options.networkName}" requires ${selected.length} placement components.`);
  }
  const physicalIds = allPhysicalIds(rackArea, nonRackArea);
  const dependency = normalizeDependency(options.cloneDependency);
  const seenRoles = new Set<StoragePlacementRole>();
  const physicalItems: StoragePhysicalItem[] = [];
  const physicalToTemplate: Record<string, string> = {};
  const wireConfigurations: RackConfigurationWire[] = [];
  const target = rackMatches[0]!;
  const existing = objects(target['rackItems']);

  for (const input of options.components) {
    if (seenRoles.has(input.role)) throw new Error(`Storage placement repeats component role ${input.role}.`);
    seenRoles.add(input.role);
    const expected = selected.find((component) => component.role === input.role);
    if (!expected) throw new Error(`Storage network "${options.networkName}" does not select ${input.role}.`);
    const physicalId = requiredString(input.physicalId, `${input.role} physical id`);
    if (physicalIds.has(physicalId) || physicalToTemplate[physicalId]) {
      throw new Error(`Physical storage identity ${physicalId} already exists in the workspace.`);
    }
    const templateId = identity(input.configuration, `${input.role} template`);
    const code = productCode(input.configuration, `${input.role} template`);
    if (templateId !== expected.templateId || code !== expected.option) {
      throw new Error(`${input.role} template ${templateId}/${code} does not match storage definition ` +
        `${expected.templateId}/${expected.option}.`);
    }
    if (input.configuration['type'] !== expected.type) {
      throw new Error(`${input.role} template ${templateId} launched as ${String(input.configuration['type'])}, not ${expected.type}.`);
    }
    const wire = buildRackConfigurations([input.configuration])[0]!;
    wireConfigurations.push(wire);
    const displayName = typeof input.configuration['name'] === 'string' && input.configuration['name'].trim()
      ? input.configuration['name']
      : input.role === 'controller' ? 'Controller' : 'Switch';
    const description = requiredString(input.configuration['description'], `${input.role} template description`);
    const raw: RackObject = {
      id: physicalId,
      code,
      type: expected.type,
      position: 1,
      features: wire.sections.map((section) => ({
        name: section.name,
        results: structuredClone(section.features),
      })),
      description,
      name: displayName,
    };
    existing.push(raw);
    appendAlias(dependency, templateId, physicalId);
    physicalIds.add(physicalId);
    physicalToTemplate[physicalId] = templateId;
    physicalItems.push({
      role: input.role, templateId, physicalId, rackId: options.rackId,
      requestedPosition: 1, raw: structuredClone(raw), ...physicalMetadata(raw),
    });
  }
  for (const expected of selected) {
    if (!seenRoles.has(expected.role)) throw new Error(`Storage placement omitted ${expected.role}.`);
  }
  target['rackItems'] = existing;
  return {
    rackArea,
    nonRackArea,
    cloneDependency: dependency,
    wireConfigurations,
    templateConfigurationIds: wireConfigurations.map((configuration) => configuration.id),
    physicalItems,
    physicalToTemplate,
  };
}

/** Validates DCSC's accepted layout and reports its authoritative placement metadata. */
export function parseStoragePlacementResponse(
  raw: unknown,
  staged: StagedStorageNetworkPlacement,
): AcceptedStoragePlacement[] {
  const state = object(raw);
  if (!state || !Array.isArray(state['rackArea']) || !Array.isArray(state['nonRackArea']) ||
      !Array.isArray(state['connections'])) {
    throw new Error('DCSC returned an incomplete storage placement layout.');
  }
  const found = new Map<string, { rackId: string; item: RackObject }[]>();
  for (const rack of objects(state['rackArea'])) {
    const rackId = identity(rack, 'Returned rack');
    for (const item of objects(rack['rackItems'])) {
      const id = identity(item, 'Returned rack item');
      const values = found.get(id) ?? [];
      values.push({ rackId, item });
      found.set(id, values);
    }
  }
  for (const item of objects(state['nonRackArea'])) {
    const id = identity(item, 'Returned non-rack item');
    const values = found.get(id) ?? [];
    values.push({ rackId: '', item });
    found.set(id, values);
  }
  return staged.physicalItems.map((expected) => {
    const matches = found.get(expected.physicalId) ?? [];
    if (matches.length !== 1 || matches[0]!.rackId !== expected.rackId) {
      throw new Error(`DCSC did not retain storage physical ${expected.physicalId} in rack ${expected.rackId}.`);
    }
    const item = matches[0]!.item;
    if (item['code'] !== expected.raw['code'] || item['type'] !== expected.raw['type']) {
      throw new Error(`DCSC returned conflicting product metadata for storage physical ${expected.physicalId}.`);
    }
    const position = Number(item['position']);
    const size = Number(item['size']);
    const quantity = Number(item['quantity']);
    if (!Number.isInteger(position) || position < 1 || !Number.isInteger(size) || size < 1 ||
        !Number.isInteger(quantity) || quantity < 0) {
      throw new Error(`DCSC returned incomplete placement metadata for storage physical ${expected.physicalId}.`);
    }
    return {
      role: expected.role,
      templateId: expected.templateId,
      physicalId: expected.physicalId,
      rackId: expected.rackId,
      position,
      size,
      quantity,
      raw: structuredClone(item),
      ...physicalMetadata(item),
    };
  });
}

/** Resolves physical storage aliases without turning them into independent configurations. */
export function resolveStoragePhysicalAliases(options: {
  rackArea: RackObject[];
  nonRackArea: RackObject[];
  storageConnectionNetworks: readonly StorageConnectionNetwork[];
  managedTemplates?: readonly AdditionalStorageManagedTemplate[] | undefined;
  cloneDependency?: unknown;
}): ResolvedStoragePhysicalAlias[] {
  const dependency = normalizeDependency(options.cloneDependency);
  const physical = new Map<string, { area: 'rack' | 'non-rack'; rackId?: string; raw: RackObject }>();
  const add = (item: RackObject, area: 'rack' | 'non-rack', rackId?: string): void => {
    const id = identity(item, `${area} storage item`);
    if (physical.has(id)) throw new Error(`Physical identity ${id} occurs more than once in the workspace.`);
    physical.set(id, { area, ...(rackId ? { rackId } : {}), raw: item });
  };
  for (const rack of options.rackArea) {
    const rackId = identity(rack, 'Rack');
    for (const item of objects(rack['rackItems'])) add(item, 'rack', rackId);
  }
  for (const item of options.nonRackArea) add(item, 'non-rack');

  const templates = new Map<string, {
    code: string; type: 'storage' | 'switch'; roles: Set<StoragePlacementRole>; networkNames: Set<string>;
  }>();
  for (const network of options.storageConnectionNetworks) {
    for (const role of ['controller', 'mainSwitch'] as const) {
      const selected = object(network[role]);
      const id = typeof selected?.['id'] === 'string' && selected['id'].trim() ? selected['id'] : undefined;
      const code = typeof selected?.['option'] === 'string' && selected['option'].trim() ? selected['option'] : undefined;
      if (!id || !code) continue;
      const type = role === 'controller' ? 'storage' : 'switch';
      if (selected?.['hardwareType'] !== type) {
        throw new Error(`Storage template ${id} has invalid ${role} hardwareType.`);
      }
      const current = templates.get(id);
      if (current && (current.code !== code || current.type !== type || !current.roles.has(role))) {
        throw new Error(`Storage template ${id} is referenced with conflicting code, type or component roles.`);
      }
      const value = current ?? {
        code, type, roles: new Set<StoragePlacementRole>(), networkNames: new Set<string>(),
      };
      value.roles.add(role);
      value.networkNames.add(network.name);
      templates.set(id, value);
    }
  }
  for (const reference of options.managedTemplates ?? []) {
    const templateId = requiredString(reference.templateId, 'Additional storage template id');
    const code = requiredString(reference.code, `Additional storage template ${templateId} code`);
    if (reference.type !== 'storage' && reference.type !== 'switch') {
      throw new Error(`Additional storage template ${templateId} has invalid type.`);
    }
    if (!Array.isArray(reference.roles) || reference.roles.length === 0 ||
        reference.roles.some(role => role !== 'controller' && role !== 'mainSwitch')) {
      throw new Error(`Additional storage template ${templateId} has invalid component roles.`);
    }
    const roles = new Set(reference.roles);
    if (roles.size !== reference.roles.length) {
      throw new Error(`Additional storage template ${templateId} repeats a component role.`);
    }
    if ([...roles].some(role => (role === 'controller' ? 'storage' : 'switch') !== reference.type)) {
      throw new Error(`Additional storage template ${templateId} has conflicting type and component roles.`);
    }
    const current = templates.get(templateId);
    if (current && (current.code !== code || current.type !== reference.type ||
        [...roles].some(role => !current.roles.has(role)))) {
      throw new Error(`Storage template ${templateId} is referenced with conflicting code, type or component roles.`);
    }
    const value = current ?? {
      code, type: reference.type, roles: new Set<StoragePlacementRole>(), networkNames: new Set<string>(),
    };
    for (const role of roles) value.roles.add(role);
    for (const name of reference.networkNames ?? []) {
      value.networkNames.add(requiredString(name, `Additional storage template ${templateId} network name`));
    }
    templates.set(templateId, value);
  }

  const resolved: ResolvedStoragePhysicalAlias[] = [];
  const claimed = new Map<string, string>();
  for (const [templateId, template] of templates) {
    const foreignRoot = Object.entries(dependency)
      .find(([root, members]) => root !== templateId && members.includes(templateId));
    if (foreignRoot) {
      throw new Error(`Storage template ${templateId} is nested under dependency root ${foreignRoot[0]}.`);
    }
    const members = dependency[templateId];
    if (members && (members[0] !== templateId || !members.includes(templateId))) {
      throw new Error(`Storage template dependency group ${templateId} must begin with its template identity.`);
    }
    for (const member of members ?? []) {
      if (member === templateId) continue;
      const placed = physical.get(member);
      if (!placed) {
        throw new Error(`Storage template ${templateId} aliases missing physical identity ${member}.`);
      }
      if (placed.raw['code'] !== template.code || placed.raw['type'] !== template.type) {
        throw new Error(`Storage physical identity ${member} does not match template ${templateId}'s code and type.`);
      }
      const previous = claimed.get(member);
      if (previous && previous !== templateId) {
        throw new Error(`Physical storage identity ${member} aliases multiple managed templates.`);
      }
      claimed.set(member, templateId);
      resolved.push({
        physicalId: member,
        templateId,
        roles: [...template.roles],
        networkNames: [...template.networkNames],
        area: placed.area,
        ...(placed.rackId ? { rackId: placed.rackId } : {}),
        raw: structuredClone(placed.raw),
        ...physicalMetadata(placed.raw),
      });
    }
  }
  return resolved;
}
