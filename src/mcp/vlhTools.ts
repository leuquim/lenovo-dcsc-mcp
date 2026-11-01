import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { inspectVirtualContainers, inspectVlh, VIRTUAL_CONTAINER_CHECKS, VLH_SECTIONS } from '../app/vlh.js';
import type { DcscService } from './service.js';
import { guard } from './toolSupport.js';

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
}
