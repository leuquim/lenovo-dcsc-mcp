import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { projectJsonPage } from '../model/pagedJson.js';
import type { DcscService } from './service.js';
import { guard } from './toolSupport.js';
import { jsonBytes } from '../util/jsonBytes.js';
import { PAGE_BYTE_BUDGET } from '../config/constants.js';

export function registerPowerControlTools(server: McpServer, service: DcscService): void {
  const runSetPowerControls = async (args: {
    session: string;
    expectedRevision: number;
    voltage?: string | undefined;
    loadFactor?: number | undefined;
    powerPolicy?: string | number | undefined;
  }) => {
    const result = await service.setPowerControls(args.session, {
      voltage: args.voltage, loadFactor: args.loadFactor, powerPolicy: args.powerPolicy,
    }, args.expectedRevision, service.newCtx());
    const response: Record<string, unknown> = {
      session: result.session, workspace: result.workspace, workspaceRevision: result.workspaceRevision,
      configurationRevision: result.configurationRevision, current: result.current,
      affectedConfigurationCount: result.affectedConfigurationIds.length,
      ...(result.current.loadFactor !== 70 ? { exportWarning:
        'Lenovo CFXML reimport can reset the load factor (verified SR630 V3: 100% to 70%). The MCP session retains it; verify and reapply after importing XML.' } : {}),
      inspect: { tool: 'dcsc_power_controls', arguments: {
        session: result.session, expectedRevision: result.workspaceRevision,
      } },
      power: { tool: 'dcsc_power', arguments: { session: result.session } },
    };
    if (jsonBytes(response) > PAGE_BYTE_BUDGET) {
      delete response['current'];
      response['currentOmitted'] = true;
    }
    return response;
  };

  server.registerTool('dcsc_power_controls', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Inspect or update power settings and available voltage/policy choices',
    description: 'Lists the native Engineering Power Report settings for one configuration (or updates them inline when voltage, loadFactor, or powerPolicy is supplied). Follow revision-bound continuations unchanged.',
    inputSchema: {
      session: z.string().describe('Configuration handle; workspace handles are ambiguous.'),
      expectedRevision: z.number().int().min(1).optional(),
      path: z.array(z.string()).default([]), offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(20),
      voltage: z.string().optional().describe('Exact voltages[].id, e.g. 230V@AC.'),
      loadFactor: z.number().int().min(0).max(100).optional().describe('Load factor percentage, not the derived power utilization percentage.'),
      powerPolicy: z.union([z.string(), z.number()]).optional().describe('Exact policies[].value.'),
    },
  }, async args => guard(async () => {
    if (args.voltage !== undefined || args.loadFactor !== undefined || args.powerPolicy !== undefined) {
      if (args.expectedRevision === undefined) {
        throw new Error('expectedRevision is required when updating power controls.');
      }
      return runSetPowerControls({
        session: args.session,
        expectedRevision: args.expectedRevision,
        voltage: args.voltage,
        loadFactor: args.loadFactor,
        powerPolicy: args.powerPolicy,
      });
    }
    if (args.path.length > 0 && args.expectedRevision === undefined) {
      throw new Error('Follow the revision-bound continuation from dcsc_power_controls before inspecting detail pages.');
    }
    const report = service.inspectPowerControls(args.session, args.expectedRevision);
    return {
      session: report.session, workspace: report.workspace, workspaceRevision: report.workspaceRevision,
      ...projectJsonPage(report, { tool: 'dcsc_power_controls',
        arguments: { session: args.session, expectedRevision: report.workspaceRevision },
        path: args.path, offset: args.offset, limit: args.limit }),
    };
  }, 'dcsc_power_controls failed'));

  server.registerTool('dcsc_set_power_controls', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Calculate and save voltage, load factor and power policy',
    description: 'Mirrors Engineering Power Report Save for one configuration and its linked copies using exact choices from dcsc_power_controls. Calculates through Lenovo, verifies accepted settings and saves atomically with history.',
    inputSchema: {
      session: z.string().describe('Configuration handle.'),
      expectedRevision: z.number().int().min(1),
      voltage: z.string().optional().describe('Exact voltages[].id, e.g. 230V@AC.'),
      loadFactor: z.number().int().min(0).max(100).optional().describe('Load factor percentage, not the derived power utilization percentage.'),
      powerPolicy: z.union([z.string(), z.number()]).optional().describe('Exact policies[].value.'),
    },
  }, async args => guard(() => runSetPowerControls(args), 'dcsc_set_power_controls failed'));
}
