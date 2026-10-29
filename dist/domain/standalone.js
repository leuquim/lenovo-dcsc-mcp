import { randomUUID } from 'node:crypto';
/** Global part lookup. The result is intentionally not assigned a synthetic cursor or total. */
export async function findParts(http, ctx, input) {
    const keyword = input.keyword.trim();
    if (keyword === '')
        throw new Error('Part lookup keyword must not be empty.');
    const types = input.types ?? ['SOFTWARE', 'SERVICE', 'HARDWARE'];
    if (types.length === 0)
        throw new Error('Part lookup requires at least one type.');
    const response = await http.send({
        endpoint: 'findpart',
        method: 'GET',
        path: '/findpart',
        query: {
            keyword,
            type: types.join(','),
            mode: input.mode,
            controlExpressModal: true,
            serviceCto: true,
        },
        responseKind: 'json',
        timeoutClass: 'fast',
        ctx,
    });
    const items = Array.isArray(response.raw)
        ? response.raw.flatMap((value) => {
            const raw = object(value);
            const code = string(raw?.['code']);
            if (!raw || !code)
                return [];
            const type = String(raw['type'] ?? 'UNKNOWN').toUpperCase();
            return [
                {
                    code,
                    description: string(raw['description']) ?? '',
                    type,
                    nextAction: nextAction(type),
                    raw,
                },
            ];
        })
        : [];
    return { items, raw: response.raw, upstreamCompleteness: 'unknown' };
}
/** Fetches both software launch contracts concurrently and retains both complete responses. */
export async function launchStandaloneSoftware(http, ctx) {
    const [launch, portal] = await Promise.all([
        http.send({
            endpoint: 'standalone_software_launch',
            method: 'POST',
            path: '/ctos/standalone_software/launch',
            query: { controlExpressModal: true, serviceCto: true },
            responseKind: 'json',
            timeoutClass: 'heavy',
            ctx,
        }),
        http.send({
            endpoint: 'software_portal_launch',
            method: 'GET',
            path: '/software/portal/launch',
            query: { controlExpressModal: true, serviceCto: true },
            responseKind: 'json',
            timeoutClass: 'heavy',
            ctx,
        }),
    ]);
    return {
        kind: 'standalone-software',
        launchRaw: launch.raw,
        portalRaw: portal.raw,
        features: indexSoftwareFeatures(portal.raw),
        selections: [],
    };
}
/** Local browse over the complete response already fetched from DCSC. */
export function browseStandaloneSoftware(state, input = {}) {
    const offset = nonNegativeInteger(input.offset ?? 0, 'offset');
    const limit = positiveInteger(input.limit ?? 50, 'limit');
    const query = input.query?.trim().toLowerCase() ?? '';
    const path = input.path ?? {};
    const matches = state.features.filter((feature) => {
        if (query && !`${feature.code} ${feature.description}`.toLowerCase().includes(query)) {
            return false;
        }
        return Object.keys(path).every((key) => {
            const expected = path[key];
            return expected === undefined || feature.path[key] === expected;
        });
    });
    return {
        items: matches.slice(offset, offset + limit),
        totalInFetchedCatalog: matches.length,
        offset,
        limit,
        upstreamCompleteness: 'unknown',
    };
}
/** Selects a software SKU locally. DCSC exposes no repricing call for this observed workflow. */
export function selectStandaloneSoftware(state, input) {
    const quantity = positiveInteger(input.quantity, 'quantity');
    const feature = uniqueByCode(state.features, input.code, 'software feature');
    const existing = state.selections.find((selection) => selection.code === input.code);
    const selection = softwareSelection(feature, quantity, existing?.id ?? input.id ?? randomUUID());
    return {
        ...state,
        selections: [
            ...state.selections.filter((candidate) => candidate.code !== input.code),
            selection,
        ],
    };
}
export function setStandaloneSoftwareQuantity(state, code, quantity) {
    if (!state.selections.some((selection) => selection.code === code)) {
        throw new Error(`Standalone software ${code} is not selected.`);
    }
    return selectStandaloneSoftware(state, { code, quantity });
}
export function removeStandaloneSoftware(state, code) {
    return { ...state, selections: state.selections.filter((selection) => selection.code !== code) };
}
/** Builds the captured /lfos/export_zip standaloneData and group envelope. */
export function buildStandaloneSoftwareExportEnvelope(state, baseData, groupName = 'Config 1') {
    const standaloneData = state.selections.map((selection) => softwareExportItem(selection));
    const products = state.selections.map((selection) => ({
        ...softwareExportItem(selection),
        type: 'standalone',
        ...(selection.totalPrice !== undefined ? { price: selection.totalPrice } : {}),
        ...(selection.unitPrice !== undefined ? { unitPrice: selection.unitPrice } : {}),
        groupId: groupName,
    }));
    return {
        endpoint: '/lfos/export_zip',
        data: { ...baseData, standaloneData },
        groups: [{ name: groupName, parent: null, index: -1, products }],
    };
}
/** Launches a product-bound service graph and its full service catalog concurrently. */
export async function launchProductServices(http, ctx, input) {
    const code = required(input.productCode, 'productCode');
    const subCategory = required(input.subCategory, 'subCategory');
    const quantity = positiveInteger(input.productQuantity ?? 1, 'productQuantity');
    const [derive, catalog] = await Promise.all([
        http.send({
            endpoint: 'standalone_services_launch',
            method: 'POST',
            path: '/services/autoDerive',
            body: { kind: 'json', value: { ctoCode: code, subCategory } },
            responseKind: 'json',
            timeoutClass: 'heavy',
            ctx,
        }),
        http.send({
            endpoint: 'service_pacs_product',
            method: 'GET',
            path: `/service_pacs/${encodeURIComponent(code)}`,
            query: { serviceCto: true },
            responseKind: 'json',
            timeoutClass: 'heavy',
            ctx,
        }),
    ]);
    return {
        kind: 'product-bound-services',
        product: {
            code,
            quantity,
            ...(input.productDescription ? { description: input.productDescription } : {}),
        },
        subCategory,
        optionGraphRaw: derive.raw,
        catalogRaw: catalog.raw,
        options: indexServiceOptions(derive.raw),
        selections: [],
    };
}
/** Refreshes selectable metadata while retaining the saved selection, request and summary price. */
export async function refreshProductServiceCatalog(http, ctx, state) {
    const fresh = await launchProductServices(http, ctx, {
        productCode: state.product.code,
        productQuantity: state.product.quantity,
        productDescription: state.product.description,
        subCategory: state.subCategory,
    });
    return {
        ...structuredClone(state),
        optionGraphRaw: fresh.optionGraphRaw,
        catalogRaw: fresh.catalogRaw,
        options: fresh.options,
    };
}
/** Posts the exact typed servicesAndor selection shape captured from the website. */
export async function selectProductService(http, ctx, state, input) {
    const quantity = positiveInteger(input.quantity, 'quantity');
    const matches = state.options.filter((option) => option.code === input.serviceCode);
    if (matches.length === 0) {
        throw new Error(`Service ${input.serviceCode} is not in the current option graph.`);
    }
    if (matches.length > 1) {
        throw new Error(`Service ${input.serviceCode} is ambiguous in the current option graph.`);
    }
    const located = matches[0];
    const selection = {
        code: input.serviceCode,
        quantity,
        description: located.description,
        type: located.type,
        characterName: located.characterName,
        section: located.section,
        sectionName: located.sectionName,
        sectionDescription: located.sectionDescription,
        ctoCode: state.product.code,
        rawFeature: located.rawFeature,
    };
    const selections = [
        ...state.selections.filter((current) => !sameServiceChoiceFamily(current, selection)),
        selection,
    ];
    const request = buildServiceDeriveRequest(state, selections, selection);
    const response = await http.send({
        endpoint: 'standalone_services_select',
        method: 'POST',
        path: '/services/autoDerive',
        body: { kind: 'json', value: request },
        responseKind: 'json',
        timeoutClass: 'heavy',
        ctx,
    });
    const authoritativeSelections = indexServiceSelections(response.raw);
    return {
        ...state,
        optionGraphRaw: response.raw,
        options: indexServiceOptions(response.raw),
        selections: authoritativeSelections,
        lastDeriveRequest: request,
        summaryRaw: undefined,
    };
}
/** Removes one selected service using the quantity-zero website toggle contract. */
export async function removeProductService(http, ctx, state, serviceCode) {
    const selected = state.selections.find((selection) => selection.code === serviceCode);
    if (!selected)
        throw new Error(`Product service ${serviceCode} is not selected.`);
    const remaining = state.selections.filter((selection) => selection.code !== serviceCode);
    const request = {
        ctoCode: state.product.code,
        subCategory: state.subCategory,
        sections: buildServiceSections(remaining),
        delta: { section: selected.section },
    };
    const response = await http.send({
        endpoint: 'standalone_services_select',
        method: 'POST',
        path: '/services/autoDerive',
        body: { kind: 'json', value: request },
        responseKind: 'json',
        timeoutClass: 'heavy',
        ctx,
    });
    return {
        ...state,
        optionGraphRaw: response.raw,
        options: indexServiceOptions(response.raw),
        selections: indexServiceSelections(response.raw),
        lastDeriveRequest: request,
        summaryRaw: undefined,
    };
}
export function buildProductServiceSummaryRequest(state) {
    return [
        {
            code: state.product.code,
            quantity: state.product.quantity,
            services: state.selections.map((selection) => ({
                serviceCode: selection.code,
                quantity: selection.quantity,
            })),
        },
    ];
}
/** Retrieves authoritative service pricing after explicit selection. */
export async function summariseProductServices(http, ctx, state) {
    if (state.selections.length === 0)
        throw new Error('Select at least one product service first.');
    const response = await http.send({
        endpoint: 'standalone_services_summaries',
        method: 'POST',
        path: '/services/summaries',
        body: { kind: 'json', value: buildProductServiceSummaryRequest(state) },
        responseKind: 'json',
        timeoutClass: 'heavy',
        ctx,
    });
    return { ...state, summaryRaw: response.raw };
}
/**
 * Builds the form fields captured from the anonymous service summary Save action.
 * The XML is restored through the typed standalone service import adapter.
 */
