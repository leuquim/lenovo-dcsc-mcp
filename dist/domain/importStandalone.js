export const SERVICE_METADATA_REFRESH_WARNING = 'DCSC import restores the complete service catalog but strips exact derive-section metadata for unselected services. Use dcsc_services_launch with workspace and refresh=true before choosing a different service; the imported selection remains inspectable, quantity-editable and exportable.';
/**
 * Adds the live browse hierarchy to imported software without silently
 * repricing its selected lines. Imported unit/extended prices remain the
 * authority while that imported SKU remains selected.
 */
export function reconcileImportedSoftwareCatalog(imported, catalog) {
    const selectedPrices = new Map(imported.selections.map((selection) => [selection.code, selection]));
    const features = catalog.features.map((feature) => {
        const selected = selectedPrices.get(feature.code);
        if (!selected)
            return feature;
        return {
            ...feature,
            ...(selected.unitPrice !== undefined ? { unitPrice: selected.unitPrice } : {}),
            priceNotAvailable: selected.feature.priceNotAvailable,
            prices: structuredClone(selected.feature.prices),
        };
    });
    const byCode = new Map(features.map((feature) => [feature.code, feature]));
    const selections = imported.selections.map((selection) => ({
        ...selection,
        feature: byCode.get(selection.code) ?? selection.feature,
    }));
    return {
        ...catalog,
        features,
        selections,
    };
}
/**
 * Restores the two standalone response shapes returned by DCSC's normal CFXML
 * import route. A software result may also contain ordinary configurations;
 * callers should restore both from the same preserved envelope. Returns
 * undefined only when the response contains no standalone state.
 */
