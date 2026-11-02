import { z } from 'zod';
import type { DcscHttpClient, RequestCtx } from '../http/request.js';
export interface MandatorySubTab {
    description: string;
    label?: string | undefined;
    value?: Record<string, unknown> | undefined;
    [key: string]: unknown;
}
export interface MandatoryTab {
    description: string;
    introduce?: string | undefined;
    subTabs: MandatorySubTab[];
    [key: string]: unknown;
}
export interface VerifyMandatorySoftwareInput {
    mode?: 'cto' | 'lfo' | undefined;
    configuration: {
        id: string;
        code: string;
        ctoCode?: string | undefined;
        lfoCode?: string | undefined;
        sections: unknown[];
        [key: string]: unknown;
    };
}
export interface VerifyMandatorySoftwareResult {
    showVerifyConfig: boolean;
    status: boolean;
    message: string | null;
    tabs: MandatoryTab[];
}
export declare const VerifyMandatorySoftwareInputSchema: z.ZodObject<{
    mode: z.ZodOptional<z.ZodEnum<{
        cto: "cto";
        lfo: "lfo";
    }>>;
    configuration: z.ZodObject<{
        id: z.ZodString;
        code: z.ZodString;
        ctoCode: z.ZodOptional<z.ZodString>;
        lfoCode: z.ZodOptional<z.ZodString>;
        sections: z.ZodArray<z.ZodUnknown>;
    }, z.core.$loose>;
}, z.core.$strip>;
export declare const MandatorySoftwareWireSchema: z.ZodObject<{
    status: z.ZodBoolean;
    tabs: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        description: z.ZodString;
        introduce: z.ZodOptional<z.ZodString>;
        subTabs: z.ZodDefault<z.ZodArray<z.ZodObject<{
            description: z.ZodString;
            label: z.ZodOptional<z.ZodString>;
            value: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$loose>>>;
    }, z.core.$loose>>>>, z.ZodTransform<{
        [x: string]: unknown;
        description: string;
        introduce?: string | undefined;
        subTabs: {
            [x: string]: unknown;
            description: string;
            label?: string | undefined;
            value?: Record<string, unknown> | undefined;
        }[];
    }[], {
        [x: string]: unknown;
        description: string;
        introduce?: string | undefined;
        subTabs: {
            [x: string]: unknown;
            description: string;
            label?: string | undefined;
            value?: Record<string, unknown> | undefined;
        }[];
    }[] | null | undefined>>;
    message: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
/**
 * Validates whether mandatory software (Operating System, Hypervisor) has been selected
 * for a CTO or LFO configuration before proceeding to checkout/summary.
 * Endpoints:
 * - POST /cto/mandatory/sw/selection
 * - POST /lfo/mandatory/sw/selection
 */
export declare function mandatoryVerifyConfig(http: DcscHttpClient, ctx: RequestCtx, input: VerifyMandatorySoftwareInput): Promise<VerifyMandatorySoftwareResult>;
