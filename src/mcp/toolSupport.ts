import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import { toToolError } from '../http/errors.js';
import { logger } from '../http/trace.js';

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function fail(err: unknown, context = 'Tool failed'): ToolResult {
  logger().error({ err: err instanceof Error ? err.message : String(err) }, context);
  return {
    content: [{ type: 'text', text: JSON.stringify(toToolError(err), null, 2) }],
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

const READ_ONLY_LOCAL_TOOLS = new Set<string>([
  'dcsc_power_controls',
  'dcsc_pci_wizard',
  'dcsc_storage_wizard',
  'dcsc_software_browse',
  'dcsc_software_inspect',
  'dcsc_services_inspect',
  'dcsc_validation_jobs',
  'dcsc_recovery_inspect',
  'dcsc_session_list',
  'dcsc_workspace_layout',
  'dcsc_session_info',
  'dcsc_list_options',
  'dcsc_get_feature',
  'dcsc_get_configuration',
  'dcsc_diff_sessions',
  'dcsc_compare_scenarios',
  'dcsc_explain',
  'dcsc_power',
  'dcsc_health',
]);

const READ_ONLY_UPSTREAM_TOOLS = new Set<string>([
  'dcsc_reference_solutions',
  'dcsc_manual_cabling_options',
  'dcsc_cabling_connections',
  'dcsc_find_parts',
  'dcsc_solution_modes',
  'dcsc_find_products',
  'dcsc_browse_catalog',
  'dcsc_list_racks',
  'dcsc_list_locales',
  'dcsc_service_categories',
  'dcsc_blueprints',
  'dcsc_scale_out',
  'dcsc_fabric_options',
  'dcsc_network_connectors',
]);

const DESTRUCTIVE_TOOLS = new Set<string>([
  'dcsc_edit_storage_network',
  'dcsc_software_remove',
  'dcsc_services_remove',
  'dcsc_reconcile_workspace',
  'dcsc_session_close',
  'dcsc_edit_layout',
  'dcsc_set_storage_wizard',
]);

const IDEMPOTENT_MUTATING_TOOLS = new Set<string>([
  'dcsc_load_unconfigured',
  'dcsc_set_unconfigured',
  'dcsc_customize_storage_controller',
  'dcsc_customize_storage_switch',
  'dcsc_assign_storage_network',
  'dcsc_set_power_controls',
  'dcsc_set_pci_wizard',
  'dcsc_software_set_quantity',
  'dcsc_services_set_quantity',
  'dcsc_services_set_product_quantity',
  'dcsc_place_on_floor',
  'dcsc_set_rack_lock',
  'dcsc_set_locale',
  'dcsc_set_configuration_controls',
  'dcsc_set_quantity',
  'dcsc_set_node_role',
  'dcsc_set_topology',
  'dcsc_set_network_preferences',
]);

const LOCAL_MUTATING_TOOLS = new Set<string>([
  'dcsc_software_select',
  'dcsc_software_set_quantity',
  'dcsc_software_remove',
  'dcsc_recovery_export',
  'dcsc_session_close',
  'dcsc_workspace_history',
  'dcsc_place_on_floor',
  'dcsc_set_quantity',
  'dcsc_undo',
]);

export function inferToolAnnotations(name: string, title?: string): ToolAnnotations {
  const isReadOnly = READ_ONLY_LOCAL_TOOLS.has(name) || READ_ONLY_UPSTREAM_TOOLS.has(name);
  const openWorld = isReadOnly
    ? READ_ONLY_UPSTREAM_TOOLS.has(name)
    : !LOCAL_MUTATING_TOOLS.has(name);
  const destructive = !isReadOnly && DESTRUCTIVE_TOOLS.has(name);
  const idempotent = isReadOnly || IDEMPOTENT_MUTATING_TOOLS.has(name);
  return {
    ...(title ? { title } : {}),
    readOnlyHint: isReadOnly,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: openWorld,
  };
}

const ALIAS_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['session', 'workspace'],
  ['expectedRevision', 'expectedWorkspaceRevision'],
  ['sessionId', 'configuration'],
];

/**
 * Bidirectional parameter aliasing so callers can pass either `session` or
 * `workspace`, either `expectedRevision` or `expectedWorkspaceRevision`, and
 * either `sessionId` or `configuration` on rack/layout tools.
 */
export function normalizeToolArgs<T>(
  args: T,
  toolName?: string,
  schemaKeys?: ReadonlySet<string>,
): T {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const record = { ...(args as Record<string, unknown>) };
  for (const [left, right] of ALIAS_PAIRS) {
    if (left === 'sessionId' && toolName && toolName !== 'dcsc_place_in_rack' && toolName !== 'dcsc_edit_layout') {
      continue;
    }
    if (schemaKeys) {
      if (schemaKeys.has(left) && !schemaKeys.has(right) && record[left] === undefined && record[right] !== undefined) {
        record[left] = record[right];
      } else if (schemaKeys.has(right) && !schemaKeys.has(left) && record[right] === undefined && record[left] !== undefined) {
        record[right] = record[left];
      }
    } else {
      if (record[left] === undefined && record[right] !== undefined) {
        record[left] = record[right];
      } else if (record[right] === undefined && record[left] !== undefined) {
        record[right] = record[left];
      }
    }
  }
  return record as T;
}

const WRAPPED_SERVERS = new WeakMap<object, McpServer>();
const VALIDATOR_PATCHED = new WeakSet<object>();
const TOOL_SCHEMA_KEYS = new WeakMap<object, Map<string, ReadonlySet<string>>>();

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
  '- Handle parameters (`session` and `workspace`) are accepted interchangeably across all session/workspace tools.',
  '- Optimistic concurrency parameters (`expectedRevision` and `expectedWorkspaceRevision`) are accepted interchangeably.',
  '- Rack target parameters (`sessionId` and `configuration`) are accepted interchangeably on `dcsc_place_in_rack` and `dcsc_edit_layout`.',
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

/**
 * Wraps an McpServer (or test double) so every registered tool automatically receives:
 * 1. Standard MCP `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
 * 2. Bidirectional parameter aliasing (`session` <-> `workspace`, `expectedRevision` <-> `expectedWorkspaceRevision`, `sessionId` <-> `configuration`)
 * 3. Consistent error guarding and logging via `guard()`.
 */
export function withToolSupport(server: McpServer): McpServer {
  const existing = WRAPPED_SERVERS.get(server as object);
  if (existing) return existing;

  let schemaKeysMap = TOOL_SCHEMA_KEYS.get(server as object);
  if (!schemaKeysMap) {
    schemaKeysMap = new Map<string, ReadonlySet<string>>();
    TOOL_SCHEMA_KEYS.set(server as object, schemaKeysMap);
  }

  const internal = server as unknown as {
    validateToolInput?: (
      tool: { inputSchema?: Record<string, unknown> },
      args: unknown,
      toolName: string,
    ) => Promise<unknown>;
  };

  if (typeof internal.validateToolInput === 'function' && !VALIDATOR_PATCHED.has(server as object)) {
    const origValidate = internal.validateToolInput.bind(server);
    internal.validateToolInput = async (tool, args, toolName) => {
      const schemaKeys = schemaKeysMap.get(toolName);
      const normalized = normalizeToolArgs(args, toolName, schemaKeys);
      return origValidate(tool, normalized, toolName);
    };
    VALIDATOR_PATCHED.add(server as object);
  }

  const wrapped = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (
          name: string,
          config: {
            title?: string;
            description?: string;
            inputSchema?: Record<string, unknown>;
            outputSchema?: Record<string, unknown>;
            annotations?: ToolAnnotations;
          },
          handler: (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult> | ToolResult,
        ) => {
          const schemaKeys = config.inputSchema && typeof config.inputSchema === 'object'
            ? new Set(Object.keys(config.inputSchema))
            : undefined;
          if (schemaKeys) {
            schemaKeysMap.set(name, schemaKeys);
          }
          const annotations = {
            ...inferToolAnnotations(name, config.title),
            ...(config.annotations ?? {}),
          };
          const enhancedConfig = {
            ...config,
            annotations,
          };
          const wrappedHandler = async (rawArgs: Record<string, unknown>, extra?: unknown): Promise<ToolResult> => {
            try {
              const normalized = normalizeToolArgs(rawArgs ?? {}, name, schemaKeys);
              return await handler(normalized, extra);
            } catch (err) {
              return fail(err, `${name} failed`);
            }
          };
          return target.registerTool(
            name,
            enhancedConfig as Parameters<McpServer['registerTool']>[1],
            wrappedHandler as Parameters<McpServer['registerTool']>[2],
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  WRAPPED_SERVERS.set(server as object, wrapped);
  WRAPPED_SERVERS.set(wrapped as object, wrapped);
  TOOL_SCHEMA_KEYS.set(wrapped as object, schemaKeysMap);
  return wrapped;
}
