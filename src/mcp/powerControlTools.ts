import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { powerReport } from '../app/power.js';
import { PAGE_BYTE_BUDGET } from '../config/constants.js';
import { projectJsonPage } from '../model/pagedJson.js';
import { jsonBytes } from '../util/jsonBytes.js';
import type { DcscService } from './service.js';
import { guard } from './toolSupport.js';

const POWER_SECTIONS = ['report', 'controls'] as const;
const POWER_CONTROLS_SECTION = 'controls';

export function registerPowerControlTools(server: McpServer, service: DcscService): void {
  server.registerTool('dcsc_power_get', {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: 'Power report and controls',
    description: 'Reads the Engineering Power Report. section "report" gives power and heat per configuration, rack and total; ' +
      'section "controls" lists the voltage, load factor and power policy choices of one configuration.',
    inputSchema: {
      session: z.string().describe('Configuration or workspace handle; controls need a configuration handle.'),
      section: z.enum(POWER_SECTIONS).default('report'),
      expectedRevision: z.number().int().min(1).optional().describe('Workspace revision; controls continuations carry it.'),
      path: z.array(z.string()).default([]).describe('Controls only: detail path from a returned continuation.'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(20),
    },
  }, async args => guard(async () => {
    if ((args.section ?? 'report') !== POWER_CONTROLS_SECTION) return powerReport(service, args.session);
    const path = args.path ?? [];
    if (path.length > 0 && args.expectedRevision === undefined) {
      throw new Error('Follow the revision-bound continuation from dcsc_power_get before inspecting detail pages.');
    }
    const report = service.inspectPowerControls(args.session, args.expectedRevision);
    return {
      session: args.session, revision: report.workspaceRevision,
      ...projectJsonPage(report, { tool: 'dcsc_power_get',
        arguments: { session: args.session, section: POWER_CONTROLS_SECTION, expectedRevision: report.workspaceRevision },
        path, offset: args.offset ?? 0, limit: args.limit ?? 20 }),
    };
  }, 'dcsc_power_get failed'));

  server.registerTool('dcsc_power_set', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Save power controls',
    description: 'Saves voltage, load factor and power policy for one configuration and its linked copies, using exact choices from dcsc_power_get.',
    inputSchema: {
      session: z.string().describe('Configuration handle.'),
      expectedRevision: z.number().int().min(1).describe('Workspace revision.'),
      voltage: z.string().optional().describe('Exact voltages[].id, e.g. 230V@AC.'),
      loadFactor: z.number().int().min(0).max(100).optional().describe('Load factor percentage.'),
      powerPolicy: z.union([z.string(), z.number()]).optional().describe('Exact policies[].value.'),
    },
  }, async args => guard(async () => {
    const result = await service.setPowerControls(args.session, {
      voltage: args.voltage, loadFactor: args.loadFactor, powerPolicy: args.powerPolicy,
    }, args.expectedRevision, service.newCtx());
    const response: Record<string, unknown> = {
      session: result.session, revision: result.workspaceRevision,
      configurationRevision: result.configurationRevision, current: result.current,
      affectedConfigurationCount: result.affectedConfigurationIds.length,
      ...(result.current.loadFactor !== 70 ? { exportWarning:
        'Lenovo CFXML reimport can reset the load factor (verified SR630 V3: 100% to 70%). The MCP session retains it; verify and reapply after importing XML.' } : {}),
      inspect: { tool: 'dcsc_power_get', arguments: {
        session: result.session, section: POWER_CONTROLS_SECTION, expectedRevision: result.workspaceRevision,
      } },
    };
    if (jsonBytes(response) > PAGE_BYTE_BUDGET) {
      delete response['current'];
      response['currentOmitted'] = true;
    }
    return response;
  }, 'dcsc_power_set failed'));
}
