import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { writeVlhArtifact } from '../files/artifactStore.js';
import { exportVlhItems, importVlhItems, fetchVlhAttributes, fetchVlhWizardInfo, VLH_PRODUCT_TYPE } from '../domain/vlh.js';
import { checkVirtualContainerRules, fetchVirtualContainerCompatibleProducts } from '../domain/virtualContainers.js';
import { assertWorkspaceRevision } from './serviceHelpers.js';
export const VLH_SECTIONS = ['topologies', 'connectors', 'functions', 'rpq'];
export const VIRTUAL_CONTAINER_CHECKS = ['compatibleProducts', 'rules'];
/** VLH wizard info (whole or one section), or the physical attributes of a product or VLH item code. */
export async function inspectVlh(rt, opts) {
    if (opts.code !== undefined) {
        if (opts.section !== undefined)
            throw new Error('Pass either section or code, not both.');
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
export async function inspectVirtualContainers(rt, handle, opts) {
    const workspace = rt.sessions.getWorkspace(handle);
    if (!workspace)
        throw new Error(`Workspace session ${handle} not found. Use dcsc_session_list to see open sessions.`);
    assertWorkspaceRevision(workspace, opts.expectedRevision);
    const ctx = rt.newCtx({ locale: workspace.locale, solution: workspace.solution });
    const result = opts.check === 'rules'
        ? { rules: await checkVirtualContainerRules(rt.http, workspace, ctx) }
        : { categories: await fetchVirtualContainerCompatibleProducts(rt.http, workspace, ctx) };
    return { session: handle, revision: workspace.revision, ...result };
}
/** Builds the item the VLH Item Editor creates, with the defaults its wizard fills in. */
export function buildVlhItem(input) {
    return {
        commonInfo: { ...input.commonInfo, description: input.description, listPrice: input.listPrice ?? 0, productType: VLH_PRODUCT_TYPE },
        vlhId: input.vlhId ?? randomUUID(),
        vlhType: input.vlhType,
        connectors: input.connectors ?? [],
        attributes: input.attributes ?? [],
        bundledParts: input.bundledParts ?? [{}],
    };
}
/** Export Items: builds the VLH items and writes the downloaded .vlh file to the artifact store. */
export async function exportVlh(rt, opts) {
    const response = await exportVlhItems(rt.http, opts.items.map(buildVlhItem), rt.newCtx());
    return writeVlhArtifact(response.stream, opts.fileName ?? 'vlh', rt.config);
}
/** Import Items: uploads a .vlh file to the VLH Item Editor. */
export async function importVlh(rt, opts) {
    const items = await importVlhItems(rt.http, { fileName: basename(opts.filePath), content: readFileSync(opts.filePath) }, rt.newCtx());
    return { imported: items };
}
//# sourceMappingURL=vlh.js.map