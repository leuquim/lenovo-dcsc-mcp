import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import type { RawConfiguration } from '../model/types.js';
import type { CableLink } from '../session/SessionStore.js';
import { DEFAULT_FLOOR_PREFERENCE } from './floor.js';
import type { NetworkDevice, NetworkType } from './fabric.js';
import type { RackObject } from './rack.js';

type Obj = Record<string, unknown>;

export interface ConnectionSummary {
  id: string;
  fromId?: string | undefined; toId?: string | undefined;
  fromPort?: string | undefined; toPort?: string | undefined;
  sourcePortName?: string | undefined; sourcePortNumber?: string | undefined;
  destinationPortName?: string | undefined; destinationPortNumber?: string | undefined;
  cableCode?: string | undefined; description?: string | undefined;
  network?: string | undefined; topology?: string | undefined;
  raw: Obj;
}
export interface AutoConnectSettings extends Obj {
  autoAddPDU?: boolean | undefined; autoAddSwitch?: boolean | undefined; p2pCabling?: boolean | undefined;
}
export type AutoConnectSettingsPatch = Pick<AutoConnectSettings, 'autoAddPDU' | 'autoAddSwitch' | 'p2pCabling'>;

/** Import/export stores these toggles in customizingFlags; live requests use settings. */
export function readAutoConnectSettings(state: Obj): AutoConnectSettings {
  const flags = object(state['customizingFlags']);
  const imported = Object.fromEntries(['autoAddPDU', 'autoAddSwitch', 'p2pCabling']
    .filter(key => typeof flags[key] === 'boolean').map(key => [key, flags[key]]));
  return structuredClone({ ...imported,
    ...object(object(state['networkingInformation'])['autoConnectSettings']),
    ...object(object(state['autoConnectState'])['autoConnectSettings']),
    ...object(state['autoConnectSettings']),
  });
}

/** Canonical live graph takes precedence, including an authoritative empty array. */
export function readConnectionGraph(state: Obj): unknown[] {
  const networking = object(state['networkingInformation']);
  for (const value of [state['connections'], object(state['autoConnectState'])['connections'],
    state['autoConnectResults'], networking['autoConnectResults'], networking['connections']]) {
    if (Array.isArray(value)) return structuredClone(value);
  }
  return [];
}

/** Retain the last graph for inspection, but never export it as a current design. */
export function invalidateConnectionGraph(state: Obj, reason: string): void {
  if (readConnectionGraph(state).length > 0) state['connectionGraphInvalidation'] = { reason };
}

export function assertCurrentConnectionGraph(state: Obj): void {
  if (state['connectionGraphInvalidation'] !== undefined) {
    throw new Error('The saved connection graph predates a workspace change. Run dcsc_add_cabling with the workspace session and mode="auto" before exporting or validating the workspace.');
  }
}

export function readSwitchMap(state: Obj): unknown[] {
  for (const value of [state['switchMap'], object(state['autoConnectState'])['switchMap'],
    object(state['networkingInformation'])['switchMap']]) {
    if (Array.isArray(value)) return structuredClone(value);
  }
  return [];
}

/** Captured SPA export groups by cablePart; AI/HPC excludes Power connections. */
export function buildCableGroups(connections: readonly unknown[], includePower: boolean): Obj[] {
  const groups = new Map<string, { code: string; description?: string; quantity: number }>();
  for (const value of connections) {
    const connection = object(value);
    if (!includePower && connection['network'] === 'Power') continue;
    const code = str(connection['cablePart']);
    if (!code) throw new Error('Cannot export a connection without its selected cable part. Re-run auto-connect.');
    const existing = groups.get(code);
    if (existing) existing.quantity += 1;
    else {
      const description = str(connection['cableType']);
      groups.set(code, { code, ...(description === undefined ? {} : { description }), quantity: 1 });
    }
  }
  return [...groups.values()];
}

