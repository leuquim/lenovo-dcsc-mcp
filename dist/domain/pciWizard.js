import { objectOrEmpty } from '../util/coerce.js';
const rows = (value) => Array.isArray(value) ? value.map(objectOrEmpty) : [];
/** Native initPciWizardOptions: retain catalog metadata and initialize UI selections. */
export function pciWizardOptions(raw) {
    const wizard = objectOrEmpty(raw['pciWizard']);
    if (wizard['pciWizardUI'] !== true)
        return [];
    return structuredClone(rows(wizard['pciWizardOptions'])).map(option => {
        const selected = rows(option['results']);
        option['adapterSlots'] = rows(option['adapterSlots']).map((row, index) => {
            const slots = rows(row['slots']);
            const matches = slots.filter(slot => selected.some(result => result['code'] === slot['code']));
            const fallback = slots.find(slot => slot['defaultSelected'] === true) ?? slots[0];
            return { ...row, lineNumber: String(index), disabled: row['required'] === true,
                defaultChecked: matches.length > 0,
                slots: slots.map(slot => ({ ...slot, quantity: 1,
                    selected: matches.length > 0 ? matches.includes(slot) : slot === fallback })) };
        });
        option['solutionPrice'] = optionPrice(option);
        return option;
    });
}
function optionPrice(option) {
    const selected = rows(option['adapterSlots']).filter(row => row['defaultChecked'] === true)
        .flatMap(row => rows(row['slots']).filter(slot => slot['selected'] === true));
    if (selected.some(slot => slot['priceNotAvailable'] === true ||
        (slot['noCharge'] !== true && typeof slot['unitPrice'] !== 'number')))
        return 'priceNotAvailable';
    return Math.round(selected.reduce((sum, slot) => sum + (slot['noCharge'] === true ? 0 : Number(slot['unitPrice'])), 0) * 100) / 100;
}
function rebuildResults(option) {
    option['results'] = rows(option['adapterSlots']).filter(row => row['defaultChecked'] === true)
        .flatMap(row => rows(row['slots']).filter(slot => slot['selected'] === true)
        .map(slot => ({ ...slot, adapterCode: row['adapterCode'] ?? '' })));
    option['solutionPrice'] = optionPrice(option);
}
export function stagePciWizardChange(raw, change) {
    const options = pciWizardOptions(raw);
    const matches = options.filter(option => option['configId'] === change.optionId);
    if (matches.length !== 1)
        throw new Error('Choose one available PCI wizard option from the current configuration.');
    const option = matches[0];
    let operate;
    if (change.rowId !== undefined) {
        const matches = rows(option['adapterSlots']).filter(row => row['lineNumber'] === change.rowId);
        if (matches.length !== 1)
            throw new Error('Choose an exact PCI wizard row from the current option.');
        const row = matches[0];
        if (change.enabled === undefined && change.slotCodes === undefined)
            throw new Error('Specify enabled or slotCodes for the PCI row.');
        if (change.enabled === false && row['required'] === true)
            throw new Error('This PCI row is required by Lenovo and cannot be disabled.');
        if (change.slotCodes !== undefined && change.enabled !== true && row['defaultChecked'] !== true) {
            throw new Error('Enable this optional PCI row when selecting its slot codes.');
        }
        const previous = rows(option['results']).map(result => result['code']);
        if (change.slotCodes !== undefined) {
            const codes = change.slotCodes;
            const slots = rows(row['slots']);
            if (codes.length === 0 || new Set(codes).size !== codes.length ||
                codes.some(code => slots.filter(slot => slot['code'] === code).length !== 1)) {
                throw new Error('Choose unique slot codes offered by this PCI row.');
            }
            const selected = slots.filter(slot => codes.includes(String(slot['code'])));
            if (new Set(selected.map(slot => slot['characterName'])).size !== selected.length) {
                throw new Error('Choose only one alternative per physical PCI slot.');
            }
            for (const slot of slots)
                slot['selected'] = codes.includes(String(slot['code']));
        }
        if (change.enabled !== undefined)
            row['defaultChecked'] = change.enabled;
        rebuildResults(option);
        const next = rows(option['results']).map(result => result['code']);
        if (change.enabled !== undefined || row['defaultChecked'] === true) {
            operate = next.some(code => !previous.includes(code)) ? 'add' : 'cancel';
        }
    }
    else {
        if (change.enabled !== undefined || change.slotCodes !== undefined)
            throw new Error('A PCI row ID is required for slot changes.');
        rebuildResults(option);
    }
    for (const candidate of options)
        candidate['activate'] = candidate === option;
    return { option, options, ...(operate ? { operate } : {}) };
}
/** Validation reallocates adapters; native UI retains slot/pricing metadata by lineNumber. */
export function acceptPciWizardValidation(option, response, operate = 'add') {
    const payload = objectOrEmpty(response);
    const validated = objectOrEmpty(payload['pciWizardOption']);
    const code = String(payload['code']);
    // Native add without adapter reassignment returns 2; spare removal returns 4.
    // Both have an empty massage and continue to derive in the SPA.
    if ((code !== '1' && !(operate === 'add' && code === '2') && !(operate === 'cancel' && code === '4')) || payload['massage']) {
        throw new Error(`Lenovo rejected the PCI slot change: ${String(payload['massage'] ?? payload['code'] ?? 'missing validation verdict')}`);
    }
    if (validated['configId'] !== option['configId'])
        throw new Error('Lenovo returned a different PCI wizard option.');
    const next = structuredClone(option);
    const incoming = rows(validated['adapterSlots']);
    const current = rows(next['adapterSlots']);
    if (incoming.length !== current.length)
        throw new Error('Lenovo changed the PCI row catalog during validation; refresh choices.');
    for (const row of current) {
        const matches = incoming.filter(candidate => candidate['lineNumber'] === row['lineNumber']);
        if (matches.length !== 1)
            throw new Error('Lenovo returned ambiguous PCI row identities.');
        for (const key of ['adapterCode', 'adapterCharacterName', 'adapterCharacterDescription'])
            row[key] = matches[0][key];
    }
    rebuildResults(next);
    return next;
}
export function withPciWizardOption(raw, options, option) {
    return { ...structuredClone(raw), pciWizard: { ...structuredClone(objectOrEmpty(raw['pciWizard'])),
            pciWizardOptions: structuredClone(options.map(candidate => candidate['configId'] === option['configId']
                ? { ...option, activate: true } : { ...candidate, activate: false })) } };
}
/** The SPA includes the physical-slot map on export, deliberately omitting it on derive. */
export function pciWizardWireFields(raw, purpose = 'derive') {
    const options = pciWizardOptions(raw);
    const active = options.filter(option => option['activate'] === true);
    if (active.length === 0)
        return {};
    if (active.length !== 1)
        throw new Error('Configuration has ambiguous active PCI wizard options.');
    const wizard = objectOrEmpty(raw['pciWizard']);
    const fields = { pciWizardOptionConfigIds: options.map(option => option['configId']), pciWizardOption: active[0] };
    for (const key of ['lastPciWizardSelectCondition', 'lastPciWizardAutoFixAllDisabledSlotFcSet',
        ...(purpose === 'export' ? ['adapterCodeAndPhysicalSlotMap'] : [])]) {
        const value = wizard[key];
        if (value && typeof value === 'object' && Object.keys(value).length > 0)
            fields[key] = structuredClone(value);
    }
    return fields;
}
export function pciWizardSections(raw, sections) {
    const active = objectOrEmpty(pciWizardWireFields(raw)['pciWizardOption']);
    if (Object.keys(active).length === 0)
        return sections;
    const names = new Set(rows(active['results']).map(slot => slot['characterName']));
    const result = structuredClone(sections.filter(section => section.subTabTitle !== 'Riser Card' && !names.has(section.name)));
    const ctoCode = String(raw.sliceCtoCode ?? raw.ctoCode ?? raw.code ?? '');
    for (const slot of rows(active['results'])) {
        if (typeof slot['characterName'] !== 'string' || typeof slot['code'] !== 'string')
            throw new Error('Selected PCI slot has no native feature identity.');
        let section = result.find(section => section.name === slot['characterName']);
        if (!section) {
            section = { name: slot['characterName'], multipleSelectable: false, type: 'hardware', results: [] };
            result.push(section);
        }
        section.results.push({ code: slot['code'], ctoCode, ...(typeof slot['description'] === 'string' ? { description: slot['description'] } : {}), quantity: 1, type: 'hardware',
            ...(typeof slot['optionCode'] === 'string' ? { optionCode: slot['optionCode'] } : {}) });
    }
    return result;
}
//# sourceMappingURL=pciWizard.js.map