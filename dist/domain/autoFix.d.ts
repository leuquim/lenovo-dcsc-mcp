import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import type { RawConfiguration } from '../model/types.js';
export interface AutoFixCandidate {
    tabTitle: string;
    characterName: string;
    characterDesc: string;
}
export interface AutoFixSelectionItem {
    featureCode: string;
    quantity: number;
}
export interface AutoFixSectionSelection {
    name: string;
    results: AutoFixSelectionItem[];
}
export interface AutoFixResponse {
    ctoCode: string;
    sections: Array<Record<string, unknown>>;
    hipos?: unknown[] | undefined;
    errors?: unknown[] | null | undefined;
    notices?: Array<{
        message: string;
        severity?: string | undefined;
    }> | null | undefined;
    message?: string | undefined;
    autoFixResult: 'FIX_SUCCESS' | 'FIX_FAIL' | string;
    pciWizard?: unknown | undefined;
    tceEnabled?: boolean | undefined;
}
export interface AutoFixResult {
    applied: boolean;
    sectionsChanged: string[];
    notices: Array<{
        message: string;
        severity?: string | undefined;
    }>;
    errors: unknown[] | null;
    message: string;
}
/**
 * Discovers candidate hardware sections eligible for auto-fix on a CTO product.
 *
 * Upstream route: POST /api/cto/hardware/autoFix/config?cto=${ctoCode}&country_or_region=${country}&language=${language}&currency=${currency}
 * Returns list of eligible sections with tab title, character name and description.
 */
export declare function inspectAutoFixCandidates(http: DcscHttpClient, ctoCode: string, ctx: RequestCtx): Promise<AutoFixCandidate[]>;
/**
 * Extracts current section selections from a raw configuration tree.
 *
 * Formats selections into the wire shape expected by POST /cto/hardware/autoFix.
 */
export declare function buildAutoFixCurrentSelections(raw: RawConfiguration): AutoFixSectionSelection[];
export interface AutoFixConfiguration {
    configurationId: string;
    showExpressMode: boolean;
    selectedTceAudience?: unknown;
}
/**
 * Executes hardware auto-fix against DCSC to resolve rule validation errors.
 *
 * Upstream route: POST /api/cto/hardware/autoFix?country_or_region=${country}&language=${language}&currency=${currency}
 */
export declare function executeAutoFix(http: DcscHttpClient, ctoCode: string, requiredSections: string[], currentSelections: AutoFixSectionSelection[], ctx: RequestCtx, configuration: AutoFixConfiguration): Promise<AutoFixResponse>;
/**
 * Merges updated section selections from auto-fix into the configuration tree.
 *
 * Matches sections by `name`, replaces their results with the resolved selections,
 * restores feature metadata (description, ctoCode, type, cost) from existing section features,
 * and clears resolved section errors.
 */
export declare function applyAutoFixSections(raw: RawConfiguration, fixedSections: Array<Record<string, unknown>>): {
    configuration: RawConfiguration;
    sectionsChanged: string[];
};
export interface ErrorCustomizeInput {
    mode?: 'cto' | 'lfo' | undefined;
    configurations: unknown[];
}
/**
 * Dispatches batch error customize with auto derive to either CTO or LFO endpoints.
 *
 * Upstream routes:
 *   POST /api/ctos/errorCustomizeWithAutoDerive
 *   POST /api/lfos/errorCustomizeWithAutoDerive
 */
export declare function errorCustomizeWithAutoDerive(http: DcscHttpClient, ctx: RequestCtx, input: ErrorCustomizeInput): Promise<unknown[]>;
