import type { RawConfiguration } from '../model/types.js';
export interface AutoDerivedSelectionProjection {
    configuration: RawConfiguration;
    /** Full server records are retained for the next derive/export. */
    autoDerivedResults: unknown[];
    applied: Array<{
        recordId?: string | undefined;
        section: string;
        code: string;
        quantity: number;
    }>;
}
/**
 * Applies the SPA's export projection for accepted FC auto-derived records.
 *
 * DCSC returns the selected result with `derived:false` and separately returns
 * the authoritative auto-derived record. The browser keeps the record and
 * marks the exact existing section result as derived before its next export.
 * Unknown, invalid, overridden, cross-configuration, and unmatched records are
 * retained but never used to invent a selection.
 */
export declare function projectAutoDerivedSelections(source: RawConfiguration, recordsValue: unknown): AutoDerivedSelectionProjection;
