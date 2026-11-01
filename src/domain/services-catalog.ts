import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import type { Obj } from '../util/coerce.js';

/**
 * Anonymous services catalogue from /service/portal/categories.
 *
 * This lists service *categories* (Advise, Deploy, …). Selecting and pricing
 * specific warranty SKUs still goes through the configuration's Services tab
 * (auto-attached when serviceCto=true) or may require entitlement for the
 * full services portal workflow — probe before claiming selection works.
 */

export interface ServiceCategory {
  id: string;
  title: string;
  description: string;
  children: ServiceCategory[];
}


function walk(node: Obj): ServiceCategory | undefined {
  const id = node['id'];
  if (typeof id !== 'string') return undefined;
  const children: ServiceCategory[] = [];
  for (const c of (node['children'] as Obj[] | undefined) ?? []) {
    const child = walk(c);
    if (child) children.push(child);
  }
  return {
    id,
    title: String(node['title'] ?? id),
    description: String(node['description'] ?? ''),
    children,
  };
}

export async function fetchServicePortalCategories(
  http: DcscHttpClient,
  ctx: RequestCtx,
): Promise<ServiceCategory | undefined> {
  const res = await http.send({
    endpoint: 'service_portal_categories',
    method: 'GET',
    path: '/service/portal/categories',
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx,
  });
  if (typeof res.raw !== 'object' || res.raw === null) return undefined;
  return walk(res.raw as Obj);
}
