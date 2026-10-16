import { buildClusterPreferences } from './cabling.js';
import type {
  CableOption,
  FabricOptions,
  NetworkDevice,
  NetworkTopology,
  NetworkType,
} from './fabric.js';

type Obj = Record<string, unknown>;

export interface ConnectorChoice {
  /** Stable key accepted by `connectorIds`. */
  id: string;
  port: string;
  portNumber: string;
  description: string;
  raw: Obj;
}

export interface TopologySelectionInput {
  /** A topology stable ID or short name. */
  topology: string;
  /** A network-type stable ID or name. Required when several networks are eligible. */
  networkName?: string | undefined;
  /** Stable IDs returned by `listTopologyConnectors`. */
  connectorIds?: readonly string[] | undefined;
  /** Port number, port name, or `port:portNumber`. Each value must identify one connector. */
  ports?: readonly string[] | undefined;
}

export interface WorkspaceNetworkSelection {
  /** Stable network-type ID. */
  networkTypeId: string;
  /** Optional topology stable ID or short name; otherwise the network's current default is used. */
  topology?: string | undefined;
  mainDeviceId?: string | undefined;
  leafDeviceId?: string | undefined;
  cableId?: string | undefined;
  leafCableId?: string | undefined;
  /** Empty string clears the color preference, matching the website's unselected color. */
  cableColor?: string | undefined;
  leafCableColor?: string | undefined;
  /** Website layout choice. Changing it clears existing VLAN joins. */
  layout?: 'Centralized' | 'Distributed' | undefined;
  mainTrunks?: number | undefined;
  leafTrunks?: number | undefined;
  /** Exact description returned by the leaf-node-cabling catalog. */
  leafCabling?: string | undefined;
  /** Stable IDs of other network records joined to this centralized main switch. */
  vlanNetworkTypeIds?: readonly string[] | undefined;
  /** Stable custom-cable ID, or `manual-cable` to clear it. Valid only without a main switch. */
  customCableId?: string | undefined;
}

export interface ResolvedWorkspaceNetworkSelection {
  networkTypeId: string;
  topologyId: string;
  mainDeviceId?: string | undefined;
  leafDeviceId?: string | undefined;
  cableId?: string | undefined;
  leafCableId?: string | undefined;
  /** Empty string clears the color preference, matching the website's unselected color. */
  cableColor?: string | undefined;
  leafCableColor?: string | undefined;
  layout: 'Centralized' | 'Distributed';
  mainTrunks: number;
  leafTrunks: number;
  leafCabling?: string | undefined;
  vlanNetworkTypeIds: string[];
  customCableId?: string | undefined;
}

export interface WorkspaceNetworkPreferences {
  /** Validated network records consumed by the SPA cluster-preference adapter. */
  networkTypes: NetworkType[];
  clusterPreference: Obj[];
  selections: ResolvedWorkspaceNetworkSelection[];
}

function object(value: unknown): Obj | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Obj
    : undefined;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function keyPart(value: unknown): string {
  return encodeURIComponent(str(value));
}

function connectorId(connector: Obj): string {
  return `connector:${keyPart(connector['port'])}:${keyPart(connector['portNumber'])}:` +
    `${keyPart(connector['sourceFeature'])}:${keyPart(connector['connectorFunction'])}`;
}

function describeConnector(choice: ConnectorChoice): string {
  return `${choice.id} (${choice.description || choice.port}:${choice.portNumber || '?'})`;
}

function resolveTopology(fabric: FabricOptions, requested: string): NetworkTopology {
  const needle = requested.toLocaleLowerCase();
  const matches = fabric.topologies.filter((item) =>
    item.id.toLocaleLowerCase() === needle || item.shortName.toLocaleLowerCase() === needle);
  if (matches.length === 1) return matches[0]!;
  const available = fabric.topologies.map((item) => `${item.id} (${item.shortName})`).join(', ') || 'none';
  if (matches.length === 0) throw new Error(`Unknown network topology "${requested}". Available: ${available}.`);
  throw new Error(`Network topology "${requested}" is ambiguous. Use one of these stable IDs: ${available}.`);
}

