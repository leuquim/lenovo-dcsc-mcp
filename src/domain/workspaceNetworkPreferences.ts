import type { FabricOptions, NetworkType } from './fabric.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};

/** Current workspace choices include the SPA's imported cluster-preference form.
 * Native convertClusterPreference2NetworkType restores these fields before editing. */
export function workspaceNetworkTypes(fabric: FabricOptions, state: Obj): NetworkType[] {
  const result = structuredClone(fabric.networkTypes);
  const networking = object(state.networkingInformation);
  const previous = object(state.autoConnectState);
  const cluster = state.clusterPreference ?? previous.clusterPreference ?? networking.clusterPreference;
  if (cluster !== undefined && !Array.isArray(cluster)) throw new Error('Saved cluster preferences must be an array.');
  for (const value of (cluster ?? []) as unknown[]) {
    const entry = object(value);
    if (typeof entry.name !== 'string' || !entry.name) throw new Error('Saved network preference has no name.');
    const matches = result.filter(network => network.name === entry.name);
    if (matches.length > 1) throw new Error(`Saved network "${entry.name}" matches multiple catalog records.`);
    const base = matches[0];
    const restored: NetworkType = { ...base,
      id: base?.id ?? `network-type:${entry.name}`, name: entry.name,
      defaultNetworkTechnology: String(entry.networkType ?? base?.defaultNetworkTechnology ?? ''),
      defaultLayout: String(entry.networkLayout ?? base?.defaultLayout ?? ''),
    };
    const fields = {
      defaultCableColor: 'cableColor', defaultCableType: 'cableType', defaultVlan: 'vlan',
      mainSwitchTrunks: 'trunks', leafSwitchTrunks: 'leafTrunks', customCable: 'customCable',
      defaultLeafCableColor: 'leafCableColor', defaultLeafCableType: 'leafCableType', defaultLeafCabling: 'leafCabling',
    };
    for (const [target, source] of Object.entries(fields)) {
      if (entry[source] !== undefined) restored[target] = structuredClone(entry[source]);
    }
    for (const role of ['main', 'leaf'] as const) {
      if (entry[`${role}Switch`] !== undefined) {
        const device = object(entry[`${role}Switch`]);
        restored[role === 'main' ? 'defaultMainSwitch' : 'defaultLeafSwitch'] = device.feature ?? '';
        restored[role === 'main' ? 'defaultMainSwitchOption' : 'defaultLeafSwitchOption'] = device.option ?? '';
      }
    }
    if (base) result[result.indexOf(base)] = restored;
    else result.push(restored);
  }
  if (state.networkTypes !== undefined && !Array.isArray(state.networkTypes)) throw new Error('Saved network types must be an array.');
  for (const value of (state.networkTypes ?? []) as unknown[]) {
    const entry = object(value);
    if (!['id', 'name', 'defaultNetworkTechnology', 'defaultLayout'].every(key => typeof entry[key] === 'string')) {
      throw new Error('Saved network type is malformed. Inspect the recovery snapshot before editing it.');
    }
    const index = result.findIndex(network => network.id === entry.id);
    if (index < 0) result.push(structuredClone(entry) as NetworkType);
    else result[index] = { ...result[index], ...structuredClone(entry) } as NetworkType;
  }
  return result;
}
