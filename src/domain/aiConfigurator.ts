import { z } from 'zod';
import { AI_PREFIX } from '../config/constants.js';
import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import { parseResponse } from '../schemas/parse.js';

export const NightingaleEnvelopeSchema = z.object({
  code: z.number().default(200),
  message: z.string().optional().nullable(),
  data: z.unknown(),
}).passthrough();

export interface AiRecommendCtosInput {
  prompt: string;
  mode?: string;
  uuid?: string;
  [key: string]: unknown;
}

export interface AiFeatureCompatInput {
  ctoCode: string;
  selections: Array<{
    sectionName: string;
    results: Array<{ code: string; quantity: number }>;
  }>;
  candidates: Array<{
    sectionName: string;
    results: Array<{ code: string; quantity: number }>;
  }>;
  [key: string]: unknown;
}

export interface AiBladeRecommendInput {
  configurationId: string;
  ctoCode: string;
  userSelections: Array<{
    sectionName: string;
    results: Array<{ code: string; quantity: number }>;
    type?: string;
  }>;
  [key: string]: unknown;
}

export interface AiRecommendCtosResult {
  candidates: Array<Record<string, unknown>>;
  raw: unknown;
}

export interface AiFeatureCompatResult {
  validated: Array<Record<string, unknown>>;
  raw: unknown;
}

export interface AiBladeRecommendResult {
  isBladeConfig: boolean;
  bladeRecommendations: Record<string, unknown>;
  raw: unknown;
}

/**
 * Recommends CTO candidates using Nightingale AI.
 * Endpoint: POST /ai-acceler/nightingale-configurator/api/v1/recommendation/ctoCandidates
 */
export async function fetchAiRecommendCtos(
  http: DcscHttpClient,
  ctx: RequestCtx,
  input: AiRecommendCtosInput,
): Promise<AiRecommendCtosResult> {
  const payload = {
    ...input,
    uuid: input.uuid ?? ctx.corrId,
  };

  const res = await http.send({
    endpoint: 'ai_recommendation_cto_candidates',
    method: 'POST',
    prefix: AI_PREFIX,
    path: '/nightingale-configurator/api/v1/recommendation/ctoCandidates',
    body: { kind: 'json', value: payload },
    responseKind: 'json',
    timeoutClass: 'interactive',
    requiresSolution: false,
    ctx,
  });

  const parsed = parseResponse(NightingaleEnvelopeSchema, res.raw, {
    endpoint: 'ai_recommendation_cto_candidates',
    corrId: ctx.corrId,
    requestId: res.requestId,
  });

  const data = (parsed as Record<string, unknown>).data ?? parsed;
  const candidates = Array.isArray(data) ? data : ((data as Record<string, unknown>).candidates || (data as Record<string, unknown>).items || []);

  return {
    candidates: Array.isArray(candidates) ? (candidates as Array<Record<string, unknown>>) : [candidates as Record<string, unknown>],
    raw: res.raw,
  };
}

/**
 * Validates feature compatibility using Nightingale AI.
 * Endpoint: POST /ai-acceler/nightingale-configurator/api/v1/feature-compat/_validate
 */
export async function fetchAiFeatureCompat(
  http: DcscHttpClient,
  ctx: RequestCtx,
  input: AiFeatureCompatInput,
): Promise<AiFeatureCompatResult> {
  const res = await http.send({
    endpoint: 'ai_feature_compat_validate',
    method: 'POST',
    prefix: AI_PREFIX,
    path: '/nightingale-configurator/api/v1/feature-compat/_validate',
    body: { kind: 'json', value: input },
    responseKind: 'json',
    timeoutClass: 'interactive',
    requiresSolution: false,
    ctx,
  });

  const parsed = parseResponse(NightingaleEnvelopeSchema, res.raw, {
    endpoint: 'ai_feature_compat_validate',
    corrId: ctx.corrId,
    requestId: res.requestId,
  });

  const data = (parsed as Record<string, unknown>).data ?? parsed;
  const validated = Array.isArray(data) ? data : ((data as Record<string, unknown>).sections || (data as Record<string, unknown>).validated || []);

  return {
    validated: Array.isArray(validated) ? (validated as Array<Record<string, unknown>>) : [validated as Record<string, unknown>],
    raw: res.raw,
  };
}

/**
 * Recommends blade configurations using Nightingale AI.
 * Endpoint: POST /ai-acceler/nightingale-configurator/api/v1/blade/recommendation
 */
export async function fetchAiBladeRecommendation(
  http: DcscHttpClient,
  ctx: RequestCtx,
  input: AiBladeRecommendInput,
): Promise<AiBladeRecommendResult> {
  const { configurationId, ctoCode, userSelections, ...rest } = input;
  const payload = {
    ...rest,
    id: configurationId,
    ctoCode,
    userSelections,
  };

  const res = await http.send({
    endpoint: 'ai_blade_recommendation',
    method: 'POST',
    prefix: AI_PREFIX,
    path: '/nightingale-configurator/api/v1/blade/recommendation',
    body: { kind: 'json', value: payload },
    responseKind: 'json',
    timeoutClass: 'interactive',
    requiresSolution: false,
    ctx,
  });

  const parsed = parseResponse(NightingaleEnvelopeSchema, res.raw, {
    endpoint: 'ai_blade_recommendation',
    corrId: ctx.corrId,
    requestId: res.requestId,
  });

  const data = ((parsed as Record<string, unknown>).data ?? parsed) as Record<string, unknown>;

  return {
    isBladeConfig: Boolean(data?.isBladeConfig),
    bladeRecommendations: (data?.bladeRecommendations || data || {}) as Record<string, unknown>,
    raw: res.raw,
  };
}