export function buildProductServiceExportEnvelope(state) {
    if (!state.lastDeriveRequest || state.selections.length === 0) {
        throw new Error('A product service must be selected before export.');
    }
    const data = buildProductServiceSummaryRequest(state);
    const integrationParams = {
        returnUrl: null,
        site: '',
        role: '',
        iad: false,
        error: null,
        context: '',
        serviceWithProductNumber: false,
    };
    return {
        endpoint: '/service_pacs/export',
        data,
        serviceAndorRequest: state.lastDeriveRequest,
        fields: {
            data: JSON.stringify(data),
            crnId: '',
            userGeneratedConfigId: '',
            lfoCode: '',
            cancelDownload: 'false',
            multipleProductData: '',
            excelData: 'null',
            groups: '',
            integrationParams: JSON.stringify(integrationParams),
            image: '',
            user: '',
            'dcsc-isFromIntegration': 'false',
            serviceAndorRequest: JSON.stringify(state.lastDeriveRequest),
            uuid: '',
        },
    };
}
function indexSoftwareFeatures(raw) {
    const root = object(raw);
    const out = [];
    for (const tab of objectArray(root?.['tabs'])) {
        for (const subTab of objectArray(tab['subTabs'])) {
            for (const section of objectArray(subTab['sections'])) {
                const subCategories = objectArray(section['subCategorys']);
                if (subCategories.length === 0) {
                    appendSoftwareFeatures(out, objectArray(section['features']), tab, subTab, section);
                }
                else {
                    for (const subCategory of subCategories) {
                        appendSoftwareFeatures(out, objectArray(subCategory['features']), tab, subTab, section, subCategory);
                    }
                }
            }
        }
    }
    return out;
}
function appendSoftwareFeatures(out, features, tab, subTab, section, subCategory) {
    for (const feature of features) {
        const code = string(feature['code']);
        if (!code)
            continue;
        const unitPrice = number(feature['unitPrice']);
        const showPrice = boolean(feature['showPrice']);
        out.push({
            code,
            ...(string(feature['softwareCode']) ? { softwareCode: string(feature['softwareCode']) } : {}),
            description: string(feature['description']) ?? '',
            ...(unitPrice !== undefined ? { unitPrice } : {}),
            priceNotAvailable: boolean(feature['priceNotAvailable']) ?? false,
            ...(showPrice !== undefined ? { showPrice } : {}),
            prices: Array.isArray(feature['prices']) ? feature['prices'] : [],
            attributes: object(feature['optionAttributes']) ?? {},
            path: {
                tab: label(tab),
                subTab: label(subTab),
                section: label(section),
                ...(subCategory ? { subCategory: label(subCategory) } : {}),
            },
            raw: feature,
        });
    }
}
function softwareSelection(feature, quantity, id) {
    return {
        id,
        kind: 'software',
        code: feature.code,
        quantity,
        ...(feature.unitPrice !== undefined
            ? { unitPrice: feature.unitPrice, totalPrice: feature.unitPrice * quantity }
            : {}),
        feature,
    };
}
function softwareExportItem(selection) {
    const feature = selection.feature.raw;
    return {
        id: selection.id,
        code: selection.code,
        quantity: selection.quantity,
        ...(selection.unitPrice !== undefined ? { price: selection.unitPrice } : {}),
        announceDate: feature['announceDate'] ?? null,
        description: selection.feature.description,
        prices: selection.feature.prices,
        type: 'software',
        showPrice: selection.feature.showPrice ?? true,
        withdrawnDate: feature['withdrawnDate'] ?? null,
        priceNotAvailable: selection.feature.priceNotAvailable,
        preSelectedQuantity: feature['preSelectedQuantity'] ?? 0,
        keyWord: feature['keyWord'] ?? null,
        inventory: feature['inventory'] ?? null,
    };
}
function indexServiceOptions(raw) {
    const root = object(raw);
    const out = [];
    for (const tab of objectArray(root?.['tabs'])) {
        for (const subTab of objectArray(tab['subTabs'])) {
            const subTabName = label(subTab);
            for (const section of objectArray(subTab['sections'])) {
                const name = string(section['name']) ?? label(section);
                const description = subTabName || string(section['description']) || name;
                const source = description.split('|')[0]?.trim() || description;
                const seen = new Set();
                for (const feature of [
                    ...objectArray(section['features']),
                    ...objectArray(section['results']),
                ]) {
                    const code = string(feature['code']);
                    if (!code || seen.has(code))
                        continue;
                    seen.add(code);
                    const unitPrice = number(feature['unitPrice']);
                    const preSelectedQuantity = number(feature['preSelectedQuantity']);
                    const type = string(feature['type']) ?? '';
                    out.push({
                        code,
                        description: string(feature['description']) ?? '',
                        type,
                        characterName: string(feature['characterName']) ?? type,
                        ...(unitPrice !== undefined ? { unitPrice } : {}),
                        ...(preSelectedQuantity !== undefined ? { preSelectedQuantity } : {}),
                        section: source,
                        sectionName: name,
                        sectionDescription: description,
                        rawFeature: feature,
                    });
                }
            }
        }
    }
    return out;
}
/** Rebuilds selected service state from DCSC's authoritative derived section results. */
function indexServiceSelections(raw) {
    const root = object(raw);
    const out = [];
    for (const tab of objectArray(root?.['tabs'])) {
        for (const subTab of objectArray(tab['subTabs'])) {
            const subTabName = label(subTab);
            for (const section of objectArray(subTab['sections'])) {
                const sectionName = string(section['name']) ?? label(section);
                const sectionDescription = subTabName || string(section['description']) || sectionName;
                const source = sectionDescription.split('|')[0]?.trim() || sectionDescription;
                for (const result of objectArray(section['results'])) {
                    const code = string(result['code']);
                    const quantity = number(result['quantity']);
                    if (!code || quantity === undefined || quantity <= 0)
                        continue;
                    const type = string(result['type']) ?? '';
                    const ctoCode = string(result['ctoCode']);
                    out.push({
                        code,
                        quantity,
                        description: string(result['description']) ?? '',
                        type,
                        characterName: string(result['characterName']) ?? type,
                        section: source,
                        sectionName,
                        sectionDescription,
                        ...(ctoCode ? { ctoCode } : {}),
                        rawFeature: result,
                    });
                }
            }
        }
    }
    return out;
}
function sameServiceChoiceFamily(current, changed) {
    if (current.code === changed.code)
        return true;
    if (current.section !== changed.section)
        return false;
    // DCSC's A-la-Carte columns are mutually exclusive base packages. Add-ons remain
    // independent across families but replace another term within the same family.
    if (changed.section === 'A la Carte')
        return true;
    if (changed.section === 'Add ons') {
        return current.sectionDescription === changed.sectionDescription;
    }
    return current.sectionName === changed.sectionName;
}
function buildServiceDeriveRequest(state, selections, changed) {
    return {
        ctoCode: state.product.code,
        subCategory: state.subCategory,
        sections: buildServiceSections(selections, changed.code),
        delta: {
            section: changed.section,
            featureCode: changed.code,
            quantity: changed.quantity,
        },
    };
}
function buildServiceSections(selections, changedCode) {
    const sections = new Map();
    for (const selection of selections) {
        let section = sections.get(selection.sectionName);
        if (!section) {
            section = {
                description: selection.sectionDescription,
                source: selection.section,
                name: selection.sectionName,
                type: 'servicesAndor',
                results: [],
            };
            sections.set(selection.sectionName, section);
        }
        section.results.push({
            code: selection.code,
            // The SPA serialises ctoCode only on the result being changed. Results
            // retained from the authoritative graph omit it, including removals.
            ...(selection.code === changedCode && selection.ctoCode
                ? { ctoCode: selection.ctoCode }
                : {}),
            description: selection.description,
            quantity: selection.quantity,
            type: selection.type,
            characterName: selection.characterName,
        });
    }
    return [...sections.values()];
}
function nextAction(type) {
    if (type === 'SOFTWARE')
        return 'browse_software_catalog';
    if (type === 'SERVICE')
        return 'select_on_product_services';
    if (type === 'CTO' || type === 'LFO')
        return 'launch_configuration';
    return 'inspect_hardware_catalog';
}
function uniqueByCode(items, code, kind) {
    const matches = items.filter((item) => item.code === code);
    if (matches.length === 0)
        throw new Error(`Unknown ${kind} code: ${code}`);
    if (matches.length > 1)
        throw new Error(`Ambiguous ${kind} code: ${code}`);
    return matches[0];
}
function object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function objectArray(value) {
    return Array.isArray(value)
        ? value.map((item) => object(item)).filter((item) => item !== undefined)
        : [];
}
function string(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function boolean(value) {
    return typeof value === 'boolean' ? value : undefined;
}
function label(value) {
    return string(value['title']) ?? string(value['description']) ?? string(value['name']) ?? '';
}
function required(value, name) {
    const trimmed = value.trim();
    if (trimmed === '')
        throw new Error(`${name} must not be empty.`);
    return trimmed;
}
function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`${name} must be a positive integer.`);
    return value;
}
function nonNegativeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer.`);
    }
    return value;
}
//# sourceMappingURL=standalone.js.map