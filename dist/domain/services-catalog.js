function walk(node) {
    const id = node['id'];
    if (typeof id !== 'string')
        return undefined;
    const children = [];
    for (const c of node['children'] ?? []) {
        const child = walk(c);
        if (child)
            children.push(child);
    }
    return {
        id,
        title: String(node['title'] ?? id),
        description: String(node['description'] ?? ''),
        children,
    };
}
export async function fetchServicePortalCategories(http, ctx) {
    const res = await http.send({
        endpoint: 'service_portal_categories',
        method: 'GET',
        path: '/service/portal/categories',
        responseKind: 'json',
        timeoutClass: 'fast',
        ctx,
    });
    if (typeof res.raw !== 'object' || res.raw === null)
        return undefined;
    return walk(res.raw);
}
//# sourceMappingURL=services-catalog.js.map