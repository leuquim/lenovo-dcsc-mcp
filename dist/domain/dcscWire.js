const resultFields = [
    'code', 'quantity', 'productNumber', 'derived', 'ctoCode', 'description',
    'preSelected', 'serviceVariant', 'derivedQuantity', 'priceNotAvailable',
    'shippingStatus', 'subCategory', 'forAutoConnect', 'autoCorrected', 'storageWizardDerived',
];
const sectionFields = ['name', 'productNumber', 'isMultiCto', 'isSwType', 'priceNotAvailable'];
function pick(source, keys) {
    return Object.fromEntries(keys.filter((key) => source[key] !== undefined)
        .map((key) => [key, structuredClone(source[key])]));
}
function objects(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === 'object' && item !== null)
        : [];
}
function resultDto(result, type, features) {
    const feature = features.find((item) => item.code === result.code);
    const dto = {
        ...pick(result, resultFields),
        code: String(result.code),
        quantity: typeof result.quantity === 'number' ? result.quantity : 1,
        type: typeof result.type === 'string' ? result.type : type,
        optionCode: typeof result.optionCode === 'string' ? result.optionCode : '',
    };
    if (!dto.description && typeof feature?.description === 'string')
        dto.description = feature.description;
    if (type === 'servicesAndor' && result.characterName !== undefined)
        dto.characterName = result.characterName;
    if (typeof result.hardMandatory === 'boolean')
        dto.hardMandatory = result.hardMandatory;
    if (feature?.fixed === true)
        dto.fixed = true;
    return dto;
}
/** Captured SPA selectableSectionSelector semantics, without mutating raw data. */
export function serializeSection(section, subTab, type = 'hardware') {
    const features = objects(section.features);
    let results = structuredClone(objects(section.results));
    const dto = {
        ...pick(section, sectionFields),
        name: section.name ?? section.title ?? 'unnamed',
        multipleSelectable: section.multipleSelectable === true,
        type,
        subTabTitle: subTab.title ?? '',
        results: [],
    };
    if (type === 'servicesAndor') {
        Object.assign(dto, pick(subTab, ['source', 'markingConditions']));
        if (subTab.source === 'Add ons' || subTab.source === 'Deployment Add ons') {
            dto.description = subTab.title;
        }
    }
    const filters = [];
    if (Array.isArray(section.groups)) {
        const derived = results.filter((item) => item.type === 'hipo');
        for (const item of derived) {
            item.derived = true;
            item.productNumber = section.productNumber;
        }
        for (const group of objects(section.groups)) {
            if (!Array.isArray(section.selectedItems) || !section.selectedItems.includes(group.code))
                continue;
            const anchor = {
                code: group.code, description: group.description, productNumber: section.productNumber,
                quantity: 1, type, ...pick(group, ['hardMandatory']),
            };
            if (dto.multipleSelectable)
                results.push(anchor);
            else
                results = [anchor];
            for (const filter of objects(group.filters)) {
                const selected = objects(filter.items).find((item) => item.code === filter.value) ?? {};
                filters.push({
                    ...pick(filter, ['name', 'productNumber', 'priceNotAvailable']),
                    name: String(filter.name), code: group.code, type,
                    results: filter.value ? [resultDto({
                            ...pick(selected, ['code', 'productNumber', 'ctoCode', 'derived', 'priceNotAvailable']),
                            quantity: filter.quantity, preSelected: filter.preSelected,
                            ...pick(group, ['hardMandatory']),
                        }, type, [])] : [],
                });
            }
        }
        results = results.concat(derived);
    }
    dto.results = results.filter((item) => typeof item.code === 'string').map((item) => resultDto(item, type, features));
    return [dto, ...filters];
}
/**
 * Serialize a newly selected software group exactly as the SPA sends it before
 * auto-derive has regenerated the group's filter and HIPO results.
 *
 * A new group selection is deliberately different from serializeSection():
 * its request contains only the group anchor. The server response owns the
 * derived licence lines and filter selections that follow.
 */
export function serializeSoftwareGroupSelection(section, subTab, groupCode) {
    const group = objects(section.groups).find((item) => item.code === groupCode);
    if (!group) {
        throw new Error(`Software group ${groupCode} is not available in section ${section.name ?? section.title ?? 'unnamed'}.`);
    }
    const result = {
        code: groupCode,
        quantity: 1,
        type: 'software',
    };
    if (typeof section.productNumber === 'string' && section.productNumber) {
        result.productNumber = section.productNumber;
    }
    if (typeof group.hardMandatory === 'boolean')
        result.hardMandatory = group.hardMandatory;
    return {
        ...pick(section, sectionFields),
        name: section.name ?? section.title ?? 'unnamed',
        multipleSelectable: section.multipleSelectable === true,
        type: 'software',
        subTabTitle: subTab.title ?? '',
        results: [result],
    };
}
export function serializeSections(raw) {
    const grouped = new Map();
    for (const tab of raw.tabs ?? []) {
        for (const subTab of tab.subTabs ?? []) {
            for (const section of subTab.sections ?? []) {
                for (const dto of serializeSection(section, subTab, tab.type ?? 'hardware')) {
                    const key = dto.type === 'servicesAndor'
                        ? `${dto.name}_${String(dto.description)}_${dto.type}`
                        : `${dto.name}_${String(dto.code)}`;
                    const prior = grouped.get(key);
                    if (prior)
                        prior.results.push(...dto.results);
                    else
                        grouped.set(key, dto);
                }
            }
        }
    }
    const selected = [...grouped.values()].filter((section) => section.results.length > 0);
    for (const section of objects(raw.unSelectableCharacters)) {
        const results = objects(section.results);
        if (results.length === 0)
            continue;
        selected.push({
            ...pick(section, ['description']), name: String(section.name),
            results: structuredClone(results),
        });
    }
    return selected;
}
export function nonemptyCode(...values) {
    for (const value of values)
        if (typeof value === 'string' && value.trim())
            return value.trim();
    return '';
}
//# sourceMappingURL=dcscWire.js.map