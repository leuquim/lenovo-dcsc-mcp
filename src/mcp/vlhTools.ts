import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { fetchVlhAttributes, fetchVlhWizardInfo } from '../domain/vlh.js';
import {
  checkVirtualContainerRules,
  fetchVirtualContainerCompatibleProducts,
} from '../domain/virtualContainers.js';
import type { DcscService } from './service.js';
import { guard, withToolSupport } from './toolSupport.js';

export function registerVlhTools(rawServer: McpServer, service: DcscService): void {
  const server = withToolSupport(rawServer);

  server.registerTool(
    'dcsc_vlh_wizard_info',
    {
      title: 'Inspect VLH Neptune wizard info',
      description:
        'Queries available network topologies, connector functions, and RPQ placeholder options for Neptune water-cooling and VLH items.',
      inputSchema: {
        section: z.enum(['topologies', 'connectors', 'functions', 'rpq']).optional().describe('Optional section to inspect.'),
      },
    },
    (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const info = await fetchVlhWizardInfo(service.http, ctx);
        if (args.section === 'topologies') return { networkTopologies: info.networkTopologies };
        if (args.section === 'connectors') return { networkTopologyConnectorsMap: info.networkTopologyConnectorsMap };
        if (args.section === 'functions') return { connectorFunctions: info.connectorFunctions };
        if (args.section === 'rpq') return { rpqPlaceholders: info.rpqPlaceholders };
        return info;
      }, 'dcsc_vlh_wizard_info failed'),
  );

  server.registerTool(
    'dcsc_vlh_attributes',
    {
      title: 'Inspect VLH physical attributes',
      description:
        'Inspects physical dimensions, EIA U-height/capacity, and connector definitions for any product or VLH item.',
      inputSchema: {
        code: z
          .string()
          .min(1)
          .describe('Product machine type code (e.g. 7D73CTO1WW) or VLH item code.'),
      },
    },
    args =>
      guard(async () => {
        const ctx = service.newCtx();
        return fetchVlhAttributes(service.http, args.code, ctx);
      }, 'dcsc_vlh_attributes failed'),
  );

  server.registerTool(
    'dcsc_virtual_container_compatible_products',
    {
      title: 'Fetch compatible products for virtual containers',
      description:
        'Fetches compatible inner products and categories for virtual containers in the current workspace.',
      inputSchema: {
        session: z.string().describe('Workspace session handle (accepts workspace alias).'),
        expectedWorkspaceRevision: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Expected workspace revision.'),
      },
    },
    args =>
      guard(async () => {
        const workspace = service.sessions.getWorkspace(args.session);
        if (!workspace) {
          throw new Error(
            `Workspace session ${args.session} not found. Use dcsc_session_list to see open sessions.`,
          );
        }
        if (
          args.expectedWorkspaceRevision !== undefined &&
          workspace.revision !== args.expectedWorkspaceRevision
        ) {
          throw new Error(
            `Workspace revision conflict: expected revision ${args.expectedWorkspaceRevision}, but current revision is ${workspace.revision}.`,
          );
        }
        const ctx = service.newCtx({ locale: workspace.locale, solution: workspace.solution });
        const categories = await fetchVirtualContainerCompatibleProducts(
          service.http,
          workspace,
          ctx,
        );
        return {
          workspace: workspace.id,
          revision: workspace.revision,
          categories,
        };
      }, 'dcsc_virtual_container_compatible_products failed'),
  );

  server.registerTool(
    'dcsc_virtual_container_check_rules',
    {
      title: 'Check virtual container rules',
      description:
        'Evaluates multi-product rules across virtual container hierarchies in the current workspace.',
      inputSchema: {
        session: z.string().describe('Workspace session handle (accepts workspace alias).'),
        expectedWorkspaceRevision: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Expected workspace revision.'),
      },
    },
    args =>
      guard(async () => {
        const workspace = service.sessions.getWorkspace(args.session);
        if (!workspace) {
          throw new Error(
            `Workspace session ${args.session} not found. Use dcsc_session_list to see open sessions.`,
          );
        }
        if (
          args.expectedWorkspaceRevision !== undefined &&
          workspace.revision !== args.expectedWorkspaceRevision
        ) {
          throw new Error(
            `Workspace revision conflict: expected revision ${args.expectedWorkspaceRevision}, but current revision is ${workspace.revision}.`,
          );
        }
        const ctx = service.newCtx({ locale: workspace.locale, solution: workspace.solution });
        const rules = await checkVirtualContainerRules(service.http, workspace, ctx);
        return {
          workspace: workspace.id,
          revision: workspace.revision,
          rules,
        };
      }, 'dcsc_virtual_container_check_rules failed'),
  );
}
