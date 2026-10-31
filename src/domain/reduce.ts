import { storageWizardOption, storageWizardSections } from './storageWizard.js';
import { pciWizardSections, pciWizardWireFields } from './pciWizard.js';
import { detachedNestedNodeIds } from './nestedPhysical.js';
import { powerLoadFactor } from './power.js';
import type { ConfigMode } from '../config/constants.js';
import { hardwareModeFamily } from './modeFamily.js';
import { randomUUID } from 'node:crypto';

import type { SolutionContext } from '../config/schema.js';
import type { RawConfiguration } from '../model/types.js';
import {
  nonemptyCode,
  serializeSection,
  serializeSections,
  type WireResult,
  type WireSection,
} from './dcscWire.js';
import type { WorkspaceSession } from '../session/SessionStore.js';
import { buildItemHierarchy, buildRackHierarchy, physicalRackData } from './workspaceWire.js';
import { buildExportGroups } from './exportGroups.js';
import { buildFloorState } from './floorWire.js';
import { applySoftwareSelection } from './softwareSelections.js';
import { readAutoConnectSettings, readConnectionGraph, readSwitchMap, buildCableGroups, assertCurrentConnectionGraph } from './cabling.js';
import { projectRackFiller } from './rackFiller.js';
import { managedStorageComponentIds, storagePhysicalTemplateIds, storageDependencyColors } from './storagePreferences.js';
import { createCloneDependencyColor, projectCloneDependency } from './cloneDependency.js';
import { physicalIds } from './workspaceReferences.js';
import { cloneConfigurationRaw } from './configurationIdentity.js';
import { projectChassisManufacturing } from './chassisManufacturing.js';
import {
  cloneColorMembers,
  exactStorageAliasRoot,
  reconcileImportedCloneOwnership,
  sameIdentitySet,
  type CloneDependency,
} from './importCloneOwnership.js';

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

export type ReducedResult = WireResult;
export type ReducedSection = WireSection;

const HARDWARE_LABEL: Readonly<Record<string, string>> = {
  rack: 'Rack', vertical_rack: 'Vertical Rack', server: 'Server', chassis: 'Chassis',
  node: 'Node', blade: 'Blade', chassis_dense: 'Chassis Dense', console: 'Console',
  manifold: 'Manifold', pdu: 'PDU', pdu_feature: 'PDU(as feature)', storage: 'Storage',
  switch: 'Switch', tape: 'Tape', ups: 'UPS', lifttool: 'Lifttool',
};

/** Describes the single change being applied. DCSC reconciles from this. */
export interface ConfigDelta {
  section?: string;
  productNumber?: string;
  featureCode?: string | null;
  quantity?: number;
  isClear?: boolean;
  mergeCtoCode?: string;
  type?: string;
  previousQuantity?: number;
  previousFeatureCode?: string | null;
}

