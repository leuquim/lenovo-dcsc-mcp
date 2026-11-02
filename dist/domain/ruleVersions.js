/**
 * Fetches version history codes for a CTO product.
 *
 * Upstream route: GET /api/ctos/${encodeURIComponent(ctoCode)}/versions
 */
export async function fetchCtoVersions(http, ctx, ctoCode) {
    const code = ctoCode.trim();
    if (!code) {
        throw new Error('A CTO product code is required to fetch CTO versions.');
    }
    const response = await http.send({
        endpoint: 'ctos.versions',
        method: 'GET',
        path: `/ctos/${encodeURIComponent(code)}/versions`,
        responseKind: 'json',
        timeoutClass: 'interactive',
        requiresSolution: true,
        ctx,
    });
    const raw = response.raw;
    if (Array.isArray(raw)) {
        return raw.map((item) => String(item));
    }
    if (raw && typeof raw === 'object') {
        const record = raw;
        const direct = record[code] ?? record[code.toUpperCase()];
        if (typeof direct === 'string') {
            return direct.split(',').map((s) => s.trim()).filter(Boolean);
        }
        if (direct !== undefined && direct !== null) {
            return [String(direct)];
        }
        return Object.keys(record);
    }
    return [];
}
/**
 * Fetches table rule versions for a specific CTO and table code.
 *
 * Upstream route: GET /api/ctos/${encodeURIComponent(ctoCode)}/${encodeURIComponent(tableCode)}/rule_versions
 */
export async function fetchRuleVersions(http, ctx, input) {
    const code = input.ctoCode.trim();
    if (!code) {
        throw new Error('A CTO product code is required to fetch rule versions.');
    }
    const table = (input.tableCode ?? '203').trim();
    const response = await http.send({
        endpoint: 'ctos.ruleVersions',
        method: 'GET',
        path: `/ctos/${encodeURIComponent(code)}/${encodeURIComponent(table)}/rule_versions`,
        responseKind: 'json',
        timeoutClass: 'interactive',
        requiresSolution: true,
        ctx,
    });
    return response.raw;
}
/**
 * Combined helper for inspecting CTO version history and rule table versions.
 */
export async function fetchRuleVersionsInfo(http, ctx, input) {
    const ctoCode = input.ctoCode.trim();
    const tableCode = input.tableCode ?? '203';
    const [versions, ruleVersions] = await Promise.all([
        fetchCtoVersions(http, ctx, ctoCode),
        fetchRuleVersions(http, ctx, { ctoCode, tableCode }),
    ]);
    return {
        ctoCode,
        versions,
        tableCode,
        ruleVersions,
    };
}
//# sourceMappingURL=ruleVersions.js.map