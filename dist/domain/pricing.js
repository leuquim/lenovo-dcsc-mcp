/** Missing or explicitly unavailable prices are not a quoted zero. */
export function availablePrice(value, unavailable = false) {
    return !unavailable && typeof value === 'number' && Number.isFinite(value)
        ? Math.round(value * 100) / 100
        : null;
}
export function configurationListPrice(raw) {
    return availablePrice(raw.totalPrice, raw.priceNotAvailable === true);
}
//# sourceMappingURL=pricing.js.map