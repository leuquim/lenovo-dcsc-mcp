import type { DcscHttpClient, RequestCtx } from '../http/request.js';

/**
 * The fabric vocabulary DCSC exposes for multi-node solutions.
 *
 * An AI factory is defined as much by its interconnect as by its nodes, so the
 * available topologies (IB_XDR, 400/800GbE) and node roles are what an
 * architect reaches for first when sizing a cluster.
 */

export interface NetworkTopology {
  shortName: string;
  description: string;
}

export interface NodeRole {
  role: string;
  description: string;
}

export interface StorageSwitch {
  option: string;
  featureCode?: string | undefined;
  description: string;
  price?: number | undefined;
}

export interface FabricOptions {
  topologies: NetworkTopology[];
  nodeRoles: NodeRole[];
  storageSwitches: StorageSwitch[];
}

type Obj = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export async function fetchFabricOptions(
  http: DcscHttpClient,
  ctx: RequestCtx,
): Promise<FabricOptions> {
  const [topo, roles, storage] = await Promise.all([
    http.send({
      endpoint: 'getTopologies',
      method: 'GET',
      path: '/getTopologies',
      responseKind: 'json',
      timeoutClass: 'fast',
      ctx,
    }),
    http.send({
      endpoint: 'node_roles',
      method: 'GET',
      path: '/node_roles',
      responseKind: 'json',
      timeoutClass: 'fast',
      ctx,
    }),
    http.send({
      endpoint: 'getStoragePreferences',
      method: 'GET',
      path: '/getStoragePreferences',
      responseKind: 'json',
      timeoutClass: 'fast',
      ctx,
    }),
  ]);

  const topologies: NetworkTopology[] = [];
  const topoRoot = topo.raw as { networkTopology?: unknown } | null;
  if (topoRoot && Array.isArray(topoRoot.networkTopology)) {
    for (const t of topoRoot.networkTopology as Obj[]) {
      const shortName = str(t['shortName']);
      if (!shortName) continue;
      topologies.push({ shortName, description: str(t['description']) ?? shortName });
    }
  }

  const nodeRoles: NodeRole[] = [];
  for (const r of (roles.raw as Obj[]) ?? []) {
    const role = str(r['role']);
    if (!role) continue;
    nodeRoles.push({ role, description: str(r['description']) ?? role });
  }

  const storageSwitches: StorageSwitch[] = [];
  const storageRoot = storage.raw as { switches?: unknown } | null;
  if (storageRoot && Array.isArray(storageRoot.switches)) {
    for (const s of storageRoot.switches as Obj[]) {
      const option = str(s['option']);
      if (!option) continue;
      storageSwitches.push({
        option,
        featureCode: str(s['featureCode']),
        description: str(s['description']) ?? '',
        ...(typeof s['price'] === 'number' ? { price: s['price'] } : {}),
      });
    }
  }

  return { topologies, nodeRoles, storageSwitches };
}
