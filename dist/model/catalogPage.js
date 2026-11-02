import { createHash } from 'node:crypto';
import { projectJsonPage } from './pagedJson.js';
import { jsonBytes } from '../util/jsonBytes.js';
import { PAGE_BYTE_BUDGET } from '../config/constants.js';
/** Preserve complete catalog rows behind byte-bounded, query-bound continuations. */
export function projectCatalogPage(options) {
    const fingerprint = createHash('sha256').update(JSON.stringify({
        arguments: options.arguments, context: options.context, items: options.items,
    })).digest('hex');
    if (options.expectedCatalogFingerprint !== undefined && options.expectedCatalogFingerprint !== fingerprint) {
        throw new Error(`The catalog or query context changed. Restart ${options.tool} without expectedCatalogFingerprint and offset to enumerate the current results.`);
    }
    const args = { ...options.arguments, expectedCatalogFingerprint: fingerprint };
    if (options.path !== undefined) {
        return projectJsonPage({ [options.collection]: options.items }, {
            tool: options.tool, arguments: args, path: options.path, offset: options.offset, limit: options.limit,
        });
    }
    const items = options.items.slice(options.offset, options.offset + Math.min(options.limit, 50));
    const page = options.base.page;
    const result = () => ({
        ...options.base,
        catalogFingerprint: fingerprint,
        page: { ...page, offset: options.offset, limit: options.limit, returned: items.length },
        [options.collection]: items,
        ...(options.offset + items.length < options.items.length ? {
            next: { tool: options.tool, arguments: { ...args, offset: options.offset + items.length, limit: options.limit } },
        } : {}),
    });
    const size = () => jsonBytes(result());
    while (items.length > 1 && size() > PAGE_BYTE_BUDGET)
        items.pop();
    if (items.length === 1 && size() > PAGE_BYTE_BUDGET) {
        const item = items[0];
        items[0] = {
            ...(typeof item.code === 'string' && item.code.length < 160 ? { code: item.code } : {}),
            compacted: true,
            detail: { tool: options.tool, arguments: {
                    ...args, path: [options.collection, String(options.offset)], offset: 0, limit: 20,
                } },
        };
    }
    if (size() > PAGE_BYTE_BUDGET)
        throw new Error('Catalog query context exceeds the response budget; shorten the query or filters.');
    return result();
}
//# sourceMappingURL=catalogPage.js.map