import { z } from 'zod';
import { AI_PREFIX } from '../config/constants.js';
import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import { parseResponse } from '../schemas/parse.js';

export const NightingaleEnvelopeSchema = z.object({
  code: z.number().default(200),
  message: z.string().optional().nullable(),
  data: z.unknown(),
}).passthrough();

export type NightingaleAiAction =
  | 'ctoCandidates'
  | 'featureCompat'
  | 'bladeRecommendation'
  | 'defaultPrompt'
  | 'promptTemplate'
  | 'candidateAttributes'
  | 'candidateFeatures'
  | 'candidateFeaturesDesc'
  | 'configReplenishment'
  | 'replaceFeatures'
  | 'recommendConfigs'
  | 'recommendServices';

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

export interface AiGenericResult {
  action: NightingaleAiAction;
  data: unknown;
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

/**
 * Generic caller for Nightingale AI configurator endpoints.
 */
export async function callNightingaleEndpoint(
  http: DcscHttpClient,
  ctx: RequestCtx,
  endpointId: string,
  subpath: string,
  payload: Record<string, unknown>,
): Promise<{ data: unknown; raw: unknown }> {
  const res = await http.send({
    endpoint: endpointId,
    method: 'POST',
    prefix: AI_PREFIX,
    path: subpath,
    body: { kind: 'json', value: payload },
    responseKind: 'json',
    timeoutClass: 'interactive',
    requiresSolution: false,
    ctx,
  });

  const parsed = parseResponse(NightingaleEnvelopeSchema, res.raw, {
    endpoint: endpointId,
    corrId: ctx.corrId,
    requestId: res.requestId,
  });

  const data = (parsed as Record<string, unknown>).data ?? parsed;
  return {
    data,
    raw: res.raw,
  };
}

/**
 * Queries default prompt suggestions.
 * Endpoint: POST /nightingale-configurator/api/v1/default-prompt/_query
 */
export async function fetchAiDefaultPrompt(
  http: DcscHttpClient,
  ctx: RequestCtx,
  payload: Record<string, unknown>,
): Promise<AiGenericResult> {
  const res = await callNightingaleEndpoint(
    http,
    ctx,
    'ai_default_prompt',
    '/nightingale-configurator/api/v1/default-prompt/_query',
    payload,
  );
  return { action: 'defaultPrompt', data: res.data, raw: res.raw };
}

/**
 * Queries prompt templates.
 * Endpoint: POST /nightingale-configurator/api/v1/prompt-template/_query
 */
export async function fetchAiPromptTemplate(
  http: DcscHttpClient,
  ctx: RequestCtx,
  payload: Record<string, unknown>,
): Promise<AiGenericResult> {
  const res = await callNightingaleEndpoint(
    http,
    ctx,
    'ai_prompt_template',
    '/nightingale-configurator/api/v1/prompt-template/_query',
    payload,
  );
  return { action: 'promptTemplate', data: res.data, raw: res.raw };
}

/**
 * Queries candidate attributes.
 * Endpoint: POST /nightingale-configurator/api/v1/candidate/attributes
 */
export async function fetchAiCandidateAttributes(
  http: DcscHttpClient,
  ctx: RequestCtx,
  payload: Record<string, unknown>,
): Promise<AiGenericResult> {
  const res = await callNightingaleEndpoint(
    http,
    ctx,
    'ai_candidate_attributes',
    '/nightingale-configurator/api/v1/candidate/attributes',
    payload,
  );
  return { action: 'candidateAttributes', data: res.data, raw: res.raw };
}

/**
 * Queries candidate features.
 * Endpoint: POST /nightingale-configurator/api/v1/candidate/features
 */
export async function fetchAiCandidateFeatures(
  http: DcscHttpClient,
  ctx: RequestCtx,
  payload: Record<string, unknown>,
): Promise<AiGenericResult> {
  const res = await callNightingaleEndpoint(
    http,
    ctx,
    'ai_candidate_features',
    '/nightingale-configurator/api/v1/candidate/features',
    payload,
  );
  return { action: 'candidateFeatures', data: res.data, raw: res.raw };
}

/**
 * Queries candidate features description.
 * Endpoint: POST /nightingale-configurator/api/v1/candidate/features/desc
 */
export async function fetchAiCandidateFeaturesDesc(
  http: DcscHttpClient,
  ctx: RequestCtx,
  payload: Record<string, unknown>,
): Promise<AiGenericResult> {
  const res = await callNightingaleEndpoint(
    http,
    ctx,
    'ai_candidate_features_desc',
    '/nightingale-configurator/api/v1/candidate/features/desc',
    payload,
  );
  return { action: 'candidateFeaturesDesc', data: res.data, raw: res.raw };
}

/**
 * Calculates configuration replenishment.
 * Endpoint: POST /nightingale-configurator/api/v1/config-replenishment/_calculate
 */
export async function fetchAiConfigReplenishment(
  http: DcscHttpClient,
  ctx: RequestCtx,
  payload: Record<string, unknown>,
): Promise<AiGenericResult> {
  const res = await callNightingaleEndpoint(
    http,
    ctx,
    'ai_config_replenishment',
    '/nightingale-configurator/api/v1/config-replenishment/_calculate',
    payload,
  );
  return { action: 'configReplenishment', data: res.data, raw: res.raw };
}

/**
 * Replaces features.
 * Endpoint: POST /nightingale-configurator/api/v1/features/replace
 */
export async function fetchAiReplaceFeatures(
  http: DcscHttpClient,
  ctx: RequestCtx,
  payload: Record<string, unknown>,
): Promise<AiGenericResult> {
  const res = await callNightingaleEndpoint(
    http,
    ctx,
    'ai_features_replace',
    '/nightingale-configurator/api/v1/features/replace',
    payload,
  );
  return { action: 'replaceFeatures', data: res.data, raw: res.raw };
}

/**
 * Recommends configurations.
 * Endpoint: POST /nightingale-configurator/api/v1/recommendation/configs
 */
export async function fetchAiRecommendConfigs(
  http: DcscHttpClient,
  ctx: RequestCtx,
  payload: Record<string, unknown>,
): Promise<AiGenericResult> {
  const res = await callNightingaleEndpoint(
    http,
    ctx,
    'ai_recommendation_configs',
    '/nightingale-configurator/api/v1/recommendation/configs',
    payload,
  );
  return { action: 'recommendConfigs', data: res.data, raw: res.raw };
}

/**
 * Recommends services.
 * Endpoint: POST /nightingale-configurator/api/v1/recommendation/services
 */
export async function fetchAiRecommendServices(
  http: DcscHttpClient,
  ctx: RequestCtx,
  payload: Record<string, unknown>,
): Promise<AiGenericResult> {
  const res = await callNightingaleEndpoint(
    http,
    ctx,
    'ai_recommendation_services',
    '/nightingale-configurator/api/v1/recommendation/services',
    payload,
  );
  return { action: 'recommendServices', data: res.data, raw: res.raw };
}
