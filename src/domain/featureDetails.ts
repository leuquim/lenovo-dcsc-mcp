import type { DcscHttpClient, RequestCtx } from '../http/request.js';

export interface FeaturePriceDetail {
  priceTypeId: number;
  price: number;
  priceNotAvailable?: boolean | undefined;
}

export interface UpstreamFeatureDetail {
  code: string;
  displayCode?: string | undefined;
  category?: string | undefined;
  description: string;
  unitPrice?: number | undefined;
  prices?: FeaturePriceDetail[] | undefined;
  priceNotAvailable?: boolean | undefined;
  priceNotCredible?: boolean | undefined;
  noCharge?: boolean | undefined;
  specialBid?: boolean | undefined;
  type?: string | undefined;
  announceDate?: string | undefined;
  withdrawnDate?: string | undefined;
  shippingStatus?: string[] | undefined;
  shipDate?: string | undefined;
  optionCode?: string | undefined;
  productNumber?: string | undefined;
  recommendedFeature?: boolean | undefined;
  topChoice?: boolean | undefined;
  isPinned?: boolean | undefined;
  eccnRestricted?: boolean | undefined;
  attributeMap?: Record<string, string> | undefined;
  attributeShowInPageMap?: Record<string, boolean> | undefined;
  attachedFeatures?: unknown[] | undefined;
  topologies?: unknown[] | undefined;
  marketingTag?: string[] | undefined;
  [key: string]: unknown;
}

export interface FeatureDetailsResultItem {
  id?: string | undefined;
  ctoCode: string;
  features: UpstreamFeatureDetail[];
}

/**
 * Queries Lenovo DCSC upstream POST /ctos/featureDetails for full spec details,
 * lifecycle dates, shipping lead times, commercial flags, and pricing.
 */
export async function fetchUpstreamFeatureDetails(
  http: DcscHttpClient,
  ctx: RequestCtx,
  ctoCode: string,
  sessionId: string,
  featureCodes: string[],
): Promise<UpstreamFeatureDetail[]> {
  if (!featureCodes || featureCodes.length === 0) {
    return [];
  }

  const payload = [
    {
      id: sessionId,
      ctoCode,
      resultFeatures: featureCodes.map((code) => ({
        code,
        ctoCode,
      })),
    },
  ];

  const res = await http.send({
    endpoint: 'feature_details',
    method: 'POST',
    path: '/ctos/featureDetails',
    body: { kind: 'json', value: payload },
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });

  const list = res.raw as FeatureDetailsResultItem[] | undefined;
  if (!Array.isArray(list) || list.length === 0) {
    return [];
  }

  return list[0]?.features ?? [];
}

export interface FeatureSpecSummary {
  code: string;
  displayCode?: string | undefined;
  category?: string | undefined;
  description: string;
  lifecycle: {
    announceDate?: string | undefined;
    withdrawnDate?: string | undefined;
    isWithdrawn: boolean;
  };
  supply: {
    shippingStatus?: string[] | undefined;
    shipDate?: string | undefined;
  };
  commercial: {
    topChoice: boolean;
    recommendedFeature: boolean;
    marketingTag: string[];
    eccnRestricted: boolean;
  };
  pricing: {
    unitPrice?: number | undefined;
    prices?: FeaturePriceDetail[] | undefined;
    specialBid?: boolean | undefined;
  };
  attributes?: Record<string, string> | undefined;
}

const FAR_FUTURE = '2999';

function checkWithdrawn(date?: string): boolean {
  if (!date || date.startsWith(FAR_FUTURE)) return false;
  return new Date(date).getTime() < Date.now();
}

/**
 * Summarizes an upstream feature detail into structured specs.
 */
export function summarizeFeatureSpec(detail: UpstreamFeatureDetail): FeatureSpecSummary {
  return {
    code: detail.code,
    ...(detail.displayCode ? { displayCode: detail.displayCode } : {}),
    ...(detail.category ? { category: detail.category } : {}),
    description: detail.description,
    lifecycle: {
      announceDate: detail.announceDate,
      withdrawnDate: detail.withdrawnDate,
      isWithdrawn: checkWithdrawn(detail.withdrawnDate),
    },
    supply: {
      shippingStatus: detail.shippingStatus,
      shipDate: detail.shipDate,
    },
    commercial: {
      topChoice: Boolean(detail.topChoice),
      recommendedFeature: Boolean(detail.recommendedFeature),
      marketingTag: Array.isArray(detail.marketingTag) ? detail.marketingTag : [],
      eccnRestricted: Boolean(detail.eccnRestricted),
    },
    pricing: {
      unitPrice: detail.unitPrice,
      prices: detail.prices,
      specialBid: detail.specialBid,
    },
    ...(detail.attributeMap ? { attributes: detail.attributeMap } : {}),
  };
}
