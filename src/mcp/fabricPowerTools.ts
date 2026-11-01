import { isDeepStrictEqual } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { invalidateConnectionGraph, type AutoConnectResult } from '../domain/cabling.js';
import { cablingDiagnostics } from '../domain/cablingDiagnostics.js';
import { listNetworkLeafCablingChoices, listTopologyConnectors } from '../domain/networkPreferences.js';
import { aggregatePower, extractPowerReport } from '../domain/power.js';
import {
  listStorageExpansions,
  storageComponentQuantities,
  storagePhysicalTemplateIds,
} from '../domain/storagePreferences.js';
import { storagePhysicalConfigurations } from '../domain/storagePhysicalState.js';
import { workspaceNetworkTypes } from '../domain/workspaceNetworkPreferences.js';
import { physicalIds } from '../domain/workspaceReferences.js';
import { projectCatalogPage } from '../model/catalogPage.js';
import type { WorkspaceSession } from '../model/session.js';
import type { DcscService } from './service.js';
import { positiveQuantity, requireSession } from './sessionTools.js';
import { guard } from './toolSupport.js';
import { jsonBytes } from '../util/jsonBytes.js';
import { PAGE_BYTE_BUDGET } from '../config/constants.js';

export function projectAutoConnectToolResult(
  workspace: WorkspaceSession,
  result: AutoConnectResult,
): Record<string, unknown> {
  const settings = Object.fromEntries(['autoAddPDU', 'autoAddSwitch', 'p2pCabling']
    .filter(key => typeof result.settings[key] === 'boolean')
    .map(key => [key, result.settings[key]]));
  const messageCount = result.messages.reduce((sum, group) => sum + group.messages.length, 0);
  const { networks: _networks, ...diagnostics } = cablingDiagnostics(
    [...workspace.configurations.values()].map(session => session.raw), workspace.serverState,
  );
  const page = (path: string[]) => ({
    tool: 'dcsc_workspace_layout',
    arguments: {
      session: workspace.id,
      expectedRevision: workspace.revision,
      path,
      offset: 0,
      limit: 20,
    },
  });
  const pages = {
    diagnostics: { inspect: page(['cablingDiagnostics']) },
    rawConnections: { total: result.rawConnections.length, inspect: page(['rawConnections']) },
    messages: { total: result.messages.length, messageCount, inspect: page(['autoConnectMessages']) },
  };
  const connections = result.connections.map(connection => ({
    id: connection.id,
    fromId: connection.fromId,
    fromPort: connection.fromPort,
    toId: connection.toId,
    toPort: connection.toPort,
    cableCode: connection.cableCode,
    description: connection.description,
  }));
  const note = result.connections.length === 0
    ? 'DCSC returned no connections. Inspect pages.diagnostics and Lenovo messages before changing hardware.'
    : undefined;
  const full: Record<string, unknown> = {
    session: workspace.id,
    revision: workspace.revision,
    mode: 'auto',
    settings,
    connectionCount: result.connections.length,
    diagnostics,
    connections,
    messageGroupCount: result.messages.length,
    messageCount,
    messages: result.messages,
    pages,
    ...(note ? { note } : {}),
    next: 'Inspect pages.diagnostics for missing networks. Use dcsc_cabling_connections to discover editable rows, then dcsc_edit_cabling_connection to change an existing connection.',
  };
  if (jsonBytes(full) <= PAGE_BYTE_BUDGET) return full;

  const clip = (value: string | undefined): { value?: string; truncated?: true } =>
    value === undefined ? {} : value.length <= 160 ? { value } : { value: value.slice(0, 160), truncated: true };
  const compactConnections = result.connections.slice(0, 5).map((connection, index) => {
    const projected: Record<string, unknown> = { detail: page(['rawConnections', String(index)]) };
    for (const field of ['id', 'fromId', 'fromPort', 'toId', 'toPort', 'cableCode', 'description'] as const) {
      const clipped = clip(connection[field]);
      if (clipped.value !== undefined) projected[field] = clipped.value;
      if (clipped.truncated) projected[`${field}Truncated`] = true;
    }
    return projected;
  });
  const compactMessages = result.messages.slice(0, 3).map((group, groupIndex) => {
    const rackId = clip(group.rackId);
    return {
      ...(rackId.value !== undefined ? { rackId: rackId.value } : {}),
      ...(rackId.truncated ? { rackIdTruncated: true } : {}),
      messageCount: group.messages.length,
      messages: group.messages.slice(0, 2).map((message, messageIndex) => {
        const clipped = clip(message);
        return clipped.truncated
          ? { text: clipped.value, truncated: true,
              detail: page(['autoConnectMessages', String(groupIndex), 'messages', String(messageIndex)]) }
          : message;
      }),
      detail: page(['autoConnectMessages', String(groupIndex)]),
    };
  });
  const compact: Record<string, unknown> = {
    ...full,
    connections: compactConnections,
    connectionsReturned: compactConnections.length,
    messages: compactMessages,
    messageGroupsReturned: compactMessages.length,
    compacted: true,
  };
  while (jsonBytes(compact) > PAGE_BYTE_BUDGET && compactConnections.length > 0) {
    compactConnections.pop();
    compact['connectionsReturned'] = compactConnections.length;
  }
  while (jsonBytes(compact) > PAGE_BYTE_BUDGET && compactMessages.length > 0) {
    compactMessages.pop();
    compact['messageGroupsReturned'] = compactMessages.length;
  }
  if (jsonBytes(compact) > PAGE_BYTE_BUDGET) {
    throw new Error('Auto-connect result context exceeds the response budget. Inspect the workspace recovery snapshot.');
  }
  return compact;
}