function topologyChoices(rawConfiguration: Obj, topology: NetworkTopology): ConnectorChoice[] {
  const connectors = Array.isArray(rawConfiguration['connectors'])
    ? rawConfiguration['connectors'].flatMap((value): Obj[] => object(value) ? [object(value)!] : [])
    : [];
  return connectors.filter((connector) => strings(connector['topologies']).includes(topology.shortName))
    .map((connector) => ({
      id: connectorId(connector),
      port: str(connector['port']),
      portNumber: str(connector['portNumber']),
      description: str(connector['portDescription']),
      raw: structuredClone(connector),
    }));
}

/** Lists the exact connector DTOs that may be selected for a configuration/topology. */
export function listTopologyConnectors(
  rawConfiguration: Obj,
  fabric: FabricOptions,
  topology: string,
): ConnectorChoice[] {
  return topologyChoices(rawConfiguration, resolveTopology(fabric, topology));
}

function resolveNetwork(
  fabric: FabricOptions,
  topology: NetworkTopology,
  requested: string | undefined,
): NetworkType {
  const candidates = requested === undefined
    ? fabric.networkTypes.filter((item) => item.defaultNetworkTechnology === topology.shortName)
    : fabric.networkTypes.filter((item) => item.id === requested || item.name === requested);
  if (candidates.length === 1) return candidates[0]!;
  const available = (requested === undefined ? candidates : fabric.networkTypes)
    .map((item) => `${item.id} (${item.name})`).join(', ') || 'none';
  if (candidates.length === 0) {
    if (requested === undefined) {
      throw new Error(`No network uses topology "${topology.shortName}" by default. Specify networkName. ` +
        `Available networks: ${fabric.networkTypes.map((item) => item.id).join(', ') || 'none'}.`);
    }
    throw new Error(`Unknown network "${requested}". Available: ${available}.`);
  }
  throw new Error(`Topology "${topology.shortName}" matches multiple networks. Specify networkName using one of: ${available}.`);
}

function resolveConnectors(
  choices: ConnectorChoice[],
  input: TopologySelectionInput,
): ConnectorChoice[] {
  const ids = input.connectorIds ?? [];
  const ports = input.ports ?? [];
  if (ids.length === 0 && ports.length === 0) {
    if (choices.length === 1) return choices;
    if (choices.length === 0) throw new Error(`No connectors support topology "${input.topology}".`);
    throw new Error(`Topology "${input.topology}" has multiple compatible connectors. ` +
      `Specify connectorIds or ports. Candidates: ${choices.map(describeConnector).join(', ')}.`);
  }

  const selected: ConnectorChoice[] = [];
  const select = (selector: string, matches: ConnectorChoice[], kind: string) => {
    if (matches.length === 1) {
      selected.push(matches[0]!);
      return;
    }
    const available = choices.map(describeConnector).join(', ') || 'none';
    if (matches.length === 0) throw new Error(`Unknown connector ${kind} "${selector}". Candidates: ${available}.`);
    throw new Error(`Connector ${kind} "${selector}" is ambiguous. Use a stable connector ID. Matches: ` +
      `${matches.map(describeConnector).join(', ')}.`);
  };
  for (const id of ids) select(id, choices.filter((choice) => choice.id === id), 'ID');
  for (const port of ports) {
    select(port, choices.filter((choice) => port === choice.portNumber || port === choice.port ||
      port === `${choice.port}:${choice.portNumber}` ||
      port === `${choice.description}:${choice.portNumber}`), 'port');
  }
  return unique(selected);
}

/**
 * Builds one configuration's SPA `selectedTopologies` map. Existing network entries and every
 * field of selected connector DTOs are preserved.
 */
export function buildSelectedTopologies(
  rawConfiguration: Obj,
  fabric: FabricOptions,
  input: TopologySelectionInput,
): Obj {
  const topology = resolveTopology(fabric, input.topology);
  const network = resolveNetwork(fabric, topology, input.networkName);
  const selected = resolveConnectors(topologyChoices(rawConfiguration, topology), input);
  const existingValue = rawConfiguration['selectedTopologies'];
  if (existingValue !== undefined && object(existingValue) === undefined) {
    throw new Error('Configuration selectedTopologies must be an object keyed by network name.');
  }
  const existing = structuredClone(object(existingValue) ?? {});
  existing[network.name] = {
    color: network['defaultCableColor'],
    maxConnectors: selected.length,
    connectors: selected.length,
    networkTechnology: topology.shortName,
    selectedConnectors: selected.map((choice) => structuredClone(choice.raw)),
  };
  return existing;
}

