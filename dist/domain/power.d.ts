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
    powerPolicy?: {
        key?: string | undefined;
        description?: string | undefined;
    } | undefined;
    powerUtilizationPct?: number | undefined;
    warnings: string[];
}
/** Pulls the power report out of a raw configuration, if DCSC supplied one. */
export declare function extractPowerReport(raw: RawConfiguration): PowerReport | undefined;
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
export declare function assessRackDensity(maxKW: number, cooling?: 'air' | 'direct water' | 'unknown'): DensityAdvisory | undefined;
export declare function aggregatePower(entries: Array<{
    report: PowerReport;
    quantity: number;
}>): AggregatedPower;
