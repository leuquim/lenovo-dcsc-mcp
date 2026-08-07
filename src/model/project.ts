import type { ConfigIndex, SectionRef } from './index.js';
import type { IndexedFeature, RawConfiguration, RawResourceTracker } from './types.js';

/**
 * Progressive disclosure.
 *
 * The raw launch payload is ~150 KB and cannot enter an LLM's context. These
 * projections are strict subsets, each one a drill-down from the last:
 *
 *   L0  session summary   — tabs, counts, subtotals, constraints   (~800 B)
 *   L1  tab view          — sections + current selections, no features
 *   L2  section view      — one line per feature, paginated
 *   L3  feature detail    — everything, for a handful of codes
 *
 * Every projection is byte-budgeted. Silently exceeding the budget would blow
 * the context window the whole design exists to protect.
 */

export const DEFAULT_MAX_BYTES = 6_000;

/** Descriptions carry markup and boilerplate; list views get a short form. */
function shortDesc(text: string, max = 90): string {
  const clean = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

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
export function projectConstraints(raw: RawConfiguration): Constraint[] {
  const trackers = (raw.resourceTrackers ?? []) as RawResourceTracker[];
  const out: Constraint[] = [];

  for (const tracker of trackers) {
    const total = findResource(tracker, /^total\b/i);
    const available = findResource(tracker, /^available\b/i);

    // Trackers that report only a quantity (e.g. "Total Ordered: 64.0GB")
    // carry no capacity, so there is no constraint to express.
    if (total === undefined || available === undefined) continue;

    const constraint: Constraint = {
      name: tracker.description ?? tracker.key ?? 'resource',
      used: total - available,
      capacity: total,
      breached: available < 0,
    };
    if (tracker.unit != null) constraint.unit = tracker.unit;
    out.push(constraint);
  }
  return out;
}

/**
 * Pulls a numeric resource by label. Values arrive as strings and some carry
 * units ("64.0GB"), which is why only the plain-numeric ones are usable as
 * capacity figures.
 */
function findResource(
  tracker: RawResourceTracker,
  labelPattern: RegExp,
): number | undefined {
  for (const entry of tracker.resources ?? []) {
    const label = entry.label ?? '';
    if (!labelPattern.test(label)) continue;
    const value = (entry.value ?? '').trim();
    if (!/^-?\d+(\.\d+)?$/.test(value)) continue;
    return Number(value);
  }
  return undefined;
}

export interface SessionSummary {
  session: string;
  revision: number;
  product: { code: string; description: string; type: string };
  currency: string;
  country: string;
  quantity: number;
  unitPrice: number;
  /** Price of one configured unit. */
  totalPrice: number;
  /** totalPrice x quantity — what the line actually costs. */
  extendedPrice: number;
  priceType: 'LIST';
  pricedAt: string;
  tabs: Array<{ title: string; sections: number; selected: number }>;
  constraints: Constraint[];
  disclaimer: string;
}

const LIST_PRICE_DISCLAIMER =
  'List price for the stated country and currency. Not a quote; partner and bid pricing require a Lenovo login.';

/** L0 — what every tool returns as its header. */
export function projectSummary(opts: {
  sessionId: string;
  revision: number;
  raw: RawConfiguration;
  index: ConfigIndex;
  currency: string;
  country: string;
  pricedAt: number;
}): SessionSummary {
  const { raw, index } = opts;

  const tabs = index.tabs.map((title) => {
    const sections = index.sections.filter((s) => s.tab === title);
    const selected = sections.reduce(
      (n, s) => n + (s.section.results?.filter((r) => r.code).length ?? 0),
      0,
    );
    return { title, sections: sections.length, selected };
  });

  return {
    session: opts.sessionId,
    revision: opts.revision,
    product: {
      code: raw.sliceCtoCode ?? 'unknown',
      description: shortDesc(raw.description ?? '', 120),
      type: raw.type ?? 'unknown',
    },
    currency: opts.currency,
    country: opts.country,
    quantity: raw.quantity ?? 1,
    unitPrice: round(raw.unitPrice ?? 0),
    totalPrice: round(raw.totalPrice ?? 0),
    extendedPrice: round((raw.totalPrice ?? 0) * (raw.quantity ?? 1)),
    priceType: 'LIST',
    pricedAt: new Date(opts.pricedAt).toISOString(),
    tabs,
    constraints: projectConstraints(raw),
    disclaimer: LIST_PRICE_DISCLAIMER,
  };
}

export interface TabSection {
  id: string;
  name: string;
  subTab: string;
  required: boolean;
  single: boolean;
  selected: Array<{ code: string; qty: number; desc: string; price: number }>;
  options: number;
  priceRange: [number, number] | null;
}

export interface TabView {
  session: string;
  revision: number;
  currency: string;
  tab: string;
  tabSubtotal: number;
  sections: TabSection[];
  next: string;
}

/** L1 — sections with current selections inlined, but no feature lists. */
export function projectTab(opts: {
  sessionId: string;
  revision: number;
  index: ConfigIndex;
  tab: string;
  currency: string;
}): TabView {
  const refs = opts.index.sections.filter(
    (s) => s.tab.toLowerCase() === opts.tab.toLowerCase(),
  );

  let subtotal = 0;
  const sections = refs.map((ref) => projectSection(ref, opts.index));
  for (const ref of refs) subtotal += ref.section.totalPrice ?? 0;

  return {
    session: opts.sessionId,
    revision: opts.revision,
    currency: opts.currency,
    tab: refs[0]?.tab ?? opts.tab,
    tabSubtotal: round(subtotal),
    sections,
    next: `dcsc_list_options(session, section: "<id>") to see the options in a section`,
  };
}

function projectSection(ref: SectionRef, index: ConfigIndex): TabSection {
  const features = index.features.filter((f) => f.section === ref.id);
  const prices = features.map((f) => f.unitPrice).filter((p) => Number.isFinite(p));

  const selected = (ref.section.results ?? [])
    .filter((r) => r.code)
    .map((r) => {
      const code = r.code as string;
      const feature = features.find((f) => f.code === code);
      return {
        code,
        qty: r.quantity ?? 1,
        desc: shortDesc(feature?.description ?? '', 70),
        price: round(feature?.unitPrice ?? r.cost ?? 0),
      };
    });

  return {
    id: ref.id,
    name: ref.title,
    subTab: ref.subTab,
    required: ref.section.required === true,
    single: ref.section.singleEntry === true,
    selected,
    options: features.length,
    priceRange:
      prices.length > 0 ? [round(Math.min(...prices)), round(Math.max(...prices))] : null,
  };
}

export interface OptionLine {
  code: string;
  desc: string;
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
  priceBasis: string;
  page: { offset: number; limit: number; total: number };
  options: OptionLine[];
  truncated?: { shown: number; total: number };
  next?: string;
}

/**
 * L2 — one line per feature.
 *
 * Prices are shown as a delta against the current selection where one exists.
 * "This CPU is +$4,200" is the question actually being asked; absolute list
 * prices force arithmetic the model routinely gets wrong.
 */
export function projectOptions(opts: {
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
  maxBytes?: number | undefined;
}): OptionsView {
  const { items, index } = opts;

  // Basis for the delta: the selected item in the section being listed.
  let basis: IndexedFeature | undefined;
  let priceBasis = 'absolute unit list price';
  if (opts.section) {
    basis = index.features.find((f) => f.section === opts.section && f.selectedQty > 0);
    if (basis) priceBasis = `delta vs currently selected ${basis.code}`;
  }

  const lines: OptionLine[] = items.map((f) => ({
    code: f.code,
    desc: shortDesc(f.description),
    ...(basis ? { delta: round(f.unitPrice - basis.unitPrice) } : {}),
    unit: round(f.unitPrice),
    ...(f.selectedQty > 0 ? { sel: f.selectedQty } : {}),
    ...(f.max > 1 ? { max: f.max } : {}),
  }));

  const view: OptionsView = {
    session: opts.sessionId,
    revision: opts.revision,
    currency: opts.currency,
    ...(opts.section !== undefined ? { section: opts.section } : {}),
    ...(opts.section !== undefined
      ? { name: index.sectionById.get(opts.section)?.title }
      : {}),
    ...(opts.query !== undefined ? { query: opts.query } : {}),
    priceBasis,
    page: { offset: opts.offset, limit: opts.limit, total: opts.total },
    options: lines,
  };

  if (opts.offset + items.length < opts.total) {
    view.next = `dcsc_list_options(session, ${
      opts.section ? `section: "${opts.section}", ` : ''
    }offset: ${opts.offset + items.length})`;
  }

  return enforceBudget(view, opts.maxBytes ?? DEFAULT_MAX_BYTES);
}

/**
 * Degrades a view that exceeds its byte budget rather than letting it through.
 * Drops trailing options and records what was hidden.
 */
export function enforceBudget(view: OptionsView, maxBytes: number): OptionsView {
  let current = view;
  while (
    Buffer.byteLength(JSON.stringify(current), 'utf8') > maxBytes &&
    current.options.length > 1
  ) {
    const keep = Math.max(1, Math.floor(current.options.length * 0.75));
    current = {
      ...current,
      options: current.options.slice(0, keep),
      truncated: { shown: keep, total: view.page.total },
    };
  }
  return current;
}

export interface FeatureDetail {
  code: string;
  description: string;
  tab: string;
  section: string;
  sectionTitle: string;
  min: number;
  max: number;
  unitPrice: number;
  selectedQty: number;
  category?: string | undefined;
  eccnRestricted: boolean;
  attributes?: Record<string, string> | undefined;
}

/** L3 — full detail. Descriptions are never truncated here. */
export function projectFeatureDetail(
  index: ConfigIndex,
  raw: RawConfiguration,
  code: string,
): FeatureDetail | undefined {
  const hits = index.byCode.get(code);
  const f = hits?.[0];
  if (!f) return undefined;

  const attributes = findAttributes(raw, code);

  return {
    code: f.code,
    description: f.description,
    tab: f.tab,
    section: f.section,
    sectionTitle: f.sectionTitle,
    min: f.min,
    max: f.max,
    unitPrice: round(f.unitPrice),
    selectedQty: f.selectedQty,
    ...(f.category !== undefined ? { category: f.category } : {}),
    eccnRestricted: f.eccnRestricted,
    ...(attributes ? { attributes } : {}),
  };
}

/**
 * Pulls `attributeMap` straight from the raw tree.
 *
 * Attributes are dropped from list views but must never be unreachable: they
 * carry the decisive detail (a "P" suffix meaning single-socket-only, for
 * instance) that a summary would otherwise hide.
 */
function findAttributes(
  raw: RawConfiguration,
  code: string,
): Record<string, string> | undefined {
  for (const tab of raw.tabs ?? []) {
    for (const subTab of tab.subTabs ?? []) {
      for (const section of subTab.sections ?? []) {
        for (const feature of section.features ?? []) {
          if (feature.code !== code) continue;
          const map = feature.attributeMap;
          if (!map) return undefined;
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(map)) {
            if (v != null && v !== '') out[k] = v;
          }
          return Object.keys(out).length > 0 ? out : undefined;
        }
      }
    }
  }
  return undefined;
}
