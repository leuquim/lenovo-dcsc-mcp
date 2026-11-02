import { numericValue } from '../util/coerce.js';
/** The website exports the saved report's load factor, including zero. */
export function powerLoadFactor(raw) {
    const container = raw.powerReportResponse;
    const report = container && typeof container === 'object' ? container['powerReport'] : undefined;
    return numericValue(report && typeof report === 'object' ? report['loadFactor'] : undefined) ?? numericValue(raw.loadFactor);
}
function band(v) {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
        return undefined;
    const o = v;
    const idle = numericValue(o['idle']);
    const max = numericValue(o['max']);
    const loadFactor = numericValue(o['loadFactorResult']);
    const worst = numericValue(o['worst']);
    if (idle === undefined || max === undefined || loadFactor === undefined || worst === undefined)
        return undefined;
    return { idle, max, loadFactor, worst };
}
/** Pulls the power report out of a raw configuration, if DCSC supplied one. */
export function extractPowerReport(raw) {
    const container = raw['powerReportResponse'];
    if (typeof container !== 'object' || container === null)
        return undefined;
    const report = container['powerReport'];
    if (typeof report !== 'object' || report === null)
        return undefined;
    const r = report;
    if (r['empty'] === true)
        return undefined;
    const inputPowerW = band(r['inputPower']);
    const inputCurrentA = band(r['inputCurrent']);
    const apparentPowerVA = band(r['apparentPower']);
    const heatBtuHr = band(r['heatGeneration']);
    // The public report is fully numeric: a partial report must not invent zero
    // heat/current/power values that would then be used in aggregate sizing.
    if (!inputPowerW || !inputCurrentA || !apparentPowerVA || !heatBtuHr)
        return undefined;
    const policy = r['powerPolicy'];
    const warnings = Array.isArray(r['warningMessages'])
        ? r['warningMessages'].filter((m) => typeof m === 'string')
        : [];
    return {
        inputPowerW,
        inputCurrentA,
        apparentPowerVA,
        heatBtuHr,
        operatingVoltage: typeof r['operatingVoltage'] === 'string' ? r['operatingVoltage'] : undefined,
        loadFactorPct: numericValue(r['loadFactor']),
        powerPolicy: typeof policy === 'object' && policy !== null
            ? {
                key: typeof policy['key'] === 'string' ? policy['key'] : undefined,
                description: typeof policy['description'] === 'string'
                    ? policy['description']
                    : undefined,
            }
            : undefined,
        powerUtilizationPct: numericValue(r['powerUtilization']),
        warnings,
    };
}
function addBands(a, b, times = 1) {
    return {
        idle: a.idle + b.idle * times,
        max: a.max + b.max * times,
        loadFactor: a.loadFactor + b.loadFactor * times,
        worst: a.worst + b.worst * times,
    };
}
const ZERO = { idle: 0, max: 0, loadFactor: 0, worst: 0 };
/**
 * Flags rack power density that a room cannot actually cool.
 *
 * DCSC prices and places a rack it has no intention of cooling: four 8-GPU
 * air-cooled nodes fit a 42U cabinet and draw ~47 kW, which is roughly double
 * what a conventional hot-aisle/cold-aisle room removes with air. Nothing in
 * the configurator says so, and the number that decides feasibility is this
 * one, not the price.
 *
 * Bands are industry-typical rather than Lenovo-published, so this advises and
 * never blocks. Liquid-cooled hardware carries its own heat out and is exempt.
 */
export function assessRackDensity(maxKW, cooling = 'unknown') {
    if (cooling === 'direct water')
        return undefined;
    if (maxKW <= 15) {
        return { maxKW, level: 'standard', message: 'Within conventional air-cooled rack density.' };
    }
    if (maxKW <= 30) {
        return {
            maxKW,
            level: 'high-density',
            message: `~${maxKW} kW per rack is high density for air. Expect to need hot-aisle or cold-aisle ` +
                'containment and verified per-rack airflow; many general-purpose halls cap out below this.',
        };
    }
    if (maxKW <= 50) {
        return {
            maxKW,
            level: 'containment-required',
            message: `~${maxKW} kW per rack exceeds what conventional air cooling removes (typically 15-30 kW). ` +
                'A rear-door heat exchanger or full containment is required, and many sites cannot supply ' +
                'this per rack at all. Compare a direct-water-cooled node before committing.',
        };
    }
    return {
        maxKW,
        level: 'liquid-recommended',
        message: `~${maxKW} kW per rack is beyond practical air cooling. Direct water cooling is the realistic ` +
            'option; if the site is air-only, spread the nodes across more racks instead.',
    };
}
export function aggregatePower(entries) {
    let inputPowerW = ZERO;
    let inputCurrentA = ZERO;
    let apparentPowerVA = ZERO;
    let heatBtuHr = ZERO;
    for (const { report, quantity } of entries) {
        const q = quantity > 0 ? quantity : 1;
        inputPowerW = addBands(inputPowerW, report.inputPowerW, q);
        inputCurrentA = addBands(inputCurrentA, report.inputCurrentA, q);
        apparentPowerVA = addBands(apparentPowerVA, report.apparentPowerVA, q);
        heatBtuHr = addBands(heatBtuHr, report.heatBtuHr, q);
    }
    const round = (n) => Math.round(n * 10) / 10;
    return {
        inputPowerW,
        inputCurrentA,
        apparentPowerVA,
        heatBtuHr,
        maxKW: round(inputPowerW.max / 1000),
        worstKW: round(inputPowerW.worst / 1000),
        expectedKW: round(inputPowerW.loadFactor / 1000),
        contributors: entries.length,
    };
}
//# sourceMappingURL=power.js.map