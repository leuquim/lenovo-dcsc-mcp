import type { ConfigIndex, SectionRef } from './index.js';
import type { IndexedFeature, RawConfiguration, RawResourceTracker } from './types.js';
import { availablePrice, configurationListPrice } from '../domain/pricing.js';
import { jsonBytes } from '../util/jsonBytes.js';
import { PAGE_BYTE_BUDGET } from '../config/constants.js';

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

export interface ResourceTrackerView {
  name: string;
  unit?: string | undefined;
  resources: Array<{ label: string; value: string }>;
}

/** The configurator's Resource Tracker panel: slot and bay occupancy exactly as DCSC reports it. */
export function projectResourceTrackers(raw: RawConfiguration): ResourceTrackerView[] {
  return (raw.resourceTrackers ?? []).map((tracker) => ({
    name: tracker.description ?? tracker.key ?? 'resource',
    ...(tracker.unit != null ? { unit: tracker.unit } : {}),
    resources: (tracker.resources ?? []).map((entry) => ({ label: entry.label ?? '', value: entry.value ?? '' })),
  }));
}

export interface ConfigurationError { tab: string; subTab: string; section: string; errors: unknown[] }

/** The configurator's Show Errors list: rule errors DCSC attached to sections. */
export function projectConfigurationErrors(index: ConfigIndex): ConfigurationError[] {
  return index.sections
    .filter((ref) => (ref.section.errors ?? []).length > 0)
    .map((ref) => ({ tab: ref.tab, subTab: ref.subTab, section: ref.title, errors: ref.section.errors! }));
}

export interface SessionSummary {
  session: string;
  revision: number;
  product: { code: string; description: string; type: string };
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
  tabs: Array<{ id: string; title: string; sections: number; selected: number }>;
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
  const totalPrice = configurationListPrice(raw);

  const tabs = index.tabs.map((title) => {
    const sections = index.sections.filter((s) => s.tab === title);
    const selected = sections.reduce(
      (n, s) => n + (s.section.results?.filter((r) => r.code).length ?? 0),
      0,
    );
    // The exact DCSC title is also the accepted tab selector. Publishing it as
    // an id gives callers a stable value to pass back without slug guessing.
    return { id: title, title, sections: sections.length, selected };
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
    unitPrice: availablePrice(raw.unitPrice, raw.priceNotAvailable === true),
    totalPrice,
    extendedPrice: totalPrice === null ? null : round(totalPrice * (raw.quantity ?? 1)),
    priceAvailable: totalPrice !== null,
    priceType: 'LIST',
    pricedAt: new Date(opts.pricedAt).toISOString(),
    tabs,
    constraints: projectConstraints(raw),
    disclaimer: LIST_PRICE_DISCLAIMER,
  };
}

export interface TabSection {
  id: string;
  /** Human display title. */
  name: string;
  /** DCSC's internal section name — the identifier mutations resolve against. */
  sectionName: string;
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
  /** Exact identifier accepted by option search's `tab` filter. */
  tabId: string;
  tabSubtotal: number | null;
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

  const sections = refs.map((ref) => projectSection(ref, opts.index));
  const subtotal = refs.some((ref) => ref.section.priceNotAvailable === true)
    ? null : round(refs.reduce((sum, ref) => sum + (availablePrice(ref.section.totalPrice) ?? 0), 0));

  return {
    session: opts.sessionId,
    revision: opts.revision,
    currency: opts.currency,
    tab: refs[0]?.tab ?? opts.tab,
    tabId: refs[0]?.tab ?? opts.tab,
    tabSubtotal: subtotal,
    sections,
    next: `dcsc_configuration_get(session, view: "options", section: "<id>") to see the options in a section`,
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
    // `name` has always carried the human title here. Keep it, but publish
    // DCSC's internal name too: it is the identifier mutations resolve against,
    // and it was previously invisible from every listing.
    name: ref.title,
    sectionName: ref.name,
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
  /** Exact tab title accepted by the `tab` filter. */
  tabId: string;
  /** Stable synthetic id accepted by configure and the `section` filter. */
  sectionId: string;
  /** DCSC's internal section name, useful when inspecting raw rule messages. */
  sectionName: string;
  /** Arguments that can be passed directly to dcsc_configure with a quantity. */
  configure: { section: string; code: string };
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
  page: { offset: number; limit: number; total: number };
  options: OptionLine[];
  truncated?: { shown: number; total: number };
  next?: { tool: string; arguments: Record<string, unknown> };
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
  tab?: string | undefined;
  filter?: 'all' | 'selected' | 'selectable' | undefined;
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
    tabId: f.tab,
    sectionId: f.section,
    sectionName: f.sectionName ?? '',
    configure: { section: f.section, code: f.code },
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
    ...(opts.tab !== undefined ? { tab: opts.tab } : {}),
    ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
    priceBasis,
    page: { offset: opts.offset, limit: opts.limit, total: opts.total },
    options: lines,
  };

  // Reserve continuation text before trimming so it participates in the byte
  // budget. enforceBudget recalculates its offset from the options retained.
  if (opts.offset < opts.total && items.length > 0) view.next = continuation(view);
  return enforceBudget(view, opts.maxBytes ?? PAGE_BYTE_BUDGET);
}

/**
 * Degrades a view that exceeds its byte budget rather than letting it through.
 * Drops trailing options and records what was hidden.
 */
export function enforceBudget(view: OptionsView, maxBytes: number): OptionsView {
  let current = withContinuation(view);
  while (
    jsonBytes(current) > maxBytes &&
    current.options.length > 1
  ) {
    const keep = Math.max(1, Math.floor(current.options.length * 0.75));
    current = {
      ...current,
      options: current.options.slice(0, keep),
      truncated: { shown: keep, total: view.page.total },
    };
    current = withContinuation(current);
  }
  return withContinuation(current);
}

function withContinuation(view: OptionsView): OptionsView {
  const nextOffset = view.page.offset + view.options.length;
  if (view.options.length === 0 || nextOffset >= view.page.total) {
    const { next: _next, ...withoutNext } = view;
    return withoutNext;
  }
  return { ...view, next: continuation(view) };
}

function continuation(view: OptionsView): NonNullable<OptionsView['next']> {
  return { tool: 'dcsc_configuration_get', arguments: {
    session: view.session,
    view: 'options',
    ...(view.query !== undefined ? { query: view.query } : {}),
    ...(view.tab !== undefined ? { tab: view.tab } : {}),
    ...(view.section !== undefined ? { section: view.section } : {}),
    ...(view.filter !== undefined ? { filter: view.filter } : {}),
    limit: view.page.limit,
    offset: view.page.offset + view.options.length,
  } };
}

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
    sectionName: f.sectionName ?? '',
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
