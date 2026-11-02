/**
 * Fetches context-aware sub-tab recommendations and rule advisories.
 * Endpoint: GET /recommendations/sub_tabs?mode={mode}&selectedProducts={productCode}
 */
export async function fetchSubTabRecommendations(http, ctx, mode, productCode) {
    if (!productCode || typeof productCode !== 'string' || productCode.trim().length === 0) {
        throw new Error('A non-empty productCode is required for sub-tab recommendations.');
    }
    const query = {
        mode: mode || 'CTO',
        selectedProducts: productCode.trim(),
    };
    const res = await http.send({
        endpoint: 'recommendations_sub_tabs',
        method: 'GET',
        path: '/recommendations/sub_tabs',
        query,
        responseKind: 'json',
        timeoutClass: 'fast',
        ctx,
    });
    if (!Array.isArray(res.raw)) {
        return [];
    }
    return res.raw;
}
/**
 * Fetches cross-sell, bundle and summary recommendations for a solution.
 * Endpoint: POST /recommendations/summary?type={mode}&mode={mode}
 */
export async function fetchSummaryRecommendations(http, ctx, payload, mode = 'CTO') {
    const query = {
        type: mode,
        mode,
    };
    const res = await http.send({
        endpoint: 'recommendations_summary',
        method: 'POST',
        path: '/recommendations/summary',
        query,
        body: { kind: 'json', value: payload },
        responseKind: 'json',
        timeoutClass: 'fast',
        ctx,
    });
    return res.raw;
}
/**
 * Fetches smart top-choice preconfigured LFO recommendations for a CTO model.
 * Endpoint: POST /smart/recommend/lfo/{country}/{ctoCode}
 */
export async function fetchSmartLfoRecommendation(http, ctx, country, ctoCode, payload, isMultiCto) {
    if (!country || !/^[A-Za-z]{2}$/.test(country)) {
        throw new Error('A valid 2-letter ISO country code is required for smart LFO recommendations.');
    }
    if (!ctoCode || typeof ctoCode !== 'string' || ctoCode.trim().length === 0) {
        throw new Error('A non-empty ctoCode is required for smart LFO recommendations.');
    }
    const query = {};
    if (isMultiCto !== undefined) {
        query['isMultiCto'] = String(isMultiCto);
    }
    const bodyValue = payload ?? { sections: [], lfoProducts: [] };
    const res = await http.send({
        endpoint: 'smart_recommend_lfo',
        method: 'POST',
        path: `/smart/recommend/lfo/${encodeURIComponent(country.toUpperCase())}/${encodeURIComponent(ctoCode)}`,
        query,
        body: { kind: 'json', value: bodyValue },
        responseKind: 'json',
        timeoutClass: 'fast',
        ctx,
    });
    return (res.raw ?? {});
}
//# sourceMappingURL=recommendations.js.map