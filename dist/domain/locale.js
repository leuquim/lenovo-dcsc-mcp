export async function fetchLocales(http, ctx) {
    const res = await http.send({
        endpoint: 'locales',
        method: 'GET',
        path: '/locales',
        responseKind: 'json',
        timeoutClass: 'fast',
        requiresSolution: false,
        ctx,
    });
    const out = [];
    for (const row of res.raw ?? []) {
        if (typeof row !== 'object' || row === null)
            continue;
        const o = row;
        const countryCode = o['countryCode'];
        if (typeof countryCode !== 'string')
            continue;
        const languages = Array.isArray(o['languages'])
            ? o['languages']
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
export function localeFromOption(opt, languageCode) {
    const lang = (languageCode
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
//# sourceMappingURL=locale.js.map