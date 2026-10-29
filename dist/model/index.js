function slug(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
}
function objectRows(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === 'object' && item !== null)
        : [];
}
function text(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function allocateSectionId(tab, name, usedIds) {
    const prefix = slug(tab) || 'unknown';
    const suffix = slug(name) || 'unnamed';
    const base = `${prefix}.${suffix}`;
    let id = base;
    let collision = 2;
    while (usedIds.has(id))
        id = `${base}-${collision++}`;
    usedIds.add(id);
    return id;
}
/**
 * Software selectors are client-side choices layered over the final derived BOM.
 * Their codes can also appear in results, or in more than one filter, without
 * representing additional physical quantity. Retain the largest authoritative
 * selected quantity instead of adding another copy to the BOM aggregate.
 */
function recordDerivedSelection(selected, code, quantity) {
    selected.set(code, Math.max(selected.get(code) ?? 0, quantity));
}
/**
 * Builds the derived index beside the raw payload.
 *
 * Non-destructive by construction: nothing here mutates or replaces `raw`.
 * Rebuilt from scratch after every mutation, which is cheap relative to the
 * network round-trip that produced the new payload.
 */
export function buildIndex(raw) {
    const features = [];
    const sections = [];
    const selected = new Map();
    const tabs = [];
    const usedIds = new Set();
    for (const tab of (raw.tabs ?? [])) {
        const tabTitle = tab.title ?? tab.tabTypeIdentifier ?? 'Unknown';
        if (!tabs.includes(tabTitle))
            tabs.push(tabTitle);
        for (const subTab of tab.subTabs ?? []) {
            const subTitle = subTab.title ?? tabTitle;
            for (const section of subTab.sections ?? []) {
                const name = section.name ?? section.title ?? 'unnamed';
                const title = section.description ?? section.title ?? name;
                // Section ids must be stable and unique; collisions are real because
                // the same section name recurs across sub-tabs.
                const id = allocateSectionId(tabTitle, name, usedIds);
                const ref = { id, tab: tabTitle, subTab: subTitle, name, title, section };
                sections.push(ref);
                // Selections live in results[], not on the features themselves.
                const selectedHere = new Map();
                for (const result of section.results ?? []) {
                    if (!result.code)
                        continue;
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
                        sectionName: name,
                        haystack: `${feature.code} ${description} ${title}`.toLowerCase(),
                    });
                }
                for (const result of section.results ?? []) {
                    if (!result.code)
                        continue;
                    if (!features.some((f) => f.code === result.code && f.section === id)) {
                        const rawRes = result;
                        const description = typeof rawRes.description === 'string' ? rawRes.description : result.code;
                        const unitPrice = typeof rawRes.unitListPrice === 'number' ? rawRes.unitListPrice : (result.cost ?? 0);
                        features.push({
                            code: result.code,
                            description,
                            min: 0,
                            max: Math.max(1, result.quantity ?? 1),
                            unitPrice,
                            category: undefined,
                            selectedQty: result.quantity ?? 1,
                            eccnRestricted: false,
                            tab: tabTitle,
                            subTab: subTitle,
                            section: id,
                            sectionTitle: title,
                            sectionName: name,
                            haystack: `${result.code} ${description} ${title}`.toLowerCase(),
                        });
                    }
                }
                // Software sections expose selectable groups outside features[]. A
                // selected group may then expose nested filters (maintenance type,
                // duration, edition, etc.) whose exact names must be addressable by a
                // later configure call. Index both layers while retaining the parent
                // tab/sub-tab context.
                const sectionRecord = section;
                const selectedGroups = new Set((Array.isArray(sectionRecord['selectedItems']) ? sectionRecord['selectedItems'] : []).filter((item) => typeof item === 'string'));
                for (const group of objectRows(sectionRecord['groups'])) {
                    const groupCode = text(group['code']);
                    if (!groupCode)
                        continue;
                    const groupDescription = text(group['description']) ?? groupCode;
                    const groupSelected = selectedGroups.has(groupCode);
                    features.push({
                        code: groupCode,
                        description: groupDescription,
                        min: 0,
                        max: 1,
                        unitPrice: finite(group['unitPrice']) ?? 0,
                        category: undefined,
                        selectedQty: groupSelected ? 1 : 0,
                        eccnRestricted: group['eccnRestricted'] === true,
                        tab: tabTitle,
                        subTab: subTitle,
                        section: id,
                        sectionTitle: title,
                        sectionName: name,
                        haystack: `${groupCode} ${groupDescription} ${title}`.toLowerCase(),
                    });
                    if (!groupSelected)
                        continue;
                    recordDerivedSelection(selected, groupCode, 1);
                    for (const filter of objectRows(group['filters'])) {
                        const filterName = text(filter['name']);
                        if (!filterName)
                            continue;
                        const refName = `${name}/${groupCode}/${filterName}`;
                        const filterTitle = text(filter['description']) ?? filterName;
                        const filterId = allocateSectionId(tabTitle, refName, usedIds);
                        const filterItems = objectRows(filter['items']).filter((item) => typeof item['code'] === 'string' && item['code'].length > 0);
                        const selectedCode = text(filter['value']);
                        const selectedQuantity = finite(filter['quantity']) ?? 1;
                        const syntheticSection = {
                            name: refName,
                            title: filterTitle,
                            description: filterTitle,
                            singleEntry: true,
                            features: filterItems,
                            results: selectedCode
                                ? [{ code: selectedCode, quantity: selectedQuantity }]
                                : [],
                        };
                        sections.push({
                            id: filterId,
                            tab: tabTitle,
                            subTab: subTitle,
                            name: refName,
                            title: filterTitle,
                            section: syntheticSection,
                        });
                        for (const item of filterItems) {
                            const itemCode = item.code;
                            const itemDescription = text(item['description']) ?? itemCode;
                            const itemSelected = itemCode === selectedCode ? selectedQuantity : 0;
                            features.push({
                                code: itemCode,
                                description: itemDescription,
                                min: finite(item['min']) ?? 0,
                                max: finite(item['max']) ?? 1,
                                unitPrice: finite(item['unitPrice']) ?? 0,
                                category: text(item['category']),
                                selectedQty: itemSelected,
                                eccnRestricted: item['eccnRestricted'] === true,
                                tab: tabTitle,
                                subTab: subTitle,
                                section: filterId,
                                sectionTitle: filterTitle,
                                sectionName: refName,
                                haystack: `${itemCode} ${itemDescription} ${filterTitle} ${groupDescription}`.toLowerCase(),
                            });
                        }
                        if (selectedCode)
                            recordDerivedSelection(selected, selectedCode, selectedQuantity);
                    }
                }
            }
        }
    }
    const byCode = new Map();
    for (const f of features) {
        const list = byCode.get(f.code);
        if (list)
            list.push(f);
        else
            byCode.set(f.code, [f]);
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
export function resolveSection(index, identifier) {
    const needle = identifier.trim().toLowerCase();
    if (needle === '')
        return undefined;
    const byId = index.sectionById.get(identifier) ?? index.sectionById.get(needle);
    if (byId)
        return byId;
    return (index.sections.find((s) => s.name.toLowerCase() === needle) ??
        index.sections.find((s) => s.title.toLowerCase() === needle) ??
        index.sections.find((s) => s.id.toLowerCase() === needle) ??
        index.sections.find((s) => slug(s.name) === slug(needle) || slug(s.title) === slug(needle)));
}
/** Section identifiers to offer back when resolution fails. */
export function suggestSections(index, identifier, limit = 8) {
    const needle = identifier.trim().toLowerCase();
    const scored = index.sections
        .map((s) => {
        const hay = `${s.id} ${s.name} ${s.title}`.toLowerCase();
        return { s, hit: hay.includes(needle) };
    })
        .filter((e) => e.hit)
        .slice(0, limit);
    const pool = scored.length > 0 ? scored.map((e) => e.s) : index.sections.slice(0, limit);
    return pool.map((s) => `${s.id} (name: "${s.name}", title: "${s.title}")`);
}
/**
 * Cross-tab feature search.
 *
 * This is the primary navigation path. Walking eleven tabs to find one feature
 * code is the failure mode this exists to prevent, so the tool descriptions
 * steer the model here first and treat browsing as the exception.
 */
export function searchFeatures(index, opts) {
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
    if (opts.filter === 'selected')
        pool = pool.filter((f) => f.selectedQty > 0);
    else if (opts.filter === 'selectable')
        pool = pool.filter((f) => f.max > 0);
    if (tokens.length === 0) {
        return { items: pool.slice(offset, offset + limit), total: pool.length, offset, limit };
    }
    const scored = [];
    for (const f of pool) {
        let score = 0;
        if (f.code.toLowerCase() === needle)
            score += 1000;
        let matched = 0;
        for (const token of tokens)
            if (f.haystack.includes(token))
                matched += 1;
        if (matched === 0 && score === 0)
            continue;
        score += (matched / tokens.length) * 100;
        if (f.haystack.includes(needle))
            score += 50;
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
//# sourceMappingURL=index.js.map