/** Website settings are a partial edit; retain imported settings we do not expose. */
export function mergeAutoConnectSettings(current: unknown, patch: AutoConnectSettingsPatch): AutoConnectSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Auto-connect settings must be an object of boolean options.');
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!['autoAddPDU', 'autoAddSwitch', 'p2pCabling'].includes(key) || typeof value !== 'boolean') {
      throw new Error(`Invalid auto-connect setting ${key}; use boolean autoAddPDU, autoAddSwitch or p2pCabling.`);
    }
  }
  return { ...structuredClone(object(current)), ...patch };
}
/** Full SPA request state. Unknown/new DCSC keys pass through unchanged. */
export interface AutoConnectPayload extends Obj {
  rackArea: RackObject[];
  nonRackArea?: RackObject[] | undefined;
  configurations: RawConfiguration[];
  controllerExpansionMap?: Obj | undefined;
  floorPreference?: Obj | undefined;
  floorItems?: unknown[] | undefined;
  clusterPreference?: unknown[] | undefined;
  powerPreference?: unknown[] | undefined;
  storageConnectionNetworks?: unknown[] | undefined;
  cloneRackMapping?: Obj | undefined;
  connections?: unknown[] | undefined;
  autoConnectSettings?: AutoConnectSettings | undefined;
  switchMap?: unknown[] | undefined;
  virtualContainerIdMapping?: Obj | undefined;
  virtualContainerRule2ConfigMapping?: Obj | undefined;
  virtualContainerInvalidRuleIdMapping?: Obj | undefined;
  vlhItems?: unknown[] | undefined;
  cloneDependency?: Record<string, string[]> | undefined;
}
export interface AutoConnectResult {
  settings: AutoConnectSettings;
  connections: ConnectionSummary[];
  cables: CableLink[];
  rawRackArea: RackObject[];
  rawNonRackArea: RackObject[];
  rawConnections: unknown[];
  errors: unknown[];
  rawState: Obj;
  messages: Array<{ rackId: string; messages: string[] }>;
}

/** One projection for graphs returned by either auto-connect or rack customization. */
export function projectConnectionGraph(rawConnections: readonly unknown[]): {
  connections: ConnectionSummary[]; cables: CableLink[];
} {
  const connections = rawConnections.map(summariseConnection);
  return { connections, cables: connections.map(toCableLink) };
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v !== '') return v;
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;
}
function object(v: unknown): Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}
function makeCloneDependency(configurations: RawConfiguration[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const configuration of configurations) {
    const id = str(configuration['id']) ?? str((configuration as Obj)['configurationId']);
    if (id) result[id] = [id];
  }
  return result;
}

/** Mirrors the SPA's converNetworkTopologies2ClusterPreference adapter. */
export function buildClusterPreferences(
  networkDevices: readonly NetworkDevice[],
  networkTypes: readonly NetworkType[],
): Obj[] {
  const find = (feature: unknown, option: unknown): NetworkDevice | undefined =>
    networkDevices.find((device) => device.feature === feature && device.option === option);
  return networkTypes.map((network) => {
    const main = find(network['defaultMainSwitch'], network['defaultMainSwitchOption']);
    const leaf = find(network['defaultLeafSwitch'], network['defaultLeafSwitchOption']);
    const topology = str(network['defaultNetworkTechnology']) ?? '';
    const base: Obj = {
      cableColor: network['defaultCableColor'], cableType: network['defaultCableType'],
      mainSwitch: main ? { feature: main.feature, option: main.option, topologyConnectors: main.topologyConnectors } : {},
      maximumPorts: main?.topologyConnectors[topology], name: network.name,
      networkLayout: network.defaultLayout, networkType: topology,
      trunks: network['mainSwitchTrunks'], vlan: Array.isArray(network['defaultVlan']) ? network['defaultVlan'] : [],
      customCable: network['customCable'],
    };
    if (network.defaultLayout === 'Centralized') {
      return { ...base, leafCableColor: network['defaultLeafCableColor'], leafCableType: '',
        leafSwitch: {}, leafMaximumPorts: 0, leafTrunks: 0, leafCabling: '' };
    }
    return { ...base, leafCableColor: network['defaultLeafCableColor'],
      leafCableType: network['defaultLeafCableType'],
      leafSwitch: leaf ? { feature: leaf.feature, option: leaf.option, topologyConnectors: leaf.topologyConnectors } : {},
      leafMaximumPorts: leaf?.topologyConnectors[topology], leafTrunks: network['leafSwitchTrunks'] ?? 0,
      leafCabling: network['defaultLeafCabling'] ?? '' };
  });
}

/** Captured automatic-switch map: calculation calls the role usage, export calls it type. */
export function buildSwitchMapEntry(id: string, network: string, usage: 'main' | 'leaf', code: string) {
  return { id, network, type: usage, code } as const;
}

