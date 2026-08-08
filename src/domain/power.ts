import type { RawConfiguration } from '../model/types.js';

/**
 * Power and thermal figures, which DCSC returns with every configuration.
 *
 * There is a /powercalculation/powercalculate endpoint, but it is not needed:
 * launch and autoDerive already carry a fully computed `powerReportResponse`
 * for the configuration as selected. For AI factory work these numbers are the
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

function band(v: unknown): PowerBand {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Obj;
  return {
    idle: num(o['idle']) ?? 0,
    max: num(o['max']) ?? 0,
    loadFactor: num(o['loadFactorResult']) ?? 0,
    worst: num(o['worst']) ?? 0,
  };
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
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

  const policy = r['powerPolicy'];
  const warnings = Array.isArray(r['warningMessages'])
    ? r['warningMessages'].filter((m): m is string => typeof m === 'string')
    : [];

  return {
    inputPowerW: band(r['inputPower']),
    inputCurrentA: band(r['inputCurrent']),
    apparentPowerVA: band(r['apparentPower']),
    heatBtuHr: band(r['heatGeneration']),
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
