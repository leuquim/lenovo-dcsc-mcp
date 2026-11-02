import type { Runtime } from './runtime.js';
export declare function positiveQuantity(quantity: number | null | undefined): number;
/** Compares scenarios (configurations or workspaces) by list price, power and heat, optionally scaled to N nodes. */
export declare function compareScenarios(rt: Runtime, sessions: string[], nodes?: number): {
    scenarios: {
        session: string;
        label: string;
        currency: string;
        scope: string;
        primaryProduct: string;
        description: string;
        configurations: number;
        products: {
            session: string;
            code: string;
            description: string;
            quantity: number;
            role: string;
            listPrice: number | null;
        }[];
        scaledToNodes?: number;
        unitListPrice?: number | null;
        physicalLayout?: string;
        physicalLayoutRequirement?: string;
        listPrice: number | null;
        priceAvailable: boolean;
        knownListPriceSubtotal?: number;
        unpricedConfigurations?: string[];
        powerAvailable: boolean;
        missingPowerConfigurations?: string[];
        knownPowerSubtotal?: import("../domain/power.js").AggregatedPower;
        expectedKW?: number;
        maxKW?: number;
        heatBtuHrMax?: number;
        pricePerExpectedKW?: number | undefined;
        racks?: number;
        rackWeightKg?: number;
        stability?: (string | undefined)[];
    }[];
    ranking: {
        status: string;
        reason: string;
    };
    priceType: string;
    disclaimer: string;
} | {
    ranking?: never;
    scenarios: {
        session: string;
        label: string;
        currency: string;
        scope: string;
        primaryProduct: string;
        description: string;
        configurations: number;
        products: {
            session: string;
            code: string;
            description: string;
            quantity: number;
            role: string;
            listPrice: number | null;
        }[];
        scaledToNodes?: number;
        unitListPrice?: number | null;
        physicalLayout?: string;
        physicalLayoutRequirement?: string;
        listPrice: number | null;
        priceAvailable: boolean;
        knownListPriceSubtotal?: number;
        unpricedConfigurations?: string[];
        powerAvailable: boolean;
        missingPowerConfigurations?: string[];
        knownPowerSubtotal?: import("../domain/power.js").AggregatedPower;
        expectedKW?: number;
        maxKW?: number;
        heatBtuHrMax?: number;
        pricePerExpectedKW?: number | undefined;
        racks?: number;
        rackWeightKg?: number;
        stability?: (string | undefined)[];
    }[];
    currency: string | undefined;
    cheapest: string | undefined;
    lowestPower: string | undefined;
    priceRanking?: {
        status: string;
        reason: string;
    };
    powerRanking?: {
        status: string;
        reason: string;
    };
    priceType: string;
    note: string;
    disclaimer: string;
};
/** Cluster sizing from one designed node, with DCSC's own placement verdicts. */
export declare function sizeScaleOut(rt: Runtime, opts: {
    session: string;
    nodes: number;
    rackCode: string;
}): Promise<{
    nodeCode: string;
    nodeDescription: string;
    nodeSizeU: number;
    nodeWeightKg: number;
    rackCode: string;
    rackSizeU: number;
    nodes: number;
    nodesPerRack: number;
    racksNeeded: number;
    totalListPrice: number;
    currency: string;
    priceScope: 'configured-nodes-only';
    excludedCosts: string[];
    lastRackNodes: number;
    fullestRackNodes: number;
    lastRackWeightKg: number;
    fullestRackWeightKg: number;
    totalWeightKg: number;
    powerPerNode?: import("../domain/power.js").PowerReport;
    clusterPower?: import("../domain/power.js").AggregatedPower;
    powerPerRack?: import("../domain/power.js").AggregatedPower;
    lastRackPower?: import("../domain/power.js").AggregatedPower;
    coolingAdvisory?: import("../domain/power.js").DensityAdvisory;
    powerNote?: string;
    priceType: string;
    disclaimer: string;
}>;
