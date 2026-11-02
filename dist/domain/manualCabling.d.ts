import type { RawConfiguration } from '../model/types.js';
import type { RackObject } from './rack.js';
import { type ReducedConfiguration } from './reduce.js';
import { type Obj } from '../util/coerce.js';
export interface ManualPortChoice {
    configurationId: string;
    code?: string | undefined;
    description?: string | undefined;
    rackId?: string | undefined;
    position?: number | undefined;
    location?: string | undefined;
    name: string;
    number: string;
    topologies: string[];
}
export interface ManualCableChoice {
    part: string;
    option?: string | undefined;
    description?: string | undefined;
    price?: number | undefined;
    length?: number | undefined;
    raw: Obj;
}
export interface ManualConnectionView {
    id: string;
    network?: string | undefined;
    topology?: string | undefined;
    type?: string | undefined;
    category?: string | undefined;
    divider?: number | undefined;
    source: {
        configurationId: string;
        portName: string;
        portNumber: string;
        location?: string | undefined;
    };
    destination: {
        configurationId: string;
        portName: string;
        portNumber: string;
        location?: string | undefined;
    };
    cable: {
        part?: string | undefined;
        option?: string | undefined;
        description?: string | undefined;
    };
    totalDistance?: number | undefined;
    compatibleCables: Array<Omit<ManualCableChoice, 'raw'>>;
}
export interface ManualCablingCatalog {
    connections: ManualConnectionView[];
    ports: ManualPortChoice[];
}
export interface ManualConnectionEndpointPatch {
    configurationId: string;
    portName: string;
    portNumber: string;
}
export interface ManualConnectionEdit {
    connectionId: string;
    source?: ManualConnectionEndpointPatch | undefined;
    destination?: ManualConnectionEndpointPatch | undefined;
    /** Exact part identifier returned in compatibleCables. */
    cablePart?: string | undefined;
    /** Per-product selected quantities, including any retained spares. */
    cableQuantities?: {
        oldPart: number;
        newPart: number;
    } | undefined;
}
export interface ManualCableReplacementPlan {
    physicalDestinationId: string;
    sharedSelection?: {
        configurationIds: string[];
        physicalDestinationIds: string[];
    } | undefined;
    /** Authoritative raw configuration ID, after resolving a managed physical alias. */
    configurationId: string;
    sectionName: string;
    oldCode: string;
    newCode: string;
    quantity: number;
    graphUsage: {
        oldCode: number;
        newCode: number;
    };
    targetQuantities: {
        oldCode: number;
        newCode: number;
    };
    wireMode: 'native-single' | 'quantity-preserving';
    choice: ManualCableChoice;
    /** Browser-equivalent compact configuration, including its delta. */
    reducedConfiguration: ReducedConfiguration;
    /** Rack state after the browser's local removal of the old cable feature. */
    rackArea: RackObject[];
    nonRackArea: RackObject[];
    /** One targeted derive. There is no import entrance flag in this operation. */
    query: {
        configurationId: string;
    };
    customizingIds: [string];
}
export interface ManualConnectionEditPlan {
    connectionId: string;
    index: number;
    before: Obj;
    staged: Obj;
    distanceRequest?: {
        floorPreference: Obj;
        floorItems: unknown[];
        from: string;
        to: string;
        network: string;
    } | undefined;
    cableReplacement?: ManualCableReplacementPlan | undefined;
    relatedChanges?: ManualConnectionEditPlan['collisionSwaps'];
    collisionSwaps?: Array<{
        index: number;
        connectionId: string;
        before: Obj;
        staged: Obj;
    }> | undefined;
}
export interface AcceptedManualCablePhysicalState {
    rackArea: RackObject[];
    nonRackArea: RackObject[];
}
export interface ManualCablingInput {
    cloneDependency?: unknown;
    connections: readonly unknown[];
    configurations: readonly RawConfiguration[];
    rackArea: readonly RackObject[];
    nonRackArea?: readonly RackObject[] | undefined;
    floorItems?: readonly unknown[] | undefined;
    floorPreference?: Obj | undefined;
    /** Physical alias ID to its authoritative managed template configuration ID. */
    physicalTemplateIds?: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined;
    mode?: 'cto' | 'lfo' | undefined;
    solutionMode?: string | undefined;
}
export declare function manualConnectionId(value: unknown): string;
export declare function discoverManualPorts(input: ManualCablingInput): ManualPortChoice[];
export declare function projectManualConnection(value: unknown): ManualConnectionView;
export declare function inspectManualCabling(input: ManualCablingInput): ManualCablingCatalog;
/**
 * Applies the accepted targeted derive to the cable destination's physical
 * feature list. The browser first removes the old rack feature locally, then
 * rebuilds the selected feature from the accepted configuration and placement
 * result. This matters when the new part was not already present physically.
 */
export declare function applyAcceptedManualCablePhysicalState(replacement: ManualCableReplacementPlan, acceptedConfiguration: RawConfiguration, response: unknown): AcceptedManualCablePhysicalState;
export declare function stageManualConnectionEdit(input: ManualCablingInput, edit: ManualConnectionEdit): ManualConnectionEditPlan;
export declare function applyManualConnectionDistance(plan: ManualConnectionEditPlan, value: unknown): ManualConnectionEditPlan;
export declare function commitManualConnectionEdit(connections: readonly unknown[], plan: ManualConnectionEditPlan): unknown[];
