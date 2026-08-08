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
  languages: Array<{ languageCode: string; languageName: string; defaulted: boolean }>;
  countryInvalid: boolean;
}

export async function fetchLocales(
  http: DcscHttpClient,
  ctx: RequestCtx,
): Promise<LocaleOption[]> {
  const res = await http.send({
    endpoint: 'locales',
    method: 'GET',
    path: '/locales',
    responseKind: 'json',
    timeoutClass: 'fast',
    requiresSolution: false,
    ctx,
  });

  const out: LocaleOption[] = [];
  for (const row of (res.raw as unknown[]) ?? []) {
    if (typeof row !== 'object' || row === null) continue;
    const o = row as Record<string, unknown>;
    const countryCode = o['countryCode'];
    if (typeof countryCode !== 'string') continue;
    const languages = Array.isArray(o['languages'])
      ? (o['languages'] as Array<Record<string, unknown>>)
          .map((l) => ({
            languageCode: String(l['languageCode'] ?? ''),
            languageName: String(l['languageName'] ?? ''),
            defaulted: l['defaulted'] === true,
          }))
          .filter((l) => l.languageCode)
      : [];
    out.push({
      countryCode: countryCode.toUpperCase(),
      countryName: String(o['countryName'] ?? countryCode),
      currency: String(o['currency'] ?? 'USD').toUpperCase(),
      region: String(o['region'] ?? ''),
      languages,
      countryInvalid: o['countryInvalid'] === true,
    });
  }
  return out;
}

/**
 * Builds a Locale for the HTTP preamble from a /locales row.
 * Prefers the defaulted language, else the first listed, else "en".
 */
export function localeFromOption(opt: LocaleOption, languageCode?: string): Locale {
  const lang =
    (languageCode
      ? opt.languages.find((l) => l.languageCode.toLowerCase() === languageCode.toLowerCase())
      : undefined) ??
    opt.languages.find((l) => l.defaulted) ??
    opt.languages[0];
  return {
    country: opt.countryCode,
    geo: opt.region || 'NA',
    language: lang?.languageCode ?? 'en',
    currency: opt.currency,
  };
}
