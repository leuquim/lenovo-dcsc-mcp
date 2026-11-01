import type { Config } from '../config/schema.js';
import { writeSpreadsheetArtifact, type SpreadsheetArtifact } from '../files/artifactStore.js';
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
export async function exportConfigurationTree(
  http: DcscHttpClient,
  ctx: RequestCtx,
  config: Config,
  input: ExportConfigurationTreeInput,
): Promise<SpreadsheetArtifact> {
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
