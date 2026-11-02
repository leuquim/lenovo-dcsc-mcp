import type { DcscHttpClient, RequestCtx } from '../http/request.js';
export type DiscoveryAction = 'caseStudies' | 'subCategoryConditions' | 'productListBySubCategory' | 'topChoiceCountry' | 'productFunctions' | 'displayOrders' | 'staticFeatures';
export interface DiscoveryHelperInput {
    action: DiscoveryAction;
    params?: Record<string, unknown> | undefined;
}
export declare function queryDiscoveryHelper(http: DcscHttpClient, ctx: RequestCtx, input: DiscoveryHelperInput): Promise<unknown>;
