import { type RackConfigurationWire, type RackObject } from './rack.js';
import { type Obj } from '../util/coerce.js';
export interface SwitchCalculationRequest extends Obj {
    rackArea: RackObject[];
    nonRackArea: RackObject[];
    configurations: RackObject[];
    clusterPreference: RackObject[];
    floorPreference: RackObject;
    powerPreference: RackObject[];
    floorItems: RackObject[];
    cloneRackMapping: RackObject;
    storageConnectionNetworks: RackObject[];
    switchMap: RackObject[];
    cloneDependency: RackObject;
}
export interface SwitchRequirement {
    rackId: string;
    rackCode: string;
    rackSize: number;
    option: string;
    rawCode: string;
    type: 'switch';
    network: string;
    usage: string;
    quantity: number;
    position: number;
    size: number;
    raw: RackObject;
}
export interface GeneratedSwitch {
    id: string;
    rackId: string;
    code: string;
    name: string;
    network: string;
    usage: string;
    requestedPosition: number;
    /** Full launch DTO with the client identity and browser-generated name attached. */
    configuration: RackObject;
    /** Compact configuration posted to `/ctos/racks/customize`. */
    wireConfiguration: RackConfigurationWire;
    /** Rack item posted before DCSC authoritatively repositions it. */
    rackItem: RackObject;
    /** Browser shape uses `type`, while the calculation response calls it `usage`. */
    switchMapEntry: {
        id: string;
        network: string;
        type: string;
        code: string;
    };
    cloneDependency: {
        [id: string]: string[];
    };
}
export interface BuildGeneratedSwitchOptions {
    id: string;
    /** One-based ordinal within this network/role, used in the browser display name. */
    ordinal?: number | undefined;
}
/**
 * Reproduces the browser's exact `/switch_calculation` body projection.
 *
 * Live evidence shows that auto-connect settings, connections and virtual-container
 * maps are deliberately absent here. Unknown workspace fields must not leak into
 * this request.
 */
export declare function buildSwitchCalculationRequest(workspace: Obj): SwitchCalculationRequest;
/** Validates and flattens DCSC's rack-grouped switch calculation response. */
export declare function parseSwitchCalculationResponse(raw: unknown, request?: SwitchCalculationRequest): SwitchRequirement[];
/**
 * Builds the three identity-linked records for one automatically generated switch.
 * A manually-added switch with the same code is not reusable: the captured SPA
 * launches a new configuration and uses its new id in all three records.
 */
export declare function buildGeneratedSwitch(requirement: SwitchRequirement, launch: RackObject, options: BuildGeneratedSwitchOptions): GeneratedSwitch;
