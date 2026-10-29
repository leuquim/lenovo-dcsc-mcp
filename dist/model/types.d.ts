/**
 * Narrow structural types over the raw DCSC configuration payload.
 *
 * These are deliberately NOT a full schema. The raw response has ~94
 * top-level fields and we consume a handful; modelling all of it would be
 * both wasted effort and a drift liability. Everything here is optional
 * because the payload varies by product family.
 *
 * Critical invariant: the raw object is retained verbatim in the session and
 * is what gets posted back on mutation. These types describe it; they never
 * replace it.
 */
export interface RawPrice {
    priceTypeId?: number;
    price?: number;
    priceNotAvailable?: boolean;
}
export interface RawFeature {
    [key: string]: unknown;
    code: string;
    description?: string | null;
    min?: number | null;
    max?: number | null;
    quantityOptions?: number[] | null;
    unitPrice?: number | null;
    prices?: RawPrice[] | null;
    productNumber?: string | null;
    type?: string | null;
    category?: string | null;
    attributeMap?: Record<string, string | null> | null;
    eccnRestricted?: boolean | null;
    announceDate?: string | null;
    withdrawnDate?: string | null;
}
/** An entry in `section.results[]` — i.e. a currently selected item. */
export interface RawResult {
    [key: string]: unknown;
    code?: string | null;
    quantity?: number | null;
    cost?: number | null;
    characterName?: string | null;
    ctoCode?: string | null;
    deSelectable?: boolean | null;
}
export interface RawSection {
    [key: string]: unknown;
    name?: string | null;
    title?: string | null;
    description?: string | null;
    singleEntry?: boolean | null;
    required?: boolean | null;
    selectable?: boolean | null;
    readOnly?: boolean | null;
    priority?: number | null;
    totalPrice?: number | null;
    features?: RawFeature[] | null;
    results?: RawResult[] | null;
    errors?: unknown[] | null;
}
export interface RawSubTab {
    [key: string]: unknown;
    title?: string | null;
    description?: string | null;
    type?: string | null;
    sections?: RawSection[] | null;
}
export interface RawTab {
    title?: string | null;
    description?: string | null;
    type?: string | null;
    tabTypeIdentifier?: string | null;
    subTabs?: RawSubTab[] | null;
}
/**
 * Resource trackers report capacity headroom (memory slots, PSU bays, CPU
 * sockets, riser slots). The shape is a label/value list rather than numeric
 * fields, and the labels vary by unit — "Total Slots"/"Available Slots" for
 * memory, "Total Bays"/"Available Bays" for power supplies.
 *
 * verified against a live 7D73CTO1WW launch, 2026-08-07
 */
export interface RawResourceTracker {
    description?: string | null;
    type?: string | null;
    key?: string | null;
    /** e.g. "Slots", "Bays". */
    unit?: string | null;
    resources?: Array<{
        label?: string | null;
        value?: string | null;
    }> | null;
}
export interface RawConfiguration {
    id?: string | null;
    sliceCtoCode?: string | null;
    slice?: string | null;
    country?: string | null;
    description?: string | null;
    type?: string | null;
    quantity?: number | null;
    unitPrice?: number | null;
    totalPrice?: number | null;
    totalPrices?: RawPrice[] | null;
    showPrice?: boolean | null;
    customized?: boolean | null;
    tabs?: RawTab[] | null;
    resourceTrackers?: RawResourceTracker[] | null;
    powerReportResponse?: unknown;
    powerPolicies?: unknown;
    shippingStatus?: unknown;
    addedParts?: unknown[] | null;
    removedParts?: unknown[] | null;
    replacedParts?: unknown[] | null;
    expressModeAvailable?: boolean | null;
    [key: string]: unknown;
}
/** A stable address for a feature within the tree. */
export interface FeatureLocation {
    tab: string;
    subTab: string;
    section: string;
    sectionTitle: string;
    sectionName?: string;
}
export interface IndexedFeature extends FeatureLocation {
    code: string;
    description: string;
    min: number;
    max: number;
    unitPrice: number;
    category: string | undefined;
    selectedQty: number;
    eccnRestricted: boolean;
    haystack: string;
}
