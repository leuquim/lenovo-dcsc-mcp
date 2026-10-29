import type { DcscHttpClient, RequestCtx } from '../http/request.js';
/**
 * Anonymous services catalogue from /service/portal/categories.
 *
 * This lists service *categories* (Advise, Deploy, …). Selecting and pricing
 * specific warranty SKUs still goes through the configuration's Services tab
 * (auto-attached when serviceCto=true) or may require entitlement for the
 * full services portal workflow — probe before claiming selection works.
 */
export interface ServiceCategory {
    id: string;
    title: string;
    description: string;
    children: ServiceCategory[];
}
export declare function fetchServicePortalCategories(http: DcscHttpClient, ctx: RequestCtx): Promise<ServiceCategory | undefined>;
