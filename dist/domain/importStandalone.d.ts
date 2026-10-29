import type { ProductServiceState, StandaloneSoftwareState } from './standalone.js';
type Obj = Record<string, unknown>;
export declare const SERVICE_METADATA_REFRESH_WARNING = "DCSC import restores the complete service catalog but strips exact derive-section metadata for unselected services. Use dcsc_services_launch with workspace and refresh=true before choosing a different service; the imported selection remains inspectable, quantity-editable and exportable.";
export interface StandaloneImportDiagnostics {
    missingParts: unknown[];
    removedParts: unknown[];
    warnings: string[];
}
export interface ImportedSoftwareState {
    kind: 'software';
    state: StandaloneSoftwareState;
    /** Complete object returned by /multiple/cfxml_import. */
    envelope: Obj;
    diagnostics: StandaloneImportDiagnostics;
}
export interface ImportedProductServiceState {
    kind: 'service';
    state: ProductServiceState;
    /** Complete object returned by /multiple/cfxml_import. */
    envelope: Obj;
    diagnostics: StandaloneImportDiagnostics;
}
export type StandaloneImportResult = ImportedSoftwareState | ImportedProductServiceState;
/**
 * Adds the live browse hierarchy to imported software without silently
 * repricing its selected lines. Imported unit/extended prices remain the
 * authority while that imported SKU remains selected.
 */
export declare function reconcileImportedSoftwareCatalog(imported: StandaloneSoftwareState, catalog: StandaloneSoftwareState): StandaloneSoftwareState;
/**
 * Restores the two standalone response shapes returned by DCSC's normal CFXML
 * import route. A software result may also contain ordinary configurations;
 * callers should restore both from the same preserved envelope. Returns
 * undefined only when the response contains no standalone state.
 */
export declare function parseStandaloneImportResponse(raw: unknown): StandaloneImportResult | undefined;
export {};
