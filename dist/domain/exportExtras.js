import { writeSpreadsheetArtifact } from '../files/artifactStore.js';
import { exportXlsPath } from './endpoints.js';
import { hardwareEndpointFamily } from './modeFamily.js';
/**
 * Exports the power report as an Excel spreadsheet (.xlsx) into the artifact store.
 * Endpoints: POST /ctos/power/export_xls, POST /lfos/power/export_xls
 */
export async function exportPowerXls(http, ctx, config, input) {
    const res = await http.send({
        endpoint: `${input.mode}_power_export_xls`,
        method: 'POST',
        path: exportXlsPath(hardwareEndpointFamily(input.mode)),
        query: { fileName: input.fileName },
        body: { kind: 'form', fields: input.exportFormPayload },
        responseKind: 'stream',
        timeoutClass: 'export',
        ctx,
    });
    return writeSpreadsheetArtifact(res.stream, input.fileName, config);
}
/**
 * Fetches shareable DCSC web URL for a configuration.
 * Endpoint: GET /copy/url?configuration_id=...
 */
export async function fetchShareUrl(http, ctx, configurationId) {
    const res = await http.send({
        endpoint: 'copy_url',
        method: 'GET',
        path: '/copy/url',
        query: { configuration_id: configurationId },
        responseKind: 'text',
        timeoutClass: 'interactive',
        requiresSolution: false,
        ctx,
    });
    const raw = res.raw;
    const rec = raw && typeof raw === 'object' ? raw : undefined;
    const candidate = typeof raw === 'string' ? raw : (rec?.url ?? rec?.shareUrl);
    const shareUrl = typeof candidate === 'string' ? candidate.trim() : '';
    if (!/^https?:\/\//i.test(shareUrl)) {
        throw new Error('DCSC returned no recognisable share URL.');
    }
    return { shareUrl };
}
//# sourceMappingURL=exportExtras.js.map