export function parseStandaloneImportResponse(raw) {
    const envelope = firstObject(raw);
    if (!envelope)
        throw new Error('DCSC returned an unrecognised CFXML import response.');
    if (envelope['type'] === 'service')
        return parseService(envelope);
    const standaloneData = objects(envelope['standaloneData']);
    if (standaloneData.length > 0)
        return parseSoftware(envelope, standaloneData);
    return undefined;
}
function parseSoftware(envelope, rows) {
    const groupProducts = objects(envelope['groups']).flatMap((group) => objects(group['products']));
    const features = [];
    const selections = [];
    for (const row of rows) {
        const code = requiredString(row['code'], 'standalone software code');
        const quantity = positiveInteger(row['quantity'], `standalone software ${code} quantity`);
        const group = groupProducts.find((candidate) => (string(row['id']) !== undefined && string(candidate['id']) === string(row['id'])) ||
            (string(candidate['code']) === code && number(candidate['quantity']) === quantity));
        // Browser-produced imports carry unit price in standaloneData and an
        // extended price in the matching group. Older MCP exports used an
        // incorrect extended standaloneData.price, so explicit unit pricing wins.
        const prices = objects(row['prices']);
        const unitPrice = number(group?.['unitPrice']) ?? number(prices[0]?.['price']) ?? number(row['price']);
        const extendedPrice = number(group?.['price']) ??
            (unitPrice !== undefined ? unitPrice * quantity : undefined);
        const priceNotAvailable = row['priceNotAvailable'] === true;
        const feature = {
            code,
            description: string(row['description']) ?? string(group?.['description']) ?? '',
            ...(unitPrice !== undefined ? { unitPrice } : {}),
            priceNotAvailable,
            ...(typeof row['showPrice'] === 'boolean' ? { showPrice: row['showPrice'] } : {}),
            prices: Array.isArray(row['prices']) ? structuredClone(row['prices']) : [],
            attributes: {},
            path: {
                tab: 'Imported software',
                subTab: 'Imported software',
                section: 'Imported software',
            },
            raw: structuredClone(row),
        };
        features.push(feature);
        selections.push({
            id: string(row['id']) ?? `${code}-imported`,
            kind: 'software',
            code,
            quantity,
            ...(unitPrice !== undefined ? { unitPrice } : {}),
            ...(extendedPrice !== undefined ? { totalPrice: extendedPrice } : {}),
            feature,
        });
    }
    return {
        kind: 'software',
        state: {
            kind: 'standalone-software',
            launchRaw: structuredClone(envelope),
            portalRaw: null,
            features,
            selections,
        },
        envelope: structuredClone(envelope),
        diagnostics: diagnostics(envelope, [
            'The import response restores selected software and prices but not the original vendor/category catalog. Relaunch the software catalog before adding a different SKU.',
        ]),
    };
}
function parseService(envelope) {
    const configurations = objects(envelope['configuration']);
    const summaries = objects(envelope['summary']);
    if (configurations.length !== 1 || summaries.length !== 1) {
        throw new Error('The captured product-service import contract supports exactly one serviced product.');
    }
    const configuration = configurations[0];
    const summary = summaries[0];
    const productCode = requiredString(summary['code'] ?? configuration['code'], 'serviced product code');
    const productQuantity = positiveInteger(summary['quantity'], 'serviced product quantity');
    const rawRequest = object(envelope['serviceAndorRequest']);
    if (!rawRequest)
        throw new Error('Service import response is missing serviceAndorRequest.');
    const rawSections = objects(rawRequest['sections']);
    const rawDelta = object(rawRequest['delta']);
    if (rawSections.length !== 1 || !rawDelta) {
        throw new Error('Service import response has an unsupported selection request shape.');
    }
    const rawSection = rawSections[0];
    const requestResults = objects(rawSection['results']);
    const summaryResults = objects(summary['results']);
    if (requestResults.length !== 1 || summaryResults.length !== 1) {
        throw new Error('The captured product-service import contract supports one selected service.');
    }
    const requestResult = requestResults[0];
    const summaryResult = summaryResults[0];
    const serviceCode = requiredString(summaryResult['code'] ?? requestResult['code'], 'selected service code');
    const quantity = positiveInteger(summaryResult['quantity'] ?? requestResult['quantity'], `service ${serviceCode} quantity`);
    const catalogFeature = objects(configuration['services']).find((candidate) => string(candidate['code']) === serviceCode);
    const description = string(summaryResult['description']) ?? string(requestResult['description']) ?? '';
    const type = string(summaryResult['type']) ?? string(catalogFeature?.['type']) ?? '';
    const characterName = string(requestResult['characterName']) ?? type;
    const section = requiredString(rawDelta['section'], 'service selection section');
    const sectionName = requiredString(rawSection['name'], 'service selection section name');
    const sectionDescription = string(rawSection['description']) ?? section;
    const rawFeature = structuredClone(catalogFeature ?? summaryResult);
    const selection = {
        code: serviceCode,
        quantity,
        description,
        type,
        characterName,
        section,
        sectionName,
        sectionDescription,
        rawFeature,
    };
    const unitPrice = number(summaryResult['unitPrice']) ?? number(catalogFeature?.['price']);
    const option = {
        code: serviceCode,
        description,
        type,
        characterName,
        ...(unitPrice !== undefined ? { unitPrice } : {}),
        section,
        sectionName,
        sectionDescription,
        rawFeature,
    };
    const lastDeriveRequest = {
        ctoCode: productCode,
        subCategory: requiredString(rawRequest['subCategory'], 'service subcategory'),
        sections: [
            {
                description: sectionDescription,
                source: section,
                name: sectionName,
                type: 'servicesAndor',
                results: [
                    {
                        code: serviceCode,
                        ctoCode: productCode,
                        description,
                        quantity,
                        type,
                        characterName,
                    },
                ],
            },
        ],
        delta: {
            section,
            featureCode: serviceCode,
            quantity,
        },
    };
    return {
        kind: 'service',
        state: {
            kind: 'product-bound-services',
            product: {
                code: productCode,
                quantity: productQuantity,
                ...(string(summary['description']) ? { description: string(summary['description']) } : {}),
            },
            subCategory: lastDeriveRequest.subCategory,
            optionGraphRaw: structuredClone(envelope),
            catalogRaw: structuredClone(configuration),
            options: [option],
            selections: [selection],
            lastDeriveRequest,
            summaryRaw: structuredClone(envelope['summary']),
        },
        envelope: structuredClone(envelope),
        diagnostics: diagnostics(envelope, [
            SERVICE_METADATA_REFRESH_WARNING,
        ]),
    };
}
function diagnostics(envelope, warnings) {
    return {
        missingParts: Array.isArray(envelope['missingParts'])
            ? structuredClone(envelope['missingParts'])
            : [],
        removedParts: Array.isArray(envelope['removedParts'])
            ? structuredClone(envelope['removedParts'])
            : [],
        warnings,
    };
}
function firstObject(value) {
    return Array.isArray(value) ? object(value[0]) : object(value);
}
function object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function objects(value) {
    return Array.isArray(value)
        ? value.map(object).filter((item) => item !== undefined)
        : [];
}
function string(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function requiredString(value, field) {
    const parsed = string(value);
    if (!parsed)
        throw new Error(`Standalone import is missing ${field}.`);
    return parsed;
}
function positiveInteger(value, field) {
    const parsed = number(value);
    if (parsed === undefined || !Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Standalone import ${field} must be a positive integer.`);
    }
    return parsed;
}
//# sourceMappingURL=importStandalone.js.map