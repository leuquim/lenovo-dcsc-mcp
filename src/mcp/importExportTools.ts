import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { CONFIG_MODES } from '../config/constants.js';
import { EXPORT_KINDS, exportArtifact, importArtifact } from '../app/importExport.js';
import { EXPORT_FILE_TYPES } from '../domain/reduce.js';
import type { DcscService } from './service.js';
import { guard } from './toolSupport.js';

const EXPORT_TYPE_NAMES = Object.keys(EXPORT_FILE_TYPES) as [keyof typeof EXPORT_FILE_TYPES, ...Array<keyof typeof EXPORT_FILE_TYPES>];

export function registerImportExportTools(server: McpServer, service: DcscService): void {

  server.registerTool(
    'dcsc_import',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: 'Import a configuration',
      description:
        'Imports a Lenovo CFXML or Excel file, or an XML string, into a new or existing workspace. Provide exactly one of filePath or content.',
      inputSchema: {
        filePath: z.string().optional().describe('Absolute path to a CFXML (.xml) or DCSC Excel (.xlsx/.xls) file.'),
        content: z.string().optional().describe('CFXML content string.'),
        mode: z.enum(CONFIG_MODES).optional(),
        session: z.string().optional().describe('Existing workspace to import into; omit to create one.'),
        expectedRevision: z.number().int().min(1).optional().describe('Workspace revision; fails if the workspace moved on.'),
        solutionMode: z.string().optional().describe('Defaults to the workspace mode, else the XML declaration, else General Purpose.'),
      },
    },
    async (args) => guard(() => importArtifact(service, args), 'dcsc_import failed'),
  );

  server.registerTool(
    'dcsc_export',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: 'Export to a file',
      description:
        'Exports to local files and returns their paths. kind: reports (ZIP of CFXML and Excel reports for a configuration or workspace, including standalone software and services), power (power report spreadsheet), configurationTree (tree spreadsheet), reference (original Lenovo reference-solution XML), servicesCatalog (Services page zip: one product's service catalog, or the whole country catalog without productCode).',
      inputSchema: {
        kind: z.enum(EXPORT_KINDS),
        session: z.string().optional().describe('Configuration or workspace handle. Required for reports and power.'),
        scope: z.enum(['auto', 'configuration', 'workspace']).optional().describe('reports/power: auto (default) follows the handle type.'),
        fileName: z.string().optional().describe('reports/power/servicesCatalog: base name without extension.'),
        fileTypes: z.array(z.enum(EXPORT_TYPE_NAMES)).min(1).optional().describe('reports/power: defaults to all applicable reports.'),
        includeShareUrl: z.boolean().optional().describe('reports/power: include the shareable web URL.'),
        name: z.string().optional().describe('configurationTree: configuration name or display code.'),
        dataList: z.array(z.object({ typeName: z.string(), contents: z.array(z.string()) })).optional()
          .describe('configurationTree: type categories and their contents.'),
        crnId: z.string().max(160).optional().describe('reference: crnId or sidNumber from dcsc_reference_solutions.'),
        productCode: z.string().optional().describe('servicesCatalog: product whose service catalog to export.'),
        solutionMode: z.string().optional().describe('reference: solution mode.'),
      },
    },
    async (args) => guard(() => exportArtifact(service, args), 'dcsc_export failed'),
  );
}
