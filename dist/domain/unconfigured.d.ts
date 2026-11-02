import type { RawConfiguration, RawPrice } from '../model/types.js';
/** The native lazy loader merges selections by section identity, never array order. */
export declare function hydrateUnconfiguredCatalog(current: RawConfiguration, catalog: RawConfiguration): RawConfiguration;
/** Mirrors changeUnconfiguredSectionSelection; no hardware derive is involved. */
export declare function stageUnconfiguredSelection(raw: RawConfiguration, change: {
    sectionName: string;
    code: string;
    quantity: number;
}): RawConfiguration;
/** Native Unconfigured selections are client-owned and omitted from autoDerive. */
export declare function unconfiguredProducts(raw: RawConfiguration): {
    code: string;
    description: string;
    quantity: number;
    unitPrice: number | null;
    price: number | null;
    prices: RawPrice[];
    priceNotAvailable: boolean;
}[];
/** Add/remove only captured per-price-type amounts; unknown prices stay unknown. */
export declare function adjustUnconfiguredPrices(prices: RawPrice[] | null | undefined, raw: RawConfiguration, sign: 1 | -1): RawPrice[] | null | undefined;
export declare function preserveUnconfiguredSelections(current: RawConfiguration, derived: RawConfiguration): RawConfiguration;
