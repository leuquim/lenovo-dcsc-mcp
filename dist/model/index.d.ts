import type { IndexedFeature, RawConfiguration, RawSection } from './types.js';
export interface SectionRef {
    /** Stable synthetic id, e.g. "processors.cpu". */
    id: string;
    tab: string;
    subTab: string;
    name: string;
    title: string;
    section: RawSection;
}
export interface ConfigIndex {
    /** Every feature in the tree, flattened. */
    features: IndexedFeature[];
    /** code -> features (a code can appear in more than one section). */
    byCode: Map<string, IndexedFeature[]>;
    sections: SectionRef[];
    sectionById: Map<string, SectionRef>;
    tabs: string[];
    /** code -> selected quantity, aggregated across the whole configuration. */
    selected: Map<string, number>;
}
/**
 * Builds the derived index beside the raw payload.
 *
 * Non-destructive by construction: nothing here mutates or replaces `raw`.
 * Rebuilt from scratch after every mutation, which is cheap relative to the
 * network round-trip that produced the new payload.
 */
export declare function buildIndex(raw: RawConfiguration): ConfigIndex;
/**
 * Resolves whatever the caller called a section into the real section.
 *
 * Three identifiers are in circulation and only one of them works against the
 * reduced model. `name` is DCSC's internal name (`PDU`); `title` is the human
 * label the option listings print (`Power Distribution Unit`); `id` is our own
 * synthetic slug (`power.pdu`). Callers reasonably pass back whichever one they
 * were last shown, so accept all three rather than silently failing to match —
 * an unmatched section used to be indistinguishable from a no-op change.
 *
 * Matching is case-insensitive and, for ids, punctuation-insensitive.
 */
export declare function resolveSection(index: ConfigIndex, identifier: string): SectionRef | undefined;
/** Section identifiers to offer back when resolution fails. */
export declare function suggestSections(index: ConfigIndex, identifier: string, limit?: number): string[];
export interface FeatureSearchOptions {
    query?: string | undefined;
    tab?: string | undefined;
    section?: string | undefined;
    filter?: 'all' | 'selected' | 'selectable' | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
}
export interface FeatureSearchResult {
    items: IndexedFeature[];
    total: number;
    offset: number;
    limit: number;
}
/**
 * Cross-tab feature search.
 *
 * This is the primary navigation path. Walking eleven tabs to find one feature
 * code is the failure mode this exists to prevent, so the tool descriptions
 * steer the model here first and treat browsing as the exception.
 */
export declare function searchFeatures(index: ConfigIndex, opts: FeatureSearchOptions): FeatureSearchResult;
