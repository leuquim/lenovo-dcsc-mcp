import { buildAutoDeriveRequest } from './reduce.js';
/**
 * Fetches compatible inner products and categories for virtual containers
 * in the current workspace.
 */
export async function fetchVirtualContainerCompatibleProducts(http, workspace, ctx) {
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
    return (res.raw ?? []);
}
/**
 * Evaluates multi-product rules across virtual container hierarchies
 * in the current workspace.
 */
export async function checkVirtualContainerRules(http, workspace, ctx) {
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
    return (res.raw ?? []);
}
//# sourceMappingURL=virtualContainers.js.map