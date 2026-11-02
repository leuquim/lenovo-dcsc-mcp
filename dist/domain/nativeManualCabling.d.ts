export { countNativePhysicalCables } from './cableQuantity.js';
import { type ManualCablingInput, type ManualConnectionEndpointPatch } from './manualCabling.js';
import type { CableOption } from './fabric.js';
import { type Obj } from '../util/coerce.js';
/** Distance results include other speeds and breakout cables; intersect with the fabric catalog. */
export declare function filterNativeManualCableChoices(distance: unknown, topology: string, catalog: readonly CableOption[], connectionType?: 'point-to-point' | 'breakout-4'): Obj;
/** The SPA preserves manual source ports in selectedTopologies before derivation. */
export declare function selectNativeManualSourcePort(configuration: Obj, row: Obj): Obj;
/** Resolve shared topology ownership without replacing a physical graph endpoint. */
export declare function nativeManualSourceConfigurationId(physicalId: string, mapping?: ManualCablingInput['physicalTemplateIds']): string;
/** Native updateSelectedTopologiesById writes shared topology state for all bindings. */
export declare function selectNativeManualSourceGroup(configurations: readonly Obj[], dependency: unknown, row: Obj, mapping?: ManualCablingInput['physicalTemplateIds']): Map<string, Obj>;
export interface NativeManualConnectionRequest {
    network: string;
    topology: string;
    source: ManualConnectionEndpointPatch;
    destination: ManualConnectionEndpointPatch;
    cablePart: string;
    connectionType?: 'point-to-point' | 'breakout-4' | undefined;
    pinExistingRoutes?: boolean;
}
/** Opt-in native ownership change: AUTO rows otherwise get regenerated. */
export declare function seedNativeManualRoutes(connections: readonly unknown[], pin: boolean): {
    rows: Obj[];
    pinnedConnectionCount: number;
};
/** Lenovo silently regenerates rejected seeds; HTTP success is insufficient. */
export declare function assertNativeConnectionsRetained(requested: readonly unknown[], accepted: readonly unknown[]): void;
/** Cover graph usage without consuming cables the user selected as spares. */
export declare function planNativeManualCableSelection(input: ManualCablingInput, row: Obj): {
    configurationId: string;
    physicalDestinationIds: any[];
    section: string;
    code: string;
    previousQuantity: number;
    requiredQuantity: number;
    quantity: number;
    configurationIds?: string[];
};
/** Preserve explicit quantities for imported manual routes across layout recalculation. */
export declare function importedManualCableSelections(input: ManualCablingInput): {
    configurationId: string;
    physicalDestinationIds: any[];
    section: string;
    code: string;
    previousQuantity: number;
    requiredQuantity: number;
    quantity: number;
    configurationIds?: string[];
}[];
/** Rack feature rows override configuration quantities during native workspace derive. */
export declare function stageNativeManualCableQuantity(input: ManualCablingInput, plan: Omit<ReturnType<typeof planNativeManualCableSelection>, 'physicalDestinationIds'> & {
    physicalDestinationIds?: string[];
    retainAsSpare?: boolean;
}, fallback?: Pick<ManualCablingInput, 'rackArea' | 'nonRackArea'>): {
    rackArea: import("./rack.js").RackObject[];
    nonRackArea: import("./rack.js").RackObject[];
};
/** Build the complete native row from physical ports and an authoritative distance response. */
export declare function stageNativeManualConnection(input: ManualCablingInput, request: NativeManualConnectionRequest & {
    distance: unknown;
}): Obj;