function candidatesText<T extends { id: string }>(items: readonly T[]): string {
  return items.map((item) => item.id).join(', ') || 'none';
}

function compatibleDevices(
  fabric: FabricOptions,
  topology: NetworkTopology,
  cable: CableOption | undefined,
): NetworkDevice[] {
  return fabric.networkDevices.filter((device) => device.topologies.includes(topology.shortName) &&
    (!cable || cable.compatibility.length === 0 || cable.compatibility.includes(device.option)));
}

function resolveDevice(
  fabric: FabricOptions,
  topology: NetworkTopology,
  cable: CableOption | undefined,
  requestedId: string | undefined,
  defaultFeature: unknown,
  defaultOption: unknown,
  role: 'main' | 'leaf',
  required: boolean,
): NetworkDevice | undefined {
  const compatible = compatibleDevices(fabric, topology, cable);
  let device: NetworkDevice | undefined;
  if (requestedId !== undefined) {
    const matches = fabric.networkDevices.filter((item) => item.id === requestedId);
    if (matches.length === 0) {
      throw new Error(`Unknown ${role} device ID "${requestedId}". Available: ${candidatesText(compatible)}.`);
    }
    if (matches.length > 1) {
      throw new Error(`${role[0]!.toUpperCase()}${role.slice(1)} device ID "${requestedId}" is not unique in ` +
        'the fabric catalog. Refresh the catalog before selecting it.');
    }
    device = matches[0];
  } else if (str(defaultFeature) || str(defaultOption)) {
    const matches = fabric.networkDevices.filter((item) =>
      item.feature === defaultFeature && item.option === defaultOption);
    if (matches.length === 0) {
      throw new Error(`The active network's default ${role} device ` +
        `(${str(defaultFeature) || '?'}/${str(defaultOption) || '?'}) is unavailable. ` +
        `Choose ${role}DeviceId from: ${candidatesText(compatible)}.`);
    }
    if (matches.length > 1) {
      throw new Error(`The active network's default ${role} device ` +
        `(${str(defaultFeature) || '?'}/${str(defaultOption) || '?'}) is ambiguous. ` +
        `Choose ${role}DeviceId from: ${candidatesText(matches)}.`);
    }
    device = matches[0];
  } else if (required) {
    throw new Error(`The active network requires a ${role} device. Choose ${role}DeviceId from: ` +
      `${candidatesText(compatible)}.`);
  }
  if (device && !compatible.some((item) => item.id === device!.id)) {
    throw new Error(`${role[0]!.toUpperCase()}${role.slice(1)} device "${device.id}" is incompatible with ` +
      `topology "${topology.shortName}"${cable ? ` and cable "${cable.id}"` : ''}. ` +
      `Choose from: ${candidatesText(compatible)}.`);
  }
  return device;
}

function cableCategory(cable: CableOption): string {
  return str(cable['category']);
}

function compatibleCables(fabric: FabricOptions, topology: NetworkTopology): CableOption[] {
  return fabric.cables.filter((cable) => cable.topologies.includes(topology.shortName));
}

