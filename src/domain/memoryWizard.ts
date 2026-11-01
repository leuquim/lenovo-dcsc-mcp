import type { DcscHttpClient, RequestCtx } from '../http/request.js';

export type MemoryWizardAction =
  | 'launch'
  | 'options'
  | 'capacityList'
  | 'memoryList'
  | 'loadmap'
  | 'slotNumber'
  | 'exportZip'
  | 'validExportZip';

export interface MemoryWizardLaunchResult {
  ctoCode: string;
  steps: string[];
  raw: unknown;
}

export interface MemoryWizardQueryInput {
  action: MemoryWizardAction;
  ctoCode?: string | undefined;
  payload?: Record<string, unknown> | undefined;
}

export interface MemoryWizardQueryResult {
  action: MemoryWizardAction;
  ctoCode?: string | undefined;
  data: unknown;
  raw?: unknown;
}

/**
 * Launches Memory Wizard for a specific CTO code.
 * Endpoint: GET /ctos/{code}/memory_wizard/launch
 */
export async function launchMemoryWizard(
  http: DcscHttpClient,
  ctx: RequestCtx,
  ctoCode: string,
): Promise<MemoryWizardLaunchResult> {
  const encoded = encodeURIComponent(ctoCode);
  const res = await http.send({
    endpoint: 'memory_wizard_launch',
    method: 'POST',
    path: `/ctos/${encoded}/memory_wizard/launch`,
    body: { kind: 'json', value: {} },
    responseKind: 'json',
    timeoutClass: 'interactive',
    requiresSolution: false,
    ctx,
  });

  const rawObj = (res.raw && typeof res.raw === 'object' ? res.raw : {}) as Record<string, unknown>;
  const steps = Array.isArray(res.raw) ? (res.raw as string[]) : Object.keys(rawObj);
  return {
    ctoCode,
    steps,
    raw: res.raw,
  };
}

/**
 * Queries Memory Wizard endpoints for options, capacity, slot numbers, and population loadmaps.
 */
export async function queryMemoryWizard(
  http: DcscHttpClient,
  ctx: RequestCtx,
  input: MemoryWizardQueryInput,
): Promise<MemoryWizardQueryResult> {
  const { action, ctoCode, payload = {} } = input;

  if (action === 'launch') {
    const launchRes = await launchMemoryWizard(http, ctx, ctoCode ?? '');
    return {
      action,
      ctoCode,
      data: launchRes.steps,
      raw: launchRes.raw,
    };
  }

  let method: 'GET' | 'POST' = 'POST';
  let path = '';
  let endpoint = '';

  switch (action) {
    case 'options':
      path = '/memory_wizard/options';
      endpoint = 'memory_wizard_options';
      break;
    case 'capacityList':
      path = '/memory_wizard/memory_capacity_list';
      endpoint = 'memory_wizard_capacity_list';
      break;
    case 'memoryList':
      path = '/memory_wizard/memory_list';
      endpoint = 'memory_wizard_memory_list';
      break;
    case 'loadmap':
      path = '/memory_wizard/memory_loadmap';
      endpoint = 'memory_wizard_loadmap';
      break;
    case 'slotNumber':
      path = '/memory_wizard/slot_number';
      endpoint = 'memory_wizard_slot_number';
      method = 'GET';
      break;
    case 'exportZip':
      path = '/memory_wizard/export_zip';
      endpoint = 'memory_wizard_export_zip';
      break;
    case 'validExportZip':
      path = '/memory_wizard/valid/export_zip';
      endpoint = 'memory_wizard_valid_export_zip';
      break;
  }

  if (method === 'GET') {
    const queryPayload: Record<string, string> = {};
    if (ctoCode) queryPayload.ctoCode = ctoCode;
    for (const [k, v] of Object.entries(payload)) {
      if (v !== undefined && v !== null) {
        queryPayload[k] = String(v);
      }
    }
    const res = await http.send({
      endpoint,
      method: 'GET',
      path,
      query: queryPayload,
      responseKind: 'json',
      timeoutClass: 'interactive',
      requiresSolution: false,
      ctx,
    });
    return {
      action,
      ctoCode,
      data: res.raw,
      raw: res.raw,
    };
  }

  const res = await http.send({
    endpoint,
    method: 'POST',
    path,
    body: { kind: 'json', value: payload },
    responseKind: 'json',
    timeoutClass: 'interactive',
    requiresSolution: false,
    ctx,
  });

  return {
    action,
    ctoCode,
    data: res.raw,
    raw: res.raw,
  };
}
