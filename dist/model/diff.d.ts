import type { ConfigIndex } from './index.js';
import type { RawConfiguration } from './types.js';
import { type Constraint } from './project.js';
/**
 * Diff between two configuration revisions.
 *
 * Computed from our own before/after selection sets rather than DCSC's
 * `addedParts` / `removedParts` arrays: those reflect only the last internal
 * reconciliation step and miss changes made earlier in the same pass.
 *
 * A mutation returns this instead of the tree — roughly 1 KB for a change that
 * can rewrite a third of the configuration.
 */
export interface PartChange {
    code: string;
    desc: string;
    qty?: number;
    from?: number;
    to?: number;
    /** True when DCSC made this change itself rather than the caller asking. */
    auto?: boolean;
}
export interface Replacement {
    from: string;
    to: string;
    desc: string;
    section: string;
}
export interface ConfigDiff {
    added: PartChange[];
    removed: PartChange[];
    /** Swaps within one section — the expected result of a choose-one change. */
    replaced: Replacement[];
    quantityChanged: PartChange[];
    price: {
        before: number | null;
        after: number | null;
        delta: number | null;
        currency: string;
    };
    constraints: Constraint[];
    autoChanges: number;
}
export declare function diffConfigurations(opts: {
    beforeIndex: ConfigIndex;
    afterIndex: ConfigIndex;
    beforeRaw: RawConfiguration;
    afterRaw: RawConfiguration;
    currency: string;
    /** Codes the caller explicitly asked for; everything else is flagged auto. */
    requested: ReadonlySet<string>;
}): ConfigDiff;
