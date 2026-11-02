import { objectOrEmpty } from '../util/coerce.js';
const money = (v) => Math.round(v * 100) / 100;
/** The native lazy loader merges selections by section identity, never array order. */
export function hydrateUnconfiguredCatalog(current, catalog) {
    const tabs = structuredClone((catalog.tabs ?? []).filter(t => t.type === 'UNCONFIGURED_TAB'));
    if (tabs.length !== 1 || !tabs[0].subTabs?.length)
        throw new Error('DCSC returned no Unconfigured catalog.');
    const sections = tabs.flatMap(t => t.subTabs ?? []).flatMap(t => t.sections ?? []);
    for (const old of (current.tabs ?? []).filter(t => t.type === 'UNCONFIGURED_TAB')
        .flatMap(t => t.subTabs ?? []).flatMap(t => t.sections ?? [])) {
        if (!old.results?.length)
            continue;
        const matches = sections.filter(s => s.name === old.name);
        if (matches.length !== 1)
            throw new Error(`The refreshed catalog cannot preserve selected section ${old.name}.`);
        const target = matches[0];
        for (const result of old.results) {
            if (!(target.features ?? []).some(f => f.code === result.code && (!result['optionCode'] || f['optionCode'] === result['optionCode']))) {
                throw new Error(`The refreshed catalog cannot preserve selected feature ${result.code}.`);
            }
        }
        target.results = structuredClone(old.results);
    }
    Object.assign(tabs[0], { mockTab: false, unConfiguredId: current.id });
    return repriceUnconfigured(current, { ...current, tabs: [...structuredClone((current.tabs ?? []).filter(t => t.type !== 'UNCONFIGURED_TAB')), ...tabs] });
}
/** Mirrors changeUnconfiguredSectionSelection; no hardware derive is involved. */
export function stageUnconfiguredSelection(raw, change) {
    if (!Number.isSafeInteger(change.quantity) || change.quantity < 0)
        throw new Error('Unconfigured quantity must be a nonnegative integer.');
    const next = structuredClone(raw);
    const sections = (next.tabs ?? []).filter(t => t.type === 'UNCONFIGURED_TAB')
        .flatMap(t => t.subTabs ?? []).flatMap(t => t.sections ?? []).filter(s => s.name === change.sectionName);
    if (sections.length !== 1)
        throw new Error('Inspect one exact Unconfigured section before editing.');
    const section = sections[0];
    if (section['readOnly'] === true || section.selectable === false)
        throw new Error('This Unconfigured section is not editable.');
    const features = (section.features ?? []).filter(f => f.code === change.code);
    if (features.length !== 1)
        throw new Error('Use an unambiguous feature from the loaded Unconfigured catalog.');
    const feature = features[0];
    const results = section.results ?? [];
    const selected = results.filter(r => r.code === change.code);
    if (selected.length > 1)
        throw new Error('The Unconfigured selection is ambiguous.');
    if (change.quantity === 0)
        section.results = results.filter(r => r.code !== change.code);
    else if (selected[0])
        selected[0].quantity = change.quantity;
    else
        section.results = [...results, { code: change.code, quantity: change.quantity,
                ...Object.fromEntries(['priceNotAvailable', 'optionCode', 'description', 'eccnRestricted', 'type']
                    .filter(key => feature[key] !== undefined).map(key => [key, feature[key]])),
            }];
    return repriceUnconfigured(raw, next);
}
/** Catalog refreshes can change unit prices without changing quantities. */
function repriceUnconfigured(raw, next) {
    const before = unconfiguredProducts(raw);
    const after = unconfiguredProducts(next);
    const delta = after.reduce((n, p) => n + (p.price ?? 0), 0) - before.reduce((n, p) => n + (p.price ?? 0), 0);
    if (typeof next.totalPrice === 'number')
        next.totalPrice = money(next.totalPrice + delta);
    if ([...before, ...after].some(p => p.price === null))
        next.priceNotAvailable = true;
    if (next.totalPrices)
        next.totalPrices = adjustUnconfiguredPrices(adjustUnconfiguredPrices(next.totalPrices, raw, -1), next, 1);
    if (Array.isArray(next['nonSoftwareTotalPrices']))
        next['nonSoftwareTotalPrices'] =
            adjustUnconfiguredPrices(adjustUnconfiguredPrices(next['nonSoftwareTotalPrices'], raw, -1), next, 1);
    return next;
}
/** Native Unconfigured selections are client-owned and omitted from autoDerive. */
export function unconfiguredProducts(raw) {
    return (raw.tabs ?? []).filter(t => t.type === 'UNCONFIGURED_TAB').flatMap(t => t.subTabs ?? [])
        .flatMap(t => t.sections ?? []).flatMap(section => (section.results ?? []).filter(r => Number(r.quantity) > 0).map(result => {
        const feature = objectOrEmpty(section.features?.find(f => f.code === result.code &&
            (!result['optionCode'] || f['optionCode'] === result['optionCode'])));
        const unavailable = feature['priceNotAvailable'] === true || result['priceNotAvailable'] === true;
        const value = feature['noCharge'] === true || result['noCharge'] === true ? 0 : feature['unitPrice'];
        const unitPrice = !unavailable && typeof value === 'number' && Number.isFinite(value) ? value : null;
        return { code: String(result.code), description: String(result['description'] ?? feature['description'] ?? ''),
            quantity: Number(result.quantity), unitPrice, price: unitPrice === null ? null : money(unitPrice * Number(result.quantity)),
            prices: Array.isArray(feature['prices']) ? feature['prices'] : [],
            priceNotAvailable: unitPrice === null };
    }));
}
/** Add/remove only captured per-price-type amounts; unknown prices stay unknown. */
export function adjustUnconfiguredPrices(prices, raw, sign) {
    const products = unconfiguredProducts(raw);
    return prices?.map(price => {
        let delta = 0;
        let unavailable = price.priceNotAvailable === true;
        for (const product of products) {
            const typed = product.prices.find(p => p.priceTypeId === price.priceTypeId);
            if (!typed || typed.priceNotAvailable || typeof typed.price !== 'number' || !Number.isFinite(typed.price))
                unavailable = true;
            else
                delta += typed.price * product.quantity;
        }
        return { ...price, ...(typeof price.price === 'number' ? { price: money(price.price + sign * delta) } : {}),
            ...(unavailable ? { priceNotAvailable: true } : {}) };
    }) ?? prices;
}
export function preserveUnconfiguredSelections(current, derived) {
    const retained = (current.tabs ?? []).filter(t => t.type === 'UNCONFIGURED_TAB' && objectOrEmpty(t)['mockTab'] !== true);
    if (retained.length === 0 || (derived.tabs ?? []).some(t => t.type === 'UNCONFIGURED_TAB' && objectOrEmpty(t)['mockTab'] !== true))
        return derived;
    const merged = { ...derived, tabs: [...(derived.tabs ?? []).filter(t => t.type !== 'UNCONFIGURED_TAB'), ...structuredClone(retained)] };
    const products = unconfiguredProducts(merged);
    if (products.length === 0)
        return merged;
    const delta = products.reduce((total, p) => total + (p.price ?? 0), 0);
    const unavailable = products.some(p => p.price === null);
    return { ...merged,
        ...(typeof derived.totalPrice === 'number' ? { totalPrice: money(derived.totalPrice + delta) } : {}),
        ...(unavailable ? { priceNotAvailable: true } : {}),
        ...(derived.totalPrices ? { totalPrices: adjustUnconfiguredPrices(derived.totalPrices, merged, 1) } : {}),
        ...(Array.isArray(derived['nonSoftwareTotalPrices']) ? {
            nonSoftwareTotalPrices: adjustUnconfiguredPrices(derived['nonSoftwareTotalPrices'], merged, 1),
        } : {}),
    };
}
//# sourceMappingURL=unconfigured.js.map