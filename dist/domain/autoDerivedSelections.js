function objects(value) {
    return Array.isArray(value)
        ? value.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
        : [];
}
function configurationId(configuration) {
    return String(configuration.id ?? configuration.configurationId ?? '');
}
function sections(configuration) {
    return [
        ...objects(configuration.unSelectableCharacters),
        ...objects(configuration.tabs).flatMap((tab) => objects(tab['subTabs']))
            .flatMap((subTab) => objects(subTab['sections'])),
    ];
}
/**
 * Applies the SPA's export projection for accepted FC auto-derived records.
 *
 * DCSC returns the selected result with `derived:false` and separately returns
 * the authoritative auto-derived record. The browser keeps the record and
 * marks the exact existing section result as derived before its next export.
 * Unknown, invalid, overridden, cross-configuration, and unmatched records are
 * retained but never used to invent a selection.
 */
export function projectAutoDerivedSelections(source, recordsValue) {
    const configuration = structuredClone(source);
    const records = structuredClone(Array.isArray(recordsValue) ? recordsValue : []);
    const id = configurationId(configuration);
    const availableSections = sections(configuration);
    const applied = [];
    for (const record of objects(records)) {
        const derivePart = record['derivePart'];
        const feature = record['feature'];
        if (record['derivePartType'] !== 'FC' || record['invalid'] === true || record['override'] === true ||
            typeof derivePart !== 'object' || derivePart === null ||
            typeof feature !== 'object' || feature === null)
            continue;
        const part = derivePart;
        const featureObject = feature;
        const targetId = typeof part['targetWorkspaceId'] === 'string' ? part['targetWorkspaceId'] : '';
        const targets = Array.isArray(record['appliedConfigurations']) ? record['appliedConfigurations'] : [];
        const sectionName = typeof part['targetSectionName'] === 'string' ? part['targetSectionName'] : '';
        const code = typeof part['featureCode'] === 'string' ? part['featureCode'] : '';
        const quantity = part['quantity'];
        if (!id || targetId !== id || !targets.includes(id) || !sectionName || !code ||
            featureObject['code'] !== code || featureObject['type'] !== 'hardware' ||
            typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0)
            continue;
        const section = availableSections.find((candidate) => candidate['name'] === sectionName);
        const result = objects(section?.['results']).find((candidate) => candidate['code'] === code);
        if (!result)
            continue;
        result['derived'] = true;
        result['quantity'] = quantity;
        applied.push({
            ...(typeof record['id'] === 'string' ? { recordId: record['id'] } : {}),
            section: sectionName,
            code,
            quantity,
        });
    }
    return { configuration, autoDerivedResults: records, applied };
}
//# sourceMappingURL=autoDerivedSelections.js.map