import type { RawConfiguration, RawPrice, RawTab } from '../model/types.js';
import { type Obj } from '../util/coerce.js';
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
/** True only for the partial response shape captured from software auto-derive. */
export declare function isSoftwareDerivePatch(value: unknown): value is SoftwareDerivePatch;
/**
 * Reconcile the partial new-software-engine response exactly as the DCSC SPA
 * does after `isCustomizeNewSoftwareEngine=true` auto-derive.
 *
 * The input configuration and response are never mutated. Response fields
 * such as `gross`, `showPrice`, and `rewardPriceDisplay` are intentionally not
 * copied: the website reducer retains those values from the current full
 * configuration.
 */
export declare function applySoftwareDerivePatch(current: RawConfiguration, value: unknown): RawConfiguration;
