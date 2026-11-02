export function referenceId(value, label) {
    if (!value || !/^[A-Za-z0-9_-]{1,160}$/.test(value))
        throw new Error(`Use an exact ${label} returned by the reference-solution catalog.`);
    return value;
}
export function referencePath(query) {
    switch (query.view) {
        case 'categories': return query.catalog === 'truscale' ? '/reference_solution/category_vc' : '/reference_solution/category_drs';
        case 'category': return `/reference_solution/categories/${referenceId(query.categoryId, 'categoryId')}`;
        case 'solutions': return `/reference_solution/categories/${referenceId(query.categoryId, 'categoryId')}/CRNs`;
        case 'popular': return '/reference_solution/new_or_popular_CRNs';
        case 'validation': return `/reference_solution/CRNs/${referenceId(query.crnId, 'crnId')}/validate`;
        case 'promotions': return '/promotion/hierarchies';
        case 'promotion-sids': return '/promotion/sid';
        case 'promotion-lfos': return '/promotion/lfo';
    }
}
export async function fetchReferenceSolutions(http, ctx, query) {
    const response = await http.send({ endpoint: `reference_${query.view}`, method: 'GET', path: referencePath(query),
        responseKind: 'json', timeoutClass: query.view === 'validation' ? 'heavy' : 'fast', ctx });
    return response.raw;
}
/** The website only downloads SUCCESS; invalid templates go through Customize. */
export async function downloadReferenceSolution(http, ctx, crnId, maxBytes) {
    const id = referenceId(crnId, 'crnId');
    const validation = await fetchReferenceSolutions(http, ctx, { view: 'validation', crnId: id });
    const status = validation && typeof validation === 'object' ? validation['type'] : undefined;
    if (status !== 'SUCCESS') {
        throw new Error(`Lenovo did not approve original-template download (${String(status ?? 'unknown status')}). Use dcsc_launch (mode reference-solution) to customize and inspect the design.`);
    }
    const response = await http.send({ endpoint: 'reference_download', method: 'GET',
        path: `/reference_solution/CRNs/${id}/download`, responseKind: 'stream', timeoutClass: 'export', ctx });
    const chunks = [];
    let length = 0;
    for await (const chunk of response.stream) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > maxBytes)
            throw new Error(`Reference download exceeded the configured limit of ${maxBytes} bytes.`);
        chunks.push(bytes);
    }
    return Buffer.concat(chunks, length);
}
/** Keep native fields while exposing category IDs without a deep tree crawl. */
export function referenceRows(raw, view) {
    const object = (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('DCSC returned an invalid reference-solution catalog row.');
        return value;
    };
    if (view !== 'categories' && view !== 'promotions')
        return Array.isArray(raw) ? raw.map(object) : [object(raw)];
    const result = [];
    const visit = (value, ancestors) => {
        const node = object(value);
        const breadcrumb = [...ancestors, String(node['name'] ?? node['title'] ?? node['id'] ?? '')];
        const { children, ...fields } = node;
        result.push({ ...fields, breadcrumb, childIds: Array.isArray(children) ? children.map(c => object(c)['id']) : [] });
        if (Array.isArray(children))
            for (const child of children)
                visit(child, breadcrumb);
    };
    for (const root of Array.isArray(raw) ? raw : [raw])
        visit(root, []);
    return result;
}
//# sourceMappingURL=referenceSolutions.js.map