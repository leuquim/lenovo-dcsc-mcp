import { z } from 'zod';
import type { DcscHttpClient, RequestCtx } from '../http/request.js';
export interface RackItemSpec {
    code: string;
    machineType?: string | undefined;
    sliceCtoCode?: string | null | undefined;
    type: string;
    asVLH?: boolean | undefined;
    [key: string]: unknown;
}
export interface RackContainerSpec {
    code: string;
    machineType?: string | undefined;
    sliceCtoCode?: string | null | undefined;
    size: number;
    rackItem: RackItemSpec;
    [key: string]: unknown;
}
export interface RackConfigurationEntry {
    configurationId: string;
    core?: Record<string, unknown> | undefined;
    sectionResults?: unknown[] | undefined;
    unSelectableCharacters?: unknown[] | undefined;
    selectedTopologies?: unknown | undefined;
    selectedStorageNetwork?: unknown | undefined;
    connectors?: unknown[] | undefined;
    [key: string]: unknown;
}
export interface RackPositionRuleInput {
    rack: RackContainerSpec;
    configurations: RackConfigurationEntry[];
}
export interface MinMaxRule {
    min: number;
    max: number;
    [key: string]: unknown;
}
export interface ServerRule {
    mtMinMaxRule?: MinMaxRule | null | undefined;
    productMinMaxRule?: MinMaxRule | null | undefined;
    [key: string]: unknown;
}
export interface RackPositionRuleResult {
    lowestPosition: number;
    highestPosition: number;
    serverRule: ServerRule;
}
export declare const RackPositionRuleInputSchema: z.ZodObject<{
    rack: z.ZodObject<{
        code: z.ZodString;
        machineType: z.ZodOptional<z.ZodString>;
        sliceCtoCode: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        size: z.ZodNumber;
        rackItem: z.ZodObject<{
            code: z.ZodString;
            machineType: z.ZodOptional<z.ZodString>;
            sliceCtoCode: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            type: z.ZodString;
            asVLH: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$loose>;
    }, z.core.$loose>;
    configurations: z.ZodArray<z.ZodObject<{
        configurationId: z.ZodString;
        core: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        sectionResults: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
        unSelectableCharacters: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
        selectedTopologies: z.ZodOptional<z.ZodUnknown>;
        selectedStorageNetwork: z.ZodOptional<z.ZodUnknown>;
        connectors: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    }, z.core.$loose>>;
}, z.core.$strip>;
export declare const RackItemResponseSchema: z.ZodObject<{
    lowestPosition: z.ZodNumber;
    highestPosition: z.ZodNumber;
    rule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        mtMinMaxRule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            min: z.ZodNumber;
            max: z.ZodNumber;
        }, z.core.$loose>>>;
        productMinMaxRule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            min: z.ZodNumber;
            max: z.ZodNumber;
        }, z.core.$loose>>>;
    }, z.core.$loose>>>;
    serverRule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        mtMinMaxRule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            min: z.ZodNumber;
            max: z.ZodNumber;
        }, z.core.$loose>>>;
        productMinMaxRule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            min: z.ZodNumber;
            max: z.ZodNumber;
        }, z.core.$loose>>>;
    }, z.core.$loose>>>;
    code: z.ZodOptional<z.ZodString>;
    sliceCtoCode: z.ZodOptional<z.ZodString>;
    type: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export type RackItemResponse = z.infer<typeof RackItemResponseSchema>;
export declare const RackPositionRuleWireSchema: z.ZodUnion<readonly [z.ZodObject<{
    rackItemResponse: z.ZodObject<{
        lowestPosition: z.ZodNumber;
        highestPosition: z.ZodNumber;
        rule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            mtMinMaxRule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                min: z.ZodNumber;
                max: z.ZodNumber;
            }, z.core.$loose>>>;
            productMinMaxRule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                min: z.ZodNumber;
                max: z.ZodNumber;
            }, z.core.$loose>>>;
        }, z.core.$loose>>>;
        serverRule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            mtMinMaxRule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                min: z.ZodNumber;
                max: z.ZodNumber;
            }, z.core.$loose>>>;
            productMinMaxRule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                min: z.ZodNumber;
                max: z.ZodNumber;
            }, z.core.$loose>>>;
        }, z.core.$loose>>>;
        code: z.ZodOptional<z.ZodString>;
        sliceCtoCode: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
}, z.core.$loose>, z.ZodObject<{
    lowestPosition: z.ZodNumber;
    highestPosition: z.ZodNumber;
    rule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        mtMinMaxRule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            min: z.ZodNumber;
            max: z.ZodNumber;
        }, z.core.$loose>>>;
        productMinMaxRule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            min: z.ZodNumber;
            max: z.ZodNumber;
        }, z.core.$loose>>>;
    }, z.core.$loose>>>;
    serverRule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        mtMinMaxRule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            min: z.ZodNumber;
            max: z.ZodNumber;
        }, z.core.$loose>>>;
        productMinMaxRule: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            min: z.ZodNumber;
            max: z.ZodNumber;
        }, z.core.$loose>>>;
    }, z.core.$loose>>>;
    code: z.ZodOptional<z.ZodString>;
    sliceCtoCode: z.ZodOptional<z.ZodString>;
    type: z.ZodOptional<z.ZodString>;
}, z.core.$loose>]>;
/**
 * Fetches placement U-position rules and machine-type / product min/max constraints
 * for placing a hardware item in a rack.
 * Endpoint: POST /racks/ctos/position/rule
 */
export declare function getHardwareRuleInRack(http: DcscHttpClient, ctx: RequestCtx, input: RackPositionRuleInput): Promise<RackPositionRuleResult>;
