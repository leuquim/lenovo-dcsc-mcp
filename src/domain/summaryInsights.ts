import { z } from 'zod';
import type { DcscHttpClient, RequestCtx } from '../http/request.js';
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
export async function fetchServiceSavings(
  http: DcscHttpClient,
  ctx: RequestCtx,
  workspaceSnapshot: Record<string, unknown>,
): Promise<ServiceSavingsResult> {
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
export async function fetchFlagSummary(
  http: DcscHttpClient,
  ctx: RequestCtx,
  workspaceSnapshot: Record<string, unknown>,
): Promise<FlagSummaryResult> {
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

  const rawRecord = parsed as Record<string, unknown>;
  const rawItems = (rawRecord.selectableEoFlagItems || rawRecord.specialFeature || rawRecord.data || []) as Array<Record<string, unknown>>;
  return {
    selectableEoFlagItems: Array.isArray(rawItems)
      ? rawItems.map((item) => ({
          ...(item.id !== undefined ? { id: item.id as string } : {}),
          ...(item.name !== undefined ? { name: item.name as string } : {}),
          ...(item.description !== undefined ? { description: item.description as string } : {}),
          ...(item.code !== undefined ? { code: item.code as string } : {}),
          ...(item.features !== undefined ? { features: item.features as unknown[] } : {}),
        }))
      : [],
  };
}
