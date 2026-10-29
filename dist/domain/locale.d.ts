import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import type { Locale } from '../config/schema.js';
/**
 * Country / language / currency catalogue from GET /locales.
 *
 * Locale is a single cohesive object: mismatched geo/country pairings produce
 * DCSC 500s, so callers pick a full row rather than free-form fields.
 */
export interface LocaleOption {
    countryCode: string;
    countryName: string;
    currency: string;
    region: string;
    languages: Array<{
        languageCode: string;
        languageName: string;
        defaulted: boolean;
    }>;
    countryInvalid: boolean;
}
export declare function fetchLocales(http: DcscHttpClient, ctx: RequestCtx): Promise<LocaleOption[]>;
/**
 * Builds a Locale for the HTTP preamble from a /locales row.
 * Prefers the defaulted language, else the first listed, else "en".
 */
export declare function localeFromOption(opt: LocaleOption, languageCode?: string): Locale;