/** Apply a user selection with the metadata and package semantics in the catalog. */
export function applyCatalogChange(
  config: ReducedConfiguration,
  raw: RawConfiguration,
  change: { sectionName: string; code: string; quantity: number },
): ReducedConfiguration {
  const softwareSelection = applySoftwareSelection(config, raw, change);
  if (softwareSelection) return softwareSelection;
  for (const tab of raw.tabs ?? []) {
    for (const subTab of tab.subTabs ?? []) {
      const section = subTab.sections?.find((item) => (item.name ?? item.title) === change.sectionName);
      if (!section) continue;
      const feature = section.features?.find((item) => item.code === change.code);

      if (tab.type === 'software') {
        const currentSection = config.sections.find((item) => item.name === change.sectionName);
        const currentResult = currentSection?.results.find((item) => item.code === change.code);
        if (!currentResult) {
          throw new Error(
            `Software item ${change.code} is not selected in section ${change.sectionName}; select its software group first.`,
          );
        }

        const sections = structuredClone(config.sections);
        const target = sections.find((item) => item.name === change.sectionName)!;
        const prior = target.results.find((item) => item.code === change.code)!;
        const previousQuantity = prior.quantity;
        if (change.quantity > 0) {
          // The SPA can serialize a derived result twice (selected + derived).
          // Both copies describe the same parent selection and must agree.
          for (const selected of target.results) {
            if (selected.code === change.code) selected.quantity = change.quantity;
          }
        }
        else target.results = target.results.filter((item) => item.code !== change.code);
        const productNumber = typeof section.productNumber === 'string'
          ? section.productNumber
          : typeof prior.productNumber === 'string'
            ? prior.productNumber
            : typeof prior.ctoCode === 'string'
              ? prior.ctoCode
              : '';
        const hipoDerivedItems = structuredClone(config.hipoDerivedItems ?? []);
        // A multi-CTO parent uses a comma-separated productNumber, while HIPO
        // records use the individual derived CTO. Scope by that identity and
        // the originating software group so shared feature codes stay local.
        const parentProducts = new Set(productNumber.split(',').map(code => code.trim()).filter(Boolean));
        const targetProducts = typeof prior.ctoCode === 'string' && prior.ctoCode
          ? new Set([prior.ctoCode])
          : parentProducts;
        const groupCodes = new Set((section.results ?? [])
          .filter(result => result.code === change.code)
          .flatMap(result => typeof result.swSubcategory === 'string' ? [result.swSubcategory] : []));
        for (const item of hipoDerivedItems as Array<Record<string, unknown>>) {
          if (!targetProducts.has(String(item.targetCtoCode)) || !Array.isArray(item.features)) continue;
          for (const selected of item.features as Array<Record<string, unknown>>) {
            const matchesParent = selected.ctoCode === undefined || selected.ctoCode === productNumber
              || (typeof selected.ctoCode === 'string' && parentProducts.has(selected.ctoCode));
            const matchesGroup = groupCodes.size === 0 || selected.swSubCategory === undefined
              || groupCodes.has(String(selected.swSubCategory));
            if (selected.featureCode === change.code && matchesParent && matchesGroup) {
              selected.quantity = change.quantity;
              selected.userChanged = true;
            }
          }
        }
        return {
          ...config,
          sections,
          hipoDerivedItems,
          delta: {
            section: change.sectionName,
            ...(productNumber ? { productNumber } : {}),
            featureCode: change.code,
            quantity: change.quantity,
            isClear: change.quantity === 0,
            ...(productNumber ? { mergeCtoCode: productNumber } : {}),
            type: typeof prior.type === 'string' ? prior.type : 'hipo',
            previousQuantity,
          },
        };
      }
      if (!feature && !section.results?.some((item) => item.code === change.code)) {
        throw new Error(`Feature ${change.code} is not available in section ${change.sectionName}.`);
      }
      if (tab.type === 'servicesAndor' && feature?.type === 'servicecto') {
        // Selecting a service package selects all its CFCs, not only the term.
        const results = change.quantity === 0 ? [] : (section.features ?? [])
          .filter((item) => item.code === change.code || Number(item.preSelectedQuantity) > 0)
          .map((item) => ({
            code: item.code, ctoCode: item.productNumber ?? '', description: item.description ?? '',
            quantity: item.code === change.code ? change.quantity : Number(item.preSelectedQuantity),
            type: item.type ?? 'servicecto', characterName: item.characterName,
          }));
        const source = typeof subTab.source === 'string' ? subTab.source : subTab.title ?? '';
        // A la Carte choices replace each other; independent Add-ons replace
        // only the same sub-tab. Lenovo Recommends remains a separate anchor.
        const sections = structuredClone(config.sections).filter((item) => {
          if (source === 'A la Carte') return item.source !== source;
          return item.subTabTitle !== subTab.title;
        });
        if (results.length > 0) sections.push({ name: change.sectionName, source, type: tab.type, results });
        return { ...config, sections, delta: { section: source } };
      }
      const templates = serializeSection(section, subTab, tab.type ?? 'hardware');
      const template = templates[0]!;
      const withTemplate = structuredClone(config);
      if (!withTemplate.sections.some((item) => item.name === change.sectionName)) {
        withTemplate.sections.push(template);
      }
      const changed = applyChange(withTemplate, {
        ...change, subTabTitle: subTab.title ?? '',
        multipleSelectable: template.multipleSelectable ?? false,
        // Hardware catalogs use singleEntry:false for independent quantities
        // even though their compact wire section keeps multipleSelectable:false.
        preserveOtherSelections: section.singleEntry === false,
      });
      const target = changed.sections.find((item) => item.name === change.sectionName);
      const result = target?.results.find((item) => item.code === change.code);
      if (result && feature) {
        result.type = typeof feature.type === 'string' ? feature.type : tab.type ?? 'hardware';
        result.description = feature.description ?? '';
        if (feature.productNumber) result.ctoCode = feature.productNumber;
        if (tab.type === 'servicesAndor' && feature.characterName !== undefined) result.characterName = feature.characterName;
      }
      return changed;
    }
  }
  throw new Error(`Unknown section ${change.sectionName}.`);
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
  selectedStorageNetwork: unknown;
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
  selectedTceAudience?: unknown;
  serviceCtoFlag: unknown;
  storageWizardOption: Record<string, unknown> | null;
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
  solutionMode = 'General Purpose',
): ReducedConfiguration {
  const sections = storageWizardSections(raw, pciWizardSections(raw, serializeSections(raw)));
  const selectedStorage = storageWizardOption(raw);
  const underlyingCto = nonemptyCode(raw.sliceCtoCode, raw.ctoCode, raw.code);
  const lfoCode = nonemptyCode(raw.lfoCode, mode === 'lfo' ? raw.code : null) || null;
  const modelNumber = mode === 'lfo' ? (lfoCode ?? underlyingCto) : underlyingCto;

  return {
    id: configurationId,
    workspaceId: configurationId,
    name: typeof raw.name === 'string' && raw.name ? raw.name : HARDWARE_LABEL[String(raw.type)] ?? 'Server',
    sliceCtoCode: modelNumber,
    ctoCode: underlyingCto,
    lfoCode,
    slice: raw.slice ?? 'GP',
    solutionMode,
    ...(typeof raw.quantity === 'number' ? { quantity: raw.quantity } : {}),
    showPrice: raw.showPrice !== false,
    asMultiProd: false,
    asVLH: false,
    sections,
    products: [],
    hipoDerivedItems: structuredClone(
      (raw.hipoDerivedItems as unknown[]) ??
      ((Array.isArray(raw.configurations) ? raw.configurations[0]?.hipoDerivedItems : undefined) as unknown[]) ??
      []),
    hipoServiceCtoServices: structuredClone(
      (raw.hipoServiceCtoServices as unknown[]) ??
      ((Array.isArray(raw.configurations) ? raw.configurations[0]?.hipoServiceCtoServices : undefined) as unknown[]) ??
      []),
    networkDerivedFeatures: {},
    // Fabric choices are client-held (SPA Redux / our session). autoDerive does
    // not echo them, so reduce must read them from raw when present rather than
    // wiping to {}.
    selectedTopologies:
      typeof raw.selectedTopologies === 'object' && raw.selectedTopologies !== null
        ? (raw.selectedTopologies as Record<string, unknown>)
        : {},
    selectedStorageNetwork: structuredClone(raw.selectedStorageNetwork ?? null),
    autoDerivedResultId: null,
    nodeRole: typeof raw.nodeRole === 'string' ? raw.nodeRole : '',
    expansionMessages: Array.isArray(raw.expansionMessages) ? raw.expansionMessages : [],
    voltage: raw.voltage ?? {},
    currentPowerPolicy: raw.currentPowerPolicy ?? 5,
    loadFactor: powerLoadFactor(raw) ?? 70,
    shippingStatus: raw.shippingStatus ?? [],
    showExpressMode: raw.showExpressMode === true,
    expressModeAvailable: raw.expressModeAvailable === true,
    showExpressT2Mode: raw.showExpressT2Mode === true,
    ...(raw.selectedTceAudience !== undefined ? { selectedTceAudience: structuredClone(raw.selectedTceAudience) } : {}),
    serviceCtoFlag: raw.serviceCtoFlag ?? {},
    storageWizardOption: selectedStorage,
    ...(selectedStorage?.['delta'] && typeof selectedStorage['delta'] === 'object'
      ? { delta: structuredClone(selectedStorage['delta']) as ConfigDelta } : {}),
    ...pciWizardWireFields(raw),
    operationHistories: [],
    pinnedList: [],
  };
}

