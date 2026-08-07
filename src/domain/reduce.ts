import { randomUUID } from 'node:crypto';

import type { SolutionContext } from '../config/schema.js';
import type { RawConfiguration, RawSection } from '../model/types.js';

/**
 * Builds the *reduced* configuration model DCSC expects on mutation and export.
 *
 * This is the key discovery from the browser capture: the SPA does NOT post the
 * 150 KB launch tree back. It sends a compact `ConfigurationResult` — the
 * sections that carry selections, each with just its `results[]` — which comes
 * to roughly 24 KB. Posting the full tree fails with
 * `ConfigurationResult.getSections() is null`.
 *
 * Shapes below were captured from live traffic on 2026-08-07 by driving
 * dcsc.lenovo.com in a real browser (see fixtures/capture/).
 */

/** DCSC identifies a configuration with a client-generated id: `US__<uuid>0`. */
export function newConfigurationId(country: string): string {
  return `${country}__${randomUUID()}0`;
}

export interface ReducedResult {
  code: string;
  quantity: number;
  ctoCode?: string;
  type?: string;
  description?: string;
  optionCode?: string;
  storageWizardDerived?: boolean;
}

export interface ReducedSection {
  name: string;
  multipleSelectable: boolean;
  type: string;
  subTabTitle: string;
  results: ReducedResult[];
}

/** Describes the single change being applied. DCSC reconciles from this. */
export interface ConfigDelta {
  section: string;
  featureCode: string;
  quantity: number;
  isClear: boolean;
  type: string;
  previousQuantity: number;
  previousFeatureCode: string | null;
}

export interface ReducedConfiguration {
  id: string;
  workspaceId: string;
  name: string;
  sliceCtoCode: string;
  ctoCode: string;
  lfoCode: string | null;
  slice: string;
  solutionMode: string;
  quantity?: number;
  showPrice: boolean;
  asMultiProd: boolean;
  asVLH: boolean;
  sections: ReducedSection[];
  products: unknown[];
  hipoDerivedItems: unknown[];
  hipoServiceCtoServices: unknown[];
  networkDerivedFeatures: Record<string, unknown>;
  selectedTopologies: Record<string, unknown>;
  selectedStorageNetwork: null;
  autoDerivedResultId: null;
  nodeRole: string;
  expansionMessages: unknown[];
  voltage: unknown;
  currentPowerPolicy: unknown;
  loadFactor: unknown;
  shippingStatus: unknown;
  showExpressMode: boolean;
  expressModeAvailable: boolean;
  showExpressT2Mode: boolean;
  serviceCtoFlag: unknown;
  storageWizardOption: null;
  operationHistories: unknown[];
  pinnedList: unknown[];
  delta?: ConfigDelta;
}

/**
 * Walks the raw tree and keeps only sections that actually carry selections.
 * A launch response has ~168 sections; typically ~34 have results.
 */
export function reduceConfiguration(
  raw: RawConfiguration,
  configurationId: string,
  mode: 'cto' | 'lfo' = 'cto',
): ReducedConfiguration {
  const sections: ReducedSection[] = [];

  for (const tab of raw.tabs ?? []) {
    for (const subTab of tab.subTabs ?? []) {
      for (const section of subTab.sections ?? []) {
        const results = toResults(section);
        if (results.length === 0) continue;
        sections.push({
          name: section.name ?? section.title ?? 'unnamed',
          multipleSelectable: section.singleEntry !== true,
          type: 'hardware',
          subTabTitle: subTab.title ?? tab.title ?? '',
          results,
        });
      }
    }
  }

  // A CTO launch returns `sliceCtoCode`; an LFO launch (`as_lfo_launch`) does
  // not — it uses `code` for the preconfigured model and `ctoCode` for the
  // underlying CTO.
  //
  // Crucially, the /lfos/* endpoints resolve the model by the LFO code, so
  // `sliceCtoCode` (the "model number" they look up) must carry the LFO code
  // there. Sending the CTO code yields
  // "Unable to find a model with model number 7DCECTO1WW", which breaks both
  // autoDerive and export for every preconfigured model.
  const underlyingCto =
    raw.sliceCtoCode ?? (raw.ctoCode as string | undefined) ?? (raw.code as string | undefined) ?? '';
  const lfoCode =
    (raw.lfoCode as string | undefined) ??
    (mode === 'lfo' ? ((raw.code as string | undefined) ?? null) : null);
  const modelNumber = mode === 'lfo' ? (lfoCode ?? underlyingCto) : underlyingCto;

  return {
    id: configurationId,
    workspaceId: configurationId,
    name: 'Server',
    sliceCtoCode: modelNumber,
    ctoCode: underlyingCto,
    lfoCode,
    slice: raw.slice ?? 'GP',
    solutionMode: 'General Purpose',
    showPrice: raw.showPrice !== false,
    asMultiProd: false,
    asVLH: false,
    sections,
    products: [],
    hipoDerivedItems: (raw.hipoDerivedItems as unknown[]) ?? [],
    hipoServiceCtoServices: (raw.hipoServiceCtoServices as unknown[]) ?? [],
    networkDerivedFeatures: {},
    selectedTopologies: {},
    selectedStorageNetwork: null,
    autoDerivedResultId: null,
    nodeRole: '',
    expansionMessages: [],
    voltage: raw.voltage ?? {},
    currentPowerPolicy: raw.currentPowerPolicy ?? 5,
    loadFactor: raw.loadFactor ?? 70,
    shippingStatus: raw.shippingStatus ?? [],
    showExpressMode: false,
    expressModeAvailable: raw.expressModeAvailable === true,
    showExpressT2Mode: false,
    serviceCtoFlag: raw.serviceCtoFlag ?? {},
    storageWizardOption: null,
    operationHistories: [],
    pinnedList: [],
  };
}

