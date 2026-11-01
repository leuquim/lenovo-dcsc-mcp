import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DcscHttpClient, RequestCtx } from '../http/request.js';

export interface ExportPowerOrGroupXlsInput {
  mode: 'cto' | 'lfo';
  reportType: 'power' | 'group';
  fileName: string;
  exportFormPayload: Record<string, string>;
  outputPath?: string | undefined;
}

export interface ExportP2pReportInput {
  payload?: Record<string, unknown> | undefined;
  fileName?: string | undefined;
  outputPath?: string | undefined;
  [key: string]: unknown;
}

export interface ExportDeliverableResult {
  filename: string;
  mimeType: string;
  bytes: number;
  base64: string;
  savedPath?: string | undefined;
}

export interface ShareUrlResult {
  shareUrl: string;
  raw: unknown;
}

/**
 * Exports power or quote group report as an Excel spreadsheet (.xlsx).
 * Endpoints:
 * - POST /ctos/power/export_xls
 * - POST /ctos/group/export_xls
 * - POST /lfos/power/export_xls
 * - POST /lfos/group/export_xls
 */
export async function exportPowerOrGroupXls(
  http: DcscHttpClient,
  ctx: RequestCtx,
  input: ExportPowerOrGroupXlsInput,
): Promise<ExportDeliverableResult> {
  const prefix = input.mode === 'lfo' ? '/lfos' : '/ctos';
  const subpath = input.reportType === 'power' ? 'power' : 'group';
  const endpointPath = `${prefix}/${subpath}/export_xls`;
  const endpointId = `${input.mode}_${subpath}_export_xls`;

  const res = await http.send({
    endpoint: endpointId,
    method: 'POST',
    path: endpointPath,
    query: { fileName: input.fileName },
    body: { kind: 'form', fields: input.exportFormPayload },
    responseKind: 'stream',
    timeoutClass: 'export',
    ctx,
  });

  const chunks: Buffer[] = [];
  for await (const chunk of res.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);

  const filename = input.fileName.endsWith('.xlsx') ? input.fileName : `${input.fileName}.xlsx`;
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

/**
 * Exports P2P cabling report as an Excel spreadsheet (.xlsx).
 * Endpoint: POST /p2p-report
 */
export async function exportP2pReport(
  http: DcscHttpClient,
  ctx: RequestCtx,
  payload: Record<string, unknown>,
  opts?: { fileName?: string | undefined; outputPath?: string | undefined },
): Promise<ExportDeliverableResult> {
  const fileName = opts?.fileName
    ?? (typeof payload.fileName === 'string' ? payload.fileName : 'P2P_Report.xlsx');
  const outputPath = opts?.outputPath
    ?? (typeof payload.outputPath === 'string' ? payload.outputPath : undefined);

  const dataField = typeof payload['data'] === 'string'
    ? (payload['data'] as string)
    : JSON.stringify(payload);

  const res = await http.send({
    endpoint: 'cabling_p2p_report',
    method: 'POST',
    path: '/p2p-report',
    query: { fileName },
    body: { kind: 'form', fields: { data: dataField } },
    responseKind: 'stream',
    timeoutClass: 'export',
    ctx,
  });

  const chunks: Buffer[] = [];
  for await (const chunk of res.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);

  const filename = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  const mimeType = res.contentType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;charset=utf-8';
  const base64 = buffer.toString('base64');
  const bytes = buffer.length;

  let savedPath: string | undefined;
  if (outputPath) {
    savedPath = path.resolve(outputPath);
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

/**
 * Fetches shareable DCSC web URL for a configuration.
 * Endpoint: GET /copy/url?configuration_id=...
 */
export async function fetchShareUrl(
  http: DcscHttpClient,
  ctx: RequestCtx,
  configurationId: string,
): Promise<ShareUrlResult> {
  const res = await http.send({
    endpoint: 'copy_url',
    method: 'GET',
    path: '/copy/url',
    query: { configuration_id: configurationId },
    responseKind: 'json',
    timeoutClass: 'interactive',
    requiresSolution: false,
    ctx,
  });

  const raw = res.raw;
  let shareUrl = '';
  if (typeof raw === 'string') {
    shareUrl = raw;
  } else if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    shareUrl = typeof rec.url === 'string' ? rec.url : (typeof rec.shareUrl === 'string' ? rec.shareUrl : JSON.stringify(raw));
  }

  return {
    shareUrl,
    raw,
  };
}
