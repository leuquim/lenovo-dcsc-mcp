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
function shortDesc(text, max = 90) {
    const clean = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
function round(n) {
    return Math.round(n * 100) / 100;
}
/**
 * `resourceTrackers` is the prevention layer: showing "PCIe slots 4/4" stops
 * the model attempting a fifth adapter, which is cheaper than surfacing the
 * resulting error afterwards.
 */
export function projectConstraints(raw) {
    const trackers = (raw.resourceTrackers ?? []);
    const out = [];
    for (const tracker of trackers) {
        const total = findResource(tracker, /^total\b/i);
        const available = findResource(tracker, /^available\b/i);
        // Trackers that report only a quantity (e.g. "Total Ordered: 64.0GB")
        // carry no capacity, so there is no constraint to express.
        if (total === undefined || available === undefined)
            continue;
        const constraint = {
            name: tracker.description ?? tracker.key ?? 'resource',
            used: total - available,
            capacity: total,
            breached: available < 0,
        };
        if (tracker.unit != null)
            constraint.unit = tracker.unit;
        out.push(constraint);
    }
    return out;
}
/**
 * Pulls a numeric resource by label. Values arrive as strings and some carry
 * units ("64.0GB"), which is why only the plain-numeric ones are usable as
 * capacity figures.
 */
function findResource(tracker, labelPattern) {
    for (const entry of tracker.resources ?? []) {
        const label = entry.label ?? '';
        if (!labelPattern.test(label))
            continue;
        const value = (entry.value ?? '').trim();
        if (!/^-?\d+(\.\d+)?$/.test(value))
            continue;
        return Number(value);
    }
    return undefined;
}
/** The configurator's Resource Tracker panel: slot and bay occupancy exactly as DCSC reports it. */
export function projectResourceTrackers(raw) {
    return (raw.resourceTrackers ?? []).map((tracker) => ({
        name: tracker.description ?? tracker.key ?? 'resource',
        ...(tracker.unit != null ? { unit: tracker.unit } : {}),
        resources: (tracker.resources ?? []).map((entry) => ({ label: entry.label ?? '', value: entry.value ?? '' })),
    }));
}
/** The configurator's Show Errors list: rule errors DCSC attached to sections. */
export function projectConfigurationErrors(index) {
    return index.sections
        .filter((ref) => (ref.section.errors ?? []).length > 0)
        .map((ref) => ({ tab: ref.tab, subTab: ref.subTab, section: ref.title, errors: ref.section.errors }));
}
const LIST_PRICE_DISCLAIMER = 'List price for the stated country and currency. Not a quote; partner and bid pricing require a Lenovo login.';
/** L0 — what every tool returns as its header. */
export function projectSummary(opts) {
    const { raw, index } = opts;
    const totalPrice = configurationListPrice(raw);
    const tabs = index.tabs.map((title) => {
        const sections = index.sections.filter((s) => s.tab === title);
        const selected = sections.reduce((n, s) => n + (s.section.results?.filter((r) => r.code).length ?? 0), 0);
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
/** L1 — sections with current selections inlined, but no feature lists. */
export function projectTab(opts) {
    const refs = opts.index.sections.filter((s) => s.tab.toLowerCase() === opts.tab.toLowerCase());
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
function projectSection(ref, index) {
    const features = index.features.filter((f) => f.section === ref.id);
    const prices = features.map((f) => f.unitPrice).filter((p) => Number.isFinite(p));
    const selected = (ref.section.results ?? [])
        .filter((r) => r.code)
        .map((r) => {
        const code = r.code;
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
        priceRange: prices.length > 0 ? [round(Math.min(...prices)), round(Math.max(...prices))] : null,
    };
}
/**
 * L2 — one line per feature.
 *
 * Prices are shown as a delta against the current selection where one exists.
 * "This CPU is +$4,200" is the question actually being asked; absolute list
 * prices force arithmetic the model routinely gets wrong.
 */
export function projectOptions(opts) {
    const { items, index } = opts;
    // Basis for the delta: the selected item in the section being listed.
    let basis;
    let priceBasis = 'absolute unit list price';
    if (opts.section) {
        basis = index.features.find((f) => f.section === opts.section && f.selectedQty > 0);
        if (basis)
            priceBasis = `delta vs currently selected ${basis.code}`;
    }
    const lines = items.map((f) => ({
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
    const view = {
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
    if (opts.offset < opts.total && items.length > 0)
        view.next = continuation(view);
    return enforceBudget(view, opts.maxBytes ?? PAGE_BYTE_BUDGET);
}
/**
 * Degrades a view that exceeds its byte budget rather than letting it through.
 * Drops trailing options and records what was hidden.
 */
export function enforceBudget(view, maxBytes) {
    let current = withContinuation(view);
    while (jsonBytes(current) > maxBytes &&
        current.options.length > 1) {
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
function withContinuation(view) {
    const nextOffset = view.page.offset + view.options.length;
    if (view.options.length === 0 || nextOffset >= view.page.total) {
        const { next: _next, ...withoutNext } = view;
        return withoutNext;
    }
    return { ...view, next: continuation(view) };
}
function continuation(view) {
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
/** L3 — full detail. Descriptions are never truncated here. */
export function projectFeatureDetail(index, raw, code) {
    const hits = index.byCode.get(code);
    const f = hits?.[0];
    if (!f)
        return undefined;
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
function findAttributes(raw, code) {
    for (const tab of raw.tabs ?? []) {
        for (const subTab of tab.subTabs ?? []) {
            for (const section of subTab.sections ?? []) {
                for (const feature of section.features ?? []) {
                    if (feature.code !== code)
                        continue;
                    const map = feature.attributeMap;
                    if (!map)
                        return undefined;
                    const out = {};
                    for (const [k, v] of Object.entries(map)) {
                        if (v != null && v !== '')
                            out[k] = v;
                    }
                    return Object.keys(out).length > 0 ? out : undefined;
                }
            }
        }
    }
    return undefined;
}
//# sourceMappingURL=project.js.map