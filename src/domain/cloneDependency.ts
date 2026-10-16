import { createHash } from 'node:crypto';

/** Stable presentation colors with the website's semantic identity membership. */
export function createCloneDependencyColor(rootId: string, members: readonly string[] = [rootId]): Record<string, unknown> {
  const hash = createHash('sha256').update(rootId).digest();
  const rgb = { r: 96 + hash[0]! % 144, g: 96 + hash[1]! % 144, b: 96 + hash[2]! % 144 };
  const dark = { r: Math.floor(rgb.r * 0.65), g: Math.floor(rgb.g * 0.65), b: Math.floor(rgb.b * 0.65) };
  const hex = (value: typeof rgb) => '#' + [value.r, value.g, value.b].map(channel => channel.toString(16).padStart(2, '0')).join('');
  return { color: hex(rgb), darkColor: hex(dark), colorRGB: rgb, darkColorRGB: dark, dependBy: [...members] };
}

/** Preserve accepted clone groups while adding independent configurations. */
export function projectCloneDependency(value: unknown, configurationIds: readonly string[],
  physicalAliases: ReadonlySet<string> = new Set()): Record<string, string[]> {
  const roots = new Set(configurationIds);
  const ids = new Set([...configurationIds, ...physicalAliases]);
  const result: Record<string, string[]> = {};
  const owners = new Map<string, string>();
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('Workspace cloneDependency must be an object of configuration identity arrays.');
  }
  for (const [root, members] of Object.entries(value ?? {})) {
    if (!Array.isArray(members) || members.some(id => typeof id !== 'string')) {
      throw new Error(`Clone dependency ${root} has invalid members.`);
    }
    if (!roots.has(root)) continue;
    const retained = [...new Set([root, ...members.filter(id => ids.has(id))])];
    for (const id of retained) {
      const owner = owners.get(id);
      if (owner !== undefined && owner !== root) throw new Error(`Configuration ${id} belongs to multiple clone groups.`);
      owners.set(id, root);
    }
    result[root] = retained;
  }
  for (const id of roots) if (!owners.has(id)) result[id] = [id];
  return result;
}
