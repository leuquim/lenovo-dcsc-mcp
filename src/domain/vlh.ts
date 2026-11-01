import type { DcscHttpClient, RequestCtx } from '../http/request.js';

export const VLH_TYPES = ['basic', 'switch', 'networking-adapter', 'networking-cable', 'server', 'rack', 'chassis'] as const;
export type VlhType = typeof VLH_TYPES[number];

export interface VlhConnectorOption {
  shortName: string;
  description: string;
  type: string;
  comment?: string;
}

export interface VlhConnectorFunction {
  shortName: string;
  description: string;
}

export interface VlhWizardInfo {
  networkTopologyConnectorsMap: Record<string, VlhConnectorOption[]>;
  connectorFunctions: VlhConnectorFunction[];
  networkTopologies: string[];
  rpqPlaceholders: string[];
}

export interface VlhConnectorRecord {
  networkTopology?: string;
  connector?: string;
  connectorFunction?: string;
  quantity?: number;
  id?: string;
  [key: string]: unknown;
}

export interface VlhAttributes {
  type: VlhType | string;
  attributes: {
    PRODUCT_TYPE?: string;
    HEIGHT_EIA?: number | string;
    EIA_U_CAPACITY?: number | string;
    CONNECTORPORT?: number | string;
    LENGTH?: number | string;
    CABLE_COLOR?: string;
    [key: string]: unknown;
  };
  connectors: VlhConnectorRecord[];
}

/**
 * Queries available network topologies, connector functions, and RPQ placeholders
 * for Neptune water-cooling and VLH items.
 */
export async function fetchVlhWizardInfo(
  http: DcscHttpClient,
  ctx: RequestCtx,
): Promise<VlhWizardInfo> {
  const res = await http.send({
    endpoint: 'vlh.wizardInfo',
    method: 'GET',
    path: '/vlh/wizardInfo',
    requiresSolution: false,
    responseKind: 'json',
    ctx,
  });
  return res.raw as VlhWizardInfo;
}

/**
 * Queries physical dimensions, EIA U-height/capacity, and connector definitions
 * for a product or VLH item.
 */
export async function fetchVlhAttributes(
  http: DcscHttpClient,
  code: string,
  ctx: RequestCtx,
): Promise<VlhAttributes> {
  if (!code || typeof code !== 'string') {
    throw new Error('A non-empty product or VLH item code is required.');
  }
  const res = await http.send({
    endpoint: 'vlh.attributes',
    method: 'GET',
    path: `/vlh/attributes/${encodeURIComponent(code)}`,
    requiresSolution: false,
    responseKind: 'json',
    ctx,
  });
  return res.raw as VlhAttributes;
}

export const VLH_PRODUCT_TYPE = 'VLH';

/** One VLH Item Editor entry as the SPA posts it to the export. */
export interface VlhItem {
  vlhId: string;
  vlhType: VlhType;
  commonInfo: { description: string; listPrice: number; productType: string; [key: string]: unknown };
  connectors: VlhConnectorRecord[];
  attributes: Array<Record<string, unknown>>;
  bundledParts: Array<Record<string, unknown>>;
}

/** The 14-field export form of the captured POST /vlh/export/xml; only `data` carries content. */
export function buildVlhExportForm(items: readonly VlhItem[]): Record<string, string> {
  return {
    data: JSON.stringify(items), crnId: '', userGeneratedConfigId: '', lfoCode: '', cancelDownload: 'false',
    multipleProductData: '', excelData: '', groups: '', integrationParams: '', image: '', user: '',
    'dcsc-isFromIntegration': 'false', serviceAndorRequest: '', uuid: '',
  };
}

/** Export Items: the VLH item definitions as a .vlh (VLHData XML) download stream. */
export async function exportVlhItems(http: DcscHttpClient, items: readonly VlhItem[], ctx: RequestCtx) {
  if (items.length === 0) throw new Error('At least one VLH item is required.');
  return http.send({
    endpoint: 'vlh.export',
    method: 'POST',
    path: '/vlh/export/xml',
    body: { kind: 'form', fields: buildVlhExportForm(items) },
    requiresSolution: false,
    responseKind: 'stream',
    timeoutClass: 'export',
    ctx,
  });
}

/** Import Items: uploads a .vlh file as the multipart part `vlhXmlFile`. */
export async function importVlhItems(http: DcscHttpClient, file: { fileName: string; content: Uint8Array }, ctx: RequestCtx) {
  const res = await http.send({
    endpoint: 'vlh.import',
    method: 'POST',
    path: '/vlh/import',
    body: { kind: 'multipart', parts: [{ name: 'vlhXmlFile', filename: file.fileName, contentType: 'application/octet-stream', content: file.content }] },
    requiresSolution: false,
    responseKind: 'json',
    timeoutClass: 'interactive',
    ctx,
  });
  return res.raw;
}
