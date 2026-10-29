import type { DcscHttpClient, RequestCtx } from '../http/request.js';
type Obj = Record<string, unknown>;
export type PartLookupType = 'SOFTWARE' | 'SERVICE' | 'HARDWARE';
export type PartLookupMode = 'CTO' | 'LFO';
export type PartNextAction = 'launch_configuration' | 'browse_software_catalog' | 'select_on_product_services' | 'inspect_hardware_catalog';
export interface FindPartsInput {
    keyword: string;
    types?: readonly PartLookupType[] | undefined;
    mode: PartLookupMode;
}
export interface PartLookupHit {
    code: string;
    description: string;
    type: string;
    nextAction: PartNextAction;
    /** Complete object returned by /findpart. */
    raw: Obj;
}
export interface FindPartsResult {
    items: PartLookupHit[];
    /** Complete response returned by /findpart. */
    raw: unknown;
    /** DCSC exposes no verified total or cursor for this endpoint. */
    upstreamCompleteness: 'unknown';
}
export interface SoftwareCatalogPath {
    tab: string;
    subTab: string;
    section: string;
    subCategory?: string | undefined;
}
export interface StandaloneSoftwareFeature {
    code: string;
    softwareCode?: string | undefined;
    description: string;
    unitPrice?: number | undefined;
    priceNotAvailable: boolean;
    showPrice?: boolean | undefined;
    prices: unknown[];
    attributes: Obj;
    path: SoftwareCatalogPath;
    /** Complete catalog feature, including unmodeled availability and marketing metadata. */
    raw: Obj;
}
export interface StandaloneSoftwareSelection {
    id: string;
    kind: 'software';
    code: string;
    quantity: number;
    unitPrice?: number | undefined;
    totalPrice?: number | undefined;
    feature: StandaloneSoftwareFeature;
}
export interface StandaloneSoftwareState {
    kind: 'standalone-software';
    /** Response from POST /ctos/standalone_software/launch. */
    launchRaw: unknown;
    /** Response from GET /software/portal/launch. */
    portalRaw: unknown;
    /** Locally indexed view of the complete captured portal response. */
    features: StandaloneSoftwareFeature[];
    selections: StandaloneSoftwareSelection[];
}
export interface BrowseSoftwareInput {
    query?: string | undefined;
    path?: Partial<SoftwareCatalogPath> | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
}
export interface BrowseSoftwareResult {
    items: StandaloneSoftwareFeature[];
    totalInFetchedCatalog: number;
    offset: number;
    limit: number;
    /** The launch endpoint has no verified pagination/total contract. */
    upstreamCompleteness: 'unknown';
}
export interface SelectSoftwareInput {
    code: string;
    quantity: number;
    /** Allows a store/session layer to supply its own durable identity. */
    id?: string | undefined;
}
export interface StandaloneSoftwareExportEnvelope {
    endpoint: '/lfos/export_zip';
    data: Obj & {
        standaloneData: Obj[];
    };
    groups: Array<{
        name: string;
        parent: null;
        index: -1;
        products: Obj[];
    }>;
}
export interface ProductServiceSelection {
    code: string;
    quantity: number;
    description: string;
    type: string;
    characterName: string;
    section: string;
    sectionName: string;
    sectionDescription: string;
    /** Present on a newly selected feature; DCSC may omit it from authoritative prior results. */
    ctoCode?: string | undefined;
    /** Full selected feature from the current auto-derive graph. */
    rawFeature: Obj;
}
export interface ProductServiceOption {
    code: string;
    description: string;
    type: string;
    characterName: string;
    unitPrice?: number | undefined;
    preSelectedQuantity?: number | undefined;
    section: string;
    sectionName: string;
    sectionDescription: string;
    /** Full feature from the current auto-derive graph. */
    rawFeature: Obj;
}
export interface ProductServiceState {
    kind: 'product-bound-services';
    product: {
        code: string;
        quantity: number;
        description?: string | undefined;
    };
    subCategory: string;
    /** Complete response from /services/autoDerive. Replaced after each selection. */
    optionGraphRaw: unknown;
    /** Complete response from /service_pacs/:productCode. */
    catalogRaw: unknown;
    /** Typed view of the current option graph; preselection metadata is not selection state. */
    options: ProductServiceOption[];
    selections: ProductServiceSelection[];
    /** Exact request used for the most recent derive; required by service export. */
    lastDeriveRequest?: ServiceDeriveRequest | undefined;
    /** Complete response from /services/summaries. */
    summaryRaw?: unknown;
}
export interface LaunchProductServicesInput {
    productCode: string;
    productQuantity?: number | undefined;
    productDescription?: string | undefined;
    /** Captured anonymous portal flow uses "Point of Sale". */
    subCategory: string;
}
export interface SelectProductServiceInput {
    serviceCode: string;
    quantity: number;
}
export interface ServiceDeriveResult {
    code: string;
    ctoCode?: string | undefined;
    description: string;
    quantity: number;
    type: string;
    characterName: string;
}
export interface ServiceDeriveSection {
    description: string;
    source: string;
    name: string;
    type: 'servicesAndor';
    results: ServiceDeriveResult[];
}
export interface ServiceDeriveRequest {
    ctoCode: string;
    subCategory: string;
    sections: ServiceDeriveSection[];
    delta: {
        section: string;
        featureCode?: string | undefined;
        quantity?: number | undefined;
    };
}
export interface ProductServiceSummaryRequest {
    code: string;
    quantity: number;
    services: Array<{
        serviceCode: string;
        quantity: number;
    }>;
}
export interface ProductServiceExportEnvelope {
    endpoint: '/service_pacs/export';
    data: ProductServiceSummaryRequest[];
    serviceAndorRequest: ServiceDeriveRequest;
    fields: Record<string, string>;
}
/** Global part lookup. The result is intentionally not assigned a synthetic cursor or total. */
export declare function findParts(http: DcscHttpClient, ctx: RequestCtx, input: FindPartsInput): Promise<FindPartsResult>;
/** Fetches both software launch contracts concurrently and retains both complete responses. */
export declare function launchStandaloneSoftware(http: DcscHttpClient, ctx: RequestCtx): Promise<StandaloneSoftwareState>;
/** Local browse over the complete response already fetched from DCSC. */
export declare function browseStandaloneSoftware(state: StandaloneSoftwareState, input?: BrowseSoftwareInput): BrowseSoftwareResult;
/** Selects a software SKU locally. DCSC exposes no repricing call for this observed workflow. */
export declare function selectStandaloneSoftware(state: StandaloneSoftwareState, input: SelectSoftwareInput): StandaloneSoftwareState;
export declare function setStandaloneSoftwareQuantity(state: StandaloneSoftwareState, code: string, quantity: number): StandaloneSoftwareState;
export declare function removeStandaloneSoftware(state: StandaloneSoftwareState, code: string): StandaloneSoftwareState;
/** Builds the captured /lfos/export_zip standaloneData and group envelope. */
export declare function buildStandaloneSoftwareExportEnvelope(state: StandaloneSoftwareState, baseData: Obj, groupName?: string): StandaloneSoftwareExportEnvelope;
/** Launches a product-bound service graph and its full service catalog concurrently. */
export declare function launchProductServices(http: DcscHttpClient, ctx: RequestCtx, input: LaunchProductServicesInput): Promise<ProductServiceState>;
/** Refreshes selectable metadata while retaining the saved selection, request and summary price. */
export declare function refreshProductServiceCatalog(http: DcscHttpClient, ctx: RequestCtx, state: ProductServiceState): Promise<ProductServiceState>;
/** Posts the exact typed servicesAndor selection shape captured from the website. */
export declare function selectProductService(http: DcscHttpClient, ctx: RequestCtx, state: ProductServiceState, input: SelectProductServiceInput): Promise<ProductServiceState>;
/** Removes one selected service using the quantity-zero website toggle contract. */
export declare function removeProductService(http: DcscHttpClient, ctx: RequestCtx, state: ProductServiceState, serviceCode: string): Promise<ProductServiceState>;
export declare function buildProductServiceSummaryRequest(state: ProductServiceState): ProductServiceSummaryRequest[];
/** Retrieves authoritative service pricing after explicit selection. */
export declare function summariseProductServices(http: DcscHttpClient, ctx: RequestCtx, state: ProductServiceState): Promise<ProductServiceState>;
/**
 * Builds the form fields captured from the anonymous service summary Save action.
 * The XML is restored through the typed standalone service import adapter.
 */
export declare function buildProductServiceExportEnvelope(state: ProductServiceState): ProductServiceExportEnvelope;
export {};
