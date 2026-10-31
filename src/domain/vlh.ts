import type { DcscHttpClient, RequestCtx } from '../http/request.js';

export type VlhType =
  | 'basic'
  | 'switch'
  | 'networking-adapter'
  | 'networking-cable'
  | 'server'
  | 'rack'
  | 'chassis';

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
    responseKind: 'json',
    ctx,
  });
  return res.raw as VlhAttributes;
}
