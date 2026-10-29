import { serializeSoftwareGroupSelection } from './dcscWire.js';
const objects = (value) => Array.isArray(value)
    ? value.filter((item) => typeof item === 'object' && item !== null) : [];
/** Filters are scoped by their parent and group; upstream names recur across products. */
export function softwareFilterName(parent, group, filter) {
    return `${parent}/${group}/${filter}`;
}
function stripDerived(sections) {
    return structuredClone(sections).map((section) => section.type === 'software'
        ? { ...section, results: section.results.filter((result) => result.type !== 'hipo') }
        : section).filter((section) => section.results.length > 0);
}
/** Browser-captured group toggles and nested maintenance/filter edits. */
export function applySoftwareSelection(config, raw, change) {
    for (const tab of raw.tabs ?? []) {
        if (tab.type !== 'software')
            continue;
        for (const subTab of tab.subTabs ?? []) {
            for (const section of subTab.sections ?? []) {
                const parent = section.name ?? section.title ?? 'unnamed';
                const groups = objects(section.groups);
                const productNumber = typeof section.productNumber === 'string' ? section.productNumber : '';
                for (const group of groups) {
                    for (const filter of objects(group.filters)) {
                        if (change.sectionName !== softwareFilterName(parent, String(group.code), String(filter.name)))
                            continue;
                        const anchor = config.sections.find((item) => item.name === parent);
                        if (!anchor?.results.some((item) => item.code === group.code && item.type === 'software')) {
                            throw new Error(`Select software group ${String(group.code)} before editing its filters.`);
                        }
                        const choice = objects(filter.items).find((item) => item.code === change.code);
                        if (!choice)
                            throw new Error(`Software filter ${String(filter.name)} has no choice ${change.code}.`);
                        if (change.quantity <= 0)
                            throw new Error('Use a positive quantity for this software filter choice.');
                        const options = choice.quantityOptions;
                        if (Array.isArray(options) && !options.includes(change.quantity)) {
                            throw new Error(`Software filter ${String(filter.name)} accepts quantities ${options.join(', ')} for ${change.code}.`);
                        }
                        const sections = stripDerived(config.sections);
                        const target = sections.find((item) => item.name === filter.name && item.code === group.code && item.productNumber === filter.productNumber);
                        const replacement = {
                            name: String(filter.name), productNumber: filter.productNumber,
                            code: group.code, type: 'software',
                            results: [{ code: change.code, productNumber: choice.productNumber ?? filter.productNumber,
                                    quantity: change.quantity, type: 'software',
                                    ...(typeof group.hardMandatory === 'boolean' ? { hardMandatory: group.hardMandatory } : {}) }],
                        };
                        if (target)
                            Object.assign(target, replacement);
                        else {
                            const parentIndex = sections.findIndex((item) => item.name === parent);
                            sections.splice(parentIndex + 1, 0, replacement);
                        }
                        const product = typeof filter.productNumber === 'string' ? filter.productNumber : productNumber;
                        return { ...config, sections, delta: {
                                section: String(filter.name), productNumber: product, featureCode: change.code,
                                quantity: change.quantity, isClear: false, mergeCtoCode: product, type: 'software',
                            } };
                    }
                }
                if (parent !== change.sectionName)
                    continue;
                const group = groups.find((item) => item.code === change.code);
                if (!group)
                    return undefined; // Derived licence quantity edit, handled by its own contract.
                if (change.quantity !== 0 && change.quantity !== 1) {
                    throw new Error('Software group selection accepts quantity 1 or 0; change the derived licence quantity separately.');
                }
                const current = config.sections.find((item) => item.name === parent);
                const selected = current?.results.filter((item) => item.type === 'software') ?? [];
                const alreadySelected = selected.some((item) => item.code === change.code);
                if ((change.quantity === 1 && alreadySelected) || (change.quantity === 0 && !alreadySelected))
                    return config;
                const multiple = section.multipleSelectable === true;
                const removed = new Set(multiple ? [change.code] : selected.map((item) => item.code));
                let sections = stripDerived(config.sections).filter((item) => item.name !== parent && !(item.type === 'software' && typeof item.code === 'string' && removed.has(item.code)));
                const retained = multiple ? selected.filter((item) => item.code !== change.code) : [];
                let replacement;
                if (change.quantity === 1) {
                    replacement = serializeSoftwareGroupSelection(section, subTab, change.code);
                    replacement.results = [...structuredClone(retained), ...replacement.results];
                }
                else if (retained.length > 0 && current) {
                    replacement = { ...structuredClone(current), results: structuredClone(retained) };
                }
                if (replacement) {
                    const originalIndex = config.sections.findIndex((item) => item.name === parent);
                    let at = originalIndex < 0 ? sections.findIndex((item) => item.type === 'software')
                        : Math.min(originalIndex, sections.length);
                    if (at < 0)
                        at = sections.length;
                    sections.splice(at, 0, replacement);
                }
                sections = sections.filter((item) => item.results.length > 0);
                return { ...config, sections, delta: {
                        // A multi-select checkbox removal omits section and uses quantity one;
                        // the single-select Reset action includes section and quantity zero.
                        ...(change.quantity === 1 || !multiple ? { section: parent } : {}),
                        ...(productNumber ? { productNumber, mergeCtoCode: productNumber } : {}),
                        featureCode: change.quantity === 1 ? change.code : null,
                        quantity: change.quantity === 0 && multiple ? 1 : 0,
                        isClear: false, type: 'software',
                    } };
            }
        }
    }
    return undefined;
}
//# sourceMappingURL=softwareSelections.js.map