export const VLH_TYPES = ['basic', 'switch', 'networking-adapter', 'networking-cable', 'server', 'rack', 'chassis'];
/**
 * Queries available network topologies, connector functions, and RPQ placeholders
 * for Neptune water-cooling and VLH items.
 */
export async function fetchVlhWizardInfo(http, ctx) {
    const res = await http.send({
        endpoint: 'vlh.wizardInfo',
        method: 'GET',
        path: '/vlh/wizardInfo',
        requiresSolution: false,
        responseKind: 'json',
        ctx,
    });
    return res.raw;
}
/**
 * Queries physical dimensions, EIA U-height/capacity, and connector definitions
 * for a product or VLH item.
 */
export async function fetchVlhAttributes(http, code, ctx) {
    if (!code || typeof code !== 'string') {
        throw new Error('A non-empty product or VLH item code is required.');
    }
    const res = await http.send({
        endpoint: 'vlh.attributes',
        method: 'GET',
        path: `/vlh/attributes/${encodeURIComponent(code)}`,
        requiresSolution: false,
        responseKind: 'json',
        ctx,
    });
    return res.raw;
}
export const VLH_PRODUCT_TYPE = 'VLH';
/** The 14-field export form of the captured POST /vlh/export/xml; only `data` carries content. */
export function buildVlhExportForm(items) {
    return {
        data: JSON.stringify(items), crnId: '', userGeneratedConfigId: '', lfoCode: '', cancelDownload: 'false',
        multipleProductData: '', excelData: '', groups: '', integrationParams: '', image: '', user: '',
        'dcsc-isFromIntegration': 'false', serviceAndorRequest: '', uuid: '',
    };
}
/** Export Items: the VLH item definitions as a .vlh (VLHData XML) download stream. */
export async function exportVlhItems(http, items, ctx) {
    if (items.length === 0)
        throw new Error('At least one VLH item is required.');
    return http.send({
        endpoint: 'vlh.export',
        method: 'POST',
        path: '/vlh/export/xml',
        body: { kind: 'form', fields: buildVlhExportForm(items) },
        requiresSolution: false,
        responseKind: 'stream',
        timeoutClass: 'export',
        ctx,
    });
}
/** Import Items: uploads a .vlh file as the multipart part `vlhXmlFile`. */
export async function importVlhItems(http, file, ctx) {
    const res = await http.send({
        endpoint: 'vlh.import',
        method: 'POST',
        path: '/vlh/import',
        body: { kind: 'multipart', parts: [{ name: 'vlhXmlFile', filename: file.fileName, contentType: 'application/octet-stream', content: file.content }] },
        requiresSolution: false,
        responseKind: 'json',
        timeoutClass: 'interactive',
        ctx,
    });
    return res.raw;
}
//# sourceMappingURL=vlh.js.map