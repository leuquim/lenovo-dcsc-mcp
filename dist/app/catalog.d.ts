import type { Runtime } from './runtime.js';
export declare const CATEGORY_KINDS: readonly ['detail', 'services', 'caseStudies', 'conditions', 'products', 'topChoiceCountry', 'productFunctions', 'displayOrders', 'staticFeatures'];
export type CategoryKind = (typeof CATEGORY_KINDS)[number];
export declare function settingsGet(rt: Runtime, args: {
    localeQuery?: string | undefined;
    limit?: number | undefined;
}): Promise<{
    locale: {
        country: string;
        geo: string;
        language: string;
        currency: string;
    };
    withdrawnSince: string | null;
    solutionModes: import("../domain/context.js").SolutionModeInfo[];
    locales?: Record<string, unknown>;
}>;
export declare function settingsSet(rt: Runtime, args: {
    country?: string | undefined;
    language?: string | undefined;
    withdrawnSince?: string | undefined;
}): Promise<{
    locale: {
        country: string;
        geo: string;
        language: string;
        currency: string;
    };
    withdrawnSince: string | null;
    scope: string;
    persisted: boolean;
    priceType: string;
    note: string;
}>;
interface Paging {
    offset?: number | undefined;
    limit?: number | undefined;
    path?: string[] | undefined;
}
interface Fingerprinted {
    expectedCatalogFingerprint?: string | undefined;
}
export type SearchArgs = ({
    kind: 'products';
    query: string;
    type?: 'CTO' | 'LFO' | undefined;
    solutionMode?: string | undefined;
} & Paging & Fingerprinted) | ({
    kind: 'tree';
    categoryPath?: string[] | undefined;
    categoryOffset?: number | undefined;
    detailPath?: string[] | undefined;
    solutionMode?: string | undefined;
} & Omit<Paging, 'path'> & Fingerprinted) | ({
    kind: 'parts';
    query: string;
    types?: Array<'SOFTWARE' | 'SERVICE' | 'HARDWARE'> | undefined;
    mode?: 'CTO' | 'LFO' | undefined;
    includeSupplyStatus?: boolean | undefined;
    supplyStatusType?: string | undefined;
    solutionMode?: string | undefined;
} & Paging & Fingerprinted) | ({
    kind: 'preconfigured';
} & Paging & Fingerprinted) | ({
    kind: 'sids';
    categoryId: string;
    query?: string | undefined;
    tceFlag?: boolean | undefined;
} & Omit<Paging, 'path'>) | ({
    kind: 'serviceProducts';
    query: string;
    solutionMode?: string | undefined;
} & Paging & Fingerprinted) | ({
    kind: 'software';
    productCode: string;
    mode?: 'CTO' | 'LFO' | undefined;
    solutionMode?: string | undefined;
} & Paging & Fingerprinted) | ({
    kind: 'specialty';
    catalog?: 'lvr' | 'converged' | 'promotion' | undefined;
    categoryId?: string | undefined;
    subType?: 'hierarchies' | 'sid' | 'lfo' | 'option' | undefined;
    query?: string | undefined;
    solutionMode?: string | undefined;
} & Paging);
export declare function searchCatalog(rt: Runtime, args: SearchArgs): Promise<unknown>;
export type CategoryArgs = ({
    kind: 'detail';
    categoryId: string;
    isTruScale?: boolean | undefined;
} & Paging) | ({
    kind: 'services';
    solutionMode?: string | undefined;
} & Paging) | ({
    kind: 'caseStudies';
    caseStudyId?: string | undefined;
} & Paging) | ({
    kind: 'conditions';
    categoryId: string;
} & Paging) | ({
    kind: 'products';
    categoryId: string;
    conditions?: string | undefined;
    pageNumber?: number | undefined;
    pageSize?: number | undefined;
    topChoice?: boolean | undefined;
} & Paging) | ({
    kind: 'topChoiceCountry';
} & Paging) | ({
    kind: 'productFunctions' | 'displayOrders';
    ctoCode: string;
} & Paging) | ({
    kind: 'staticFeatures';
    ctoCode: string;
    tab: string;
} & Paging);
export declare function categoryInfo(rt: Runtime, args: CategoryArgs): Promise<unknown>;
export declare function subTabRecommendations(rt: Runtime, args: {
    session?: string | undefined;
    productCode?: string | undefined;
    mode?: string | undefined;
    solutionMode?: string | undefined;
}): Promise<{
    productCode: string;
    count: number;
    recommendations: import("../domain/recommendations.js").SubTabRecommendation[];
}>;
export declare function featureSpecs(rt: Runtime, args: {
    session?: string | undefined;
    ctoCode?: string | undefined;
    codes: string[];
    solutionMode?: string | undefined;
}): Promise<{
    ctoCode: string;
    count: number;
    features: import("../domain/featureDetails.js").FeatureSpecSummary[];
}>;
export declare function smartRecommendations(rt: Runtime, args: {
    type?: 'summary' | 'smart-lfo' | undefined;
    session?: string | undefined;
    ctoCode?: string | undefined;
    country?: string | undefined;
    solutionMode?: string | undefined;
}): Promise<{
    type: string;
    country: string;
    ctoCode: string;
    result: import("../domain/recommendations.js").SmartLfoResponse;
} | {
    country?: never;
    type: string;
    ctoCode: string | undefined;
    result: unknown;
}>;
export {};