/**
 * Applies a selection change to the reduced model and records the delta.
 */
export function applyChange(
  config: ReducedConfiguration,
  change: {
    sectionName: string;
    code: string;
    quantity: number;
    /** Sub-tab the section lives under. DCSC needs it to locate a new section. */
    subTabTitle?: string | undefined;
    /** False for single-select sections, so a change replaces instead of appends. */
    multipleSelectable?: boolean | undefined;
    /** Catalog singleEntry:false: retain peer result codes without changing the wire flag. */
    preserveOtherSelections?: boolean | undefined;
  },
): ReducedConfiguration {
  const needle = change.sectionName.toLowerCase();
  let sections = structuredClone(config.sections);
  let section = sections.find(
    (s) =>
      s.name.toLowerCase() === needle ||
      (typeof (s as unknown as Record<string, unknown>).title === 'string' &&
        String((s as unknown as Record<string, unknown>).title).toLowerCase() === needle),
  );

  // reduceConfiguration only keeps sections that already have results. A first
  // selection into an empty section (PDU on a fresh rack, for example) has to
  // create the section or autoDerive never sees the change.
  if (!section) {
    if (change.quantity <= 0) {
      return {
        ...config,
        delta: {
          section: change.sectionName,
          featureCode: change.code,
          quantity: 0,
          isClear: true,
          type: 'hardware',
          previousQuantity: 0,
          previousFeatureCode: null,
        },
      };
    }
    // A synthesized section has to carry the same identity DCSC uses in its own
    // tree. An empty subTabTitle used to be enough for autoDerive to accept the
    // payload and then quietly drop the selection, so the caller must supply the
    // sub-tab it read off the launch tree.
    section = {
      name: change.sectionName,
      multipleSelectable: change.multipleSelectable ?? true,
      type: 'hardware',
      subTabTitle: change.subTabTitle ?? '',
      results: [],
    };
    sections = [...sections, section];
  }

  const previous = section.results.find((r) => r.code === change.code)
    ?? (change.preserveOtherSelections ? undefined : section.results[0]);

  const delta: ConfigDelta = {
    section: change.sectionName,
    featureCode: change.code,
    quantity: change.quantity,
    isClear: change.quantity === 0,
    type: 'hardware',
    previousQuantity: previous?.quantity ?? 0,
    previousFeatureCode: previous?.code ?? null,
  };

  if (section.multipleSelectable || change.preserveOtherSelections) {
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

  return { ...config, sections, delta };
}

export function buildPlacement(
  id: string,
  productCode: string,
  quantity = 0,
  slice = 'GP',
): Record<string, unknown> {
  return {
    id,
    code: productCode,
    sliceCtoCode: productCode,
    machineType: productCode.length >= 4 ? productCode.slice(0, 4) : productCode,
    slice,
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
  opts: { validationMode: 'guided' | 'expert'; autoCorrect?: boolean },
): Record<string, unknown> {
  if (opts.validationMode === 'expert' && opts.autoCorrect === true) {
    throw new Error('Auto-Correct cannot be enabled in Expert mode.');
  }
  const autoCorrect = opts.autoCorrect ?? opts.validationMode === 'guided';
  if ('configurations' in input && input.configurations instanceof Map) {
    const ws = input as WorkspaceSession;
    const projections = new Map(ws.rackArea.flatMap(rack => {
      const session = [...ws.configurations.values()].find(s => s.configurationId === rack.id);
      return session && hardwareModeFamily(session.mode) === 'cto'
        ? [[session.configurationId, projectRackFiller(rack, { ...session.raw, id: session.configurationId })] as const] : [];
    }));
    const configs = [...ws.configurations.values()].map((s) => reduceConfiguration(
      projections.get(s.configurationId)?.configuration ?? s.raw,
      s.configurationId, hardwareModeFamily(s.mode), s.solution.solutionMode));
    const ids = configs.map((c) => c.id);
    const detachedNodes = detachedNestedNodeIds(ws);
    const managedControllers = managedStorageComponentIds(ws.serverState);
    const nonRackPlacement = [...ws.configurations.values()].filter(s => !managedControllers.has(s.configurationId) &&
      !detachedNodes.has(s.configurationId)).map((s) =>
      buildPlacement(s.configurationId, s.reduced.sliceCtoCode, s.raw.quantity ?? 1),
    );

    const cloneDependency = projectCloneDependency(ws.serverState.cloneDependency, ids.filter(id => !detachedNodes.has(id)),
      new Set(storagePhysicalTemplateIds(ws).keys()));
    const rackedIds = new Set(ws.rackArea.flatMap(rack => [...physicalIds(rack)]));

    return {
      workspaceInformation: {
        configurations: null,
        rackData: ws.rackArea.map(rack => physicalRackData(projections.get(String(rack.id))?.rack ?? rack)),
        nonRackData: ws.nonRackArea.length > 0 ? structuredClone(ws.nonRackArea) : nonRackPlacement.filter(item => !rackedIds.has(String(item.id))),
        cloneDependency,
        nonRackVirtualData: [],
        rackVirtualData: [],
      },
      autoDerivedResults: structuredClone(ws.serverState.autoDerivedResults ?? []),
      configurations: configs,
      operationHistories: [],
      controllerExpansionMap: ws.serverState.controllerExpansionMap ?? {},
      customizingFlags: {
        componentRestriction: true,
        autoDerive: true,
        ctoRules: true,
        minMax: true,
        placement: true,
        fromMemoryWizard: false,
        autoVariant: autoCorrect,
      },
      virtualContainerIdMapping: ws.serverState.virtualContainerIdMapping ?? {},
      virtualContainerRule2ConfigMapping: ws.serverState.virtualContainerRule2ConfigMapping ?? {},
      virtualContainerInvalidRuleIdMapping: ws.serverState.virtualContainerInvalidRuleIdMapping ?? {},
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
      autoDerive: true,
      ctoRules: true,
      minMax: true,
      placement: true,
      fromMemoryWizard: false,
      autoVariant: autoCorrect,
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
  QUOTE_CSV: 'QUOTE_CSV',
  EPRICE_CSV: 'EPRICE_CSV',
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

export const ALL_EXPORT_TYPES: ExportFileType[] = Object.keys(EXPORT_FILE_TYPES) as ExportFileType[];
export const DEFAULT_EXPORT_TYPES: ExportFileType[] = ALL_EXPORT_TYPES;

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

/** Shared complete browser-equivalent grouping for both scopes. */
export function buildGroups(
  raw: RawConfiguration | WorkspaceSession,
  configurationId?: string,
  mode?: ConfigMode,
): Array<Record<string, unknown>> {
  return buildExportGroups(raw, configurationId, mode).map((group) => ({ ...group }));
}

export function buildExportConfiguration(
  config: ReducedConfiguration,
  raw: RawConfiguration,
): Record<string, unknown> {
  return {
    id: config.id,
    workspaceId: config.id,
    code: config.sliceCtoCode,
    ctoCode: config.sliceCtoCode,
    sliceCtoCode: config.sliceCtoCode,
    lfoCode: config.lfoCode,
    name: config.name,
    type: raw.type ?? 'server',
    quantity: raw.quantity ?? 1,
    showPrice: config.showPrice,
    priceNotAvailable: false,
    specialBid: false,
    evaluationFlag: raw.evaluationFlag ?? 11,
    asMultiProd: false,
    autoDerivedResultId: null,
    sections: config.sections,
    products: [],
    slice: config.solutionMode === 'HPC and AI - Systems' ? 'HPCGP' : (config.slice ?? 'GP'),
    networkDerivedFeatures: {},
    solutionMode: config.solutionMode,
    asVLH: false,
    operationHistories: [],
    pinnedList: [],
    hipoDerivedItems: config.hipoDerivedItems,
    hipoServiceCtoServices: config.hipoServiceCtoServices,
    expansionMessages: raw.expansionMessages ?? [],
    nodeRole: config.nodeRole ?? '',
    selectedTopologies: config.selectedTopologies ?? {},
    selectedStorageNetwork: config.selectedStorageNetwork,
    serviceCtoFlag: config.serviceCtoFlag,
    storageWizardOption: storageWizardOption(raw),
    ...pciWizardWireFields(raw, 'export'),
    shippingStatus: config.shippingStatus,
    voltage: config.voltage,
    currentPowerPolicy: config.currentPowerPolicy,
    loadFactor: config.loadFactor,
    expressModeAvailable: config.expressModeAvailable,
    showExpressMode: config.showExpressMode,
    showExpressT2Mode: config.showExpressT2Mode,
    ...(config.selectedTceAudience !== undefined ? { selectedTceAudience: structuredClone(config.selectedTceAudience) } : {}),
  };
}

/** Export hierarchy and physical rack data are separate, never coordinate conversions. */
export const rackToLocalExportShape = buildRackHierarchy;
export const rackToServerExportShape = physicalRackData;

type ExportValidationEntry = {
  key: string;
  data: string[];
  unselectableWarnings?: Array<{ description: null; warnings: unknown[]; unSelectable: true }>;
};
type ExportValidationBucket = Record<string, ExportValidationEntry>;

function exportDiagnosticText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  for (const key of ['text', 'message', 'description', 'messageKey']) {
    if (typeof item[key] === 'string' && item[key].trim() !== '') return item[key];
  }
  return undefined;
}

/** Exact current-report sources used by the SPA's export projector. */
function exportDiagnostics(raw: RawConfiguration): {
  messages: Array<{ severity: 'err' | 'info' | 'warn'; message: string }>;
  unselectableWarnings: unknown[];
} {
  const output: Array<{ severity: 'err' | 'info' | 'warn'; message: string }> = [];
  const append = (value: unknown, severity: 'err' | 'info' | 'warn', stripMarkers = false): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      const rawMessage = exportDiagnosticText(entry);
      if (rawMessage) output.push({ severity, message: stripMarkers ? rawMessage.replaceAll('##', '') : rawMessage });
    }
  };
  for (const tab of raw.tabs ?? []) {
    for (const subTab of tab.subTabs ?? []) {
      append(subTab.warn, 'warn');
      append(subTab.info, 'info');
      append(subTab.notes, 'info');
      for (const section of subTab.sections ?? []) {
        append(section.errors, 'err', true);
      }
    }
  }
  if (Array.isArray(raw.unSelectableCharacters)) {
    for (const section of raw.unSelectableCharacters) {
      if (section !== null && typeof section === 'object' && !Array.isArray(section)) {
        append((section as Record<string, unknown>)['errors'], 'err', true);
      }
    }
  }
  if (Array.isArray(raw.serviceValidationMessages)) {
    for (const value of raw.serviceValidationMessages) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const group = value as Record<string, unknown>;
      const errors = Array.isArray(group['errors']) ? group['errors'] : [];
      if (group['description'] === 'Service' && errors.length === 0) append([group['message']], 'err', true);
      else append(errors, 'err', true);
    }
  }
  return { messages: output, unselectableWarnings: Array.isArray(raw.warnings) ? structuredClone(raw.warnings) : [] };
}

/**
 * Message History is partly historical and partly a current-state report.
 * Preserve captured user actions, but always rebuild validation messages from
 * the configurations being exported so stale/imported diagnostics cannot be
 * presented as applying to a different or subsequently edited configuration.
 */
function buildMessageHistory(
  targets: Array<{ configurationId: string; raw: RawConfiguration; label: string }>,
  captured?: unknown,
  autoConnectMessages: Array<{ configurationId: string; message: string }> = [],
): Record<string, unknown> {
  const capturedRows = Array.isArray(captured) ? captured
    : captured !== null && typeof captured === 'object' && !Array.isArray(captured) &&
        Array.isArray((captured as Record<string, unknown>)['history'])
      ? (captured as Record<string, unknown>)['history'] as unknown[] : [];
  const history = structuredClone(capturedRows.filter(row =>
    row !== null && typeof row === 'object' && !Array.isArray(row)));
  const labels = new Map(targets.map(target => [target.configurationId, target.label]));
  const validationReport: Record<'err' | 'info' | 'warn', ExportValidationBucket> = {
    err: {}, info: {}, warn: {},
  };
  for (const target of targets) {
    const diagnostics = exportDiagnostics(target.raw);
    for (const diagnostic of diagnostics.messages) {
      const bucket = validationReport[diagnostic.severity];
      const entry = bucket[target.configurationId] ??= {
        key: labels.get(target.configurationId) ?? 'Configuration',
        data: [],
      };
      entry.data.push(diagnostic.message);
    }
    if (diagnostics.unselectableWarnings.length > 0) {
      const entry = validationReport.warn[target.configurationId] ??= {
        key: labels.get(target.configurationId) ?? 'Configuration', data: [],
      };
      entry.unselectableWarnings = [{ description: null, warnings: diagnostics.unselectableWarnings,
        unSelectable: true }];
    }
  }
  for (const diagnostic of autoConnectMessages) {
    if (!labels.has(diagnostic.configurationId)) continue;
    const entry = validationReport.warn[diagnostic.configurationId] ??= {
      key: labels.get(diagnostic.configurationId) ?? 'Configuration', data: [],
    };
    entry.data.push(diagnostic.message);
  }
  return { history, validationReport: { ...validationReport, configurations: [] } };
}

function exportObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Project one non-overlapping dependency/color graph for the export boundary. */
function projectExportCloneColors(
  dependency: CloneDependency,
  sourceColors: Record<string, unknown>,
  activeConfigurationIds: ReadonlySet<string>,
  storageAliases: ReadonlyMap<string, string>,
  storageRoots: ReadonlySet<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const owners = new Map<string, string>();
  const storagePresentationOwners = new Map<string, string>();
  for (const [root, members] of Object.entries(dependency)) {
    for (const member of members) owners.set(member, root);
  }
  for (const [physicalId, templateId] of storageAliases) {
    if (owners.get(physicalId) !== templateId) {
      throw new Error(
        `Managed storage identity ${physicalId} must belong to dependency root ${templateId}; ` +
        'reconcile storage placement before exporting.',
      );
    }
  }

  for (const [root, members] of Object.entries(dependency)) {
    const source = sourceColors[root];
    if (storageRoots.has(root)) {
      const expected = [root, ...[...storageAliases].filter(([physicalId, templateId]) =>
        templateId === root && physicalId !== root).map(([physicalId]) => physicalId)];
      if (!sameIdentitySet(members, expected)) {
        throw new Error(
          `Managed storage dependency ${root} does not match its physical aliases; ` +
          'reconcile storage placement before exporting.',
        );
      }
      const storageColor = exportObject(source);
      result[root] = storageColor
        ? { ...structuredClone(storageColor), dependBy: [...members] }
        : createCloneDependencyColor(root, members);
      continue;
    }
    const existing = exportObject(source);
    const existingMembers = cloneColorMembers(existing, root);
    if (existingMembers && !sameIdentitySet(existingMembers, members) &&
        !(existingMembers.length === 1 && existingMembers[0] === root)) {
      throw new Error(
        `Clone dependency color ${root} conflicts with the active dependency group; ` +
        'reconcile or reimport the workspace before exporting.',
      );
    }
    result[root] = existing
      ? { ...structuredClone(existing), dependBy: [...members] }
      : createCloneDependencyColor(root, members);
  }

  for (const [root, source] of Object.entries(sourceColors)) {
    if (Object.hasOwn(result, root)) continue;
    const members = cloneColorMembers(source, root, { allowEmpty: true, allowRootless: true });
    if (members?.length === 0) {
      if (!activeConfigurationIds.has(root) && !storageRoots.has(root) && owners.get(root) === undefined) continue;
      throw new Error(`Clone color ${root} has empty ownership for an active dependency; reconcile the workspace before exporting.`);
    }
    const mappedStorageMembers = members?.filter(member => storageAliases.has(member)) ?? [];
    if (members && mappedStorageMembers.length > 0) {
      const templateId = exactStorageAliasRoot(members, storageAliases);
      const presentationKey = templateId !== undefined &&
        (storageAliases.get(root) === templateId ||
          (!activeConfigurationIds.has(root) && !storageRoots.has(root) && owners.get(root) === undefined));
      if (!presentationKey) {
        throw new Error(`Clone color ${root} has incomplete or conflicting managed storage ownership; reconcile the workspace before exporting.`);
      }
      for (const member of members) {
        const previous = storagePresentationOwners.get(member);
        if (previous && previous !== root) {
          throw new Error(`Clone color ${root} overlaps managed storage presentation group ${previous}; reconcile the workspace before exporting.`);
        }
        storagePresentationOwners.set(member, root);
      }
      continue;
    }
    if (members && !members.includes(root)) {
      throw new Error(`Clone color ${root} has rootless ownership outside a managed storage group; reconcile the workspace before exporting.`);
    }
    if (!activeConfigurationIds.has(root) && !storageRoots.has(root)) {
      if (members?.some(member => activeConfigurationIds.has(member))) {
        throw new Error(`Inactive clone color ${root} still owns active configurations; reconcile the workspace before exporting.`);
      }
      continue;
    }
    const owner = owners.get(root);
    if (owner !== undefined && owner !== root) {
      if (members && !(members.length === 1 && members[0] === root)) {
        throw new Error(`Clone color ${root} overlaps active dependency group ${owner}; reconcile the workspace before exporting.`);
      }
      continue;
    }
    throw new Error(`Clone color ${root} has no matching active dependency root; reconcile the workspace before exporting.`);
  }
  return result;
}

/**
 * The SPA keeps every physical loose item in workspaceInformation.nonRackData,
 * but compresses linked copies in the slim workspace hierarchy. Its grouping
 * key is the clone-color root plus the ship-uninstalled partition. Chassis are
 * grouped only when their children resolve to the same clone-root identities.
 */
function groupLooseCloneItems(
  items: readonly Record<string, unknown>[],
  colors: Record<string, unknown>,
  ungroupedIds: ReadonlySet<string> = new Set(),
): Record<string, unknown>[] {
  const owners = new Map<string, string>();
  for (const [root, color] of Object.entries(colors)) {
    for (const member of cloneColorMembers(color, root) ?? [root]) owners.set(member, root);
  }
  const itemId = (item: Record<string, unknown>): string => String(item['id'] ?? '');
  const nodes = (item: Record<string, unknown>): Record<string, unknown>[] =>
    Array.isArray(item['nodes'])
      ? item['nodes'].filter((node): node is Record<string, unknown> =>
        node !== null && typeof node === 'object' && !Array.isArray(node))
      : [];
  const nodeRoots = (item: Record<string, unknown>): string[] => nodes(item)
    .map(node => owners.get(itemId(node)) ?? itemId(node)).sort();
  const sameNodeRoots = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((identity, index) => identity === right[index]);
  const groups: Array<{ key: string; root: string; items: Record<string, unknown>[] }> = [];
  const sorted = [...items].sort((left, right) => Number(left['position'] ?? 0) - Number(right['position'] ?? 0));
  for (const item of sorted) {
    const id = itemId(item);
    // DCSC drops unplaced managed-storage configuration records when their
    // physical aliases are compressed into one quantity-N slim hierarchy
    // item. Keep each managed physical identity explicit while retaining its
    // template ownership in cloneDependency/cloneDependencyColor.
    const ungrouped = ungroupedIds.has(id);
    const root = ungrouped ? id : owners.get(id) ?? id;
    const key = JSON.stringify([ungrouped ? 'physical' : 'owner', root, item['shipUninstalled'] === true]);
    const existing = groups.find(group => group.key === key && (
      item['type'] !== 'chassis' ||
      (group.items[0]?.['type'] === 'chassis' && sameNodeRoots(nodeRoots(item), nodeRoots(group.items[0])))
    ));
    if (existing) existing.items.push(item);
    else groups.push({ key, root, items: [item] });
  }
  return groups.map(group => {
    const ids = group.items.map(itemId);
    const root = group.root;
    const selected = group.items.find(item => itemId(item) === root) ?? group.items[0]!;
    const result: Record<string, unknown> = {
      ...structuredClone(selected), quantity: group.items.length, originalIds: ids,
    };
    if (result['type'] === 'chassis') {
      const groupedNodes = new Map<string, { source: Record<string, unknown>; ids: string[] }>();
      for (const node of group.items.flatMap(nodes)) {
        const id = itemId(node);
        const nodeRoot = owners.get(id) ?? id;
        const existing = groupedNodes.get(nodeRoot);
        if (existing) existing.ids.push(id);
        else groupedNodes.set(nodeRoot, { source: node, ids: [id] });
      }
      result['nodes'] = [...groupedNodes].map(([nodeRoot, value]) => ({
        ...structuredClone(value.source),
        id: nodeRoot,
        quantity: value.ids.length / group.items.length,
        originalIds: value.ids,
      }));
    }
    return result;
  });
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
  /** Authoritative physical metadata for a single-configuration export. */
  placement?: Record<string, unknown>;
  autoDerivedResults?: unknown[];
}): Record<string, unknown> {
  if (opts.workspace) {
    const ws = opts.workspace;
    const state = ws.serverState ?? {};
    assertCurrentConnectionGraph(state);
    const floor = buildFloorState(ws);
    const stateWorkspace = (state.workspace ?? {}) as Record<string, unknown>;
    const stateNetwork = (state.networkingInformation ?? {}) as Record<string, unknown>;
    // This is a live-request field, not part of the website export network envelope.
    const { autoConnectSettings: _requestSettings, ...exportNetwork } = stateNetwork;
    const settings = readAutoConnectSettings(state);
    const settingFlags = Object.fromEntries(['autoAddPDU', 'autoAddSwitch', 'p2pCabling']
      .filter(key => typeof settings[key] === 'boolean').map(key => [key, settings[key]]));
    const configs = [...ws.configurations.values()];
    const projectedConfigurations = projectChassisManufacturing({ rackArea: ws.rackArea,
      nonRackArea: ws.nonRackArea, configurations: configs.map(session => session.raw),
      cloneDependencyColor: state.cloneDependencyColor });
    const exportConfigs = configs.map((s, index) => {
      const raw = projectedConfigurations[index]!;
      return buildExportConfiguration(reduceConfiguration(raw, s.configurationId, hardwareModeFamily(s.mode), s.solution.solutionMode), raw);
    });
    const ids = configs.map((s) => s.configurationId);
    const detachedNodes = detachedNestedNodeIds(ws);

    const projectedRacks = ws.rackArea.map(rack => {
      const session = configs.find(s => s.configurationId === rack.id);
      return session && hardwareModeFamily(session.mode) === 'cto'
        ? projectRackFiller(rack, { ...session.raw, id: session.configurationId }).rack : rack;
    });
    const localRackArea = projectedRacks.map((rack, index) => buildRackHierarchy(rack, index));
    const rackData = projectedRacks.map(physicalRackData);

    // Configurations that live in the rack area — the cabinets themselves and
    // anything DCSC placed inside them — must not also be exported as loose
    // non-rack items, or they would be counted twice.
    const rackedIds = new Set<string>();
    for (const rack of ws.rackArea) {
      for (const id of physicalIds(rack)) rackedIds.add(id);
      for (const item of (rack['servers'] as Array<Record<string, unknown>> | undefined) ?? []) {
        const id = item['id'];
        if (typeof id === 'string') rackedIds.add(id);
      }
    }
    // Children of an unplaced chassis stay nested in its hierarchy. Their
    // independent configuration sessions must not create additional loose units.
    for (const container of ws.nonRackArea) {
      for (const id of physicalIds(container)) {
        if (id !== container.id) rackedIds.add(id);
      }
    }
    const managedControllers = managedStorageComponentIds(ws.serverState);
    const looseConfigs = configs.filter((s) => !rackedIds.has(s.configurationId) && !detachedNodes.has(s.configurationId) &&
      (!managedControllers.has(s.configurationId) || ws.nonRackArea.some(item => item.id === s.configurationId)));

    const nonRackData = structuredClone(ws.nonRackArea ?? []);
    for (const s of looseConfigs) {
      if (nonRackData.some(item => item.id === s.configurationId)) continue;
      const idx = configs.indexOf(s);
      nonRackData.push(buildPlacement(
        s.configurationId,
        s.reduced.sliceCtoCode,
        s.raw.quantity ?? 1,
        (exportConfigs[idx]?.slice as string) ?? 'GP',
      ));
    }
    // Mark rack cabinets as type "rack" so export can distinguish them.
    for (const c of exportConfigs) {
      const code = String(c['code'] ?? '');
      if (ws.rackArea.some((r) => String(r['code'] ?? '').toUpperCase() === code.toUpperCase())) {
        c['type'] = 'rack';
        c['name'] = 'Rack';
      }
      // Carry topology selection into the export payload.
      const session = configs.find((s) => s.configurationId === c['id'] || s.reduced.id === c['id']);
      if (session?.reduced.selectedTopologies) {
        c['selectedTopologies'] = session.reduced.selectedTopologies;
      }
      if (session?.reduced.nodeRole) {
        c['nodeRole'] = session.reduced.nodeRole;
      }
    }

    const activeConfigurationIds = new Set(ids.filter(id => !detachedNodes.has(id)));
    const storageAliases = storagePhysicalTemplateIds(ws);
    const storageRoots = new Set([...managedStorageComponentIds(state), ...storageAliases.values()]);
    const sourceCloneDependencyColors = storageDependencyColors(ws);
    const importedCloneOwnership = reconcileImportedCloneOwnership({
      dependency: projectCloneDependency(state.cloneDependency, [...activeConfigurationIds], new Set(storageAliases.keys())),
      colors: sourceCloneDependencyColors,
      provenance: state.importCloneExpansion,
      activeConfigurationIds,
      storageRoots,
      storageAliases,
      configurations: configs,
    });
    const cloneDependency = importedCloneOwnership.dependency;
    const exportCloneDependencyColor = projectExportCloneColors(
      cloneDependency,
      importedCloneOwnership.colors,
      activeConfigurationIds,
      storageAliases,
      storageRoots,
    );
    const diagnosticRoots = new Set(
      Object.keys(exportCloneDependencyColor),
    );
    // Physical storage aliases have no separate editable configuration. Keep
    // each loose alias explicit in the slim hierarchy, alongside the complete
    // physical list, just as racked aliases remain separate cabinet children.
    const nonRackArea = groupLooseCloneItems(
      nonRackData,
      exportCloneDependencyColor,
      new Set(storageAliases.keys()),
    ).map(item => {
      const hierarchy = buildItemHierarchy(item);
      const originals = Array.isArray(item['originalIds']) ? item['originalIds'] : [item['id']];
      // The website imports an unracked line as one physical copy per
      // originalId. A quantity-N configuration with a single physical record
      // makes /racks/customize fail and the CFXML opens empty, so refuse it
      // rather than export a file that cannot be reopened.
      const singleton = originals.length === 1
        ? looseConfigs.find(session => session.configurationId === item['id'])
        : undefined;
      const singletonQuantity = singleton?.raw.quantity ?? 1;
      if (singleton && singletonQuantity > 1) {
        const syntheticIds = Array.from(
          { length: singletonQuantity - 1 },
          (_, i) => `${singleton.configurationId}__clone_${i + 1}`,
        );
        const expandedOriginalIds = [singleton.configurationId, ...syntheticIds];

        item['quantity'] = singletonQuantity;
        item['originalIds'] = expandedOriginalIds;

        const rootRecord = nonRackData.find(r => r['id'] === singleton.configurationId);
        if (rootRecord) {
          rootRecord['quantity'] = 1;
          rootRecord['originalIds'] = [singleton.configurationId];
        }
        const slice = (exportConfigs[configs.indexOf(singleton)]?.slice as string) ?? 'GP';
        for (const cloneId of syntheticIds) {
          const clonedPlacement = rootRecord
            ? { ...structuredClone(rootRecord), id: cloneId, quantity: 1, originalIds: [cloneId] }
            : buildPlacement(cloneId, singleton.reduced.sliceCtoCode, 1, slice);
          if (!rootRecord) clonedPlacement['originalIds'] = [cloneId];
          nonRackData.push(clonedPlacement);
        }

        cloneDependency[singleton.configurationId] = expandedOriginalIds;
        const existingColor = exportCloneDependencyColor[singleton.configurationId] as Record<string, unknown> | undefined;
        exportCloneDependencyColor[singleton.configurationId] = existingColor
          ? { ...existingColor, root: singleton.configurationId, dependBy: expandedOriginalIds }
          : createCloneDependencyColor(singleton.configurationId, expandedOriginalIds);

        if (opts.solution.solutionMode !== 'General Purpose') {
          const rootConfig = exportConfigs[configs.indexOf(singleton)];
          if (rootConfig) rootConfig['quantity'] = 1;
          for (const cloneId of syntheticIds) {
            const clonedRaw = cloneConfigurationRaw(singleton.raw, singleton.configurationId, cloneId);
            clonedRaw.quantity = 1;
            exportConfigs.push(buildExportConfiguration(
              reduceConfiguration(clonedRaw, cloneId, hardwareModeFamily(singleton.mode), opts.solution.solutionMode),
              clonedRaw,
            ));
          }
        }

        return {
          ...hierarchy,
          quantity: singletonQuantity,
          originalIds: structuredClone(expandedOriginalIds),
        };
      }
      return {
        ...hierarchy,
        quantity: item['quantity'] ?? 1,
        originalIds: structuredClone(originals),
      };
    });

    return {
      // The website enables physical clone expansion outside General Purpose.
      // Without it, CFXML omits alias configurations and fails on reimport.
      toggle7116On: opts.solution.solutionMode !== 'General Purpose',
      workspace: {
        rackArea: localRackArea,
        nonRackArea,
        floorItems: floor.items,
        cloneRackMapping: stateWorkspace.cloneRackMapping ?? {},
      },
      configurations: exportConfigs,
      crnId: '',
      cloneDependencyColor: exportCloneDependencyColor,
      virtualContainerIdMapping: state.virtualContainerIdMapping ?? {},
      virtualContainerRule2ConfigMapping: state.virtualContainerRule2ConfigMapping ?? {},
      virtualContainerInvalidRuleIdMapping: state.virtualContainerInvalidRuleIdMapping ?? {},
      statusRelatedResult: {
        overPreSelectResults: [],
        autoDerivedConfigurationIds: ids,
        requiredSections: null,
      },
      // SPA deletes workspaceInformation.configurations when removeRedundantConfigurations is on.
      workspaceInformation: {
        rackData,
        nonRackData,
        cloneDependency,
        nonRackVirtualData: [],
        rackVirtualData: [],
      },
      autoDerivedResults: structuredClone(state.autoDerivedResults ?? []),
      crossSystemConfigs: [],
      standaloneData: state.standaloneData ?? [],
      standaloneSwSubcategorySelections: state.standaloneSwSubcategorySelections ?? state.standaloneSoftwareCtoSelections ?? [],
      ruleConditionIdMapping: '{}',
      instanceIdMapping: '{}',
      controllerExpansionMap: state.controllerExpansionMap ?? {},
      controllerIndexMap: state.controllerIndexMap ?? {},
      autoConnectResults: readConnectionGraph(state),
      floorInformation: floor.information,
      networkingInformation: {
        ...exportNetwork,
        // Live native state can carry preferences without the imported export mirror.
        // Explicit empty current selections must also override stale imported values.
        ...(state.clusterPreference !== undefined ? { clusterPreference: structuredClone(state.clusterPreference) } : {}),
        ...(state.storageConnectionNetworks !== undefined ? { storageNetworks: structuredClone(state.storageConnectionNetworks) } : {}),
        // Website power-source preferences use {rack, selection, preferredPDU}.
        // Local selected-PDU summaries are derived from the rack BOM and must
        // not replace that distinct, lossless imported preference envelope.
        powerSelection: structuredClone(stateNetwork.powerSelection ?? []),
        autoConnectResults: readConnectionGraph(state),
        cables: buildCableGroups(readConnectionGraph(state), ws.solution.solutionMode === 'General Purpose'),
        switchMap: readSwitchMap(state),
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
        autoAddPDU: ws.rackArea.length > 0,
        autoAddSwitch: ws.rackArea.length > 0,
        p2pCabling: true,
        autoArrange: false,
        autoConnect: true,
        ...((state.customizingFlags ?? {}) as Record<string, unknown>),
        ...settingFlags,
      },
      messageHistory: buildMessageHistory(
        configs.map((session, index) => ({ session, index }))
          .filter(({ session }) => diagnosticRoots.has(session.configurationId) &&
            !detachedNodes.has(session.configurationId))
          .map(({ session, index }) => ({
          configurationId: session.configurationId,
          raw: projectedConfigurations[index]!,
          label: session.reduced.name || HARDWARE_LABEL[session.product.type] || session.product.code,
          })),
        Array.isArray(state.historyInformation) ? state.historyInformation : state.messageHistory,
        ws.rackArea.flatMap(rack => (Array.isArray(rack['errors']) ? rack['errors'] : [])
          .filter((error): error is Record<string, unknown> =>
            error !== null && typeof error === 'object' && !Array.isArray(error) &&
            String((error as Record<string, unknown>)['code'] ?? '') === '102')
          .map(error => ({ configurationId: String(rack['id'] ?? ''),
            message: String(error['message'] ?? '') }))
          .filter(message => message.configurationId !== '' && message.message !== '')),
      ),
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
  const placement = opts.placement ?? buildPlacement(id, config.sliceCtoCode, quantity, exportConfig.slice as string);

  return {
    toggle7116On: opts.solution.solutionMode !== 'General Purpose',
    workspace: {
      rackArea: [],
      nonRackArea: [{ ...buildItemHierarchy(placement), quantity }],
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
      nonRackData: [structuredClone(placement)],
      cloneDependency: { [id]: [id] },
      nonRackVirtualData: [],
      rackVirtualData: [],
    },
    autoDerivedResults: structuredClone(opts.autoDerivedResults ?? []),
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
    // A config-only export must never leak history from another workspace.
    messageHistory: buildMessageHistory([{ configurationId: id, raw, label: config.name }]),
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
  image?: string | undefined;
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
    image: opts.image ?? '',
    user: '',
    'dcsc-isFromIntegration': 'false',
    serviceAndorRequest: '',
    uuid: '',
  };
}
