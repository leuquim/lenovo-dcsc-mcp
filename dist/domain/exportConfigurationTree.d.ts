import type { Config } from '../config/schema.js';
import { type SpreadsheetArtifact } from '../files/artifactStore.js';
import type { DcscHttpClient, RequestCtx } from '../http/request.js';
export interface ExportConfigurationTreeInput {
    name: string;
    dataList: Array<{
        typeName: string;
        contents: string[];
    }>;
}
/**
 * Exports configuration tree as an Excel spreadsheet (.xlsx) into the artifact store.
 * Endpoint: POST /ctos/export/configurationTree
 */
export declare function exportConfigurationTree(http: DcscHttpClient, ctx: RequestCtx, config: Config, input: ExportConfigurationTreeInput): Promise<SpreadsheetArtifact>;
