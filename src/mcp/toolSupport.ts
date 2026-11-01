import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RESPONSE_BYTE_BUDGET } from '../config/constants.js';
import { toToolError } from '../http/errors.js';
import { logger } from '../http/trace.js';
import { errorMessage } from '../util/coerce.js';

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
    return ok(await fn());
  } catch (err) {
    return fail(err, context);
  }
}

export const VERIFIED_CAPABILITIES_DOC = [
  '# Lenovo DCSC MCP — Verified Capabilities & Upstream Constraints',
  '',
  '## Cabling & Fabric Matrix',
  '- Native manual cable creation (`dcsc_manual_cabling_options` -> `dcsc_create_cabling_connection`) is verified for:',
  '  - Management networks (including DB710S sources and linked SN2201 destinations)',
  '  - 10 GbE copper storage (DE2000H controllers, including fresh controller setup, rack placement, and two shared DE2000H instances with spares)',
  '  - 100 GbE copper (including linked source configurations and 4-way QSFP28-to-SFP28 `breakout-4` DAC branches)',
  '- Native existing-row cable edits (`dcsc_cabling_connections` -> `dcsc_edit_cabling_connection`) support endpoint swaps (source and destination) and cable-part replacements with optional `cableQuantities` for pair/pack rules and spares.',
  '- `dcsc_add_cabling(mode: "auto")` invokes DCSC `/auto_connect`. `mode: "manual"` records a local planning link only (excluded from Lenovo CFXML exports).',
  '',
  '## Reimport & Roundtrip Warnings',
  '- **Four-way breakout (`breakout-4`):** Native DCSC website CFXML import resets `BREAKOUT4` to `P2P` with divider 1. MCP `dcsc_import` restores the saved 4-way breakout shape and physical cable quantities from the exported CFXML.',
  '- **Power load factor:** Native DCSC CFXML reimport can reset custom load factors (e.g., 100% -> 70% on SR630 V3). Saved MCP sessions retain custom load factors; reapply via `dcsc_set_power_controls` after XML import.',
  '- **Detached nested nodes:** `dcsc_edit_layout(action: "detach")` matches the website Delete Node action (retains commercial line, removes physical placement), but native DCSC reimport drops detached nodes. Use `action: "unplace"` for roundtrip retention.',
  '',
  '## Parameter Conventions',
  '- `session` is the handle of a configuration or workspace; `expectedRevision` is the revision of that handle.',
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
        title: 'Lenovo DCSC MCP Verified Capabilities & Constraints',
        description: 'Detailed protocol coverage, hardware verification notes, reimport caveats, and parameter conventions.',
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
