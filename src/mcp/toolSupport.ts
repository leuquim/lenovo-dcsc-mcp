import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RESPONSE_BYTE_BUDGET } from '../config/constants.js';
import { toToolError } from '../http/errors.js';
import { logger } from '../http/trace.js';
import { errorMessage } from '../util/coerce.js';
import { nestWorkspaceGetContinuations } from './continuations.js';

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function ok(value: unknown): ToolResult {
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text);
  if (bytes > RESPONSE_BYTE_BUDGET) {
    throw new Error(`Response is ${bytes} bytes, over the ${RESPONSE_BYTE_BUDGET} byte budget. Narrow the request or page with offset and limit.`);
  }
  return { content: [{ type: 'text', text }] };
}

export function fail(err: unknown, context = 'Tool failed'): ToolResult {
  logger().error({ err: errorMessage(err) }, context);
  return {
    content: [{ type: 'text', text: JSON.stringify(toToolError(err)) }],
    isError: true,
  };
}

/** Wraps a handler so no raw upstream detail can escape through a tool result. */
export async function guard(fn: () => unknown | Promise<unknown>, context = 'Tool failed'): Promise<ToolResult> {
  try {
    return ok(nestWorkspaceGetContinuations(await fn()));
  } catch (err) {
    return fail(err, context);
  }
}

export const VERIFIED_CAPABILITIES_DOC = [
  '# Lenovo DCSC MCP workflow guide',
  '',
  'Prices are list prices for the configured country and currency, retrieved anonymously. They are not a quote.',
  '',
  '## Handles',
  '- `session` is a configuration or workspace handle. Writes need `expectedRevision`, always the workspace revision. Every write returns the new `revision`; reads return the current one.',
  '- Responses are small. Follow returned `next`, `detail` and `inspect` continuations unchanged to page.',
  '',
  '## Workflow',
  '1. Discover: `dcsc_settings_get` (country, solution modes; `dcsc_settings_set` changes the default locale and the withdrawn-since date that also lists withdrawn products), `dcsc_search` (products, parts, SIDs, service products that take service packs, and the software offered for a product ID), `dcsc_category`, `dcsc_reference_solutions`.',
  '2. Launch: `dcsc_launch` opens a CTO, LFO, reference solution, software or services basket, or unconfigured options. Pass `session` to add to an existing workspace. Use `dcsc_import` to start from a CFXML or Excel file.',
  '3. Configure: `dcsc_configuration_get` shows tabs, options, selections, rules and recommendations. `dcsc_configure` applies option changes, quantity, Guided/Expert mode, Auto-Correct and the AI Express / Full Mode switch (`expressMode`) in one call; `dcsc_configuration_get` views `errors` and `resources` show rule errors and slot/bay occupancy. `dcsc_wizard_get`/`dcsc_wizard_set` drive the PCI and storage wizards. `dcsc_auto_fix` resolves rule errors.',
  '4. Rack and floor: `dcsc_rack_get` lists cabinets, compatible chassis and PDU options. `dcsc_rack_add` adds a rack. `dcsc_rack_edit` places, moves, removes, locks, clones and copies. `dcsc_floor_set` positions and colours racks, edits the Floor Preference and flips the Auto Arrange and COG Validation controls, which later layout and Auto-Connect requests honour. `dcsc_pdu_set` sets PDUs and cords. `dcsc_rack_position_rule` computes valid U positions.',
  '5. Network, cabling, storage: `dcsc_network_get`/`dcsc_network_set` for topologies, node roles and preferences. `dcsc_auto_connect` generates cabling. `dcsc_cabling_get`/`dcsc_cabling_set` list and edit connections; `dcsc_cabling_get` also returns the cable distance between two endpoints. `dcsc_storage_get`/`dcsc_storage_set` manage storage networks, controllers and switches. `dcsc_vlh_get`/`dcsc_vlh_set` read VLH data and create and export VLH items (`dcsc_vlh_set`); `dcsc_virtual_container_get` reads virtual container data.',
  '6. Power: `dcsc_power_get` reads the power report and the controls of a configuration; `dcsc_power_set` saves them.',
  '7. Validate: `dcsc_validate` runs manufacturing validation; `dcsc_workspace_get` (view `validation`) lists saved jobs.',
  '8. Export: `dcsc_export` writes reports, the power report, the configuration tree, reference XML or the Services catalog (`servicesCatalog`) and returns file paths. Default report types follow the solution mode (HPC: Quote Reference, P2P by Rack and VLH instead of Quote).',
  '',
  'Also: `dcsc_workspace_get` (layout, baskets, history), `dcsc_basket_browse`/`dcsc_basket_set` (standalone software, hardware, services), `dcsc_compare` (scenarios, scale-out, part diff), `dcsc_undo`, `dcsc_session_list`, `dcsc_session_close`, `dcsc_reconcile_workspace` and `dcsc_recovery_export` for damaged or legacy workspaces.',
  '',
  '## Constraints',
  '- Manual cable creation is verified for management, 10 GbE copper storage and 100 GbE copper networks, including 4-way `breakout-4` DAC branches. Use rows and cable choices from `dcsc_cabling_get`.',
  '- Native DCSC CFXML import resets `breakout-4` to point-to-point and can reset custom power load factors. `dcsc_import` restores the breakout shape and cable quantities; reapply load factors with `dcsc_power_set` after an import.',
  '- `dcsc_rack_edit` action `detach` matches the website Delete Node action, but native DCSC import drops detached nodes. Use `unplace` to keep them through a round trip.',
].join('\n');

export function registerCapabilitiesResource(server: McpServer): void {
  const candidate = server as unknown as {
    registerResource?: (
      name: string,
      uri: string,
      metadata: { title?: string; description?: string; mimeType?: string },
      readCallback: () => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>,
    ) => unknown;
  };
  if (typeof candidate.registerResource !== 'function') return;
  try {
    candidate.registerResource(
      'dcsc_capabilities',
      'dcsc://docs/capabilities',
      {
        title: 'Lenovo DCSC MCP workflow guide',
        description: 'Tool workflow from discovery to export, handle conventions and known constraints.',
        mimeType: 'text/markdown',
      },
      async () => ({
        contents: [
          {
            uri: 'dcsc://docs/capabilities',
            mimeType: 'text/markdown',
            text: VERIFIED_CAPABILITIES_DOC,
          },
        ],
      }),
    );
  } catch {
    // Ignore duplicate registration in tests that call registerTools multiple times on one server.
  }
}
