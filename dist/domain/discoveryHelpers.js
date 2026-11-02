/**
 * Queries anonymous catalog discovery helper routes.
 *
 * Supported actions:
 *   - 'caseStudies': Case study product details (/categories/caseStudy/{id})
 *   - 'subCategoryConditions': Search conditions for subcategories (/categories/getSubCategorySearchConditions)
 *   - 'productListBySubCategory': Filtered product list by subcategory (/categories/getProductListBySubCategory)
 *   - 'topChoiceCountry': Country top-choice flag (/categories/checkTopChoiceCountry)
 *   - 'productFunctions': Enabled feature functions for a product (/function_definition/product_functions)
 *   - 'displayOrders': Feature and group display ordering (/ctos/{code}/display_orders/features_and_groups)
 *   - 'staticFeatures': Static feature sections for a tab (/ctos/{code}/{tab}/staticFeatures)
 */
function requireText(params, action, ...keys) {
    for (const key of keys) {
        const value = params[key];
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    throw new Error(`${keys[0]} is required for discoveryAction ${action}.`);
}
export async function queryDiscoveryHelper(http, ctx, input) {
    const params = input.params ?? {};
    switch (input.action) {
        case 'caseStudies': {
            const id = typeof params['id'] === 'string' && params['id'].trim() ? params['id'].trim() : 'all';
            const response = await http.send({
                endpoint: 'categories.caseStudy',
                method: 'GET',
                path: `/categories/caseStudy/${encodeURIComponent(id)}`,
                responseKind: 'json',
                timeoutClass: 'interactive',
                requiresSolution: true,
                ctx,
            });
            return response.raw;
        }
        case 'subCategoryConditions': {
            const query = {};
            for (const [k, v] of Object.entries(params)) {
                if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                    query[k] = String(v);
                }
            }
            const response = await http.send({
                endpoint: 'categories.getSubCategorySearchConditions',
                method: 'GET',
                path: '/categories/getSubCategorySearchConditions',
                query: Object.keys(query).length > 0 ? query : undefined,
                responseKind: 'json',
                timeoutClass: 'interactive',
                requiresSolution: true,
                ctx,
            });
            return response.raw;
        }
        case 'productListBySubCategory': {
            const query = {
                categoryId: typeof params['categoryId'] === 'string' ? params['categoryId'] : 'STG@Servers@Rack Server',
                conditions: typeof params['conditions'] === 'object' && params['conditions'] !== null
                    ? JSON.stringify(params['conditions'])
                    : typeof params['conditions'] === 'string'
                        ? params['conditions']
                        : JSON.stringify({}),
                pageNumber: typeof params['pageNumber'] === 'string' || typeof params['pageNumber'] === 'number'
                    ? String(params['pageNumber'])
                    : '1',
                pageSize: typeof params['pageSize'] === 'string' || typeof params['pageSize'] === 'number'
                    ? String(params['pageSize'])
                    : '10',
                signCustomize: 'true',
            };
            if (typeof params['topChoice'] === 'string' || typeof params['topChoice'] === 'boolean') {
                query['topChoice'] = String(params['topChoice']);
            }
            const response = await http.send({
                endpoint: 'categories.getProductListBySubCategory',
                method: 'GET',
                path: '/categories/getProductListBySubCategory',
                query,
                responseKind: 'json',
                timeoutClass: 'interactive',
                requiresSolution: true,
                ctx,
            });
            return response.raw;
        }
        case 'topChoiceCountry': {
            const response = await http.send({
                endpoint: 'categories.checkTopChoiceCountry',
                method: 'GET',
                path: '/categories/checkTopChoiceCountry',
                responseKind: 'json',
                timeoutClass: 'interactive',
                requiresSolution: true,
                ctx,
            });
            return response.raw;
        }
        case 'productFunctions': {
            const code = requireText(params, 'productFunctions', 'ctoCode', 'code');
            const response = await http.send({
                endpoint: 'function_definition.product_functions',
                method: 'POST',
                path: '/function_definition/product_functions',
                query: { code },
                body: { kind: 'json', value: {} },
                responseKind: 'json',
                timeoutClass: 'interactive',
                requiresSolution: true,
                ctx,
            });
            return response.raw;
        }
        case 'displayOrders': {
            const code = requireText(params, 'displayOrders', 'ctoCode', 'code');
            const response = await http.send({
                endpoint: 'ctos.display_orders',
                method: 'GET',
                path: `/ctos/${encodeURIComponent(code)}/display_orders/features_and_groups`,
                responseKind: 'json',
                timeoutClass: 'heavy',
                requiresSolution: true,
                ctx,
            });
            return response.raw;
        }
        case 'staticFeatures': {
            const code = requireText(params, 'staticFeatures', 'ctoCode', 'code');
            const tab = requireText(params, 'staticFeatures', 'tab');
            const response = await http.send({
                endpoint: 'ctos.staticFeatures',
                method: 'POST',
                path: `/ctos/${encodeURIComponent(code)}/${encodeURIComponent(tab)}/staticFeatures`,
                body: { kind: 'json', value: {} },
                responseKind: 'json',
                timeoutClass: 'interactive',
                requiresSolution: true,
                ctx,
            });
            return response.raw;
        }
    }
}
//# sourceMappingURL=discoveryHelpers.js.map