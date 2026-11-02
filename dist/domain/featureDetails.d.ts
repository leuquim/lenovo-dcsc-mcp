import type { DcscHttpClient, RequestCtx } from '../http/request.js';
export interface FeaturePriceDetail {
    priceTypeId: number;
    price: number;
    priceNotAvailable?: boolean | undefined;
}
export interface UpstreamFeatureDetail {
    code: string;
    displayCode?: string | undefined;
    category?: string | undefined;
    description: string;
    unitPrice?: number | undefined;
    prices?: FeaturePriceDetail[] | undefined;
    priceNotAvailable?: boolean | undefined;
    priceNotCredible?: boolean | undefined;
    noCharge?: boolean | undefined;
    specialBid?: boolean | undefined;
    type?: string | undefined;
    announceDate?: string | undefined;
    withdrawnDate?: string | undefined;
    shippingStatus?: string[] | undefined;
    shipDate?: string | undefined;
    optionCode?: string | undefined;
    productNumber?: string | undefined;
    recommendedFeature?: boolean | undefined;
    topChoice?: boolean | undefined;
    isPinned?: boolean | undefined;
    eccnRestricted?: boolean | undefined;
    attributeMap?: Record<string, string> | undefined;
    attributeShowInPageMap?: Record<string, boolean> | undefined;
    attachedFeatures?: unknown[] | undefined;
    topologies?: unknown[] | undefined;
    marketingTag?: string[] | undefined;
    [key: string]: unknown;
}
export interface FeatureDetailsResultItem {
    id?: string | undefined;
    ctoCode: string;
    features: UpstreamFeatureDetail[];
}
/**
 * Queries Lenovo DCSC upstream POST /ctos/featureDetails for full spec details,
 * lifecycle dates, shipping lead times, commercial flags, and pricing.
 */
export declare function fetchUpstreamFeatureDetails(http: DcscHttpClient, ctx: RequestCtx, ctoCode: string, sessionId: string, featureCodes: string[]): Promise<UpstreamFeatureDetail[]>;
export interface FeatureSpecSummary {
    code: string;
    displayCode?: string | undefined;
    category?: string | undefined;
    description: string;
    lifecycle: {
        announceDate?: string | undefined;
        withdrawnDate?: string | undefined;
        isWithdrawn: boolean;
    };
    supply: {
        shippingStatus?: string[] | undefined;
        shipDate?: string | undefined;
    };
    commercial: {
        topChoice: boolean;
        recommendedFeature: boolean;
        marketingTag: string[];
        eccnRestricted: boolean;
    };
    pricing: {
        unitPrice?: number | undefined;
        prices?: FeaturePriceDetail[] | undefined;
        specialBid?: boolean | undefined;
    };
    attributes?: Record<string, string> | undefined;
}
/**
 * Summarizes an upstream feature detail into structured specs.
 */
export declare function summarizeFeatureSpec(detail: UpstreamFeatureDetail): FeatureSpecSummary;