function toResults(section: RawSection): ReducedResult[] {
  const out: ReducedResult[] = [];
  for (const result of section.results ?? []) {
    if (!result.code) continue;
    out.push({
      code: result.code,
      quantity: result.quantity ?? 1,
      type: 'hardware',
      ...(result.ctoCode != null ? { ctoCode: result.ctoCode } : {}),
    });
  }
  return out;
}

/**
 * Applies a selection change to the reduced model and records the delta.
 *
 * For a single-entry section the incoming code replaces whatever was there;
 * DCSC needs `previousFeatureCode` to reconcile dependent parts (heatsinks,
 * cables, fillers), which is why the delta is not merely descriptive.
 */
export function applyChange(
  config: ReducedConfiguration,
  change: { sectionName: string; code: string; quantity: number },
): ReducedConfiguration {
  const section = config.sections.find((s) => s.name === change.sectionName);
  const previous = section?.results[0];

  const delta: ConfigDelta = {
    section: change.sectionName,
    featureCode: change.code,
    quantity: change.quantity,
    isClear: change.quantity === 0,
    type: 'hardware',
    previousQuantity: previous?.quantity ?? 0,
    previousFeatureCode: previous?.code ?? null,
  };

  if (section) {
    if (section.multipleSelectable) {
      const existing = section.results.find((r) => r.code === change.code);
      if (existing) existing.quantity = change.quantity;
      else if (change.quantity > 0)
        section.results.push({ code: change.code, quantity: change.quantity, type: 'hardware' });
      section.results = section.results.filter((r) => r.quantity > 0);
    } else {
      section.results =
        change.quantity > 0
          ? [{ code: change.code, quantity: change.quantity, type: 'hardware' }]
          : [];
    }
  }

  return { ...config, delta };
}

/**
 * A placement entry for `workspaceInformation.nonRackData`.
 *
 * Distinct from `workspace.nonRackArea`, which is the *layout* entry
 * (`originalIds` / `derivedResults` / `removedResults`). Conflating the two
 * makes the rule engine return HTTP 500 with no useful detail.
 *
 * The real client sends full physical metadata here (weight, dimensions,
 * centre-of-gravity), which comes from the rack placement service. For a
 * non-rack configuration those are not needed: this minimal shape was verified
 * to return HTTP 200 by ablating a known-good captured request.
 */
export function buildPlacement(
  id: string,
  productCode: string,
  quantity = 0,
): Record<string, unknown> {
  return {
    id,
    code: productCode,
    sliceCtoCode: productCode,
    type: 'server',
    size: 1,
    height: 1,
    quantity,
    position: 1,
    lock: false,
    nodes: [],
    features: [],
    errors: [],
    placementError: [],
    attributes: {},
  };
}

/** The envelope autoDerive expects. Note `workspaceInformation.configurations` is null. */
export function buildAutoDeriveRequest(
  config: ReducedConfiguration,
  opts: { validationMode: 'guided' | 'expert' },
): Record<string, unknown> {
  const id = config.id;
  return {
    workspaceInformation: {
      configurations: null,
      rackData: [],
      nonRackData: [buildPlacement(id, config.sliceCtoCode)],
      cloneDependency: { [id]: [id] },
      nonRackVirtualData: [],
      rackVirtualData: [],
    },
    autoDerivedResults: [],
    configurations: [config],
    operationHistories: [],
    controllerExpansionMap: {},
    customizingFlags: {
      componentRestriction: true,
      // Guided mode runs full rules validation on every change; expert defers.
      autoDerive: opts.validationMode === 'guided',
      ctoRules: true,
      minMax: true,
      placement: true,
      fromMemoryWizard: false,
      autoVariant: true,
    },
    virtualContainerIdMapping: {},
    virtualContainerRule2ConfigMapping: {},
    virtualContainerInvalidRuleIdMapping: {},
    callServiceVarintOnly: false,
    statusRelatedResult: {
      overPreSelectResults: [],
      autoDerivedConfigurationIds: [id],
      requiredSections: null,
    },
    customizingIds: [id],
    importInformation: [],
  };
}

