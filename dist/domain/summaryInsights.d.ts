import { z } from 'zod';
import type { DcscHttpClient, RequestCtx } from '../http/request.js';
export declare const ServiceSavingItemSchema: z.ZodObject<{
    price: z.ZodNumber;
    priceNotAvailable: z.ZodBoolean;
    totalPrice: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const ServiceSavingsWireSchema: z.ZodObject<{
    serviceSaving: z.ZodArray<z.ZodObject<{
        price: z.ZodNumber;
        priceNotAvailable: z.ZodBoolean;
        totalPrice: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const FlagFeatureItemSchema: z.ZodObject<{
    tabTitle: z.ZodOptional<z.ZodString>;
    subDescription: z.ZodOptional<z.ZodString>;
    sectionName: z.ZodOptional<z.ZodString>;
    sectionDescription: z.ZodOptional<z.ZodString>;
    code: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    displayCode: z.ZodOptional<z.ZodString>;
    marketValue: z.ZodOptional<z.ZodString>;
    subTitle: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SelectableEoFlagItemSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    code: z.ZodOptional<z.ZodString>;
    features: z.ZodOptional<z.ZodArray<z.ZodObject<{
        tabTitle: z.ZodOptional<z.ZodString>;
        subDescription: z.ZodOptional<z.ZodString>;
        sectionName: z.ZodOptional<z.ZodString>;
        sectionDescription: z.ZodOptional<z.ZodString>;
        code: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        displayCode: z.ZodOptional<z.ZodString>;
        marketValue: z.ZodOptional<z.ZodString>;
        subTitle: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export declare const FlagSummaryWireSchema: z.ZodObject<{
    selectableEoFlagItems: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        code: z.ZodOptional<z.ZodString>;
        features: z.ZodOptional<z.ZodArray<z.ZodObject<{
            tabTitle: z.ZodOptional<z.ZodString>;
            subDescription: z.ZodOptional<z.ZodString>;
            sectionName: z.ZodOptional<z.ZodString>;
            sectionDescription: z.ZodOptional<z.ZodString>;
            code: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            displayCode: z.ZodOptional<z.ZodString>;
            marketValue: z.ZodOptional<z.ZodString>;
            subTitle: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>>;
    specialFeature: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        code: z.ZodOptional<z.ZodString>;
        features: z.ZodOptional<z.ZodArray<z.ZodObject<{
            tabTitle: z.ZodOptional<z.ZodString>;
            subDescription: z.ZodOptional<z.ZodString>;
            sectionName: z.ZodOptional<z.ZodString>;
            sectionDescription: z.ZodOptional<z.ZodString>;
            code: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            displayCode: z.ZodOptional<z.ZodString>;
            marketValue: z.ZodOptional<z.ZodString>;
            subTitle: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>>;
    data: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        code: z.ZodOptional<z.ZodString>;
        features: z.ZodOptional<z.ZodArray<z.ZodObject<{
            tabTitle: z.ZodOptional<z.ZodString>;
            subDescription: z.ZodOptional<z.ZodString>;
            sectionName: z.ZodOptional<z.ZodString>;
            sectionDescription: z.ZodOptional<z.ZodString>;
            code: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            displayCode: z.ZodOptional<z.ZodString>;
            marketValue: z.ZodOptional<z.ZodString>;
            subTitle: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>>;
}, z.core.$loose>;
export interface SummaryInsightsInput {
    type?: 'serviceSaving' | 'flagSummary' | string;
    workspaceSnapshot: Record<string, unknown>;
}
export interface ServiceSavingsResult {
    serviceSaving: Array<{
        price: number;
        priceNotAvailable: boolean;
        totalPrice?: number;
    }>;
}
export interface FlagSummaryResult {
    selectableEoFlagItems: Array<{
        id?: string | undefined;
        name?: string | undefined;
        description?: string | undefined;
        code?: string | undefined;
        features?: unknown[] | undefined;
    }>;
}
/**
 * Fetches service savings pricing calculation.
 * Endpoint: POST /ctos/serviceSaving
 */
export declare function fetchServiceSavings(http: DcscHttpClient, ctx: RequestCtx, workspaceSnapshot: Record<string, unknown>): Promise<ServiceSavingsResult>;
/**
 * Fetches selectable special feature flag summary.
 * Endpoint: POST /ctos/flag_summary
 */
export declare function fetchFlagSummary(http: DcscHttpClient, ctx: RequestCtx, workspaceSnapshot: Record<string, unknown>): Promise<FlagSummaryResult>;
