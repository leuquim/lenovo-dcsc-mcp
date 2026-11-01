import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import type { WorkspaceSession } from '../model/session.js';
import { buildAutoDeriveRequest } from './reduce.js';

export interface VirtualCompatibleProduct {
  code: string;
  description?: string;
  type?: string;
  [key: string]: unknown;
}

export interface VirtualContainerCompatibleCategory {
  id: string;
  compatibleProducts: VirtualCompatibleProduct[];
  [key: string]: unknown;
}

/**
 * Fetches compatible inner products and categories for virtual containers
 * in the current workspace.
 */
export async function fetchVirtualContainerCompatibleProducts(
  http: DcscHttpClient,
  workspace: WorkspaceSession,
  ctx: RequestCtx,
): Promise<VirtualContainerCompatibleCategory[]> {
  const wire = buildAutoDeriveRequest(workspace, {
    validationMode: workspace.validationMode ?? 'guided',
  });
  const res = await http.send({
    endpoint: 'virtualContainers.compatibleProducts',
    method: 'POST',
    path: '/virtual-containers/getCompatibleProductsForVirtualContainer',
    body: { kind: 'json', value: wire },
    responseKind: 'json',
    ctx,
  });
  return (res.raw ?? []) as VirtualContainerCompatibleCategory[];
}

/**
 * Evaluates multi-product rules across virtual container hierarchies
 * in the current workspace.
 */
export async function checkVirtualContainerRules(
  http: DcscHttpClient,
  workspace: WorkspaceSession,
  ctx: RequestCtx,
): Promise<unknown[]> {
  const wire = buildAutoDeriveRequest(workspace, {
    validationMode: workspace.validationMode ?? 'guided',
  });
  const res = await http.send({
    endpoint: 'virtualContainers.checkIfAnythingNeedUpdate',
    method: 'POST',
    path: '/virtual-containers/checkIfAnythingNeedUpdate',
    body: { kind: 'json', value: wire },
    responseKind: 'json',
    ctx,
  });
  return (res.raw ?? []) as unknown[];
}
