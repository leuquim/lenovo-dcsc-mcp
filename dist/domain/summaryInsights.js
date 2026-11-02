import { z } from 'zod';
import { parseResponse } from '../schemas/parse.js';
export const ServiceSavingItemSchema = z.object({
    price: z.number(),
    priceNotAvailable: z.boolean(),
    totalPrice: z.number().optional(),
});
export const ServiceSavingsWireSchema = z.object({
    serviceSaving: z.array(ServiceSavingItemSchema),
});
export const FlagFeatureItemSchema = z.object({
    tabTitle: z.string().optional(),
    subDescription: z.string().optional(),
    sectionName: z.string().optional(),
    sectionDescription: z.string().optional(),
    code: z.string().optional(),
    description: z.string().optional(),
    displayCode: z.string().optional(),
    marketValue: z.string().optional(),
    subTitle: z.string().optional(),
});
export const SelectableEoFlagItemSchema = z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    code: z.string().optional(),
    features: z.array(FlagFeatureItemSchema).optional(),
});
export const FlagSummaryWireSchema = z.object({
    selectableEoFlagItems: z.array(SelectableEoFlagItemSchema).optional(),
    specialFeature: z.array(SelectableEoFlagItemSchema).optional(),
    data: z.array(SelectableEoFlagItemSchema).optional(),
}).passthrough();
/**
 * Fetches service savings pricing calculation.
 * Endpoint: POST /ctos/serviceSaving
 */
export async function fetchServiceSavings(http, ctx, workspaceSnapshot) {
    const res = await http.send({
        endpoint: 'ctos_service_saving',
        method: 'POST',
        path: '/ctos/serviceSaving',
        body: { kind: 'json', value: workspaceSnapshot },
        responseKind: 'json',
        timeoutClass: 'interactive',
        ctx,
    });
    const parsed = parseResponse(ServiceSavingsWireSchema, res.raw, {
        endpoint: 'ctos_service_saving',
        corrId: ctx.corrId,
        requestId: res.requestId,
    });
    return {
        serviceSaving: parsed.serviceSaving.map((item) => ({
            price: item.price,
            priceNotAvailable: item.priceNotAvailable,
            ...(item.totalPrice !== undefined ? { totalPrice: item.totalPrice } : {}),
        })),
    };
}
/**
 * Fetches selectable special feature flag summary.
 * Endpoint: POST /ctos/flag_summary
 */
export async function fetchFlagSummary(http, ctx, workspaceSnapshot) {
    const res = await http.send({
        endpoint: 'ctos_flag_summary',
        method: 'POST',
        path: '/ctos/flag_summary',
        body: { kind: 'json', value: workspaceSnapshot },
        responseKind: 'json',
        timeoutClass: 'interactive',
        ctx,
    });
    const parsed = parseResponse(FlagSummaryWireSchema, res.raw, {
        endpoint: 'ctos_flag_summary',
        corrId: ctx.corrId,
        requestId: res.requestId,
    });
    const rawRecord = parsed;
    const rawItems = (rawRecord.selectableEoFlagItems || rawRecord.specialFeature || rawRecord.data || []);
    return {
        selectableEoFlagItems: Array.isArray(rawItems)
            ? rawItems.map((item) => ({
                ...(item.id !== undefined ? { id: item.id } : {}),
                ...(item.name !== undefined ? { name: item.name } : {}),
                ...(item.description !== undefined ? { description: item.description } : {}),
                ...(item.code !== undefined ? { code: item.code } : {}),
                ...(item.features !== undefined ? { features: item.features } : {}),
            }))
            : [],
    };
}
//# sourceMappingURL=summaryInsights.js.map