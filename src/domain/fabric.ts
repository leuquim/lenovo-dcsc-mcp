import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import { nonEmptyString, type Obj, objectOrEmpty } from '../util/coerce.js';


/** Every option retains the fields DCSC returned; `id` is a stable client key. */
export interface FabricOption extends Obj { id: string }
export interface NetworkTopology extends FabricOption { shortName: string; description: string }
export interface NetworkDevice extends FabricOption {
  option: string; feature: string; description: string; topologies: string[];
  topologyConnectors: Record<string, number>;
}
export interface NetworkType extends FabricOption {
  name: string; defaultNetworkTechnology: string; defaultLayout: string;
}
export interface CableOption extends FabricOption {
  featureCode: string; description: string; topologies: string[]; compatibility: string[];
}
export interface SelectedService extends FabricOption { featureCode: string; description: string }
export interface NodeRole extends FabricOption { role: string; description: string }
export interface LeafNodeCabling extends FabricOption { description: string }
export interface StorageSwitch extends FabricOption {
  option: string; featureCode?: string | undefined; description: string; price?: number | undefined;
}
export interface StorageController extends FabricOption {
  option: string; featureCode?: string | undefined; description: string; expansions: unknown[];
  price?: number | undefined;
}

export interface FabricOptions {
  topologies: NetworkTopology[];
  networkDevices: NetworkDevice[];
  networkTypes: NetworkType[];
  cables: CableOption[];
  selectedServices: SelectedService[];
  nodeRoles: NodeRole[];
  /** Browser radio choices returned by getTopologies. Older fixtures may omit them. */
  leafNodeCabling?: LeafNodeCabling[] | undefined;
  storageSwitches: StorageSwitch[];
  storageControllers: StorageController[];
}
export interface FabricPage<T> {
  items: T[]; total: number; offset: number; limit: number; nextOffset?: number | undefined;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((item): item is string => typeof item === 'string') : [];
}
function numericMap(v: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(objectOrEmpty(v)).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  );
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Obj).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
function hash(value: unknown): string {
  let result = 0x811c9dc5;
  for (const char of stableJson(value)) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(36);
}
function id(prefix: string, value: Obj, preferred: unknown[]): string {
  const key = preferred.map(nonEmptyString).filter(Boolean).join(':');
  return `${prefix}:${key || hash(value)}`;
}
function asArray(v: unknown): Obj[] {
  return Array.isArray(v) ? v.filter((item): item is Obj => typeof item === 'object' && item !== null) : [];
}

export async function fetchFabricOptions(
  http: DcscHttpClient,
  ctx: RequestCtx,
): Promise<FabricOptions> {
  const [topo, roles, storage] = await Promise.all([
    http.send({ endpoint: 'getTopologies', method: 'GET', path: '/getTopologies', responseKind: 'json', timeoutClass: 'fast', ctx }),
    http.send({ endpoint: 'node_roles', method: 'GET', path: '/node_roles', responseKind: 'json', timeoutClass: 'fast', ctx }),
    http.send({ endpoint: 'getStoragePreferences', method: 'GET', path: '/getStoragePreferences', responseKind: 'json', timeoutClass: 'fast', ctx }),
  ]);
  const topologyRoot = objectOrEmpty(topo.raw);
  const storageRoot = objectOrEmpty(storage.raw);

  const topologies = asArray(topologyRoot['networkTopology']).flatMap((source) => {
    const shortName = nonEmptyString(source['shortName']);
    return shortName ? [{ ...source, id: id('topology', source, [shortName]), shortName,
      description: nonEmptyString(source['description']) ?? shortName }] : [];
  });
  const networkDevices = asArray(topologyRoot['networkDevices']).flatMap((source) => {
    const option = nonEmptyString(source['option']);
    if (!option) return [];
    const feature = nonEmptyString(source['feature']) ?? '';
    return [{ ...source, id: id('network-device', source, [option, feature, source['description']]),
      option, feature, description: nonEmptyString(source['description']) ?? '',
      topologies: strings(source['topologies']), topologyConnectors: numericMap(source['topologyConnectors']) }];
  });
  const networkTypes = asArray(topologyRoot['networkType']).flatMap((source) => {
    const name = nonEmptyString(source['name']);
    return name ? [{ ...source, id: id('network-type', source, [name]), name,
      defaultNetworkTechnology: nonEmptyString(source['defaultNetworkTechnology']) ?? '',
      defaultLayout: nonEmptyString(source['defaultLayout']) ?? '' }] : [];
  });
  const cables = asArray(topologyRoot['cables']).map((source) => ({ ...source,
    id: id('cable', source, [source['featureCode'], source['option'], source['code'], hash(source)]),
    featureCode: nonEmptyString(source['featureCode']) ?? '', description: nonEmptyString(source['description']) ?? '',
    topologies: strings(source['topologies']), compatibility: strings(source['compatibility']) }));
  const selectedServices = asArray(topologyRoot['selectedServices']).map((source) => ({ ...source,
    id: id('network-service', source, [source['featureCode'], source['option'], hash(source)]),
    featureCode: nonEmptyString(source['featureCode']) ?? '', description: nonEmptyString(source['description']) ?? '' }));
  const leafNodeCabling = asArray(topologyRoot['leafNodeCabling']).flatMap((source) => {
    const description = nonEmptyString(source['description']);
    return description ? [{ ...source, id: id('leaf-cabling', source, [description]), description }] : [];
  });
  const nodeRoles = asArray(roles.raw).flatMap((source) => {
    const role = nonEmptyString(source['role']);
    return role ? [{ ...source, id: id('node-role', source, [role]), role,
      description: nonEmptyString(source['description']) ?? role }] : [];
  });
  const storageSwitches = asArray(storageRoot['switches']).flatMap((source) => {
    const option = nonEmptyString(source['option']);
    return option ? [{ ...source, id: id('storage-switch', source, [option, source['featureCode']]),
      option, featureCode: nonEmptyString(source['featureCode']), description: nonEmptyString(source['description']) ?? '',
      ...(typeof source['price'] === 'number' ? { price: source['price'] } : {}) }] : [];
  });
  const storageControllers = asArray(storageRoot['controllers']).flatMap((source) => {
    const option = nonEmptyString(source['option']);
    return option ? [{ ...source, id: id('storage-controller', source, [option, source['featureCode']]),
      option, featureCode: nonEmptyString(source['featureCode']), description: nonEmptyString(source['description']) ?? '',
      expansions: Array.isArray(source['expansions']) ? source['expansions'] : [],
      ...(typeof source['price'] === 'number' ? { price: source['price'] } : {}) }] : [];
  });
  return { topologies, networkDevices, networkTypes, cables, selectedServices, nodeRoles,
    ...(Object.hasOwn(topologyRoot, 'leafNodeCabling') ? { leafNodeCabling } : {}),
    storageSwitches, storageControllers };
}
