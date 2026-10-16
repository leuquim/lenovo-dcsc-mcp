import type { RawConfiguration } from '../model/types.js';

/** Missing or explicitly unavailable prices are not a quoted zero. */
export function availablePrice(value: unknown, unavailable = false): number | null {
  return !unavailable && typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 100) / 100
    : null;
}

export function configurationListPrice(raw: RawConfiguration): number | null {
  return availablePrice(raw.totalPrice, raw.priceNotAvailable === true);
}
