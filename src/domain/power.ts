import type { RawConfiguration } from '../model/types.js';

/**
 * Power and thermal figures, when DCSC supplies a numeric report.
 *
 * There is a /powercalculation/powercalculate endpoint, but it is not needed:
 * supported launch and autoDerive responses carry a computed
 * `powerReportResponse` for the configuration as selected. Some current
 * products omit that report; callers must preserve unavailable metrics. For AI factory work these numbers are the
 * binding design constraint long before price is — a single 8-GPU node draws
 * more than 10 kW, so rack and room capacity, not budget, decides the layout.
 */

export interface PowerBand {
  /** Watts, amps, VA or BTU/hr depending on the field. */
  idle: number;
  max: number;
  /** DCSC's expected steady-state figure at the configured load factor. */
  loadFactor: number;
  worst: number;
}

export interface PowerReport {
  inputPowerW: PowerBand;
  inputCurrentA: PowerBand;
  apparentPowerVA: PowerBand;
  heatBtuHr: PowerBand;
  operatingVoltage?: string | undefined;
  /** Percent of max load DCSC assumes for the loadFactor column. */
  loadFactorPct?: number | undefined;
  powerPolicy?: { key?: string | undefined; description?: string | undefined } | undefined;
  powerUtilizationPct?: number | undefined;
  warnings: string[];
}

type Obj = Record<string, unknown>;

function band(v: unknown): PowerBand | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Obj;
  const idle = num(o['idle']);
  const max = num(o['max']);
  const loadFactor = num(o['loadFactorResult']);
  const worst = num(o['worst']);
  if (idle === undefined || max === undefined || loadFactor === undefined || worst === undefined) return undefined;
  return { idle, max, loadFactor, worst };
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Pulls the power report out of a raw configuration, if DCSC supplied one. */
export function extractPowerReport(raw: RawConfiguration): PowerReport | undefined {
  const container = raw['powerReportResponse'];
  if (typeof container !== 'object' || container === null) return undefined;
  const report = (container as Obj)['powerReport'];
  if (typeof report !== 'object' || report === null) return undefined;
  const r = report as Obj;
  if (r['empty'] === true) return undefined;

  const inputPowerW = band(r['inputPower']);
  const inputCurrentA = band(r['inputCurrent']);
  const apparentPowerVA = band(r['apparentPower']);
  const heatBtuHr = band(r['heatGeneration']);
  // The public report is fully numeric: a partial report must not invent zero
  // heat/current/power values that would then be used in aggregate sizing.
  if (!inputPowerW || !inputCurrentA || !apparentPowerVA || !heatBtuHr) return undefined;

  const policy = r['powerPolicy'];
  const warnings = Array.isArray(r['warningMessages'])
    ? r['warningMessages'].filter((m): m is string => typeof m === 'string')
    : [];

  return {
    inputPowerW,
    inputCurrentA,
    apparentPowerVA,
    heatBtuHr,
    operatingVoltage: typeof r['operatingVoltage'] === 'string' ? r['operatingVoltage'] : undefined,
    loadFactorPct: num(r['loadFactor']),
    powerPolicy:
      typeof policy === 'object' && policy !== null
        ? {
            key: typeof (policy as Obj)['key'] === 'string' ? ((policy as Obj)['key'] as string) : undefined,
            description:
              typeof (policy as Obj)['description'] === 'string'
                ? ((policy as Obj)['description'] as string)
                : undefined,
          }
        : undefined,
    powerUtilizationPct: num(r['powerUtilization']),
    warnings,
  };
}

function addBands(a: PowerBand, b: PowerBand, times = 1): PowerBand {
  return {
    idle: a.idle + b.idle * times,
    max: a.max + b.max * times,
    loadFactor: a.loadFactor + b.loadFactor * times,
    worst: a.worst + b.worst * times,
  };
}

const ZERO: PowerBand = { idle: 0, max: 0, loadFactor: 0, worst: 0 };

export interface AggregatedPower {
  inputPowerW: PowerBand;
  inputCurrentA: PowerBand;
  apparentPowerVA: PowerBand;
  heatBtuHr: PowerBand;
  /** Convenience for sizing conversations. */
  maxKW: number;
  worstKW: number;
  expectedKW: number;
  contributors: number;
}

/**
 * Sums power across configurations, honouring each one's unit quantity.
 *
 * Currents are summed too, which is only meaningful when everything sits on the
 * same voltage — callers should report the voltage alongside.
 */
export interface DensityAdvisory {
  maxKW: number;
  level: 'standard' | 'high-density' | 'containment-required' | 'liquid-recommended';
  message: string;
}

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
export function assessRackDensity(
  maxKW: number,
  cooling: 'air' | 'direct water' | 'unknown' = 'unknown',
): DensityAdvisory | undefined {
  if (cooling === 'direct water') return undefined;
  if (maxKW <= 15) {
    return { maxKW, level: 'standard', message: 'Within conventional air-cooled rack density.' };
  }
  if (maxKW <= 30) {
    return {
      maxKW,
      level: 'high-density',
      message:
        `~${maxKW} kW per rack is high density for air. Expect to need hot-aisle or cold-aisle ` +
        'containment and verified per-rack airflow; many general-purpose halls cap out below this.',
    };
  }
  if (maxKW <= 50) {
    return {
      maxKW,
      level: 'containment-required',
      message:
        `~${maxKW} kW per rack exceeds what conventional air cooling removes (typically 15-30 kW). ` +
        'A rear-door heat exchanger or full containment is required, and many sites cannot supply ' +
        'this per rack at all. Compare a direct-water-cooled node before committing.',
    };
  }
  return {
    maxKW,
    level: 'liquid-recommended',
    message:
      `~${maxKW} kW per rack is beyond practical air cooling. Direct water cooling is the realistic ` +
      'option; if the site is air-only, spread the nodes across more racks instead.',
  };
}

export function aggregatePower(
  entries: Array<{ report: PowerReport; quantity: number }>,
): AggregatedPower {
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

  const round = (n: number) => Math.round(n * 10) / 10;
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