/**
 * Export format flags. Captured from the live export dialog — these are what
 * populate the ZIP. Without them the server returns a valid but EMPTY archive.
 */
export const EXPORT_FILE_TYPES = {
  /** The interchange XML: re-imports into DCSC and feeds Lenovo Bid Portal. */
  XML: 'XML',
  QUOTE: 'QUOTE',
  QUOTE_SUPPLYINFO: 'QUOTE_SUPPLYINFO',
  QUOTE_GROUP: 'QUOTE_GROUP',
  SUMMARY: 'SUMMARY',
  POWER_REPORT: 'POWER_REPORT',
  RACK_REPORT: 'RACK_REPORT',
  RACK_DIAGRAM: 'RACK_DIAGRAM',
  FLOOR: 'FLOOR',
  MESSAGE_HISTORY: 'MESSAGE_HISTORY',
} as const;

export type ExportFileType = keyof typeof EXPORT_FILE_TYPES;

export const DEFAULT_EXPORT_TYPES: ExportFileType[] = ['XML', 'QUOTE', 'SUMMARY'];

export interface ExportGroupProduct {
  id: string;
  code: string;
  description: string;
  quantity: number;
  price: number;
  unitPrice: number;
  showPrice: boolean;
  type: string;
  groupId: string;
  priceNotAvailable: boolean;
  asMultiProd: boolean;
}

/** The `groups` form field: the priced product list shown on the summary page. */
export function buildGroups(
  raw: RawConfiguration,
  configurationId: string,
): Array<Record<string, unknown>> {
  // `totalPrice` is the price of ONE configured unit. In the groups payload
  // `price` is the extended line total and `unitPrice` is the per-unit figure —
  // they coincide only at quantity 1. Sending the unit price as the extended
  // total would under-price an 8-node cluster by a factor of 8.
  const quantity = raw.quantity ?? 1;
  const unitPrice = raw.totalPrice ?? 0;

  return [
    {
      name: 'Config 1',
      parent: null,
      index: -1,
      products: [
        {
          id: configurationId,
          code: raw.sliceCtoCode ?? '',
          description: raw.description ?? '',
          quantity,
          price: unitPrice * quantity,
          unitPrice,
          prices: raw.totalPrices ?? [],
          type: 'hardware',
          groupId: 'Config 1',
          showPrice: raw.showPrice !== false,
          priceNotAvailable: false,
          asMultiProd: false,
          specialBid: false,
          shippingStatus: raw.shippingStatus ?? [],
        },
      ],
    },
  ];
}

/**
 * The export endpoint takes a DIFFERENT configuration shape from autoDerive.
 *
 * Its DTO rejects unknown properties, so sending the autoDerive shape fails the
 * whole body with HTTP 400 "Failed to read request". Two differences matter
 * most:
 *   - it reads `code`, not `ctoCode` (omitting `code` makes the rule engine
 *     request `/cto/characters/` with an empty segment and 404);
 *   - it has no `workspaceId`, `slice`, `solutionMode`, `asVLH`, `products`,
 *     `networkDerivedFeatures`, `operationHistories` or `pinnedList`.
 *
 * Field set verified against a live browser capture, 2026-08-07.
 */
export function buildExportConfiguration(
  config: ReducedConfiguration,
  raw: RawConfiguration,
): Record<string, unknown> {
  return {
    id: config.id,
    // For a preconfigured model the export identifies the product by its LFO
    // code; for a CTO it is the CTO code.
    code: config.lfoCode ?? config.sliceCtoCode,
    sliceCtoCode: config.sliceCtoCode,
    lfoCode: config.lfoCode,
    name: config.name,
    type: 'server',
    quantity: raw.quantity ?? 1,
    showPrice: config.showPrice,
    priceNotAvailable: false,
    specialBid: false,
    asMultiProd: false,
    autoDerivedResultId: null,
    sections: config.sections,
    hipoDerivedItems: config.hipoDerivedItems,
    hipoServiceCtoServices: config.hipoServiceCtoServices,
    expansionMessages: [],
    nodeRole: '',
    selectedTopologies: {},
    selectedStorageNetwork: null,
    serviceCtoFlag: config.serviceCtoFlag,
    storageWizardOption: null,
    shippingStatus: config.shippingStatus,
    voltage: config.voltage,
    currentPowerPolicy: config.currentPowerPolicy,
    loadFactor: config.loadFactor,
    expressModeAvailable: config.expressModeAvailable,
    showExpressMode: false,
    showExpressT2Mode: false,
  };
}