function resolveCable(
  fabric: FabricOptions,
  topology: NetworkTopology,
  requestedId: string | undefined,
  currentCategory: unknown,
  field: 'cableId' | 'leafCableId',
): CableOption | undefined {
  const compatible = compatibleCables(fabric, topology);
  if (requestedId !== undefined) {
    const matches = fabric.cables.filter((item) => item.id === requestedId);
    if (matches.length === 0) {
      throw new Error(`Unknown ${field} "${requestedId}". Available: ${candidatesText(compatible)}.`);
    }
    if (matches.length > 1) {
      throw new Error(`${field} "${requestedId}" is not unique in the fabric catalog. Refresh the catalog before selecting it.`);
    }
    const cable = matches[0]!;
    if (!compatible.some((item) => item.id === cable.id)) {
      throw new Error(`Cable "${requestedId}" does not support topology "${topology.shortName}". ` +
        `Choose from: ${candidatesText(compatible)}.`);
    }
    if (!cableCategory(cable)) throw new Error(`Cable "${requestedId}" has no category; DCSC cannot store it as defaultCableType.`);
    return cable;
  }
  const category = str(currentCategory);
  if (!category) return undefined;
  const matches = compatible.filter((cable) => cableCategory(cable) === category);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`The active network's default cable category "${category}" is unavailable for ` +
      `topology "${topology.shortName}". Choose ${field} from: ${candidatesText(compatible)}.`);
  }
  throw new Error(`The active network's default cable category "${category}" matches multiple cables. ` +
    `Choose ${field} by stable ID: ${candidatesText(matches)}.`);
}

function resolveCableColor(fabric: FabricOptions, topology: NetworkTopology, cable: CableOption | undefined,
  requested: string | undefined, field: string): string | undefined {
  if (requested === undefined) return undefined;
  if (typeof requested !== 'string') throw new Error(`${field} must be a color or an empty string to clear it.`);
  if (requested === '') return '';
  const colors = unique(fabric.cables.filter(item => item.topologies.includes(topology.shortName) &&
    (!cable || cableCategory(item) === cableCategory(cable))).map(item => str(item['color'])).filter(Boolean));
  const color = colors.find(value => value.toLocaleLowerCase() === requested.toLocaleLowerCase());
  if (!color) throw new Error(`Unknown ${field} "${requested}". Available: ${colors.join(', ') || 'none'}; use "" for no preference.`);
  return color;
}

function truthyNumber(value: unknown): boolean {
  return typeof value === 'number' ? value > 0 : Number(value) > 0;
}

const SOURCE_LEAF_CABLING = [
  'Minimal distance cabling (lower cost)',
  'Balance Connections across leaf switches (best performance)',
] as const;
export const EXISTING_CUSTOMER_SWITCH_ID = 'existing-customer-switch';
export const MANUAL_CABLE_ID = 'manual-cable';

export interface NetworkLeafCablingChoice extends Record<string, unknown> { id: string; description: string }

