import type { RawConfiguration } from '../model/types.js';
import { type Obj } from '../util/coerce.js';
export interface PowerControlChanges {
    voltage?: string | undefined;
    loadFactor?: number | undefined;
    powerPolicy?: string | number | undefined;
}
/** IDs are the website selector values, not a new voltage vocabulary. */
export declare function inspectPowerControls(raw: RawConfiguration): {
    available: boolean;
    current: {
        voltage: string | null;
        loadFactor: number | null;
        powerPolicy: {} | null;
    };
    voltages: {
        id: string;
        voltage: Obj;
    }[];
    policies: {
        value: unknown;
        description: unknown;
        key: unknown;
    }[];
    loadFactorRange: {
        min: number;
        max: number;
        step: number;
    };
};
/** Stage the power dialog's client-held fields without changing committed state. */
export declare function stagePowerControls(raw: RawConfiguration, changes: PowerControlChanges): RawConfiguration;
/** Captured powerReportQuerySelector; quantity is not multiplied into a unit report. */
export declare function buildPowerCalculationRequest(raw: RawConfiguration): Obj[];
/** Native Save updates both retained unselectable shapes; never synthesizes a selection. */
export declare function acceptPowerCalculation(draft: RawConfiguration, response: unknown): RawConfiguration;
