import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toToolError } from '../http/errors.js';
import { projectJsonPage } from '../model/pagedJson.js';
import type { DcscService } from './service.js';

export function registerPowerControlTools(server: McpServer, service: DcscService): void {
  server.registerTool('dcsc_power_controls', {
    title: 'Inspect power settings and available voltage/policy choices',
    description: 'Lists the native Engineering Power Report settings for one configuration, including voltage IDs, load factor, power policies and linked configurations affected by Save. Follow revision-bound continuations unchanged. Unknown power remains unavailable.',
    inputSchema: {
      session: z.string().describe('Configuration handle; workspace handles are ambiguous.'),
      expectedWorkspaceRevision: z.number().int().min(1).optional(),
      path: z.array(z.string()).default([]), offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(20),
    },
  }, async args => {
    try {
      if (args.path.length > 0 && args.expectedWorkspaceRevision === undefined) {
        throw new Error('Follow the revision-bound continuation from dcsc_power_controls before inspecting detail pages.');
      }
      const report = service.inspectPowerControls(args.session, args.expectedWorkspaceRevision);
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        session: report.session, workspace: report.workspace, workspaceRevision: report.workspaceRevision,
        ...projectJsonPage(report, { tool: 'dcsc_power_controls',
          arguments: { session: args.session, expectedWorkspaceRevision: report.workspaceRevision },
          path: args.path, offset: args.offset, limit: args.limit }),
      }, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error)) }] };
    }
  });
  server.registerTool('dcsc_set_power_controls', {
    title: 'Calculate and save voltage, load factor and power policy',
    description: 'Mirrors Engineering Power Report Save for one configuration and its linked copies. Uses exact choices from dcsc_power_controls. Calculates through Lenovo, verifies accepted settings, saves report and export metadata atomically with history. Does not estimate unknown power. Workspace revision is required because linked copies and managed physical instances can be affected.',
    inputSchema: {
      session: z.string().describe('Configuration handle.'),
      expectedWorkspaceRevision: z.number().int().min(1),
      voltage: z.string().optional().describe('Exact voltages[].id, e.g. 230V@AC.'),
      loadFactor: z.number().int().min(0).max(100).optional().describe('Load factor percentage, not the derived power utilization percentage.'),
      powerPolicy: z.union([z.string(), z.number()]).optional().describe('Exact policies[].value.'),
    },
  }, async args => {
    try {
      const result = await service.setPowerControls(args.session, {
        voltage: args.voltage, loadFactor: args.loadFactor, powerPolicy: args.powerPolicy,
      }, args.expectedWorkspaceRevision, service.newCtx());
      const response: Record<string, unknown> = {
        session: result.session, workspace: result.workspace, workspaceRevision: result.workspaceRevision,
        configurationRevision: result.configurationRevision, current: result.current,
        affectedConfigurationCount: result.affectedConfigurationIds.length,
        ...(result.current.loadFactor !== 70 ? { exportWarning:
          'Lenovo CFXML reimport can reset the load factor (verified SR630 V3: 100% to 70%). The MCP session retains it; verify and reapply after importing XML.' } : {}),
        inspect: { tool: 'dcsc_power_controls', arguments: {
          session: result.session, expectedWorkspaceRevision: result.workspaceRevision,
        } },
        power: { tool: 'dcsc_power', arguments: { session: result.session } },
      };
      if (Buffer.byteLength(JSON.stringify(response, null, 2)) > 7_000) {
        delete response['current'];
        response['currentOmitted'] = true;
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(toToolError(error)) }] };
    }
  });
}