/** Effective website radio choices, including the SPA fallback when the API omits/empties the list. */
export function listNetworkLeafCablingChoices(fabric: FabricOptions): NetworkLeafCablingChoice[] {
  if (fabric.leafNodeCabling !== undefined) {
    return fabric.leafNodeCabling.filter(choice => choice.description)
      .map(choice => ({ id: choice.id, description: choice.description }));
  }
  return SOURCE_LEAF_CABLING.map((description, index) =>
    ({ id: `leaf-cabling:source:${index}`, description }));
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

function validateTrunks(value: number, device: NetworkDevice | undefined, topology: NetworkTopology,
  field: string): number {
  if (!device) {
    if (value !== 0) throw new Error(`${field} requires a selected switch.`);
    return value;
  }
  const ports = device.topologyConnectors[topology.shortName];
  if (!Number.isInteger(ports) || ports! <= 0) {
    throw new Error(`${field} cannot be set because switch ${device.id} has no connector capacity for ${topology.shortName}.`);
  }
  if (value > ports! - 1) {
    throw new Error(`${field} ${value} exceeds switch ${device.id}'s maximum ${ports! - 1} for ${topology.shortName}.`);
  }
  return value;
}

function resolveLeafCabling(fabric: FabricOptions, requested: string | undefined,
  current: unknown): string | undefined {
  if (requested === undefined) return str(current) || undefined;
  const catalog = listNetworkLeafCablingChoices(fabric).map(choice => choice.description)
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const match = catalog.find(value => value.toLocaleLowerCase() === requested.toLocaleLowerCase());
  if (!match) throw new Error(`Unknown leafCabling "${requested}". Available: ${catalog.join(', ') || 'none'}.`);
  return match;
}

function resolveCustomCable(fabric: FabricOptions, topology: NetworkTopology,
  category: string, requested: string | undefined, current: unknown): { value?: string; id?: string } {
  const candidates = fabric.cables.filter(cable => cable['customCable'] === true &&
    cable.topologies.includes(topology.shortName) && (!category || cableCategory(cable) === category));
  if (requested === MANUAL_CABLE_ID) return { value: '', id: MANUAL_CABLE_ID };
  if (requested !== undefined) {
    const matches = candidates.filter(cable => cable.id === requested);
    if (matches.length !== 1) {
      throw new Error(`Unknown or incompatible customCableId "${requested}". Available: ` +
        `${candidatesText(candidates)}; or ${MANUAL_CABLE_ID}.`);
    }
    const featureCode = str(matches[0]!['featureCode']);
    if (!featureCode) throw new Error(`Custom cable ${requested} has no featureCode.`);
    return { value: featureCode, id: matches[0]!.id };
  }
  if (typeof current !== 'string') return {};
  const value = current;
  if (!value) return { value };
  const matches = candidates.filter(cable => cable.featureCode === value);
  return { value, ...(matches.length === 1 ? { id: matches[0]!.id } : {}) };
}

/**
 * Validates active network selections and produces the exact cluster-preference DTOs consumed by
 * auto-connect. Defaults are accepted only when they still identify one available catalog option.
 */
export function buildWorkspaceNetworkPreferences(
  fabric: FabricOptions,
  requested: readonly WorkspaceNetworkSelection[],
): WorkspaceNetworkPreferences {
  const seen = new Set<string>();
  const requestedById = new Map<string, WorkspaceNetworkSelection>();
  for (const selection of requested) {
    if (requestedById.has(selection.networkTypeId)) {
      throw new Error(`Network "${selection.networkTypeId}" was selected more than once.`);
    }
    requestedById.set(selection.networkTypeId, selection);
  }
  const selections: ResolvedWorkspaceNetworkSelection[] = [];
  const networkTypes = requested.map((selection) => {
    const matches = fabric.networkTypes.filter((item) => item.id === selection.networkTypeId);
    if (matches.length === 0) {
      throw new Error(`Unknown networkTypeId "${selection.networkTypeId}". Available: ` +
        `${candidatesText(fabric.networkTypes)}.`);
    }
    if (matches.length > 1) {
      throw new Error(`networkTypeId "${selection.networkTypeId}" is not unique in the fabric catalog. ` +
        'Refresh the catalog before selecting it.');
    }
    const network = matches[0]!;
    if (seen.has(network.id)) throw new Error(`Network "${network.id}" was selected more than once.`);
    seen.add(network.id);
    const topology = resolveTopology(fabric, selection.topology ?? network.defaultNetworkTechnology);
    const layout = selection.layout ?? network.defaultLayout;
    if (layout !== 'Centralized' && layout !== 'Distributed') {
      throw new Error(`Unknown layout "${layout}" for network "${network.name}". Use Centralized or Distributed.`);
    }
    const cable = resolveCable(fabric, topology, selection.cableId, network['defaultCableType'], 'cableId');
    const clearMain = selection.mainDeviceId === EXISTING_CUSTOMER_SWITCH_ID;
    const needsMain = !clearMain && (selection.mainDeviceId !== undefined || str(network['defaultMainSwitch']) !== '' ||
      str(network['defaultMainSwitchOption']) !== '' || truthyNumber(network['mainSwitchTrunks']));
    const main = clearMain ? undefined : resolveDevice(fabric, topology, cable, selection.mainDeviceId,
      network['defaultMainSwitch'], network['defaultMainSwitchOption'], 'main', needsMain);

    const distributed = layout === 'Distributed';
    if (!distributed && (selection.leafDeviceId !== undefined || selection.leafCableId !== undefined ||
        selection.leafCableColor !== undefined || selection.leafTrunks !== undefined || selection.leafCabling !== undefined)) {
      throw new Error(`Network "${network.name}" is Centralized and does not accept leaf device, cable, trunk or policy selections.`);
    }
    const leafCable = distributed
      ? resolveCable(fabric, topology, selection.leafCableId, network['defaultLeafCableType'], 'leafCableId')
      : undefined;
    const clearLeaf = selection.leafDeviceId === EXISTING_CUSTOMER_SWITCH_ID;
    const needsLeaf = distributed && !clearLeaf && (selection.leafDeviceId !== undefined ||
      str(network['defaultLeafSwitch']) !== '' || str(network['defaultLeafSwitchOption']) !== '' ||
      truthyNumber(network['leafSwitchTrunks']));
    const leaf = distributed && !clearLeaf
      ? resolveDevice(fabric, topology, leafCable ?? cable, selection.leafDeviceId,
        network['defaultLeafSwitch'], network['defaultLeafSwitchOption'], 'leaf', needsLeaf)
      : undefined;

    const cableColor = resolveCableColor(fabric, topology, cable, selection.cableColor, 'cableColor');
    const leafCableColor = resolveCableColor(fabric, topology, leafCable ?? cable, selection.leafCableColor, 'leafCableColor');
    const mainTrunks = validateTrunks(clearMain && selection.mainTrunks === undefined ? 0 : selection.mainTrunks === undefined
      ? integer(Number(network['mainSwitchTrunks'] ?? 0), 'current mainTrunks')
      : integer(selection.mainTrunks, 'mainTrunks'), main, topology, 'mainTrunks');
    const leafTrunks = distributed ? validateTrunks(clearLeaf && selection.leafTrunks === undefined ? 0 : selection.leafTrunks === undefined
      ? integer(Number(network['leafSwitchTrunks'] ?? 0), 'current leafTrunks')
      : integer(selection.leafTrunks, 'leafTrunks'), leaf, topology, 'leafTrunks')
      : integer(Number(network['leafSwitchTrunks'] ?? 0), 'current leafTrunks');
    const leafCabling = distributed
      ? resolveLeafCabling(fabric, selection.leafCabling, network['defaultLeafCabling']) : undefined;
    const mainChanged = clearMain ? !!(str(network['defaultMainSwitch']) || str(network['defaultMainSwitchOption']))
      : selection.mainDeviceId !== undefined && !!main &&
        (main.feature !== str(network['defaultMainSwitch']) || main.option !== str(network['defaultMainSwitchOption']));
    const leafChanged = clearLeaf ? !!(str(network['defaultLeafSwitch']) || str(network['defaultLeafSwitchOption']))
      : selection.leafDeviceId !== undefined && !!leaf &&
        (leaf.feature !== str(network['defaultLeafSwitch']) || leaf.option !== str(network['defaultLeafSwitchOption']));
    const clearVlan = layout !== network.defaultLayout || mainChanged || leafChanged;
    let vlanNetworkTypeIds: string[];
    let defaultVlan: Array<{ name: string; networkType: string }>;
    if (selection.vlanNetworkTypeIds !== undefined) {
      if (!distributed && !main && selection.vlanNetworkTypeIds.length > 0) {
        throw new Error('Non-empty vlanNetworkTypeIds requires a selected centralized main switch.');
      }
      if (distributed && selection.vlanNetworkTypeIds.length > 0) {
        throw new Error('vlanNetworkTypeIds is available only for a Centralized network.');
      }
      vlanNetworkTypeIds = unique([...selection.vlanNetworkTypeIds]);
      if (vlanNetworkTypeIds.length !== selection.vlanNetworkTypeIds.length) {
        throw new Error('vlanNetworkTypeIds contains duplicate network IDs.');
      }
      defaultVlan = vlanNetworkTypeIds.map(id => {
        const candidates = fabric.networkTypes.filter(value => value.id === id);
        if (candidates.length !== 1) {
          throw new Error(`Unknown or ambiguous VLAN networkTypeId "${id}". Available: ${candidatesText(fabric.networkTypes)}.`);
        }
        const peer = candidates[0]!;
        if (peer.id === network.id) throw new Error('A network cannot join itself as a VLAN peer.');
        const peerRequest = requestedById.get(peer.id);
        let peerFeature = str(peer['defaultMainSwitch']);
        let peerOption = str(peer['defaultMainSwitchOption']);
        if (peerRequest?.mainDeviceId === EXISTING_CUSTOMER_SWITCH_ID) {
          peerFeature = ''; peerOption = '';
        } else if (peerRequest?.mainDeviceId !== undefined) {
          const peerDevices = fabric.networkDevices.filter(device => device.id === peerRequest.mainDeviceId);
          if (peerDevices.length !== 1) {
            throw new Error(`VLAN peer "${id}" requests an unknown or ambiguous mainDeviceId.`);
          }
          peerFeature = peerDevices[0]!.feature; peerOption = peerDevices[0]!.option;
        }
        if (!main || peerFeature !== main.feature || peerOption !== main.option) {
          throw new Error(`VLAN peer "${id}" does not use the selected main switch ${main?.feature ?? '?'}/${main?.option ?? '?'}.`);
        }
        const peerTopology = peerRequest?.topology === undefined ? peer.defaultNetworkTechnology
          : resolveTopology(fabric, peerRequest.topology).shortName;
        return { name: peer.name, networkType: peerTopology };
      });
    } else if (clearVlan) {
      vlanNetworkTypeIds = [];
      defaultVlan = [];
    } else {
      defaultVlan = Array.isArray(network['defaultVlan'])
        ? network['defaultVlan'].flatMap(value => {
          const item = object(value);
          const name = str(item?.['name']); const networkType = str(item?.['networkType']);
          return name && networkType ? [{ name, networkType }] : [];
        }) : [];
      vlanNetworkTypeIds = defaultVlan.flatMap(value => {
        const matches = fabric.networkTypes.filter(peer => peer.name === value.name &&
          peer.defaultNetworkTechnology === value.networkType);
        return matches.length === 1 ? [matches[0]!.id] : [];
      });
    }
    if (selection.customCableId !== undefined && main) {
      throw new Error('customCableId is available only when no main switch is selected.');
    }
    const customCable = resolveCustomCable(fabric, topology, cable ? cableCategory(cable) : str(network['defaultCableType']),
      selection.customCableId, network['customCable']);
    const resolved: NetworkType = {
      ...structuredClone(network),
      defaultNetworkTechnology: topology.shortName,
      defaultLayout: layout,
      defaultVlan,
      mainSwitchTrunks: mainTrunks,
      leafSwitchTrunks: leafTrunks,
      ...(cableColor !== undefined ? { defaultCableColor: cableColor } : {}),
      ...(leafCableColor !== undefined ? { defaultLeafCableColor: leafCableColor } : {}),
      ...(cable ? { defaultCableType: cableCategory(cable) } : {}),
      ...(clearMain ? { defaultMainSwitch: '', defaultMainSwitchOption: '' }
        : main ? { defaultMainSwitch: main.feature, defaultMainSwitchOption: main.option } : {}),
      ...(leafCable ? { defaultLeafCableType: cableCategory(leafCable) } : {}),
      ...(clearLeaf ? { defaultLeafSwitch: '', defaultLeafSwitchOption: '' }
        : leaf ? { defaultLeafSwitch: leaf.feature, defaultLeafSwitchOption: leaf.option } : {}),
      ...(leafCabling !== undefined ? { defaultLeafCabling: leafCabling } : {}),
      ...(customCable.value !== undefined ? { customCable: customCable.value } : {}),
    };
    selections.push({
      networkTypeId: network.id,
      topologyId: topology.id,
      ...(cableColor !== undefined ? { cableColor } : {}),
      ...(leafCableColor !== undefined ? { leafCableColor } : {}),
      ...(clearMain ? { mainDeviceId: EXISTING_CUSTOMER_SWITCH_ID } : main ? { mainDeviceId: main.id } : {}),
      ...(clearLeaf ? { leafDeviceId: EXISTING_CUSTOMER_SWITCH_ID } : leaf ? { leafDeviceId: leaf.id } : {}),
      ...(cable ? { cableId: cable.id } : {}),
      ...(leafCable ? { leafCableId: leafCable.id } : {}),
      layout, mainTrunks, leafTrunks,
      ...(leafCabling !== undefined ? { leafCabling } : {}),
      vlanNetworkTypeIds,
      ...(customCable.id ? { customCableId: customCable.id } : {}),
    });
    return resolved;
  });
  return { networkTypes, clusterPreference: buildClusterPreferences(fabric.networkDevices, networkTypes), selections };
}
