/**
 * Queries Lenovo DCSC upstream POST /ctos/featureDetails for full spec details,
 * lifecycle dates, shipping lead times, commercial flags, and pricing.
 */
export async function fetchUpstreamFeatureDetails(http, ctx, ctoCode, sessionId, featureCodes) {
    if (!featureCodes || featureCodes.length === 0) {
        return [];
    }
    const payload = [
        {
            id: sessionId,
            ctoCode,
            resultFeatures: featureCodes.map((code) => ({
                code,
                ctoCode,
            })),
        },
    ];
    const res = await http.send({
        endpoint: 'feature_details',
        method: 'POST',
        path: '/ctos/featureDetails',
        body: { kind: 'json', value: payload },
        responseKind: 'json',
        timeoutClass: 'fast',
        ctx,
    });
    const list = res.raw;
    if (!Array.isArray(list) || list.length === 0) {
        return [];
    }
    return list[0]?.features ?? [];
}
const FAR_FUTURE = '2999';
function checkWithdrawn(date) {
    if (!date || date.startsWith(FAR_FUTURE))
        return false;
    return new Date(date).getTime() < Date.now();
}
/**
 * Summarizes an upstream feature detail into structured specs.
 */
export function summarizeFeatureSpec(detail) {
    return {
        code: detail.code,
        ...(detail.displayCode ? { displayCode: detail.displayCode } : {}),
        ...(detail.category ? { category: detail.category } : {}),
        description: detail.description,
        lifecycle: {
            announceDate: detail.announceDate,
            withdrawnDate: detail.withdrawnDate,
            isWithdrawn: checkWithdrawn(detail.withdrawnDate),
        },
        supply: {
            shippingStatus: detail.shippingStatus,
            shipDate: detail.shipDate,
        },
        commercial: {
            topChoice: Boolean(detail.topChoice),
            recommendedFeature: Boolean(detail.recommendedFeature),
            marketingTag: Array.isArray(detail.marketingTag) ? detail.marketingTag : [],
            eccnRestricted: Boolean(detail.eccnRestricted),
        },
        pricing: {
            unitPrice: detail.unitPrice,
            prices: detail.prices,
            specialBid: detail.specialBid,
        },
        ...(detail.attributeMap ? { attributes: detail.attributeMap } : {}),
    };
}
//# sourceMappingURL=featureDetails.js.map