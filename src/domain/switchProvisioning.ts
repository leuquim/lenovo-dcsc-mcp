import { buildRackConfigurations, type RackConfigurationWire, type RackObject } from './rack.js';

type Obj = Record<string, unknown>;

/** Fields the browser posts to `/switch_calculation`, in captured wire order. */
const SWITCH_CALCULATION_ARRAY_FIELDS = [
  'rackArea',
  'nonRackArea',
  'configurations',
  'clusterPreference',
  'powerPreference',
  'floorItems',
  'storageConnectionNetworks',
  'switchMap',
] as const;

const SWITCH_CALCULATION_OBJECT_FIELDS = [
  'floorPreference',
  'cloneRackMapping',
  'cloneDependency',
] as const;

export interface SwitchCalculationRequest extends Obj {
  rackArea: RackObject[];
  nonRackArea: RackObject[];
  configurations: RackObject[];
  clusterPreference: RackObject[];
  floorPreference: RackObject;
  powerPreference: RackObject[];
  floorItems: RackObject[];
  cloneRackMapping: RackObject;
  storageConnectionNetworks: RackObject[];
  switchMap: RackObject[];
  cloneDependency: RackObject;
}

export interface SwitchRequirement {
  rackId: string;
  rackCode: string;
  rackSize: number;
  option: string;
  rawCode: string;
  type: 'switch';
  network: string;
  usage: string;
  quantity: number;
  position: number;
  size: number;
  raw: RackObject;
}

export interface GeneratedSwitch {
  id: string;
  rackId: string;
  code: string;
  name: string;
  network: string;
  usage: string;
  requestedPosition: number;
  /** Full launch DTO with the client identity and browser-generated name attached. */
  configuration: RackObject;
  /** Compact configuration posted to `/ctos/racks/customize`. */
  wireConfiguration: RackConfigurationWire;
  /** Rack item posted before DCSC authoritatively repositions it. */
  rackItem: RackObject;
  /** Browser shape uses `type`, while the calculation response calls it `usage`. */
  switchMapEntry: { id: string; network: string; type: string; code: string };
  cloneDependency: { [id: string]: string[] };
}

export interface BuildGeneratedSwitchOptions {
  id: string;
  /** One-based ordinal within this network/role, used in the browser display name. */
  ordinal?: number | undefined;
}

/**
 * Reproduces the browser's exact `/switch_calculation` body projection.
 *
 * Live evidence shows that auto-connect settings, connections and virtual-container
 * maps are deliberately absent here. Unknown workspace fields must not leak into
 * this request.
 */
export function buildSwitchCalculationRequest(workspace: Obj): SwitchCalculationRequest {
  const request: Obj = {};
  for (const field of SWITCH_CALCULATION_ARRAY_FIELDS) {
    const value = workspace[field];
    if (value !== undefined && !Array.isArray(value)) {
      throw new Error(`Switch calculation field ${field} must be an array.`);
    }
    request[field] = structuredClone(value ?? []);
  }
  for (const field of SWITCH_CALCULATION_OBJECT_FIELDS) {
    const value = workspace[field];
    if (value !== undefined && !isObject(value)) {
      throw new Error(`Switch calculation field ${field} must be an object.`);
    }
    request[field] = structuredClone(value ?? {});
  }

  // Preserve the captured browser order. It is immaterial to JSON semantics but
  // makes wire fixtures and request diffs stable.
  return {
    rackArea: request['rackArea'] as RackObject[],
    nonRackArea: request['nonRackArea'] as RackObject[],
    configurations: request['configurations'] as RackObject[],
    clusterPreference: request['clusterPreference'] as RackObject[],
    floorPreference: request['floorPreference'] as RackObject,
    powerPreference: request['powerPreference'] as RackObject[],
    floorItems: request['floorItems'] as RackObject[],
    cloneRackMapping: request['cloneRackMapping'] as RackObject,
    storageConnectionNetworks: request['storageConnectionNetworks'] as RackObject[],
    switchMap: request['switchMap'] as RackObject[],
    cloneDependency: request['cloneDependency'] as RackObject,
  };
}