export function registerFabricPowerTools(server: McpServer, service: DcscService): void {

  server.registerTool(
    'dcsc_add_cabling',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: 'Generate native cabling or record a local planning link',
      description:
        'Runs native DCSC /auto_connect (mode="auto", default) to generate workspace cabling and update Automated Rack PDU / Switch / P2P settings. Mode "manual" records a local-only planning link excluded from Lenovo exports; for native exportable manual connections use dcsc_manual_cabling_options -> dcsc_create_cabling_connection, or dcsc_cabling_connections -> dcsc_edit_cabling_connection.',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
        session: z.string().describe('Session or workspace ID.'),
        mode: z
          .enum(['auto', 'manual'])
          .optional()
          .default('auto')
          .describe('auto = DCSC /auto_connect (default). manual = local port map only.'),
        settings: z.object({
          autoAddPDU: z.boolean().optional().describe('Automatically add rack PDUs. Disable when planning without automated PDU selection.'),
          autoAddSwitch: z.boolean().optional().describe('Automatically add switches for selected networking preferences.'),
          p2pCabling: z.boolean().optional().describe('Enable point-to-point cabling.'),
        }).strict().optional().describe('Auto mode only. Omitted fields retain the saved setting.'),
        fromConfigId: z
          .string()
          .optional()
          .describe('Manual mode: source configuration ID (DCSC configuration id).'),
        fromPort: z.string().optional().describe('Manual mode: source port name or number.'),
        toConfigId: z.string().optional().describe('Manual mode: destination configuration ID.'),
        toPort: z.string().optional().describe('Manual mode: destination port name or number.'),
        cableCode: z.string().optional().describe('Manual mode: optional cable part code.'),
        description: z.string().optional().describe('Manual mode: optional description.'),
      },
    },
    async (args) =>
      guard(async () => {
        const mode = args.mode ?? 'auto';
        if (mode === 'manual' && args.settings !== undefined) {
          throw new Error('Auto-connect settings require mode="auto".');
        }
        if (mode === 'auto' && [args.fromConfigId, args.fromPort, args.toConfigId, args.toPort,
          args.cableCode, args.description].some(value => value !== undefined)) {
          throw new Error('Endpoint, cableCode and description fields require mode="manual", which saves a local planning link excluded from Lenovo exports. ' +
            'Auto mode cannot create a specified manual connection: omit those fields to run native Auto-Connect, ' +
            'use dcsc_manual_cabling_options and dcsc_create_cabling_connection for native manual creation, or use dcsc_cabling_connections and dcsc_edit_cabling_connection to edit an existing native row.');
        }
        if (mode === 'auto') {
          const ctx = service.newCtx();
          const result = await service.runAutoConnect(args.session, ctx, args.expectedRevision, args.settings);
          return projectAutoConnectToolResult(service.sessions.getWorkspace(args.session)!, result);
        }

        if (!args.fromConfigId || !args.fromPort || !args.toConfigId || !args.toPort) {
          throw new Error(
            'Manual mode requires fromConfigId, fromPort, toConfigId and toPort. ' +
              'Or omit them and use mode "auto" to let DCSC cable the layout.',
          );
        }
        const link = await service.addManualCabling(args.session, {
          fromConfigId: args.fromConfigId,
          fromPort: args.fromPort,
          toConfigId: args.toConfigId,
          toPort: args.toPort,
          ...(args.cableCode !== undefined ? { cableCode: args.cableCode } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
        }, args.expectedRevision);
        return {
          session: args.session,
          revision: service.sessions.getWorkspace(args.session)!.revision,
          mode: 'manual',
          cabling: link,
          includedInLenovoExport: false,
          warning:
            'This planning link is saved locally and excluded from Lenovo exports. ' +
            'Prefer mode "auto" (dcsc_add_cabling with mode auto) for server-authored connections.',
          next: 'dcsc_add_cabling(session, mode: "auto") to replace manual links with DCSC auto-connect.',
        };
      }, 'dcsc_add_cabling failed'),
  );

  server.registerTool(
    'dcsc_power',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Power and thermal budget for a configuration or solution',
      description:
        'Reports DCSC power and heat figures (idle / expected / max / worst-case input power, current, apparent power and heat output) per configuration, per rack (physical placements), and in total. Use dcsc_power_controls / dcsc_set_power_controls to inspect or change voltage, load factor and power policy.',
      inputSchema: {
        session: z.string().describe('Session or workspace ID.'),
      },
    },
    async (args) =>
      guard(async () => {
        const resolved = service.sessions.resolveHandle(args.session);
        if (!resolved) throw new Error(`Session / Workspace ${args.session} not found`);
        const workspace = resolved.workspace;
        const configs =
          resolved.kind === 'workspace'
            ? [...resolved.workspace.configurations.values()]
            : [resolved.session];
        const storageQuantities = resolved.kind === 'workspace'
          ? storageComponentQuantities(resolved.workspace) : new Map<string, number>();
        const units = new Map(configs.map(session => [session.id,
          workspace && storageQuantities.has(session.configurationId)
            ? storagePhysicalConfigurations(workspace, session.configurationId, session.raw)
                .map(instance => ({ ...instance, quantity: 1, power: extractPowerReport(instance.raw) }))
            : [{ physicalId: session.configurationId, raw: session.raw, quantity: positiveQuantity(session.raw.quantity),
                power: extractPowerReport(session.raw) }],
        ]));
        const perConfig = configs.map((s) => ({
          session: s.id,
          configurationId: s.configurationId,
          code: s.product.code,
          description: s.product.description,
          salesQuantity: storageQuantities.get(s.configurationId) ?? positiveQuantity(s.raw.quantity),
          ...(storageQuantities.has(s.configurationId) ? { managedStorageTemplate: true } : {}),
          power: units.get(s.id)!.every(unit => isDeepStrictEqual(unit.power, units.get(s.id)![0]?.power))
            ? units.get(s.id)![0]?.power : undefined,
          ...(storageQuantities.has(s.configurationId) ? { physicalInstances: units.get(s.id)!.map(unit => ({
            physicalId: unit.physicalId, power: unit.power,
          })) } : {}),
        }));

        const contributing = [...units.values()].flat().filter(
          (p): p is typeof p & { power: NonNullable<typeof p.power> } => p.power !== undefined && p.quantity > 0);
        const total =
          contributing.length > 0
            ? aggregatePower(
                contributing.map((p) => ({ report: p.power, quantity: p.quantity })),
              )
            : undefined;

        const missingPowerConfigurations = perConfig.filter(entry => entry.salesQuantity > 0 && units.get(entry.session)!.some(unit => !unit.power) &&
          configs.find(config => config.id === entry.session)?.product.type.toLowerCase() !== 'rack')
          .map(entry => entry.session);
        const totalPowerAvailable = total !== undefined && missingPowerConfigurations.length === 0;

        const sessionByPhysicalId = new Map<string, (typeof configs)[number]>();
        for (const session of configs) {
          sessionByPhysicalId.set(session.id, session);
          sessionByPhysicalId.set(session.configurationId, session);
        }
        if (workspace) for (const [physicalId, templateId] of storagePhysicalTemplateIds(workspace)) {
          const template = sessionByPhysicalId.get(templateId);
          if (template) sessionByPhysicalId.set(physicalId, template);
        }
        const placedBySession = new Map<string, number>();

        const perRack = (workspace?.rackSummaries ?? [])
          .map((rack) => {
            let scopedPlacements = 0;
            const missingPowerConfigurations: string[] = [];
            const rawRack = workspace?.rackArea.find(item => item.id === rack.id);
            const placedIds = rawRack ? [...physicalIds(rawRack)].filter(id => id !== rack.id)
              : rack.items.map(item => item.id);
            const physicalEntries = placedIds.flatMap((physicalId) => {
              const session = sessionByPhysicalId.get(physicalId);
              if (!session) return [];
              scopedPlacements += 1;
              placedBySession.set(session.id, (placedBySession.get(session.id) ?? 0) + 1);
              const report = units.get(session.id)?.find(unit => unit.physicalId === physicalId)?.power ??
                (!storageQuantities.has(session.configurationId) ? extractPowerReport(session.raw) : undefined);
              if (!report && session.product.type.toLowerCase() !== 'rack') missingPowerConfigurations.push(session.id);
              return report ? [{ report, quantity: 1 }] : [];
            });
            return {
              rackId: rack.id,
              code: rack.code,
              physicallyPlacedUnits: scopedPlacements,
              powerContributors: physicalEntries.length,
              powerAvailable: physicalEntries.length > 0 && missingPowerConfigurations.length === 0,
              ...(physicalEntries.length > 0 && missingPowerConfigurations.length === 0
                ? aggregatePower(physicalEntries)
                : { missingPowerConfigurations, ...(physicalEntries.length > 0
                  ? { knownPowerSubtotal: aggregatePower(physicalEntries) } : {}) }),
            };
          })
          .filter((rack) => resolved.kind === 'workspace' || rack.physicallyPlacedUnits > 0);

        const unplacedSalesUnits = perConfig
          .filter((entry) => {
            const session = configs.find((candidate) => candidate.id === entry.session);
            return session?.product.type.toLowerCase() !== 'rack';
          })
          .map((entry) => {
            const placedUnits = placedBySession.get(entry.session) ?? 0;
            return {
              session: entry.session,
              configurationId: entry.configurationId,
              code: entry.code,
              salesQuantity: entry.salesQuantity,
              physicallyPlacedUnits: placedUnits,
              unplacedUnits: Math.max(0, entry.salesQuantity - placedUnits),
              ...(placedUnits > entry.salesQuantity
                ? {
                    warning:
                      'The validated rack layout contains more physical instances than the sales quantity.',
                  }
                : {}),
            };
          })
          .filter((entry) => entry.unplacedUnits > 0 || entry.warning !== undefined);

        const voltages = [
          ...new Set(contributing.map((p) => p.power.operatingVoltage).filter(Boolean)),
        ];

        return {
          session: args.session,
          currency:
            resolved.kind === 'workspace'
              ? resolved.workspace.locale.currency
              : resolved.session.locale.currency,
          perConfiguration: perConfig,
          totalPowerAvailable,
          ...(totalPowerAvailable
            ? { total, totalScope: 'sales quantities across the selected scope' }
            : { missingPowerConfigurations, ...(total ? { knownPowerSubtotal: total } : {}),
              powerAvailabilityReason: 'DCSC did not supply a complete numeric power report for every included powered configuration.' }),
          ...(perRack.length > 0 ? { perRack } : {}),
          unplacedSalesUnits,
          operatingVoltage: voltages.length === 1 ? voltages[0] : voltages,
          ...(voltages.length > 1
            ? {
                voltageWarning:
                  'Configurations run at different voltages, so the summed current figure is not meaningful. ' +
                  'Compare power (W) instead.',
              }
            : {}),
          note:
            'idle / expected / max / worst are DCSC\'s own bands. "expected" applies the configured ' +
            'load factor and is the figure to size a room against; "worst" is what a breaker must survive.',
        };
      }, 'dcsc_power failed'),
  );

  server.registerTool(
    'dcsc_fabric_options',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: 'Browse fabric devices, topologies, cables and storage preferences',
      description: 'Browses the fetched fabric catalog with stable option IDs and true totals across collections (topologies, networkDevices, networkTypes, cables, selectedServices, nodeRoles, storageSwitches, storageControllers, leafNodeCabling).',
      inputSchema: {
        solutionMode: z.string().optional(),
        session: z.string().optional().describe('Use the locale and solution of this workspace/configuration.'),
        collection: z.enum(['topologies', 'networkDevices', 'networkTypes', 'cables', 'selectedServices', 'nodeRoles', 'storageSwitches', 'storageControllers', 'leafNodeCabling']).default('topologies'),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        optionId: z.string().optional(),
        fields: z.array(z.string()).optional().describe('Return these top-level fields, plus id.'),
        path: z.array(z.string()).optional().describe('Lossless detail path from a returned continuation.'),
        expectedCatalogFingerprint: z.string().optional().describe('Returned continuation fingerprint; rejects changed fabric catalog or context.'),
      },
    },
    async (args) => guard(async () => {
      const workspace = args.session ? service.sessions.getWorkspace(args.session) : undefined;
      if (args.session && !workspace) throw new Error('Workspace not found.');
      const ctx = service.newCtx(workspace ? { locale: workspace.locale, solution: workspace.solution } : {});
      const solution = workspace?.solution ?? await service.resolveSolution(ctx, args.solutionMode);
      const catalog = await service.fabricOptions(ctx, solution);
      const fabric = { ...catalog, leafNodeCabling: listNetworkLeafCablingChoices(catalog),
        ...(workspace ? { networkTypes: workspaceNetworkTypes(catalog, workspace.serverState) } : {}) };
      const all = args.collection === 'storageControllers'
        ? fabric.storageControllers.map(controller => ({ ...controller,
          expansions: listStorageExpansions(controller).map(({ raw, ...choice }) => ({ ...raw, ...choice })),
        }))
        : fabric[args.collection] ?? [];
      const selected = args.optionId ? all.filter((item) => item.id === args.optionId) : all;
      if (args.optionId && selected.length === 0) throw new Error('Unknown optionId in this fabric collection.');
      const items: Record<string, unknown>[] = selected.map((item) => args.fields
        ? Object.fromEntries(Object.entries(item).filter(([key]) => key === 'id' || args.fields!.includes(key)))
        : { ...item });
      return projectCatalogPage({
        tool: 'dcsc_fabric_options', collection: 'items', context: ctx.locale,
        arguments: { session: args.session, solutionMode: solution.solutionMode,
          collection: args.collection, optionId: args.optionId, fields: args.fields },
        offset: args.optionId && args.path === undefined ? 0 : args.offset, limit: args.limit, path: args.path,
        expectedCatalogFingerprint: args.expectedCatalogFingerprint, items,
        base: { solutionMode: solution.solutionMode, currency: ctx.locale.currency,
          collection: args.collection, total: all.length, offset: args.offset, limit: args.limit,
          collections: Object.fromEntries(Object.entries(fabric).map(([key, values]) => [key, values?.length ?? 0])) },
      });
    }, 'dcsc_fabric_options failed'),
  );

  server.registerTool(
    'dcsc_set_node_role',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: 'Set a configuration\'s role in the cluster',
      description:
        'Tags a configuration as Compute, Storage or Management (from dcsc_fabric_options).',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected configuration revision.'),
        session: z.string(),
        role: z.string().describe('Role from dcsc_fabric_options, e.g. "Compute".'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);
        const ctx = service.newCtx({ locale: session.locale, solution: session.solution });
        const roles = await service.fabricOptions(ctx, session.solution);
        const match = roles.nodeRoles.find(
          (r) => r.role.toLowerCase() === args.role.toLowerCase(),
        );
        if (!match) {
          throw new Error(
            `Unknown node role "${args.role}". Valid roles: ${roles.nodeRoles.map((r) => r.role).join(', ')}.`,
          );
        }
        await service.sessions.transact(session.id, { expectedRevision: args.expectedRevision }, (workspace, draft) => {
          if (!draft) throw new Error(`Configuration session ${session.id} no longer exists.`);
          if (draft.raw.nodeRole !== match.role) {
            invalidateConnectionGraph(workspace.serverState, 'Node role changed. Regenerate connections.');
          }
          draft.raw.nodeRole = match.role;
        });
        const updated = requireSession(service, session.id);
        const workspace = service.sessions.getWorkspace(updated.id)!;
        const connectionGraphStale = workspace.serverState.connectionGraphInvalidation !== undefined;
        return { session: updated.id, revision: updated.revision, nodeRole: match.role,
          workspace: workspace.id, workspaceRevision: workspace.revision, connectionGraphStale,
          ...(connectionGraphStale ? { regenerateConnections: { tool: 'dcsc_add_cabling', arguments: {
            session: workspace.id, mode: 'auto', expectedRevision: workspace.revision,
          } } } : {}) };
      }, 'dcsc_set_node_role failed'),
  );

  server.registerTool(
    'dcsc_set_topology',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: 'Apply a network topology to a configuration',
      description:
        'Selects a fabric topology shortName (from dcsc_fabric_options, e.g. IB_XDR, 400GbE_Fiber) and connectors/ports on a configuration, running auto-connect when racks are present and autoConnect=true.',
      inputSchema: {
        session: z.string().describe('Configuration session ID.'),
        topology: z.string().describe('Topology shortName from dcsc_fabric_options, e.g. "IB_XDR".'),
        networkName: z.string().optional().describe('Network name or stable networkType ID. Required when topology does not uniquely identify a network.'),
        connectorIds: z.array(z.string()).optional().describe('Connector IDs to select. An explicitly empty selection clears ports for this network.'),
        ports: z.array(z.string()).optional().describe('Exact port selectors; pass [] to clear this network’s ports.'),
        expectedRevision: z.number().int().min(1).optional(),
        autoConnect: z
          .boolean()
          .optional()
          .default(true)
          .describe('If true (default) and the workspace has racks, run DCSC auto-connect after selecting.'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = requireSession(service, args.session);
        const ctx = service.newCtx({ locale: session.locale, solution: session.solution });
        const result = await service.applyTopology({
          sessionHandle: session.id,
          topology: args.topology, networkName: args.networkName, connectorIds: args.connectorIds, ports: args.ports,
          expectedRevision: args.expectedRevision,
          autoConnect: args.autoConnect ?? true,
          ctx,
        });
        const workspace = service.sessions.getWorkspace(session.id)!;
        const connectionGraphStale = workspace.serverState.connectionGraphInvalidation !== undefined;
        return {
          session: result.session,
          revision: requireSession(service, session.id).revision,
          workspace: workspace.id, workspaceRevision: workspace.revision, connectionGraphStale,
          ...(connectionGraphStale ? { regenerateConnections: { tool: 'dcsc_add_cabling', arguments: {
            session: workspace.id, mode: 'auto', expectedRevision: workspace.revision,
          } } } : {}),
          topology: result.topology,
          selectedTopologies: result.selectedTopologies,
          autoConnect: result.autoConnect
            ? {
                connectionCount: result.autoConnect.connections.length,
                messages: result.autoConnect.messages,
              }
            : undefined,
          next:
            result.autoConnect && result.autoConnect.connections.length === 0
              ? 'No connections yet — add switches/nodes or re-run dcsc_add_cabling(mode: "auto").'
              : 'dcsc_add_cabling(mode: "auto") or dcsc_workspace_layout to inspect cabling.',
        };
      }, 'dcsc_set_topology failed'),
  );

  server.registerTool('dcsc_network_connectors', {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'List compatible network connector IDs',
    description: 'Finds actual configuration connectors for a topology. Use the returned IDs with dcsc_set_topology.',
    inputSchema: { session: z.string(), topology: z.string(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(10) },
  }, async (args) => guard(async () => {
    const session = requireSession(service, args.session);
    const ctx = service.newCtx({ locale: session.locale, solution: session.solution });
    const fabric = await service.fabricOptions(ctx, session.solution);
    const choices = listTopologyConnectors(session.raw, fabric, args.topology);
    const items = choices.slice(args.offset, args.offset + args.limit).map(({ raw: _raw, ...choice }) => choice);
    return { session: session.id, topology: args.topology, total: choices.length, items,
      next: args.offset + items.length < choices.length ? { tool: 'dcsc_network_connectors', arguments: { ...args, offset: args.offset + items.length } } : undefined };
  }, 'dcsc_network_connectors failed'));

  server.registerTool('dcsc_set_network_preferences', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Select workspace network devices and cables',
    description: 'Updates workspace network preferences (topology, layout, main/leaf switches, trunks, VLAN joins, cable categories/colors) atomically, provisioning switches when automatic switch creation is enabled.',
    inputSchema: {
      session: z.string(),
      selections: z.array(z.object({ networkTypeId: z.string(), topology: z.string().optional(),
        layout: z.enum(['Centralized', 'Distributed']).optional(),
        mainDeviceId: z.string().optional().describe('Catalog device ID or existing-customer-switch to clear the managed main switch.'),
        leafDeviceId: z.string().optional().describe('Catalog device ID or existing-customer-switch to clear the managed leaf switch.'),
        mainTrunks: z.number().int().min(0).optional().describe('Trunk count, bounded by the selected switch topology capacity.'),
        leafTrunks: z.number().int().min(0).optional(),
        leafCabling: z.string().optional().describe('Exact description from dcsc_fabric_options collection=leafNodeCabling.'),
        vlanNetworkTypeIds: z.array(z.string()).optional().describe('Stable IDs of peer networks sharing the main switch; empty array clears VLAN joins.'),
        customCableId: z.string().optional().describe('Custom cable catalog ID with an existing customer main switch; manual-cable clears the fixed cable part.'),
        cableId: z.string().optional(), leafCableId: z.string().optional(),
        cableColor: z.string().optional().describe('Catalog cable color; empty string clears the preference.'),
        leafCableColor: z.string().optional().describe('Leaf cable color; empty string clears the preference.') })).min(1),
      expectedRevision: z.number().int().min(1).optional(), autoConnect: z.boolean().default(false),
    },
  }, async (args) => guard(async () => {
    const workspace = service.sessions.getWorkspace(args.session);
    if (!workspace) throw new Error('Workspace not found.');
    const result = await service.setNetworkPreferences(workspace.id, { selections: args.selections,
      expectedRevision: args.expectedRevision, autoConnect: args.autoConnect,
      ctx: service.newCtx({ locale: workspace.locale, solution: workspace.solution }) });
    return { ...result, ...(result.autoConnectRequired ? {
      regenerateConnections: { tool: 'dcsc_add_cabling', arguments: {
        session: workspace.id, mode: 'auto', expectedRevision: result.revision,
      } },
    } : {}) };
  }, 'dcsc_set_network_preferences failed'));
}
