import { randomUUID } from 'node:crypto';

import type { SolutionContext } from '../config/schema.js';
import type { RawConfiguration, RawSection } from '../model/types.js';
import type { WorkspaceSession } from '../session/SessionStore.js';

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

/** The envelope autoDerive expects. Supports single config or workspace. */
export function buildAutoDeriveRequest(
  input: ReducedConfiguration | WorkspaceSession,
  opts: { validationMode: 'guided' | 'expert' },
): Record<string, unknown> {
  if ('configurations' in input && input.configurations instanceof Map) {
    const ws = input as WorkspaceSession;
    const configs = [...ws.configurations.values()].map((s) => s.reduced);
    const ids = configs.map((c) => c.id);
    const nonRackPlacement = [...ws.configurations.values()].map((s) =>
      buildPlacement(s.configurationId, s.reduced.sliceCtoCode, s.raw.quantity ?? 1),
    );

    const cloneDependency: Record<string, string[]> = {};
    for (const id of ids) cloneDependency[id] = [id];

    return {
      workspaceInformation: {
        configurations: null,
        rackData: [],
        nonRackData: nonRackPlacement,
        cloneDependency,
        nonRackVirtualData: [],
        rackVirtualData: [],
      },
      autoDerivedResults: [],
      configurations: configs,
      operationHistories: [],
      controllerExpansionMap: {},
      customizingFlags: {
        componentRestriction: true,
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
        autoDerivedConfigurationIds: ids,
        requiredSections: null,
      },
      customizingIds: ids,
      importInformation: [],
    };
  }

  const config = input as ReducedConfiguration;
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

export const EXPORT_FILE_TYPES = {
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
  P2P_REPORT: 'P2P_REPORT',
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

/** The `groups` form field: priced products in the solution workspace. */
export function buildGroups(
  raw: RawConfiguration | WorkspaceSession,
  configurationId?: string,
): Array<Record<string, unknown>> {
  if ('configurations' in raw && raw.configurations instanceof Map) {
    const ws = raw as WorkspaceSession;
    const products: Array<Record<string, unknown>> = [];

    for (const session of ws.configurations.values()) {
      const q = session.raw.quantity ?? 1;
      const unit = session.raw.totalPrice ?? 0;
      products.push({
        id: session.configurationId,
        code: session.raw.sliceCtoCode ?? session.product.code,
        description: session.raw.description ?? '',
        quantity: q,
        price: unit * q,
        unitPrice: unit,
        prices: session.raw.totalPrices ?? [],
        type: 'hardware',
        groupId: 'Config 1',
        showPrice: session.raw.showPrice !== false,
        priceNotAvailable: false,
        asMultiProd: false,
        specialBid: false,
        shippingStatus: session.raw.shippingStatus ?? [],
      });

      // Include hipo software & service products if present
      for (const hipo of (session.raw.hipoDerivedItems as Array<Record<string, unknown>>) ?? []) {
        products.push({
          id: session.configurationId,
          code: hipo.targetCtoCode ?? '',
          description: hipo.targetCtoCodeDescription ?? '',
          quantity: hipo.targetCtoQuantity ?? 1,
          price: (hipo.targetCtoPrice as number) ?? 0,
          prices: hipo.targetCTOPrices ?? [],
          unitPrice: (hipo.targetCtoUnitPrice as number) ?? 1,
          type: 'hipo',
          priceNotAvailable: false,
          showPrice: true,
          asMultiProd: false,
          groupId: 'Config 1',
        });
      }

      for (const svc of (session.raw.hipoServiceCtoServices as Array<Record<string, unknown>>) ?? []) {
        products.push({
          id: session.configurationId,
          code: svc.targetCto ?? '',
          description: svc.description ?? '',
          quantity: 1,
          price: (svc.price as number) ?? 0,
          unitPrice: (svc.price as number) ?? 0,
          type: 'servicectohipo',
          titleType: 'serviceCtoHipo',
          priceNotAvailable: false,
          showPrice: true,
          groupId: 'Config 1',
        });
      }
    }

    return [{ name: 'Config 1', parent: null, index: -1, products }];
  }

  const rawConfig = raw as RawConfiguration;
  const configId = configurationId ?? newConfigurationId('US');
  const quantity = rawConfig.quantity ?? 1;
  const unitPrice = rawConfig.totalPrice ?? 0;

  return [
    {
      name: 'Config 1',
      parent: null,
      index: -1,
      products: [
        {
          id: configId,
          code: rawConfig.sliceCtoCode ?? '',
          description: rawConfig.description ?? '',
          quantity,
          price: unitPrice * quantity,
          unitPrice,
          prices: rawConfig.totalPrices ?? [],
          type: 'hardware',
          groupId: 'Config 1',
          showPrice: rawConfig.showPrice !== false,
          priceNotAvailable: false,
          asMultiProd: false,
          specialBid: false,
          shippingStatus: rawConfig.shippingStatus ?? [],
        },
      ],
    },
  ];
}

export function buildExportConfiguration(
  config: ReducedConfiguration,
  raw: RawConfiguration,
): Record<string, unknown> {
  return {
    id: config.id,
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
 * Supports single configuration or full WorkspaceSession with racks & cabling.
 */
export function buildExportData(opts: {
  raw?: RawConfiguration;
  config?: ReducedConfiguration;
  workspace?: WorkspaceSession;
  solution: SolutionContext;
  fileTypes: ExportFileType[];
  validationMode: 'guided' | 'expert';
}): Record<string, unknown> {
  if (opts.workspace) {
    const ws = opts.workspace;
    const configs = [...ws.configurations.values()];
    const exportConfigs = configs.map((s) => buildExportConfiguration(s.reduced, s.raw));
    const ids = configs.map((s) => s.configurationId);

    const rackArea: unknown[] = [];

    const nonRackArea = configs.map((s) => ({
      id: s.configurationId,
      quantity: s.raw.quantity ?? 1,
      size: 1,
      type: 'server',
      originalIds: [s.configurationId],
      derivedResults: [],
      removedResults: [],
    }));

    const nonRackData = configs.map((s) =>
      buildPlacement(s.configurationId, s.reduced.sliceCtoCode, s.raw.quantity ?? 1),
    );

    const rackData: unknown[] = [];

    const cloneDependency: Record<string, string[]> = {};
    for (const id of ids) cloneDependency[id] = [id];

    return {
      toggle7116On: false,
      workspace: {
        rackArea,
        nonRackArea,
        floorItems: [],
        cloneRackMapping: {},
      },
      configurations: exportConfigs,
      crnId: '',
      cloneDependencyColor: {},
      virtualContainerIdMapping: {},
      virtualContainerRule2ConfigMapping: {},
      virtualContainerInvalidRuleIdMapping: {},
      statusRelatedResult: {
        overPreSelectResults: [],
        autoDerivedConfigurationIds: ids,
        requiredSections: null,
      },
      workspaceInformation: {
        configurations: exportConfigs,
        rackData,
        nonRackData,
        cloneDependency,
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
      floorInformation: { floorGrid: [], floorGridSettings: {}, floorPreference: {}, cloneRackMapping: {} },
      networkingInformation: {
        powerSelection: [],
        autoConnectResults: [],
        cables: ws.cables.map((c) => ({
          fromId: c.fromConfigId,
          fromPort: c.fromPort,
          toId: c.toConfigId,
          toPort: c.toPort,
          cableCode: c.cableCode ?? '',
          quantity: 1,
        })),
        switchMap: [],
      },
      customizingFlags: {
        componentRestriction: true,
        autoDerive: true,
        ctoRules: true,
        minMax: true,
        placement: true,
        fromMemoryWizard: false,
        autoVariant: true,
        cogValidation: true,
        autoAddPDU: ws.racks.size > 0,
        autoAddSwitch: ws.racks.size > 0,
        p2pCabling: ws.cables.length > 0,
        autoArrange: false,
        autoConnect: ws.cables.length > 0,
      },
      messageHistory: {
        history: [],
        validationReport: {
          err: {},
          info: {},
          warn: {},
          configurations: [],
        },
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

  const config = opts.config!;
  const raw = opts.raw!;
  const id = config.id;
  const quantity = raw.quantity ?? 1;
  const exportConfig = buildExportConfiguration(config, raw);

  return {
    toggle7116On: false,
    workspace: {
      rackArea: [],
      nonRackArea: [
        {
          id,
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
      nonRackData: [buildPlacement(id, config.sliceCtoCode, quantity)],
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
    networkingInformation: {
      powerSelection: [],
      autoConnectResults: [],
      cables: [],
      switchMap: [],
    },
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
    messageHistory: {
      history: [],
      validationReport: {
        err: {},
        info: {},
        warn: {},
        configurations: [],
      },
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
    image: '',
    user: '',
    'dcsc-isFromIntegration': 'false',
    serviceAndorRequest: '',
    uuid: '',
  };
}
