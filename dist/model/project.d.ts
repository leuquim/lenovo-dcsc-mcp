import type { ConfigIndex } from './index.js';
import type { IndexedFeature, RawConfiguration } from './types.js';
export interface Constraint {
    name: string;
    used: number;
    capacity: number;
    unit?: string | undefined;
    breached: boolean;
}
/**
 * `resourceTrackers` is the prevention layer: showing "PCIe slots 4/4" stops
 * the model attempting a fifth adapter, which is cheaper than surfacing the
 * resulting error afterwards.
 */
export declare function projectConstraints(raw: RawConfiguration): Constraint[];
export interface ResourceTrackerView {
    name: string;
    unit?: string | undefined;
    resources: Array<{
        label: string;
        value: string;
    }>;
}
/** The configurator's Resource Tracker panel: slot and bay occupancy exactly as DCSC reports it. */
export declare function projectResourceTrackers(raw: RawConfiguration): ResourceTrackerView[];
export interface ConfigurationError {
    tab: string;
    subTab: string;
    section: string;
    errors: unknown[];
}
/** The configurator's Show Errors list: rule errors DCSC attached to sections. */
export declare function projectConfigurationErrors(index: ConfigIndex): ConfigurationError[];
export interface SessionSummary {
    session: string;
    revision: number;
    product: {
        code: string;
        description: string;
        type: string;
    };
    currency: string;
    country: string;
    quantity: number;
    unitPrice: number | null;
    /** Price of one configured unit. */
    totalPrice: number | null;
    /** totalPrice x quantity — what the line actually costs. */
    extendedPrice: number | null;
    priceAvailable: boolean;
    priceType: 'LIST';
    pricedAt: string;
    tabs: Array<{
        id: string;
        title: string;
        sections: number;
        selected: number;
    }>;
    constraints: Constraint[];
    disclaimer: string;
}
/** L0 — what every tool returns as its header. */
export declare function projectSummary(opts: {
    sessionId: string;
    revision: number;
    raw: RawConfiguration;
    index: ConfigIndex;
    currency: string;
    country: string;
    pricedAt: number;
}): SessionSummary;
export interface TabSection {
    id: string;
    /** Human display title. */
    name: string;
    /** DCSC's internal section name — the identifier mutations resolve against. */
    sectionName: string;
    subTab: string;
    required: boolean;
    single: boolean;
    selected: Array<{
        code: string;
        qty: number;
        desc: string;
        price: number;
    }>;
    options: number;
    priceRange: [number, number] | null;
}
export interface TabView {
    session: string;
    revision: number;
    currency: string;
    tab: string;
    /** Exact identifier accepted by option search's `tab` filter. */
    tabId: string;
    tabSubtotal: number | null;
    sections: TabSection[];
    next: string;
}
/** L1 — sections with current selections inlined, but no feature lists. */
export declare function projectTab(opts: {
    sessionId: string;
    revision: number;
    index: ConfigIndex;
    tab: string;
    currency: string;
}): TabView;
export interface OptionLine {
    code: string;
    desc: string;
    /** Exact tab title accepted by the `tab` filter. */
    tabId: string;
    /** Stable synthetic id accepted by configure and the `section` filter. */
    sectionId: string;
    /** DCSC's internal section name, useful when inspecting raw rule messages. */
    sectionName: string;
    /** Arguments that can be passed directly to dcsc_configure with a quantity. */
    configure: {
        section: string;
        code: string;
    };
    /** Delta versus the currently selected item in this section, when there is one. */
    delta?: number;
    unit: number;
    sel?: number;
    max?: number;
}
export interface OptionsView {
    session: string;
    revision: number;
    currency: string;
    section?: string | undefined;
    name?: string | undefined;
    query?: string | undefined;
    tab?: string | undefined;
    filter?: 'all' | 'selected' | 'selectable' | undefined;
    priceBasis: string;
    page: {
        offset: number;
        limit: number;
        total: number;
    };
    options: OptionLine[];
    truncated?: {
        shown: number;
        total: number;
    };
    next?: {
        tool: string;
        arguments: Record<string, unknown>;
    };
}
/**
 * L2 — one line per feature.
 *
 * Prices are shown as a delta against the current selection where one exists.
 * "This CPU is +$4,200" is the question actually being asked; absolute list
 * prices force arithmetic the model routinely gets wrong.
 */
export declare function projectOptions(opts: {
    sessionId: string;
    revision: number;
    currency: string;
    items: IndexedFeature[];
    total: number;
    offset: number;
    limit: number;
    index: ConfigIndex;
    section?: string | undefined;
    query?: string | undefined;
    tab?: string | undefined;
    filter?: 'all' | 'selected' | 'selectable' | undefined;
    maxBytes?: number | undefined;
}): OptionsView;
/**
 * Degrades a view that exceeds its byte budget rather than letting it through.
 * Drops trailing options and records what was hidden.
 */
export declare function enforceBudget(view: OptionsView, maxBytes: number): OptionsView;
export interface FeatureDetail {
    code: string;
    description: string;
    tab: string;
    section: string;
    sectionTitle: string;
    /** DCSC's internal section name — the identifier mutations resolve against. */
    sectionName: string;
    min: number;
    max: number;
    unitPrice: number;
    selectedQty: number;
    category?: string | undefined;
    eccnRestricted: boolean;
    attributes?: Record<string, string> | undefined;
}
/** L3 — full detail. Descriptions are never truncated here. */
export declare function projectFeatureDetail(index: ConfigIndex, raw: RawConfiguration, code: string): FeatureDetail | undefined;
