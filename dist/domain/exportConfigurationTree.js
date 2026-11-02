import { writeSpreadsheetArtifact } from '../files/artifactStore.js';
/**
 * Exports configuration tree as an Excel spreadsheet (.xlsx) into the artifact store.
 * Endpoint: POST /ctos/export/configurationTree
 */
export async function exportConfigurationTree(http, ctx, config, input) {
    const res = await http.send({
        endpoint: 'ctos_export_configuration_tree',
        method: 'POST',
        path: '/ctos/export/configurationTree',
        body: { kind: 'json', value: { name: input.name, dataList: input.dataList } },
        responseKind: 'stream',
        timeoutClass: 'export',
        ctx,
    });
    return writeSpreadsheetArtifact(res.stream, input.name || 'configuration', config);
}
//# sourceMappingURL=exportConfigurationTree.js.map