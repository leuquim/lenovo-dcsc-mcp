import type { RawConfiguration } from '../model/types.js';
import type { RackObject } from './rack.js';

type Obj = Record<string, unknown>;
interface Membership { code: string; quantity: number }

function objects(value: unknown): Obj[] {
  return Array.isArray(value) ? value.filter((item): item is Obj =>
    item !== null && typeof item === 'object' && !Array.isArray(item)) : [];
}

/**
 * The SPA's deriveGroupIdToConfiguration adds catalog-backed MI_P selections
 * locally before export. Group ordinals restart per rack (and loose area),
 * per chassis model, in physical position order. Linked chassis with the same
 * node configuration membership share an ordinal.
 */
export function projectChassisManufacturing(input: {
  rackArea: readonly RackObject[];
  nonRackArea: readonly RackObject[];
  configurations: readonly RawConfiguration[];
  cloneDependencyColor?: unknown;
}): RawConfiguration[] {
  const roots = new Map<string, string>();
  const colors = input.cloneDependencyColor;
  if (colors && typeof colors === 'object' && !Array.isArray(colors)) {
    for (const [root, color] of Object.entries(colors)) {
      const members = (color as Obj | null)?.dependBy;
      if (Array.isArray(members)) for (const id of members) if (typeof id === 'string') roots.set(id, root);
    }
  }
  const memberships = new Map<string, Membership>();
  const physical = new Map<string, Obj>();
  const rootOf = (item: Obj): string => roots.get(String(item.id)) ?? String(item.id);
  for (const area of [...input.rackArea.map(rack => objects(rack.rackItems)), input.nonRackArea]) {
    const counters = new Map<string, number>();
    const groups = new Map<string, number>();
    for (const item of [...area].sort((a, b) => Number(a.position ?? Infinity) - Number(b.position ?? Infinity))) {
      physical.set(String(item.id), item);
      if (item.type !== 'chassis') continue;
      const nodes = objects(item.nodes);
      for (const node of nodes) physical.set(String(node.id), node);
      const model = String(item.chassisModel ?? '');
      const key = JSON.stringify([rootOf(item), model, item.shipUninstalled === true,
        nodes.map(rootOf).sort()]);
      let ordinal = groups.get(key);
      if (ordinal === undefined) {
        ordinal = (counters.get(model) ?? 0) + 1;
        counters.set(model, ordinal);
        groups.set(key, ordinal);
      }
      if (ordinal > 99) throw new Error('DCSC chassis group metadata supports at most 99 groups per model and area.');
      const code = `${model === 'flex' ? '33' : '75'}${String(ordinal).padStart(2, '0')}`;
      if (nodes.length > 0) memberships.set(String(item.id), { code, quantity: model === 'flex' ? 1 : nodes.length });
      for (const node of nodes) memberships.set(String(node.id), { code, quantity: 1 });
    }
  }
  return input.configurations.map(source => {
    const item = physical.get(String(source.id));
    if (!item || item.type !== 'chassis' && item.type !== 'node') return source;
    const configuration = structuredClone(source);
    const sections = objects(configuration.unSelectableCharacters);
    const section = sections.find(value => value.name === 'MI_P');
    if (!section) return configuration;
    const membership = memberships.get(String(source.id));
    const prefix = membership?.code.slice(0, 2) ?? (item.chassisModel === 'flex' ? '33' : '75');
    section.results = objects(section.results).filter(result => !String(result.code).startsWith(prefix));
    if (membership && objects(section.features).some(feature => feature.code === membership.code)) {
      (section.results as Obj[]).push({ code: membership.code, quantity: membership.quantity });
    }
    const selected = objects(configuration.unSelectableCharacterResults).find(value => value.characterName === 'MI_P');
    if (selected) selected.results = structuredClone(section.results);
    return configuration;
  });
}