/**
 * Builds the `data` field of the export form POST.
 *
 * `exportFileTypes` is the field that blind probing could not find: it is a
 * plain top-level array inside `data`, not a separate parameter and not the
 * `{zipAll, selection}` shape the bundle's builder function suggested. Without
 * it the server returns a valid but EMPTY archive.
 */
export function buildExportData(opts: {
  raw: RawConfiguration;
  config: ReducedConfiguration;
  solution: SolutionContext;
  fileTypes: ExportFileType[];
  validationMode: 'guided' | 'expert';
}): Record<string, unknown> {
  const id = opts.config.id;
  const quantity = opts.raw.quantity ?? 1;
  const exportConfig = buildExportConfiguration(opts.config, opts.raw);
  return {
    toggle7116On: false,
    workspace: {
      rackArea: [],
      nonRackArea: [
        {
          id,
          // This is what drives <Quantity> in the exported CFXML. Hardcoding 1
          // silently exports a single unit however many the caller asked for —
          // i.e. a quote short by a factor of `quantity`.
          quantity,
          size: 1,
          type: 'server',
          originalIds: [id],
          derivedResults: [],
          removedResults: [],
        },
      ],
      floorItems: [],
      cloneRackMapping: {},
    },
    configurations: [exportConfig],
    crnId: '',
    // The map's values are objects, not colour scalars. Sending `{id: 0}`
    // fails the whole body with "Failed to read request"; an empty map is
    // accepted.
    cloneDependencyColor: {},
    virtualContainerIdMapping: {},
    virtualContainerRule2ConfigMapping: {},
    virtualContainerInvalidRuleIdMapping: {},
    statusRelatedResult: {
      overPreSelectResults: [],
      autoDerivedConfigurationIds: [id],
      requiredSections: null,
    },
    workspaceInformation: {
      configurations: [exportConfig],
      rackData: [],
      nonRackData: [buildPlacement(id, opts.config.sliceCtoCode, quantity)],
      cloneDependency: { [id]: [id] },
      nonRackVirtualData: [],
      rackVirtualData: [],
    },
    autoDerivedResults: [],
    crossSystemConfigs: [],
    standaloneData: [],
    ruleConditionIdMapping: '{}',
    instanceIdMapping: '{}',
    controllerExpansionMap: {},
    controllerIndexMap: {},
    autoConnectResults: [],
    floorInformation: { floorGridSettings: {}, floorPreference: {}, cloneRackMapping: {} },
    // Deliberately NOT sent: `networkingInformation` and `messageHistory`.
    // The real client sends both, but its shapes differ from the naive
    // `{powerSelection:{}, cables:[], …}` / `{history:[], validationReport:[]}`
    // and each fails deserialization with HTTP 400 "Failed to read request".
    // They are only meaningful for rack/cluster solutions, so omitting them
    // costs nothing for a general-purpose configuration.
    customizingFlags: {
      componentRestriction: true,
      autoDerive: true,
      ctoRules: true,
      minMax: true,
      placement: true,
      fromMemoryWizard: false,
      autoVariant: true,
      cogValidation: true,
      autoAddPDU: false,
      autoAddSwitch: false,
      p2pCabling: false,
      autoArrange: false,
      autoConnect: false,
    },
    operationMode: {
      type: opts.validationMode === 'guided' ? 'guide' : 'expert',
      options: { autoFix: false, showErrors: true },
    },
    solutionMode: {
      mode: opts.solution.solutionMode,
      masterSlices: opts.solution.masterSlices,
      sbSlices: [],
    },
    configId2RecommendedDatasMap: {},
    lbpExportShowPrice: [1],
    crossVariantDeriveResults: [],
    exportFileTypes: opts.fileTypes,
  };
}

/** The 14 form fields of the export POST, as sent by the real client. */
export function buildExportForm(opts: {
  data: Record<string, unknown>;
  groups: Array<Record<string, unknown>>;
}): Record<string, string> {
  return {
    data: JSON.stringify(opts.data),
    crnId: '',
    userGeneratedConfigId: '',
    lfoCode: '',
    cancelDownload: 'false',
    multipleProductData: '[]',
    excelData: '',
    groups: JSON.stringify(opts.groups),
    integrationParams: JSON.stringify({
      returnUrl: null,
      site: '',
      role: '',
      iad: false,
      error: null,
      context: '',
      serviceWithProductNumber: false,
    }),
    // Empty even in the real browser for a non-rack configuration — the
    // html2canvas rack diagram only applies to rack solutions.
    image: '',
    user: '',
    'dcsc-isFromIntegration': 'false',
    serviceAndorRequest: '',
    uuid: '',
  };
}
