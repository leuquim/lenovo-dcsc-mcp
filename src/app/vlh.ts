import { fetchVlhAttributes, fetchVlhWizardInfo } from '../domain/vlh.js';
import { checkVirtualContainerRules, fetchVirtualContainerCompatibleProducts } from '../domain/virtualContainers.js';
import type { Runtime } from './runtime.js';
import { assertWorkspaceRevision } from './serviceHelpers.js';

export const VLH_SECTIONS = ['topologies', 'connectors', 'functions', 'rpq'] as const;
export type VlhSection = typeof VLH_SECTIONS[number];

export const VIRTUAL_CONTAINER_CHECKS = ['compatibleProducts', 'rules'] as const;
export type VirtualContainerCheck = typeof VIRTUAL_CONTAINER_CHECKS[number];

/** VLH wizard info (whole or one section), or the physical attributes of a product or VLH item code. */
export async function inspectVlh(rt: Runtime, opts: { section?: VlhSection | undefined; code?: string | undefined }) {
  if (opts.code !== undefined) {
    if (opts.section !== undefined) throw new Error('Pass either section or code, not both.');
    return fetchVlhAttributes(rt.http, opts.code, rt.newCtx());
  }
  const info = await fetchVlhWizardInfo(rt.http, rt.newCtx());
  switch (opts.section) {
    case 'topologies': return { networkTopologies: info.networkTopologies };
    case 'connectors': return { networkTopologyConnectorsMap: info.networkTopologyConnectorsMap };
    case 'functions': return { connectorFunctions: info.connectorFunctions };
    case 'rpq': return { rpqPlaceholders: info.rpqPlaceholders };
    default: return info;
  }
}

/** Virtual-container compatible products or multi-product rule results for a workspace. */
export async function inspectVirtualContainers(rt: Runtime, handle: string, opts: {
  check: VirtualContainerCheck; expectedRevision?: number | undefined;
}) {
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error(`Workspace session ${handle} not found. Use dcsc_session_list to see open sessions.`);
  assertWorkspaceRevision(workspace, opts.expectedRevision);
  const ctx = rt.newCtx({ locale: workspace.locale, solution: workspace.solution });
  const result = opts.check === 'rules'
    ? { rules: await checkVirtualContainerRules(rt.http, workspace, ctx) }
    : { categories: await fetchVirtualContainerCompatibleProducts(rt.http, workspace, ctx) };
  return { session: handle, revision: workspace.revision, ...result };
}
