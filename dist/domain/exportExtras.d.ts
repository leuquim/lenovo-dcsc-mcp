import type { Config } from '../config/schema.js';
import { type SpreadsheetArtifact } from '../files/artifactStore.js';
import type { DcscHttpClient, RequestCtx } from '../http/request.js';
export interface ExportPowerXlsInput {
    mode: 'cto' | 'lfo';
    fileName: string;
    exportFormPayload: Record<string, string>;
}
export interface ShareUrlResult {
    shareUrl: string;
}
/**
 * Exports the power report as an Excel spreadsheet (.xlsx) into the artifact store.
 * Endpoints: POST /ctos/power/export_xls, POST /lfos/power/export_xls
 */
export declare function exportPowerXls(http: DcscHttpClient, ctx: RequestCtx, config: Config, input: ExportPowerXlsInput): Promise<SpreadsheetArtifact>;
/**
 * Fetches shareable DCSC web URL for a configuration.
 * Endpoint: GET /copy/url?configuration_id=...
 */
export declare function fetchShareUrl(http: DcscHttpClient, ctx: RequestCtx, configurationId: string): Promise<ShareUrlResult>;
