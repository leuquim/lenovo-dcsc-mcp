/**
 * Fetches supply status and shipping lead-times.
 * Endpoint: GET /supply/status?country=...&type=...&code=...
 */
export async function fetchSupplyStatus(http, ctx, input) {
    const country = input.country ?? ctx.locale.country;
    const type = input.type ?? 'Option';
    const code = input.code;
    const res = await http.send({
        endpoint: 'supply_status',
        method: 'GET',
        path: '/supply/status',
        query: {
            country,
            type,
            code,
        },
        responseKind: 'json',
        timeoutClass: 'interactive',
        requiresSolution: false,
        ctx,
    });
    const raw = res.raw;
    let shippingStatus = [];
    const items = Array.isArray(raw) ? raw : [raw];
    for (const item of items) {
        if (item && typeof item === 'object') {
            const rec = item;
            if (Array.isArray(rec.shippingStatus)) {
                shippingStatus = rec.shippingStatus.map((v) => String(v));
                break;
            }
        }
    }
    return {
        code,
        type,
        country,
        shippingStatus,
        raw,
    };
}
/**
 * Fetches ESD (Electronic Software Delivery) info or alternatives.
 * Endpoints:
 * - POST /sst/esd/info
 * - POST /sst/esd/alternative
 */
export async function fetchEsdInfo(http, ctx, input) {
    const path = input.action === 'info' ? '/sst/esd/info' : '/sst/esd/alternative';
    const endpoint = input.action === 'info' ? 'sst_esd_info' : 'sst_esd_alternative';
    const res = await http.send({
        endpoint,
        method: 'POST',
        path,
        body: { kind: 'json', value: input.payload },
        responseKind: 'json',
        timeoutClass: 'interactive',
        requiresSolution: false,
        ctx,
    });
    return {
        action: input.action,
        data: res.raw,
        raw: res.raw,
    };
}
//# sourceMappingURL=supplyStatus.js.map