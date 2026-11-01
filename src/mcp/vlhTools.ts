import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { exportVlh, importVlh, inspectVirtualContainers, inspectVlh, VIRTUAL_CONTAINER_CHECKS, VLH_SECTIONS } from '../app/vlh.js';
import { VLH_TYPES } from '../domain/vlh.js';
import type { DcscService } from './service.js';
import { guard } from './toolSupport.js';

const vlhItemSchema = z.object({
  vlhType: z.enum(VLH_TYPES).default('basic'),
  description: z.string().min(1),
  listPrice: z.number().min(0).optional(),
  vlhId: z.string().min(1).optional().describe('Defaults to a new UUID.'),
  commonInfo: z.record(z.string(), z.unknown()).optional().describe('Extra Item Editor fields, e.g. partNumber, machineType.'),
  connectors: z.array(z.record(z.string(), z.unknown())).optional().describe('Entries shaped like dcsc_vlh_get connectors.'),
  attributes: z.array(z.record(z.string(), z.unknown())).optional(),
  bundledParts: z.array(z.record(z.string(), z.unknown())).optional(),
});

export function registerVlhTools(server: McpServer, service: DcscService): void {
  server.registerTool('dcsc_vlh_get', {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'VLH wizard info and attributes',
    description: 'Reads the VLH wizard info (network topologies, connectors, connector functions, RPQ placeholders), or the physical dimensions, U-height and connectors of a product or VLH item code.',
    inputSchema: {
      section: z.enum(VLH_SECTIONS).optional().describe('Wizard info section; omit for all.'),
      code: z.string().min(1).optional().describe('Product machine type or VLH item code; returns its attributes instead of the wizard info.'),
    },
  }, args => guard(() => inspectVlh(service, args), 'dcsc_vlh_get failed'));

  server.registerTool('dcsc_virtual_container_get', {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Virtual container checks',
    description: 'Reads the compatible inner products and categories, or the multi-product rule results, of the virtual containers in a workspace.',
    inputSchema: {
      session: z.string().describe('Workspace handle.'),
      check: z.enum(VIRTUAL_CONTAINER_CHECKS).default('compatibleProducts'),
      expectedRevision: z.number().int().min(1).optional().describe('Workspace revision.'),
    },
  }, args => guard(() => inspectVirtualContainers(service, args.session,
    { check: args.check ?? 'compatibleProducts', expectedRevision: args.expectedRevision }), 'dcsc_virtual_container_get failed'));

  server.registerTool('dcsc_vlh_set', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    title: 'VLH Item Editor export and import',
    description: 'Creates VLH items as the VLH Item Editor does and exports them (action export, default) to a .vlh file, returning its path; or imports a .vlh file (action import).',
    inputSchema: {
      action: z.enum(['export', 'import']).optional().default('export'),
      items: z.array(vlhItemSchema).min(1).max(50).optional().describe('export: the items to create.'),
      fileName: z.string().min(1).optional().describe('export: base name without extension; defaults to vlh.'),
      filePath: z.string().min(1).optional().describe('import: absolute path of a .vlh file.'),
    },
  }, args => guard(() => {
    if (args.action === 'import') {
      if (!args.filePath) throw new Error('filePath is required for action import.');
      return importVlh(service, { filePath: args.filePath });
    }
    if (!args.items) throw new Error('items is required for action export.');
    return exportVlh(service, { items: args.items, fileName: args.fileName });
  }, 'dcsc_vlh_set failed'));
}
