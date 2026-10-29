/**
 * Narrow structural types over the raw DCSC configuration payload.
 *
 * These are deliberately NOT a full schema. The raw response has ~94
 * top-level fields and we consume a handful; modelling all of it would be
 * both wasted effort and a drift liability. Everything here is optional
 * because the payload varies by product family.
 *
 * Critical invariant: the raw object is retained verbatim in the session and
 * is what gets posted back on mutation. These types describe it; they never
 * replace it.
 */
export {};
//# sourceMappingURL=types.js.map