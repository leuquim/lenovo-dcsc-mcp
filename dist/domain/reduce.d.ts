import type { ConfigMode } from '../config/constants.js';
import type { SolutionContext } from '../config/schema.js';
import type { RawConfiguration } from '../model/types.js';
import { type WireResult, type WireSection } from './dcscWire.js';
import type { WorkspaceSession } from '../session/SessionStore.js';
import { buildRackHierarchy, physicalRackData } from './workspaceWire.js';
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
export declare function newConfigurationId(country: string): string;
export type ReducedResult = WireResult;
export type ReducedSection = WireSection;
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
export declare function applyCatalogChange(config: ReducedConfiguration, raw: RawConfiguration, change: {
    sectionName: string;
    code: string;
    quantity: number;
}): ReducedConfiguration;
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
export declare function reduceConfiguration(raw: RawConfiguration, configurationId: string, mode?: 'cto' | 'lfo', solutionMode?: string): ReducedConfiguration;
/**
 * Applies a selection change to the reduced model and records the delta.
 */
export declare function applyChange(config: ReducedConfiguration, change: {
    sectionName: string;
    code: string;
    quantity: number;
    /** Sub-tab the section lives under. DCSC needs it to locate a new section. */
    subTabTitle?: string | undefined;
    /** False for single-select sections, so a change replaces instead of appends. */
    multipleSelectable?: boolean | undefined;
    /** Catalog singleEntry:false: retain peer result codes without changing the wire flag. */
    preserveOtherSelections?: boolean | undefined;
}): ReducedConfiguration;
export declare function buildPlacement(id: string, productCode: string, quantity?: number, slice?: string): Record<string, unknown>;
/** The envelope autoDerive expects. Supports single config or workspace. */
export declare function buildAutoDeriveRequest(input: ReducedConfiguration | WorkspaceSession, opts: {
    validationMode: 'guided' | 'expert';
    autoCorrect?: boolean;
}): Record<string, unknown>;
export declare const EXPORT_FILE_TYPES: {
    readonly XML: "XML";
    readonly QUOTE: "QUOTE";
    readonly QUOTE_CSV: "QUOTE_CSV";
    readonly EPRICE_CSV: "EPRICE_CSV";
    readonly QUOTE_SUPPLYINFO: "QUOTE_SUPPLYINFO";
    readonly QUOTE_GROUP: "QUOTE_GROUP";
    readonly SUMMARY: "SUMMARY";
    readonly POWER_REPORT: "POWER_REPORT";
    readonly RACK_REPORT: "RACK_REPORT";
    readonly RACK_DIAGRAM: "RACK_DIAGRAM";
    readonly FLOOR: "FLOOR";
    readonly MESSAGE_HISTORY: "MESSAGE_HISTORY";
    readonly P2P_REPORT: "P2P_REPORT";
};
export type ExportFileType = keyof typeof EXPORT_FILE_TYPES;
export declare const ALL_EXPORT_TYPES: ExportFileType[];
export declare const DEFAULT_EXPORT_TYPES: ExportFileType[];
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
export declare function buildGroups(raw: RawConfiguration | WorkspaceSession, configurationId?: string, mode?: ConfigMode): Array<Record<string, unknown>>;
export declare function buildExportConfiguration(config: ReducedConfiguration, raw: RawConfiguration): Record<string, unknown>;
/** Export hierarchy and physical rack data are separate, never coordinate conversions. */
export declare const rackToLocalExportShape: typeof buildRackHierarchy;
export declare const rackToServerExportShape: typeof physicalRackData;
/**
 * Builds the `data` field of the export form POST.
 * Supports single configuration or full WorkspaceSession with racks & cabling.
 */
export declare function buildExportData(opts: {
    raw?: RawConfiguration;
    config?: ReducedConfiguration;
    workspace?: WorkspaceSession;
    solution: SolutionContext;
    fileTypes: ExportFileType[];
    validationMode: 'guided' | 'expert';
    /** Authoritative physical metadata for a single-configuration export. */
    placement?: Record<string, unknown>;
    autoDerivedResults?: unknown[];
}): Record<string, unknown>;
/** The 14 form fields of the export POST, as sent by the real client. */
export declare function buildExportForm(opts: {
    data: Record<string, unknown>;
    groups: Array<Record<string, unknown>>;
    image?: string | undefined;
}): Record<string, string>;