/** Validates and flattens DCSC's rack-grouped switch calculation response. */
export function parseSwitchCalculationResponse(
  raw: unknown,
  request?: SwitchCalculationRequest,
): SwitchRequirement[] {
  if (!Array.isArray(raw)) throw new Error('Switch calculation response must be an array of racks.');
  const knownRacks = request === undefined
    ? undefined
    : new Set(request.rackArea.map((rack) => requiredString(rack['id'], 'rackArea id')));
  const rackIds = new Set<string>();
  const requirements: SwitchRequirement[] = [];

  for (const [rackIndex, value] of raw.entries()) {
    const rack = requiredObject(value, `switch calculation rack ${rackIndex}`);
    const rackId = requiredString(rack['id'], `switch calculation rack ${rackIndex} id`);
    if (rackIds.has(rackId)) throw new Error(`Switch calculation returned duplicate rack id ${rackId}.`);
    rackIds.add(rackId);
    if (knownRacks && !knownRacks.has(rackId)) {
      throw new Error(`Switch calculation returned unknown rack id ${rackId}.`);
    }
    const rackCode = requiredString(rack['option'], `switch calculation rack ${rackId} option`);
    const rackSize = positiveInteger(rack['size'], `switch calculation rack ${rackId} size`);
    const items = rack['items'];
    if (!Array.isArray(items)) throw new Error(`Switch calculation rack ${rackId} is missing its items array.`);

    for (const [itemIndex, itemValue] of items.entries()) {
      const item = requiredObject(itemValue, `switch calculation item ${rackId}/${itemIndex}`);
      const option = requiredString(item['option'], `switch calculation item ${rackId}/${itemIndex} option`);
      const rawCode = requiredString(item['rawCode'], `switch calculation item ${rackId}/${itemIndex} rawCode`);
      if (option.toUpperCase() !== rawCode.toUpperCase()) {
        throw new Error(`Switch calculation item ${rackId}/${itemIndex} has conflicting option and rawCode.`);
      }
      if (item['type'] !== 'switch') {
        throw new Error(`Switch calculation item ${rackId}/${itemIndex} has unsupported type ${String(item['type'])}.`);
      }
      const returnedId = item['id'];
      if (returnedId !== undefined && returnedId !== '') {
        throw new Error(`Switch calculation item ${rackId}/${itemIndex} unexpectedly has an id; ` +
          'automatic switches require a fresh client-generated id.');
      }
      requirements.push({
        rackId,
        rackCode,
        rackSize,
        option,
        rawCode,
        type: 'switch',
        network: requiredString(item['network'], `switch calculation item ${rackId}/${itemIndex} network`),
        usage: requiredString(item['usage'], `switch calculation item ${rackId}/${itemIndex} usage`),
        quantity: positiveInteger(item['quantity'], `switch calculation item ${rackId}/${itemIndex} quantity`),
        position: positiveInteger(item['position'], `switch calculation item ${rackId}/${itemIndex} position`),
        size: positiveInteger(item['size'], `switch calculation item ${rackId}/${itemIndex} size`),
        raw: structuredClone(item),
      });
    }
  }
  return requirements;
}

/**
 * Builds the three identity-linked records for one automatically generated switch.
 * A manually-added switch with the same code is not reusable: the captured SPA
 * launches a new configuration and uses its new id in all three records.
 */
export function buildGeneratedSwitch(
  requirement: SwitchRequirement,
  launch: RackObject,
  options: BuildGeneratedSwitchOptions,
): GeneratedSwitch {
  const id = requiredString(options.id, 'generated switch id');
  const launchCode = requiredString(launch['sliceCtoCode'] ?? launch['code'], 'switch launch code');
  if (launchCode.toUpperCase() !== requirement.option.toUpperCase()) {
    throw new Error(`Switch launch code ${launchCode} does not match calculated option ${requirement.option}.`);
  }
  if (launch['type'] !== 'switch') {
    throw new Error(`Calculated option ${requirement.option} launched as ${String(launch['type'])}, not switch.`);
  }
  const ordinal = options.ordinal ?? 1;
  if (!Number.isInteger(ordinal) || ordinal < 1) throw new Error('Generated switch ordinal must be a positive integer.');
  const role = titleCase(requirement.usage);
  const name = `Switch - ${requirement.network} ${role} ${ordinal}`;
  const configuration: RackObject = structuredClone({ ...launch, id, name });
  const wireConfiguration = buildRackConfigurations([configuration])[0];
  if (!wireConfiguration) throw new Error('Failed to project the generated switch configuration.');
  const description = requiredString(launch['description'], 'switch launch description');

  return {
    id,
    rackId: requirement.rackId,
    code: requirement.option,
    name,
    network: requirement.network,
    usage: requirement.usage,
    requestedPosition: requirement.position,
    configuration,
    wireConfiguration,
    rackItem: {
      id,
      code: requirement.option,
      sliceCtoCode: requirement.option,
      position: requirement.position,
      type: 'switch',
      fixPosition: true,
      features: wireConfiguration.sections.map((section) => ({
        name: section.name,
        results: structuredClone(section.features),
      })),
      description,
      name,
      hardwareType: 'switch',
    },
    switchMapEntry: {
      id,
      network: requirement.network,
      type: requirement.usage,
      code: requirement.option,
    },
    cloneDependency: { [id]: [id] },
  };
}

/** The browser-authoritative endpoint order for a populated automatic-switch run. */
export const SWITCH_PROVISIONING_SEQUENCE = [
  {
    phase: 'calculate',
    method: 'POST',
    path: '/switch_calculation',
    query: { autoArrange: true, autoConnect: true, cogValidation: true },
  },
  {
    phase: 'launch-each-generated-switch',
    method: 'POST',
    path: '/ctos/{code}/launch',
    query: { serviceCto: true, serviceType: 'servicecto', controlExpressModal: false },
  },
  {
    phase: 'customize-generated-layout',
    method: 'POST',
    path: '/ctos/racks/customize',
    query: { autoArrange: true, autoConnect: true, cogValidation: true },
  },
  {
    phase: 'derive-generated-configuration',
    method: 'POST',
    path: '/ctos/autoDerive',
    query: { guideMode: true },
  },
  {
    phase: 'connect-p2p',
    method: 'POST',
    path: '/auto_connect',
    query: { autoArrange: true, autoConnect: true, cogValidation: true },
  },
] as const;

function requiredObject(value: unknown, label: string): RackObject {
  if (!isObject(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function isObject(value: unknown): value is RackObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1).toLowerCase()}`;
}