/** Exact /auto_connect request shape: the SPA never seeds regeneration with prior graph rows. */
export function buildAutoConnectRequest(payload: AutoConnectPayload): AutoConnectPayload {
  const requestState: AutoConnectPayload = {
    nonRackArea: [], controllerExpansionMap: {}, floorPreference: DEFAULT_FLOOR_PREFERENCE,
    floorItems: [], clusterPreference: [], powerPreference: [], storageConnectionNetworks: [],
    cloneRackMapping: {}, autoConnectSettings: {}, switchMap: [],
    virtualContainerIdMapping: {}, virtualContainerRule2ConfigMapping: {},
    virtualContainerInvalidRuleIdMapping: {}, vlhItems: [],
    cloneDependency: makeCloneDependency(payload.configurations),
    ...structuredClone(payload),
  };
  // Keep stale/manual rows in local state until the transaction accepts the
  // response, but never let them influence the complete recalculation.
  delete requestState.connections;
  return requestState;
}

export async function autoConnect(
  http: DcscHttpClient,
  ctx: RequestCtx,
  payload: AutoConnectPayload,
  query?: { autoArrange: boolean; autoConnect: boolean; cogValidation: boolean },
): Promise<AutoConnectResult> {
  if (payload.rackArea.length === 0 && (payload.nonRackArea?.length ?? 0) === 0) {
    throw new Error('Nothing to cable: the workspace has no racks or non-rack items. Add and place products first.');
  }
  const requestState = buildAutoConnectRequest(payload);
  const res = await http.send({ endpoint: 'auto_connect', method: 'POST', path: '/auto_connect', query,
    body: { kind: 'json', value: requestState }, responseKind: 'json', timeoutClass: 'heavy', ctx });
  const rawState = object(res.raw);
  const rawConnections = Array.isArray(rawState['connections']) ? rawState['connections'] : [];
  const { connections, cables } = projectConnectionGraph(rawConnections);
  const rackArea = Array.isArray(rawState['rackArea']) ? rawState['rackArea'] as RackObject[] : payload.rackArea;
  const nonRackArea = Array.isArray(rawState['nonRackArea']) ? rawState['nonRackArea'] as RackObject[] : payload.nonRackArea ?? [];
  return { settings: structuredClone(requestState.autoConnectSettings ?? {}),
    connections, cables, rawRackArea: rackArea,
    rawNonRackArea: nonRackArea, rawConnections,
    errors: Array.isArray(rawState['errors']) ? rawState['errors'] : [], rawState,
    messages: extractAutoConnectMessages(rackArea) };
}

function summariseConnection(value: unknown): ConnectionSummary {
  const raw = object(value);
  const fromId = str(raw['sourceId']); const toId = str(raw['destinationId']);
  const sourcePortName = str(raw['sourcePortName']); const sourcePortNumber = str(raw['sourcePortNumber']);
  const destinationPortName = str(raw['destinationPortName']);
  const destinationPortNumber = str(raw['destinationPortNumber']);
  const cableCode = str(raw['cablePart']); const description = str(raw['cableType']);
  const network = str(raw['network']); const topology = str(raw['topology']);
  const key = [cableCode, sourcePortName, sourcePortNumber, fromId,
    destinationPortName, destinationPortNumber, toId].filter(Boolean).join(':');
  return { id: str(raw['id']) ?? (key || 'connection'), fromId, toId,
    fromPort: [sourcePortName, sourcePortNumber].filter(Boolean).join(' - ') || undefined,
    toPort: [destinationPortName, destinationPortNumber].filter(Boolean).join(' - ') || undefined,
    sourcePortName, sourcePortNumber, destinationPortName, destinationPortNumber,
    cableCode, description, network, topology, raw };
}
function toCableLink(connection: ConnectionSummary): CableLink {
  return { id: connection.id, fromConfigId: connection.fromId ?? '', fromPort: connection.fromPort ?? '',
    toConfigId: connection.toId ?? '', toPort: connection.toPort ?? '',
    ...(connection.cableCode !== undefined ? { cableCode: connection.cableCode } : {}),
    ...(connection.description !== undefined ? { description: connection.description } : {}) };
}
function extractAutoConnectMessages(rackArea: RackObject[]): Array<{ rackId: string; messages: string[] }> {
  const out: Array<{ rackId: string; messages: string[] }> = [];
  for (const rack of rackArea) {
    const errors = rack['errors'];
    if (!Array.isArray(errors)) continue;
    const messages = errors.filter((error) => String(object(error)['code'] ?? '') === '102')
      .map((error) => String(object(error)['message'] ?? '')).filter(Boolean);
    if (messages.length > 0) out.push({ rackId: String(rack['id'] ?? ''), messages });
  }
  return out;
}
