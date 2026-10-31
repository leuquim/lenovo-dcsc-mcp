import { z } from 'zod';
import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import { parseResponse } from '../schemas/parse.js';

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
  mtMinMaxRule?: MinMaxRule | undefined;
  productMinMaxRule?: MinMaxRule | undefined;
  [key: string]: unknown;
}

export interface RackPositionRuleResult {
  lowestPosition: number;
  highestPosition: number;
  serverRule: ServerRule;
}

export const RackPositionRuleInputSchema = z.object({
  rack: z.object({
    code: z.string().min(1, 'Rack code is required'),
    machineType: z.string().optional(),
    sliceCtoCode: z.string().nullable().optional(),
    size: z.number().int().positive('Rack size must be a positive integer'),
    rackItem: z.object({
      code: z.string().min(1, 'Rack item code is required'),
      machineType: z.string().optional(),
      sliceCtoCode: z.string().nullable().optional(),
      type: z.string().min(1, 'Rack item type is required'),
      asVLH: z.boolean().optional(),
    }).passthrough(),
  }).passthrough(),
  configurations: z.array(
    z.object({
      configurationId: z.string().min(1, 'configurationId is required'),
      core: z.record(z.string(), z.unknown()).optional(),
      sectionResults: z.array(z.unknown()).optional(),
      unSelectableCharacters: z.array(z.unknown()).optional(),
      selectedTopologies: z.unknown().optional(),
      selectedStorageNetwork: z.unknown().optional(),
      connectors: z.array(z.unknown()).optional(),
    }).passthrough(),
  ),
});

const MinMaxRuleSchema = z.object({
  min: z.number(),
  max: z.number(),
}).passthrough();

const ServerRuleSchema = z.object({
  mtMinMaxRule: MinMaxRuleSchema.optional(),
  productMinMaxRule: MinMaxRuleSchema.optional(),
}).passthrough();

export const RackItemResponseSchema = z.object({
  lowestPosition: z.number(),
  highestPosition: z.number(),
  rule: ServerRuleSchema.optional(),
  serverRule: ServerRuleSchema.optional(),
  code: z.string().optional(),
}).passthrough();

export type RackItemResponse = z.infer<typeof RackItemResponseSchema>;

export const RackPositionRuleWireSchema = z.union([
  z.object({
    rackItemResponse: RackItemResponseSchema,
  }).passthrough(),
  RackItemResponseSchema,
]);

/**
 * Fetches placement U-position rules and machine-type / product min/max constraints
 * for placing a hardware item in a rack.
 * Endpoint: POST /racks/ctos/position/rule
 */
export async function getHardwareRuleInRack(
  http: DcscHttpClient,
  ctx: RequestCtx,
  input: RackPositionRuleInput,
): Promise<RackPositionRuleResult> {
  const validatedInput = RackPositionRuleInputSchema.parse(input);

  const res = await http.send({
    endpoint: 'racks_ctos_position_rule',
    method: 'POST',
    path: '/racks/ctos/position/rule',
    body: {
      kind: 'json',
      value: {
        rack: validatedInput.rack,
        configurations: validatedInput.configurations,
      },
    },
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });

  const parsed = parseResponse(RackPositionRuleWireSchema, res.raw, {
    endpoint: 'racks_ctos_position_rule',
    corrId: ctx.corrId,
    requestId: res.requestId,
  });

  const item: RackItemResponse =
    'rackItemResponse' in parsed && parsed.rackItemResponse
      ? (parsed.rackItemResponse as RackItemResponse)
      : (parsed as RackItemResponse);

  return {
    lowestPosition: item.lowestPosition,
    highestPosition: item.highestPosition,
    serverRule: item.serverRule ?? item.rule ?? {},
  };
}
