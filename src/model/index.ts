import type {
  IndexedFeature,
  RawConfiguration,
  RawSection,
  RawTab,
} from './types.js';

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

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Builds the derived index beside the raw payload.
 *
 * Non-destructive by construction: nothing here mutates or replaces `raw`.
 * Rebuilt from scratch after every mutation, which is cheap relative to the
 * network round-trip that produced the new payload.
 */
export function buildIndex(raw: RawConfiguration): ConfigIndex {
  const features: IndexedFeature[] = [];
  const sections: SectionRef[] = [];
  const selected = new Map<string, number>();
  const tabs: string[] = [];
  const usedIds = new Set<string>();

  for (const tab of (raw.tabs ?? []) as RawTab[]) {
    const tabTitle = tab.title ?? tab.tabTypeIdentifier ?? 'Unknown';
    if (!tabs.includes(tabTitle)) tabs.push(tabTitle);

    for (const subTab of tab.subTabs ?? []) {
      const subTitle = subTab.title ?? tabTitle;

      for (const section of subTab.sections ?? []) {
        const name = section.name ?? section.title ?? 'unnamed';
        const title = section.description ?? section.title ?? name;

        // Section ids must be stable and unique; collisions are real because
        // the same section name recurs across sub-tabs.
        let id = `${slug(tabTitle)}.${slug(name)}`;
        let n = 2;
        while (usedIds.has(id)) id = `${slug(tabTitle)}.${slug(name)}-${n++}`;
        usedIds.add(id);

        const ref: SectionRef = { id, tab: tabTitle, subTab: subTitle, name, title, section };
        sections.push(ref);

        // Selections live in results[], not on the features themselves.
        const selectedHere = new Map<string, number>();
        for (const result of section.results ?? []) {
          if (!result.code) continue;
          const qty = result.quantity ?? 1;
          selectedHere.set(result.code, (selectedHere.get(result.code) ?? 0) + qty);
          selected.set(result.code, (selected.get(result.code) ?? 0) + qty);
        }

        for (const feature of section.features ?? []) {
          const description = feature.description ?? '';
          features.push({
            code: feature.code,
            description,
            min: feature.min ?? 0,
            max: feature.max ?? 1,
            unitPrice: feature.unitPrice ?? 0,
            category: feature.category ?? undefined,
            selectedQty: selectedHere.get(feature.code) ?? 0,
            eccnRestricted: feature.eccnRestricted === true,
            tab: tabTitle,
            subTab: subTitle,
            section: id,
            sectionTitle: title,
            haystack: `${feature.code} ${description} ${title}`.toLowerCase(),
          });
        }
      }
    }
  }

  const byCode = new Map<string, IndexedFeature[]>();
  for (const f of features) {
    const list = byCode.get(f.code);
    if (list) list.push(f);
    else byCode.set(f.code, [f]);
  }

  return {
    features,
    byCode,
    sections,
    sectionById: new Map(sections.map((s) => [s.id, s])),
    tabs,
    selected,
  };
}

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
export function searchFeatures(
  index: ConfigIndex,
  opts: FeatureSearchOptions,
): FeatureSearchResult {
  const limit = Math.min(opts.limit ?? 25, 100);
  const offset = opts.offset ?? 0;
  const needle = opts.query?.trim().toLowerCase() ?? '';
  const tokens = needle ? needle.split(/\s+/).filter(Boolean) : [];

  let pool = index.features;
  if (opts.tab) {
    const tab = opts.tab.toLowerCase();
    pool = pool.filter((f) => f.tab.toLowerCase() === tab);
  }
  if (opts.section) {
    pool = pool.filter((f) => f.section === opts.section);
  }
  if (opts.filter === 'selected') pool = pool.filter((f) => f.selectedQty > 0);
  else if (opts.filter === 'selectable') pool = pool.filter((f) => f.max > 0);

  if (tokens.length === 0) {
    return { items: pool.slice(offset, offset + limit), total: pool.length, offset, limit };
  }

  const scored: Array<{ f: IndexedFeature; score: number }> = [];
  for (const f of pool) {
    let score = 0;
    if (f.code.toLowerCase() === needle) score += 1000;
    let matched = 0;
    for (const token of tokens) if (f.haystack.includes(token)) matched += 1;
    if (matched === 0 && score === 0) continue;
    score += (matched / tokens.length) * 100;
    if (f.haystack.includes(needle)) score += 50;
    scored.push({ f, score });
  }
  scored.sort((a, b) => b.score - a.score || a.f.code.localeCompare(b.f.code));

  return {
    items: scored.slice(offset, offset + limit).map((s) => s.f),
    total: scored.length,
    offset,
    limit,
  };
}
