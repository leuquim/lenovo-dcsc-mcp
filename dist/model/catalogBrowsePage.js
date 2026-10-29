import { createHash } from 'node:crypto';
import { projectJsonPage } from './pagedJson.js';
/**
 * Bound both collections returned by hierarchical catalog browsing while
 * advancing each cursor by the number that survived byte trimming.
 */
export function projectCatalogBrowsePage(options) {
    const fingerprint = createHash('sha256').update(JSON.stringify({
        arguments: options.arguments,
        context: options.context,
        path: options.path,
        categories: options.categories,
        products: options.products,
    })).digest('hex');
    if (options.expectedCatalogFingerprint !== undefined && options.expectedCatalogFingerprint !== fingerprint) {
        throw new Error(`The catalog or query context changed. Restart ${options.tool} without expectedCatalogFingerprint and offsets to enumerate the current results.`);
    }
    const args = { ...options.arguments, expectedCatalogFingerprint: fingerprint };
    const source = { categories: options.categories, products: options.products };
    if (options.detailPath !== undefined) {
        return projectJsonPage(source, {
            tool: options.tool,
            arguments: args,
            path: options.detailPath,
            offset: options.productOffset,
            limit: options.limit,
            pathArgument: 'detailPath',
        });
    }
    const categoryLimit = Math.min(options.limit, 50);
    const productLimit = Math.min(options.limit, 50);
    const categories = options.categories.slice(options.categoryOffset, options.categoryOffset + categoryLimit);
    const products = options.products.slice(options.productOffset, options.productOffset + productLimit);
    const continuation = () => {
        const nextCategoryOffset = options.categoryOffset + categories.length;
        const nextProductOffset = options.productOffset + products.length;
        return nextCategoryOffset < options.categories.length || nextProductOffset < options.products.length
            ? {
                tool: options.tool,
                arguments: {
                    ...args,
                    categoryOffset: nextCategoryOffset,
                    offset: nextProductOffset,
                    limit: options.limit,
                },
            }
            : undefined;
    };
    const result = () => ({
        path: options.path,
        catalogFingerprint: fingerprint,
        categories,
        categoryPage: {
            offset: options.categoryOffset,
            limit: options.limit,
            total: options.categories.length,
            returned: categories.length,
        },
        products,
        // Preserve the historical product-page fields while adding its retained count.
        page: {
            offset: options.productOffset,
            limit: options.limit,
            total: options.products.length,
            returned: products.length,
        },
        ...(continuation() ? { next: continuation() } : {}),
    });
    const size = () => Buffer.byteLength(JSON.stringify(result(), null, 2));
    while (size() > 7_500 && categories.length + products.length > 1) {
        if (products.length >= categories.length && products.length > 0)
            products.pop();
        else
            categories.pop();
    }
    if (size() > 7_500) {
        if (products.length === 1) {
            const row = products[0];
            products[0] = compact(row, 'code', {
                tool: options.tool,
                arguments: { ...args, detailPath: ['products', String(options.productOffset)], offset: 0, limit: 20 },
            });
        }
        else if (categories.length === 1) {
            const row = categories[0];
            categories[0] = compact(row, 'id', {
                tool: options.tool,
                arguments: { ...args, detailPath: ['categories', String(options.categoryOffset)], offset: 0, limit: 20 },
            });
        }
    }
    if (size() > 7_500)
        throw new Error('Catalog browse context exceeds the response budget. Inspect a narrower breadcrumb.');
    return result();
}
function compact(row, preferredKey, detail) {
    const preferred = row[preferredKey];
    return {
        ...(typeof preferred === 'string' && preferred.length < 160 ? { [preferredKey]: preferred } : {}),
        compacted: true,
        detail,
    };
}
//# sourceMappingURL=catalogBrowsePage.js.map