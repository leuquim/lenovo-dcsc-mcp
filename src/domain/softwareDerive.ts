import type { RawConfiguration, RawPrice, RawTab } from '../model/types.js';

type Obj = Record<string, unknown>;

/**
 * The new software engine returns a partial configuration response rather
 * than the normal `{ configurations: [...] }` auto-derive envelope.
 */
export interface SoftwareDerivePatch {
  softwareTabs: RawTab[];
  softwareHipoDerivedItems: Obj[];
  totalPrices: RawPrice[];
  allHardwareFeatures: Record<string, string[]>;
  derivedHardwareFeatures: Record<string, number>;
  flashPrices: unknown[];
  errors?: unknown;
  gross?: boolean;
  rewardPriceDisplay?: unknown;
  showPrice?: boolean;
  [key: string]: unknown;
}

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrice(value: unknown): value is RawPrice {
  return isObject(value)
    && (value.priceTypeId === undefined || typeof value.priceTypeId === 'number')
    && (value.price === undefined || typeof value.price === 'number')
    && (value.priceNotAvailable === undefined || typeof value.priceNotAvailable === 'boolean');
}

function isStringArrayMap(value: unknown): value is Record<string, string[]> {
  return isObject(value)
    && Object.values(value).every((entry) => Array.isArray(entry)
      && entry.every((item) => typeof item === 'string'));
}

function isNumberMap(value: unknown): value is Record<string, number> {
  return isObject(value)
    && Object.values(value).every((entry) => typeof entry === 'number');
}

/** True only for the partial response shape captured from software auto-derive. */
export function isSoftwareDerivePatch(value: unknown): value is SoftwareDerivePatch {
  if (!isObject(value)) return false;
  return Array.isArray(value.softwareTabs)
    && value.softwareTabs.length > 0
    && value.softwareTabs.every(isObject)
    && Array.isArray(value.softwareHipoDerivedItems)
    && value.softwareHipoDerivedItems.every(isObject)
    && Array.isArray(value.totalPrices)
    && value.totalPrices.every(isPrice)
    && isStringArrayMap(value.allHardwareFeatures)
    && isNumberMap(value.derivedHardwareFeatures)
    && Array.isArray(value.flashPrices);
}

function calculateDeltaTotalPrices(
  current: RawConfiguration,
  softwarePrices: RawPrice[],
): RawPrice[] | null {
  const value = current.nonSoftwareTotalPrices;
  const nonSoftwarePrices = value === undefined ? [] : structuredClone(value);
  const firstUnavailable = Array.isArray(nonSoftwarePrices)
    && nonSoftwarePrices[0]?.priceNotAvailable === true;

  // This is the SPA's calculateDeltaTotalPrice fallback. It deliberately
  // leaves the prior aggregate untouched when prices are hidden/unavailable.
  if (!current.showPrice || !nonSoftwarePrices || firstUnavailable) {
    return structuredClone(current.totalPrices ?? null);
  }
  if (!Array.isArray(nonSoftwarePrices)) {
    throw new Error('Software auto-derive cannot reconcile nonSoftwareTotalPrices: expected an array or null.');
  }

  for (const base of nonSoftwarePrices) {
    const software = softwarePrices.find((price) => price.priceTypeId === base.priceTypeId);
    if (!software) continue;
    if (typeof base.price !== 'number' || typeof software.price !== 'number') {
      throw new Error('Software auto-derive returned a non-numeric matching price.');
    }
    base.price += software.price;
    base.priceNotAvailable = software.priceNotAvailable;
  }
  return nonSoftwarePrices;
}

function reconcileUnselectableCharacters(
  current: unknown,
  allHardwareFeatures: Record<string, string[]>,
  derivedHardwareFeatures: Record<string, number>,
): Obj[] {
  if (!Array.isArray(current)) {
    throw new Error('Software auto-derive cannot reconcile a configuration without unSelectableCharacters.');
  }

  return current.map((value) => {
    if (!isObject(value)) return structuredClone(value) as Obj;
    const name = typeof value.name === 'string' ? value.name : undefined;
    const hardwareCodes = name === undefined ? undefined : allHardwareFeatures[name];
    if (!hardwareCodes || hardwareCodes.length === 0) return structuredClone(value);

    const existing = Array.isArray(value.results)
      ? value.results.filter((result) => !isObject(result) || !result.swDerived)
      : [];
    const existingCodes = new Set(existing.flatMap((result) =>
      isObject(result) && typeof result.code === 'string' ? [result.code] : []));
    const absentHardwareCodes = new Set(hardwareCodes.filter((code) => !existingCodes.has(code)));
    const derived = Object.entries(derivedHardwareFeatures)
      .filter(([code]) => absentHardwareCodes.has(code))
      .map(([code, quantity]) => ({ code, derived: true, swDerived: true, quantity }));

    return { ...structuredClone(value), results: [...structuredClone(existing), ...derived] };
  });
}

/**
 * Reconcile the partial new-software-engine response exactly as the DCSC SPA
 * does after `isCustomizeNewSoftwareEngine=true` auto-derive.
 *
 * The input configuration and response are never mutated. Response fields
 * such as `gross`, `showPrice`, and `rewardPriceDisplay` are intentionally not
 * copied: the website reducer retains those values from the current full
 * configuration.
 */
export function applySoftwareDerivePatch(
  current: RawConfiguration,
  value: unknown,
): RawConfiguration {
  if (!isSoftwareDerivePatch(value)) {
    throw new Error('Invalid software auto-derive response: expected the partial software response shape.');
  }

  const next = structuredClone(current);
  if (!Array.isArray(next.tabs)) {
    throw new Error('Software auto-derive cannot reconcile a configuration without tabs.');
  }
  const softwareTabIndex = next.tabs.findIndex((tab) => tab.type === 'software');
  if (softwareTabIndex < 0) {
    throw new Error('Software auto-derive cannot reconcile a configuration without a software tab.');
  }

  const softwareTab = structuredClone(value.softwareTabs[0]!);
  (softwareTab as Obj).hideOnPage = false;
  next.tabs[softwareTabIndex] = softwareTab;

  const priorHipo = Array.isArray(next.hipoDerivedItems)
    ? next.hipoDerivedItems.filter((item) => isObject(item) && Boolean(item.derivedByHw))
    : [];
  next.hipoDerivedItems = [
    ...structuredClone(priorHipo),
    ...structuredClone(value.softwareHipoDerivedItems),
  ];
  next.flashPrices = structuredClone(value.flashPrices);
  next.unSelectableCharacters = reconcileUnselectableCharacters(
    next.unSelectableCharacters,
    value.allHardwareFeatures,
    value.derivedHardwareFeatures,
  );
  next.totalPrices = calculateDeltaTotalPrices(next, value.totalPrices);
  next.totalPrice = next.totalPrices?.[0]?.price ?? null;
  next.priceNotAvailable = next.totalPrices?.[0]?.priceNotAvailable ?? false;
  return next;
}
