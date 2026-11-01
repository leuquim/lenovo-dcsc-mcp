import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { BASKET_ACTIONS, BASKETS, basketBrowse, basketSet } from '../app/standalone.js';
import type { DcscService } from './service.js';
import { guard } from './toolSupport.js';

export function registerStandaloneTools(server: McpServer, service: DcscService): void {

  server.registerTool(
    'dcsc_basket_browse',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Browse a standalone software or services basket',
      description:
        'Pages through the software catalog or the service options already loaded into a workspace, with list prices. Select items with dcsc_basket_set.',
      inputSchema: {
        session: z.string().describe('Workspace holding the basket.'),
        basket: z.enum(['software', 'services']),
        query: z.string().optional(),
        tab: z.string().optional().describe('software: catalog tab.'),
        subTab: z.string().optional().describe('software: catalog sub-tab.'),
        section: z.string().optional().describe('software: catalog section.'),
        subCategory: z.string().optional().describe('software: catalog sub-category.'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(1000).optional().describe('Rows per page (capped at 50), or characters on a detail page.'),
        path: z.array(z.string()).optional().describe('software: detail path from a continuation.'),
        expectedCatalogFingerprint: z.string().optional().describe('software: fingerprint from a continuation.'),
      },
    },
    async (args) => guard(() => basketBrowse(service, args), 'dcsc_basket_browse failed'),
  );

  server.registerTool(
    'dcsc_basket_set',
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      title: 'Change a standalone basket',
      description:
        'Adds, changes the quantity of or removes an item in a standalone software, hardware or services basket, and returns the updated basket. Hardware select without session creates a new workspace.',
      inputSchema: {
        session: z.string().optional().describe('Workspace handle; optional only for hardware select.'),
        basket: z.enum(BASKETS),
        action: z.enum(BASKET_ACTIONS).describe('select adds or replaces; setQuantity changes a selected item; remove deletes it; setProductQuantity (services) sets the covered-product count.'),
        code: z.string().min(1).optional().describe('Part or service code. services setQuantity/remove may omit it when one service is selected.'),
        quantity: z.number().int().min(1).max(99999).optional().describe('Required except for remove; select defaults to 1.'),
        solutionMode: z.string().optional().describe('hardware select without session: solution mode.'),
        label: z.string().optional().describe('hardware select without session: workspace label.'),
        expectedRevision: z.number().int().min(1).optional().describe('Workspace revision.'),
      },
    },
    async (args) => guard(() => basketSet(service, args), 'dcsc_basket_set failed'),
  );
}
