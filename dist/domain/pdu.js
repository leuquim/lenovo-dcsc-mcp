/**
 * PDU selection for rack cabinets.
 *
 * A rack added via dcsc_rack_add is launched as a full configuration. Its
 * Power tab carries PDU, RACK_POWERCABLE and LINECORD sections. Selecting a
 * PDU is the same operation as any other feature change: put it in the
 * reduced model and round-trip through /ctos/autoDerive. DCSC's response is
 * authoritative — quantity, price and any auto-pulled line cords come back
 * from the server.
 *
 * `/pdu/pduPreference?codes=` exists and is what the SPA uses for the power
 * preference panel, but for the rack cabinets we have tested it returns `{}`
 * anonymously. The configuration tree is the reliable catalogue. Placement
 * rules (`pduPlacementRules` on the rackArea object from /racks/customize)
 * describe sidewall bays; they constrain physical install, not which feature
 * codes may be ordered.
 */
/**
 * Lists orderable PDUs and related power options from the rack configuration
 * index, plus sidewall rules from the last customize response.
 */
export function listPduCatalog(opts) {
    const options = [];
    for (const f of opts.index.features) {
        const section = (f.sectionName ?? '').toUpperCase();
        const isPduSection = section === 'PDU' || section === 'RACK_POWERCABLE' || section === 'LINECORD';
        const looksLikePdu = /pdu/i.test(f.description ?? '') ||
            /pdu/i.test(f.category ?? '') ||
            /pdu/i.test(f.sectionTitle ?? '');
        if (!isPduSection && !looksLikePdu)
            continue;
        options.push({
            code: f.code,
            description: f.description ?? f.code,
            section: f.sectionName ?? section,
            min: f.min ?? 0,
            max: f.max ?? 1,
            ...(typeof f.unitPrice === 'number' ? { unitPrice: f.unitPrice } : {}),
            selectedQty: f.selectedQty ?? 0,
        });
    }
    const placementRules = [];
    let totalCombinedSlots;
    const rules = opts.rackObject?.['pduPlacementRules'];
    if (typeof rules === 'object' && rules !== null) {
        const r = rules;
        if (typeof r['totalCombined'] === 'number')
            totalCombinedSlots = r['totalCombined'];
        for (const tr of r['pduTypeRules'] ?? []) {
            const features = Array.isArray(tr['features'])
                ? tr['features'].filter((x) => typeof x === 'string')
                : [];
            const sw = tr['sideWallPlacement']?.[0];
            const maxQuantity = typeof sw?.['totalQuantity'] === 'number' ? sw['totalQuantity'] : undefined;
            placementRules.push({
                groupName: String(tr['groupName'] ?? 'PDU'),
                features,
                ...(maxQuantity !== undefined ? { maxQuantity } : {}),
            });
        }
    }
    return {
        options,
        placementRules,
        ...(totalCombinedSlots !== undefined ? { totalCombinedSlots } : {}),
    };
}
/** Selected PDU / cord lines currently on the rack configuration. */
export function selectedPowerLines(index) {
    const out = [];
    for (const f of index.features) {
        const section = (f.sectionName ?? '').toUpperCase();
        if (section !== 'PDU' && section !== 'RACK_POWERCABLE' && section !== 'LINECORD')
            continue;
        if ((f.selectedQty ?? 0) <= 0)
            continue;
        out.push({
            code: f.code,
            description: f.description ?? f.code,
            section: f.sectionName ?? section,
            quantity: f.selectedQty ?? 0,
            ...(typeof f.unitPrice === 'number' ? { unitPrice: f.unitPrice } : {}),
        });
    }
    return out;
}
/**
 * Resolves a requested code to the section name autoDerive needs.
 *
 * Callers often know only the feature code; the index carries the section.
 */
export function resolvePowerChange(index, code, quantity) {
    const hits = index.byCode.get(code) ?? index.byCode.get(code.toUpperCase()) ?? [];
    const hit = hits.find((h) => {
        const s = (h.sectionName ?? '').toUpperCase();
        return s === 'PDU' || s === 'RACK_POWERCABLE' || s === 'LINECORD';
    }) ?? hits[0];
    if (!hit) {
        throw new Error(`Unknown power feature "${code}". Use dcsc_rack_get with the rack id to list options, ` +
            'or dcsc_configuration_get(session, view: "options", query: "PDU") on the rack configuration.');
    }
    return {
        section: hit.sectionName ?? 'PDU',
        code: hit.code,
        quantity,
    };
}
//# sourceMappingURL=pdu.js.map