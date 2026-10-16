type Obj = Record<string, unknown>;

export interface ConfigIdFeature {
  featureCode: string;
  quantity: 1;
  description: string;
}

export interface ConfigIdAssignmentInput {
  rackData: readonly Obj[];
  nonRackData: readonly Obj[];
  configurations: readonly Obj[];
  /** Raw response from GET /rmp/mip. The SPA's config-ID family is key 5374. */
  mipCatalog: unknown;
  /** Optional physical item id -> root configuration id mapping for clones. */
  cloneRoots?: Readonly<Record<string, string>>;
}

export interface ConfigIdAssignmentResult {
  rackData: Obj[];
  nonRackData: Obj[];
  assignedPhysicalItems: number;
  consumedCatalogFeatures: number;
}

/**
 * Applies DCSC's client-held configuration-ID metadata to physical workspace
 * items. The server only supplies the ordered feature catalog through
 * `/rmp/mip`; placement and autoDerive responses do not add these features.
 *
 * A physical item qualifies only when its associated configuration contains a
 * 5374-family HIPO product with a feature list. Distinct 5374 products consume
 * the catalog in physical layout order. Clone items reuse their root's mapping.
 */
export function assignConfigIdFeatures(input: ConfigIdAssignmentInput): ConfigIdAssignmentResult {
  const rackData = structuredClone(input.rackData) as Obj[];
  const nonRackData = structuredClone(input.nonRackData) as Obj[];
  const configurations = new Map(input.configurations.flatMap(configuration => {
    const id = string(configuration['id']) || string(configuration['configurationId']);
    return id === '' ? [] : [[id, configuration] as const];
  }));
  const catalog = configIdCatalog(input.mipCatalog);
  const assignedByRoot = new Map<string, Map<string, ConfigIdFeature>>();
  let cursor = 0;
  let assignedPhysicalItems = 0;

  for (const item of physicalItems(rackData, nonRackData)) {
    const itemId = string(item['id']);
    const originalId = string(array(item['originalIds'])[0]);
    const rootId = input.cloneRoots?.[itemId] ?? (originalId || itemId);
    const configuration = configurations.get(rootId) ?? configurations.get(itemId);
    const targetCodes = configIdTargetCodes(configuration);
    if (targetCodes.length === 0) {
      if (array(item['configIdFeatures']).length > 0) item['configIdFeatures'] = [];
      continue;
    }

    let assigned = assignedByRoot.get(rootId);
    if (!assigned) {
      assigned = new Map();
      assignedByRoot.set(rootId, assigned);
    }
    const features: ConfigIdFeature[] = [];
    for (const targetCode of targetCodes) {
      let feature = assigned.get(targetCode);
      if (!feature) {
        const source = catalog[cursor];
        if (!source) {
          throw new Error(
            `DCSC /rmp/mip returned ${catalog.length} configuration IDs, ` +
              `but the workspace needs at least ${cursor + 1}.`,
          );
        }
        cursor += 1;
        feature = { ...source };
        assigned.set(targetCode, feature);
      }
      features.push({ ...feature });
    }
    if (item['shipUninstalled'] !== true) item['configIdFeatures'] = features;
    assignedPhysicalItems += 1;
  }

  return { rackData, nonRackData, assignedPhysicalItems, consumedCatalogFeatures: cursor };
}

/** Extracts the exact 5374 family consumed by the current DCSC SPA. */
export function configIdCatalog(value: unknown): ConfigIdFeature[] {
  const source = object(value)['5374'];
  return array(source).flatMap(entry => {
    const feature = object(entry);
    const featureCode = string(feature['featureCode']);
    if (featureCode === '') return [];
    return [{ featureCode, quantity: 1 as const, description: string(feature['description']) }];
  });
}

function physicalItems(racks: readonly Obj[], loose: readonly Obj[]): Obj[] {
  const result: Obj[] = [];
  const append = (item: Obj): void => {
    const nodes = records(item['nodes']);
    if (nodes.length > 0) nodes.forEach(append);
    else result.push(item);
  };
  for (const rack of racks) records(rack['servers'] ?? rack['rackItems']).forEach(append);
  for (const item of loose) append(item);
  return result;
}

export function configIdTargetCodes(configuration: Obj | undefined): string[] {
  if (!configuration) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of array(configuration['hipoDerivedItems'])) {
    const hipo = object(raw);
    const targetCode = string(hipo['targetCtoCode']);
    if (!targetCode.startsWith('5374') || !Array.isArray(hipo['features']) || seen.has(targetCode)) continue;
    seen.add(targetCode);
    result.push(targetCode);
  }
  return result;
}

function records(value: unknown): Obj[] {
  return array(value).filter((entry): entry is Obj => typeof entry === 'object' && entry !== null);
}

function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function object(value: unknown): Obj {
  return typeof value === 'object' && value !== null ? value as Obj : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
