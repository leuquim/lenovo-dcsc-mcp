import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DcscHttpClient, RequestCtx } from '../http/request.js';

export interface ExportConfigurationTreeInput {
  name: string;
  dataList: Array<{
    typeName: string;
    contents: string[];
  }>;
  outputPath?: string;
}

export interface ExportConfigurationTreeResult {
  filename: string;
  mimeType: string;
  bytes: number;
  base64: string;
  savedPath?: string;
}

/**
 * Exports configuration tree as an Excel spreadsheet (.xlsx).
 * Endpoint: POST /ctos/export/configurationTree
 */
export async function exportConfigurationTree(
  http: DcscHttpClient,
  ctx: RequestCtx,
  input: ExportConfigurationTreeInput,
): Promise<ExportConfigurationTreeResult> {
  const payload = {
    name: input.name,
    dataList: input.dataList,
  };

  const res = await http.send({
    endpoint: 'ctos_export_configuration_tree',
    method: 'POST',
    path: '/ctos/export/configurationTree',
    body: { kind: 'json', value: payload },
    responseKind: 'stream',
    timeoutClass: 'export',
    ctx,
  });

  const chunks: Buffer[] = [];
  for await (const chunk of res.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);

  const filename = `${input.name || 'configuration'}.xlsx`;
  const mimeType = res.contentType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;charset=utf-8';
  const base64 = buffer.toString('base64');
  const bytes = buffer.length;

  let savedPath: string | undefined;
  if (input.outputPath) {
    savedPath = path.resolve(input.outputPath);
    await fs.mkdir(path.dirname(savedPath), { recursive: true });
    await fs.writeFile(savedPath, buffer);
  }

  return {
    filename,
    mimeType,
    bytes,
    base64,
    ...(savedPath ? { savedPath } : {}),
  };
}
