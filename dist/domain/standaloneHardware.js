import { randomUUID } from 'node:crypto';
import { findParts } from './standalone.js';
import { finiteNumber, nonBlankString, objectItems, requirePositiveSafeInteger } from '../util/coerce.js';
export function emptyStandaloneHardware() {
    return { kind: 'standalone-hardware', selections: [] };
}
/** Resolves an exact hardware part number through the website's Part Search endpoint. */
export async function lookupStandaloneHardwarePart(http, ctx, code, mode = 'LFO') {
    const wanted = code.trim().toUpperCase();
    if (wanted === '')
        throw new Error('Part number must not be empty.');
    const result = await findParts(http, ctx, { keyword: wanted, types: ['HARDWARE'], mode });
    const matches = result.items.filter((item) => item.type === 'HARDWARE' && item.code.toUpperCase() === wanted);
    if (matches.length === 0) {
        const near = result.items.slice(0, 5).map((item) => `${item.code} (${item.type})`).join(', ');
        throw new Error(`No standalone hardware part ${wanted} in DCSC Part Search.${near ? ` Closest results: ${near}.` : ''}`);
    }
    return structuredClone(matches[0].raw);
}
export function standaloneHardwareSelection(part, quantity, id = randomUUID()) {
    const code = nonBlankString(part['code']);
    if (!code)
        throw new Error('Part Search row has no part number.');
    const unitPrice = finiteNumber(part['price']) ?? finiteNumber(objectItems(part['prices'])[0]?.['price']);
    return {
        id,
        kind: 'hardware',
        code,
        quantity: requirePositiveSafeInteger(quantity, 'quantity'),
        description: nonBlankString(part['description']) ?? '',
        ...(nonBlankString(part['featureCode']) ? { featureCode: nonBlankString(part['featureCode']) } : {}),
        ...(unitPrice !== undefined ? { unitPrice } : {}),
        priceNotAvailable: part['priceNotAvailable'] === true,
        part: structuredClone(part),
    };
}
/** Adds a part, or replaces the quantity of one already selected (the website keeps one line per part). */
export function selectStandaloneHardware(state, part, quantity) {
    const code = nonBlankString(part['code']);
    const existing = state.selections.find((selection) => selection.code === code);
    const selection = standaloneHardwareSelection(part, quantity, existing?.id);
    return {
        ...state,
        selections: existing
            ? state.selections.map((candidate) => (candidate.code === code ? selection : candidate))
            : [...state.selections, selection],
    };
}
export function setStandaloneHardwareQuantity(state, code, quantity) {
    const existing = requireSelection(state, code);
    return selectStandaloneHardware(state, existing.part, quantity);
}
export function removeStandaloneHardware(state, code) {
    requireSelection(state, code);
    return { ...state, selections: state.selections.filter((selection) => selection.code !== code) };
}
/** One `standaloneData` row, matching the captured website export form. */
export function standaloneHardwareExportItem(selection) {
    return {
        keyWord: null,
        isLFO: false,
        ...structuredClone(selection.part),
        id: selection.id,
        quantity: selection.quantity,
    };
}
/** One `groups[].products` row: the same row typed `standalone` with unit and extended price. */
export function standaloneHardwareGroupProduct(selection, groupName = 'Config 1') {
    return {
        ...standaloneHardwareExportItem(selection),
        type: 'standalone',
        price: selection.unitPrice !== undefined ? round2(selection.unitPrice * selection.quantity) : null,
        unitPrice: selection.unitPrice ?? null,
        groupId: groupName,
    };
}
/**
 * Restores standalone hardware rows from a /multiple/cfxml_import response.
 * Rows are recognised by `type: "HARDWARE"`; everything else is left to the
 * software parser.
 */
export function parseStandaloneHardwareRows(rows, groupProducts) {
    const hardware = rows.filter((row) => String(row['type'] ?? '').toUpperCase() === 'HARDWARE');
    if (hardware.length === 0)
        return undefined;
    return {
        kind: 'standalone-hardware',
        selections: hardware.map((row) => {
            const code = nonBlankString(row['code']);
            if (!code)
                throw new Error('Imported standalone hardware row has no part number.');
            const id = nonBlankString(row['id']) ?? randomUUID();
            const group = groupProducts.find((candidate) => nonBlankString(candidate['id']) === id);
            const unitPrice = finiteNumber(group?.['unitPrice']);
            const part = structuredClone(row);
            delete part['id'];
            delete part['quantity'];
            if (unitPrice !== undefined && finiteNumber(part['price']) === undefined)
                part['price'] = unitPrice;
            return standaloneHardwareSelection(part, requirePositiveSafeInteger(finiteNumber(row['quantity']) ?? 0, `standalone ${code} quantity`), id);
        }),
    };
}
export function isStandaloneHardwareRow(row) {
    return String(row['type'] ?? '').toUpperCase() === 'HARDWARE';
}
export function standaloneHardwareTotal(state) {
    let total = 0;
    for (const selection of state.selections) {
        if (selection.unitPrice === undefined)
            return undefined;
        total += selection.unitPrice * selection.quantity;
    }
    return round2(total);
}
function requireSelection(state, code) {
    const selection = state.selections.find((candidate) => candidate.code === code);
    if (!selection)
        throw new Error(`Standalone hardware ${code} is not selected.`);
    return selection;
}
function round2(value) {
    return Math.round(value * 100) / 100;
}
//# sourceMappingURL=standaloneHardware.js.map