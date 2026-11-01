import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { configurationListPrice } from '../domain/pricing.js';
import type { LayoutResult } from '../domain/rack.js';
import { projectCatalogPage } from '../model/catalogPage.js';
import { projectSummary } from '../model/project.js';
import {
  projectWorkspaceLayout,
  projectWorkspacePage,
} from '../model/workspaceProjection.js';
import type { WorkspaceSession } from '../model/session.js';
import type { DcscService } from './service.js';
import type { RackPositionRuleInput } from '../domain/rackPositionRule.js';
import { requireSession } from './sessionTools.js';
import { guard, withToolSupport } from './toolSupport.js';

/**
 * Presents a rack layout the way an architect reads one.
 *
 * Everything here is DCSC's verdict, not ours — in particular `unplaced` and
 * `errors`, which are how the server says a placement was refused.
 */
export function projectLayout(layout: LayoutResult, workspace: WorkspaceSession): Record<string, unknown> {
  const unstable = layout.racks.filter((r) => r.stableStatus && r.stableStatus !== 'PASSED');
  const page = (path: string[]) => ({
    tool: 'dcsc_workspace_layout',
    arguments: {
      session: workspace.id,
      expectedWorkspaceRevision: workspace.revision,
      path,
      offset: 0,
      limit: 20,
    },
  });
  const rackRows = layout.racks.map((r) => ({
    rackId: r.id,
    code: r.code,
    description: r.description,
    sizeU: r.sizeU,
    usedU: r.usedU,
    freeU: r.freeU,
    totalWeightKg: r.totalWeightKg,
    stability: r.stableStatus,
    items: r.items,
  }));
  const full: Record<string, unknown> = {
    racks: rackRows,
    rackCount: layout.racks.length,
    unplaced: layout.unplaced,
    unplacedCount: layout.unplaced.length,
    errors: layout.errors,
    errorCount: layout.errors.length,
    pages: {
      racks: { total: layout.racks.length, inspect: page(['rawRackArea']) },
      unplaced: { total: layout.unplaced.length, inspect: page(['rawNonRackArea']) },
      errors: { total: layout.errors.length, inspect: page(['layoutErrors']) },
    },
    ...(layout.unplaced.length > 0
      ? {
          warning:
            `DCSC could not place ${layout.unplaced.length} item(s) in a rack. ` +
            'They remain outside the rack area — see errors for the rule that blocked them.',
        }
      : {}),
    ...(unstable.length > 0
      ? {
          stabilityWarning:
            `Centre-of-gravity check returned ${unstable
              .map((r) => `${r.code}=${r.stableStatus}`)
              .join(', ')}. FAILED means the rack is not safe to ship as laid out.`,
        }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(full, null, 2)) <= 7_000) return full;

  const clip = (value: string | undefined) => value === undefined
    ? { value: undefined, truncated: false }
    : value.length <= 160
      ? { value, truncated: false }
      : { value: value.slice(0, 160), truncated: true };
  const compactRacks = layout.racks.slice(0, 3).map((rack, index) => {
    const detail = page(['rawRackArea', String(index)]);
    const row: Record<string, unknown> = {
      sizeU: rack.sizeU, usedU: rack.usedU, freeU: rack.freeU,
      totalWeightKg: rack.totalWeightKg, stability: rack.stableStatus,
      itemCount: rack.items.length, errorCount: rack.errors.length, detail,
    };
    for (const [field, value] of [['rackId', rack.id], ['code', rack.code], ['description', rack.description]] as const) {
      const clipped = clip(value);
      if (clipped.value !== undefined) row[field] = clipped.value;
      if (clipped.truncated) row[`${field}Truncated`] = true;
    }
    return row;
  });
  const compactUnplaced = layout.unplaced.slice(0, 3).map((item, index) => {
    const detail = page(['rawNonRackArea', String(index)]);
    const row: Record<string, unknown> = { detail };
    for (const [field, value] of [['id', item.id], ['code', item.code], ['description', item.description]] as const) {
      const clipped = clip(value);
      if (clipped.value !== undefined) row[field] = clipped.value;
      if (clipped.truncated) row[`${field}Truncated`] = true;
    }
    return row;
  });
  const compactErrors = layout.errors.slice(0, 3).map((error, index) => {
    const detail = page(['layoutErrors', String(index)]);
    const row: Record<string, unknown> = { detail };
    for (const [field, value] of [['code', error.code], ['message', error.message]] as const) {
      const clipped = clip(value);
      if (clipped.value !== undefined) row[field] = clipped.value;
      if (clipped.truncated) row[`${field}Truncated`] = true;
    }
    return row;
  });
  const compact: Record<string, unknown> = {
    racks: compactRacks,
    rackCount: layout.racks.length,
    racksReturned: compactRacks.length,
    unplaced: compactUnplaced,
    unplacedCount: layout.unplaced.length,
    unplacedReturned: compactUnplaced.length,
    errors: compactErrors,
    errorCount: layout.errors.length,
    errorsReturned: compactErrors.length,
    pages: full['pages'],
    compacted: true,
    ...(layout.unplaced.length > 0
      ? { warning: `DCSC could not place ${layout.unplaced.length} item(s) in a rack. Follow pages.unplaced for the complete accepted state.` }
      : {}),
    ...(unstable.length > 0
      ? { stabilityWarning: `Centre-of-gravity check returned ${unstable.length} non-passing rack verdict(s). Follow pages.racks for complete details.` }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(compact, null, 2)) > 7_500) {
    throw new Error('Layout result context exceeds the response budget. Use dcsc_recovery_export to inspect the workspace.');
  }
  return compact;
}

export function registerRackLayoutTools(rawServer: McpServer, service: DcscService): void {
  const server = withToolSupport(rawServer);

  server.registerTool(
    'dcsc_list_racks',
    {
      title: 'List rack cabinets and compatible chassis or nodes',
      description:
        'Lists rack cabinets (or compatible chassis/nodes via hardwareType). Pass session or productCode to filter by compatibility.',
      inputSchema: { solutionMode: z.string().optional(), session: z.string().optional(), productCode: z.string().optional(),
        hardwareType: z.enum(['rack', 'chassis', 'node']).optional().default('rack'),
        path: z.array(z.string()).optional().describe('Lossless detail path from a returned continuation.'),
        expectedCatalogFingerprint: z.string().optional().describe('Returned continuation fingerprint; rejects changed compatibility catalog or context.'),
        offset: z.number().int().min(0).optional().default(0), limit: z.number().int().min(1).max(50).optional().default(20) },
    },
    async (args) =>
      guard(async () => {
        const session = args.session ? requireSession(service, args.session) : undefined;
        if (session && args.productCode && args.productCode !== session.product.code) throw new Error('productCode conflicts with the selected configuration.');
        const masterCode = session?.product.code ?? args.productCode;
        const ctx = service.newCtx(session ? { locale: session.locale, solution: session.solution } : {});
        const solution = session?.solution ?? await service.resolveSolution(ctx, args.solutionMode);
        if (session && args.solutionMode && (await service.resolveSolution(ctx, args.solutionMode)).solutionMode !== solution.solutionMode) throw new Error('solutionMode conflicts with the selected configuration.');
        const hardwareType = args.hardwareType ?? 'rack';
        const racks = await service.rackCabinets(ctx, solution, masterCode, hardwareType);
        const result = projectCatalogPage({
          tool: 'dcsc_list_racks', collection: 'racks', context: ctx.locale,
          arguments: { session: args.session, productCode: args.productCode, solutionMode: solution.solutionMode, hardwareType },
          offset: args.offset, limit: args.limit, path: args.path,
          expectedCatalogFingerprint: args.expectedCatalogFingerprint, items: racks.map(rack => ({ ...rack })),
          base: { solutionMode: solution.solutionMode, hardwareType, total: racks.length, compatibleWith: masterCode ?? null,
            offset: args.offset, nextAction: hardwareType === 'rack'
              ? 'dcsc_add_rack(session, rackCode) to add one to a workspace.'
              : 'dcsc_launch(productCode, workspace) to configure the selected product, then dcsc_place_in_rack; include chassisId to copy a node into its chassis.' },
        });
        return args.path !== undefined ? result : { ...result, returned: (result.page as Record<string, unknown>).returned };
      }, 'dcsc_list_racks failed'),
  );

  server.registerTool(
    'dcsc_add_rack',
    {
      title: 'Add a rack enclosure to a solution workspace',
      description:
        'Adds a rack cabinet (rackCode from dcsc_list_racks) to a workspace and returns the DCSC-validated layout.',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
        session: z.string().describe('Session or workspace ID.'),
        rackCode: z.string().describe('Rack product code from dcsc_list_racks, e.g. "7D6DCTO1WW".'),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const layout = await service.addRack(args.session, args.rackCode, ctx, args.expectedRevision);
        const workspace = service.sessions.getWorkspace(args.session)!;
        return {
          session: args.session,
          revision: workspace.revision,
          ...projectLayout(layout, workspace),
          next: 'dcsc_place_in_rack(session, rackId, sessionId) to place a configuration in this rack.',
        };
      }, 'dcsc_add_rack failed'),
  );

  server.registerTool(
    'dcsc_place_in_rack',
    {
      title: 'Place a configuration in a rack enclosure',
      description:
        'Places one configured product into a rack and returns DCSC\'s validated U positions, weight and stability verdict. Omit uPosition to let DCSC choose a valid slot. Places ONE physical unit per configuration (use dcsc_clone_configuration for multiple units). Pass chassisId to copy a non-rack node into a placed chassis.',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
        session: z.string().describe('Session or workspace ID.'),
        rackId: z.string().describe('Rack ID from dcsc_add_rack.'),
        sessionId: z.string().describe('Configuration session/ID to place, or an existing managed-storage physical ID to move.'),
        chassisId: z.string().optional().describe('Placed chassis ID for Add Node As Copy. The source node remains in the non-rack area.'),
        uPosition: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('Starting U position. Omit to let DCSC arrange it.'),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const placed = service.sessions.get(args.sessionId);
        const quantity = placed?.raw.quantity ?? 1;

        const layout = await service.placeInRack(args.session, {
          rackId: args.rackId,
          expectedRevision: args.expectedRevision,
          sessionId: args.sessionId,
          ...(args.chassisId !== undefined ? { chassisId: args.chassisId } : {}),
          ...(args.uPosition !== undefined ? { position: args.uPosition } : {}),
          ctx,
        });
        const workspace = service.sessions.getWorkspace(args.session)!;
        return {
          session: args.session,
          revision: workspace.revision,
          ...projectLayout(layout, workspace),
          ...(layout.nestedPlacement ? { nestedPlacement: layout.nestedPlacement } : {}),
          ...(quantity > 1
            ? {
                quantityWarning:
                  `${args.sessionId} has quantity ${quantity}, but placement added ONE item ` +
                  `(${placed?.product.code ?? 'unknown'}) to the rack. The rack elevation, used U and ` +
                  'weight therefore reflect a single unit while the price reflects ' +
                  `${quantity}. Use dcsc_clone_configuration(session, count: ${quantity - 1}) and place ` +
                  'each copy to model the real cabinet.',
              }
            : {}),
        };
      }, 'dcsc_place_in_rack failed'),
  );

  server.registerTool(
    'dcsc_edit_layout',
    {
      title: 'Move, unplace, detach, remove or arrange workspace items',
      description: 'Edits workspace layout atomically through DCSC: move (to rackId/uPosition), unplace (to non-rack area), detach (Delete Node from chassis while keeping commercial line; use unplace for roundtrip reimport retention), remove (delete configuration), or arrange (reorder rack contents).',
      inputSchema: {
        session: z.string().describe('Workspace ID, or a configuration handle in that workspace.'),
        action: z.enum(['move', 'unplace', 'detach', 'remove', 'arrange']),
        configuration: z.string().optional().describe('Configuration session handle or physical instance ID; required except for arrange.'),
        rackId: z.string().optional().describe('Destination rack ID for move.'),
        uPosition: z.number().int().min(1).optional(),
        contents: z.enum(['unplace', 'delete']).default('unplace').describe('Disposition of products inside a removed rack or chassis.'),
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
      },
    },
    async (args) => guard(async () => {
      const workspace = service.sessions.getWorkspace(args.session);
      if (!workspace) throw new Error('Workspace not found.');
      const ctx = service.newCtx({ locale: workspace.locale, solution: workspace.solution });
      if (args.action !== 'arrange' && !args.configuration) throw new Error('configuration is required for this action.');
      let layout: LayoutResult;
      if (args.action === 'move') {
        if (!args.rackId) throw new Error('rackId is required when moving a configuration.');
        layout = await service.placeInRack(workspace.id, { rackId: args.rackId,
          sessionId: args.configuration!, position: args.uPosition, expectedRevision: args.expectedRevision, ctx });
      } else {
        layout = await service.editLayout(workspace.id, { action: args.action, configurationId: args.configuration,
          contents: args.contents, expectedRevision: args.expectedRevision, ctx });
      }
      return { workspace: workspace.id, revision: workspace.revision, ...projectLayout(layout, workspace),
        ...(args.action === 'detach' ? { warning: 'The node configuration remains in this workspace and its commercial export. Lenovo reimport drops detached nodes. Undo this action and use unplace to retain the node through an export/import roundtrip.' } : {}) };
    }, 'dcsc_edit_layout failed'),
  );

  server.registerTool(
    'dcsc_place_on_floor',
    {
      title: 'Place a rack on the floor grid (planning only)',
      description:
        'Positions a rack on client-side floor-tile coordinates (x, y) for layout planning and workspace exports.',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
        session: z.string().describe('Session or workspace ID.'),
        rackId: z.string().describe('Rack ID from dcsc_add_rack (configuration id of the rack).'),
        x: z.number().int().min(0).describe('Floor tile X coordinate (0-based).'),
        y: z.number().int().min(0).describe('Floor tile Y coordinate (0-based).'),
      },
    },
    async (args) =>
      guard(async () => {
        const result = await service.placeOnFloor(args.session, args.rackId, args.x, args.y, args.expectedRevision);
        return {
          session: args.session,
          revision: service.sessions.getWorkspace(args.session)!.revision,
          floorPlacement: result.item,
          clientSide: result.clientSide,
          warning: result.warning,
          next: 'dcsc_workspace_layout(session) to list floor items.',
        };
      }, 'dcsc_place_on_floor failed'),
  );

  server.registerTool('dcsc_set_rack_lock', {
    title: 'Lock or unlock a rack item or empty U position',
    description: 'Locks or unlocks an existing direct rack item (itemId) or empty U slot (rackId + 1-based position) and commits atomically with history.',
    inputSchema: {
      session: z.string().describe('Workspace or configuration handle.'),
      target: z.union([
        z.object({ itemId: z.string().min(1).describe('Physical item ID from dcsc_workspace_layout.') }).strict(),
        z.object({ rackId: z.string().min(1), position: z.number().int().min(1).describe('Empty U position, one-based.') }).strict(),
      ]),
      locked: z.boolean().describe('true to lock; false to unlock.'),
      expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
    },
  }, async args => guard(async () => {
    const { layout: _layout, ...accepted } = await service.setRackLock(args.session, {
      target: args.target, locked: args.locked, expectedRevision: args.expectedRevision, ctx: service.newCtx(),
    });
    const workspace = service.sessions.getWorkspace(args.session)!;
    return { ...accepted, workspace: workspace.id, workspaceRevision: workspace.revision,
      revisionScope: 'workspace', next: { tool: 'dcsc_workspace_layout', arguments: { session: workspace.id } } };
  }, 'dcsc_set_rack_lock failed'));

  server.registerTool('dcsc_copy_rack_item', {
    title: 'Copy a configured rack item independently',
    description: 'Performs the website rack Copy action for a direct CTO item (or populated HPC chassis with direct node children), creating an independent configuration Copy_<name> in the same rack whose future edits do not propagate to the source.',
    inputSchema: {
      session: z.string().describe('Explicit configuration handle of the racked item to copy.'),
      expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
    },
  }, async args => guard(async () => {
    const { source, copy, placement, nestedCopies } = await service.copyRackItem(args.session, {
      expectedRevision: args.expectedRevision, ctx: service.newCtx(),
    });
    return {
      ...projectSummary({ sessionId: copy.id, revision: copy.revision, raw: copy.raw, index: copy.index,
        currency: copy.locale.currency, country: copy.locale.country, pricedAt: copy.pricedAt }),
      workspace: copy.workspaceId,
      workspaceRevision: service.sessions.getWorkspace(copy.workspaceId)!.revision,
      configurationId: copy.configurationId, name: copy.raw.name,
      nestedConfigurationsCreated: nestedCopies.length,
      source: { session: source.id, configurationId: source.configurationId },
      placement,
      inspect: { tool: 'dcsc_workspace_layout', arguments: { session: copy.workspaceId } },
      next: { tool: 'dcsc_list_options', arguments: { session: copy.id } },
    };
  }, 'dcsc_copy_rack_item failed'));

  server.registerTool(
    'dcsc_clone_configuration',
    {
      title: 'Duplicate a configured product N times in the same workspace',
      description:
        'Duplicates a configured product into N additional configurations in the same workspace. Default placement="none" creates unplaced copies; placement="same-rack" performs the website Clone Multiple workflow (linked copies placed in free U slots of the same rack).',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
        session: z.string().describe('Session holding the configured template product.'),
        placement: z.enum(['none', 'same-rack']).optional().describe('Default none creates configuration copies; same-rack also performs physical Clone Multiple.'),
        count: z
          .number()
          .int()
          .min(1)
          .max(32)
          .describe('How many additional copies to create (the source is not counted).'),
        labelPrefix: z
          .string()
          .optional()
          .describe('Names clones "<prefix> 2", "<prefix> 3", … Defaults to the source label.'),
      },
    },
    async (args) =>
      guard(async () => {
        const { source, clones, placements, nestedConfigurations } = await service.cloneConfiguration({
          sessionHandle: args.session,
          count: args.count,
          expectedRevision: args.expectedRevision,
          placement: args.placement,
          ctx: service.newCtx(),
          ...(args.labelPrefix !== undefined ? { labelPrefix: args.labelPrefix } : {}),
        });
        const unit = configurationListPrice(source.raw);
        const configurations = [source, ...clones, ...nestedConfigurations ?? []];
        const priceAvailable = configurations.every(session => configurationListPrice(session.raw) !== null);
        const total = configurations.reduce((sum, session) =>
          sum + (configurationListPrice(session.raw) ?? 0) * (session.raw.quantity ?? 1), 0);
        return {
          workspace: source.workspaceId,
          revision: source.revision,
          workspaceRevision: service.sessions.getWorkspace(source.workspaceId)!.revision,
          source: { session: source.id, productCode: source.product.code, unitPrice: unit },
          created: clones.map((c) => ({
            session: c.id,
            configurationId: c.configurationId,
            label: c.label,
            unitPrice: configurationListPrice(c.raw),
          })),
          totalConfigurations: configurations.length,
          ...(nestedConfigurations ? { nestedConfigurationsCreated: nestedConfigurations.length * clones.length / (clones.length + 1) } : {}),
          combinedListPrice: priceAvailable ? Math.round(total * 100) / 100 : null,
          priceAvailable,
          ...(!priceAvailable ? { knownListPriceSubtotal: Math.round(total * 100) / 100 } : {}),
          currency: source.locale.currency,
          priceType: 'LIST',
          nodeRole: source.reduced.nodeRole,
          ...(placements ? { placements } : {}),
          next: placements
            ? { tool: 'dcsc_workspace_layout', arguments: { session: source.workspaceId } }
            : 'dcsc_place_in_rack(session, rackId, sessionId) for each, or dcsc_scale_out to size racks first.',
        };
      }, 'dcsc_clone_configuration failed'),
  );

  server.registerTool(
    'dcsc_workspace_layout',
    {
      title: 'Read back the validated rack and floor layout',
      description:
        'Returns the physical layout of a workspace: racks (U occupancy, weight, stability verdict, items), cables, floor tiles and power selections. Large collections return revision-bound continuations.',
      inputSchema: {
        session: z.string().describe('Session or workspace ID.'),
        path: z.array(z.string()).optional().describe('Detail path from a returned inspect/detail continuation.'),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(1000).optional().default(20),
        expectedWorkspaceRevision: z.number().int().min(1).optional()
          .describe('Revision supplied by a continuation; rejects pages from a workspace that changed.'),
      },
    },
    async (args) =>
      guard(async () => {
        const ws = service.sessions.getWorkspace(args.session);
        if (!ws) throw new Error(`Session / Workspace ${args.session} not found`);
        if (args.expectedWorkspaceRevision !== undefined && args.expectedWorkspaceRevision !== ws.revision) {
          throw new Error(
            `Workspace ${ws.id} changed from revision ${args.expectedWorkspaceRevision} to ${ws.revision}. ` +
            'Restart dcsc_workspace_layout without path before following new continuations.',
          );
        }
        if (args.path !== undefined) {
          if (args.expectedWorkspaceRevision === undefined) {
            throw new Error(
              'expectedWorkspaceRevision is required for detail pages. ' +
              'Call dcsc_workspace_layout without path and follow its continuation.',
            );
          }
          return projectWorkspacePage(ws, {
            tool: 'dcsc_workspace_layout',
            arguments: { session: ws.id, expectedWorkspaceRevision: ws.revision },
            path: args.path,
            offset: args.offset,
            limit: args.limit,
          });
        }
        return projectWorkspaceLayout(ws, {
          tool: 'dcsc_workspace_layout',
          arguments: { session: ws.id, expectedWorkspaceRevision: ws.revision },
        });
      }, 'dcsc_workspace_layout failed'),
  );

  server.registerTool(
    'dcsc_configure_pdu',
    {
      title: 'Select PDUs and power cords on a rack',
      description:
        'Configures PDUs and line/jumper cords on a rack cabinet through DCSC autoDerive. Call with session+rackId alone to list options and placement rules; call with pduCode (and optional cordCode, quantity) to apply.',
      inputSchema: {
        expectedRevision: z.number().int().min(1).optional().describe('Expected workspace revision.'),
        session: z.string().describe('Session or workspace ID.'),
        rackId: z.string().describe('Rack ID from dcsc_add_rack (configuration id of the rack).'),
        pduCode: z
          .string()
          .optional()
          .describe('PDU feature code from the catalog, e.g. "C0CS". Omit to list options only.'),
        cordCode: z
          .string()
          .optional()
          .describe('Line cord or rack power cable feature code, e.g. "6500".'),
        quantity: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(1)
          .describe('Quantity for pduCode/cordCode. 0 removes. Default 1.'),
      },
    },
    async (args) =>
      guard(async () => {
        const ctx = service.newCtx();
        const result = await service.configurePdu(args.session, args.rackId, {
          ...(args.pduCode !== undefined ? { pduCode: args.pduCode } : {}),
          ...(args.cordCode !== undefined ? { cordCode: args.cordCode } : {}),
          quantity: args.quantity ?? 1,
          expectedRevision: args.expectedRevision,
          ctx,
        });

        if (result.catalog) {
          const project = (o: (typeof result.catalog.options)[number]) => ({
            code: o.code,
            desc: o.description.slice(0, 64),
            max: o.max,
            unitPrice: o.unitPrice,
            ...(o.selectedQty > 0 ? { selectedQty: o.selectedQty } : {}),
          });
          const bucket = (pred: (s: string) => boolean, limit: number) => {
            const all = result.catalog!.options.filter((o) => pred(o.section.toUpperCase()));
            return {
              total: all.length,
              shown: Math.min(all.length, limit),
              truncated: all.length > limit,
              options: all.slice(0, limit).map(project),
            };
          };

          const pdus = bucket((s) => s === 'PDU', 14);
          const lineCords = bucket((s) => s === 'LINECORD', 18);
          const jumpers = bucket((s) => s === 'RACK_POWERCABLE', 6);
          const other = bucket(
            (s) => s !== 'PDU' && s !== 'LINECORD' && s !== 'RACK_POWERCABLE',
            4,
          );

          return {
            session: args.session,
            rackId: result.rackId,
            revision: service.sessions.getWorkspace(args.session)!.revision,
            rackSession: result.rackSessionId,
            listing: true,
            pduOptions: pdus.options,
            lineCordOptions: lineCords.options,
            jumperCordOptions: jumpers.options,
            otherPowerOptions: other.options,
            counts: {
              pdu: { total: pdus.total, shown: pdus.shown, truncated: pdus.truncated },
              lineCord: {
                total: lineCords.total,
                shown: lineCords.shown,
                truncated: lineCords.truncated,
              },
              jumperCord: {
                total: jumpers.total,
                shown: jumpers.shown,
                truncated: jumpers.truncated,
              },
              other: { total: other.total, shown: other.shown, truncated: other.truncated },
            },
            placementRules: result.catalog.placementRules,
            totalCombinedSlots: result.catalog.totalCombinedSlots,
            selected: result.selected,
            totalPrice: result.totalPrice,
            priceType: 'LIST',
            lineCordNote:
              lineCords.total === 0
                ? 'This rack tree carries no LINECORD options — check dcsc_list_options(rackSession, tab: "Power").'
                : 'A PDU needs a LINECORD to reach facility power; jumper cords only connect equipment ' +
                  'to the PDU. Line cords are country- and voltage-specific, so pick one that matches ' +
                  'the site feed.',
            next:
              'dcsc_configure_pdu(session, rackId, pduCode: "<code>", cordCode: "<lineCord>", quantity: N). ' +
              'Prices are anonymous LIST prices.',
          };
        }

        return {
          session: args.session,
          rackId: result.rackId,
          revision: service.sessions.getWorkspace(args.session)!.revision,
          rackSession: result.rackSessionId,
          powerSelection: result.selection,
          selected: result.selected,
          totalPrice: result.totalPrice,
          priceType: 'LIST',
          powerReadiness: result.powerReadiness,
          note:
            'Selection was applied through DCSC autoDerive. totalPrice is the rack cabinet LIST price ' +
            'after the change, not a quote.',
          next:
            result.powerReadiness && !result.powerReadiness.complete
              ? 'dcsc_configure_pdu(session, rackId, cordCode: "<code>", quantity: N) to add the line cords ' +
                'this rack still needs.'
              : 'dcsc_session_info(rackSession) for the full rack BOM, or dcsc_workspace_layout(session).',
        };
      }, 'dcsc_configure_pdu failed'),
    );

  server.registerTool(
    'dcsc_rack_position_rule',
    {
      title: 'Get hardware U-position rules in a rack',
      description: 'Calculates lowest and highest valid U-positions and placement rules for a server or hardware item within a rack.',
      inputSchema: {
        rack: z.object({
          code: z.string(),
          machineType: z.string().optional(),
          sliceCtoCode: z.string().nullable().optional(),
          size: z.number(),
          rackItem: z.object({
            code: z.string(),
            machineType: z.string().optional(),
            sliceCtoCode: z.string().nullable().optional(),
            type: z.string(),
            asVLH: z.boolean().optional(),
          }).passthrough(),
        }).passthrough().describe('Rack container specification.'),
        configurations: z.array(
          z.object({
            configurationId: z.string(),
            core: z.record(z.string(), z.unknown()).optional(),
            sectionResults: z.array(z.unknown()).optional(),
            unSelectableCharacters: z.array(z.unknown()).optional(),
            selectedTopologies: z.unknown().optional(),
            selectedStorageNetwork: z.unknown().optional(),
            connectors: z.array(z.unknown()).optional(),
          }).passthrough(),
        ).describe('Associated configurations.'),
      },
    },
    async (args) =>
      guard(async () => {
        return service.rackPositionRule(args as unknown as RackPositionRuleInput);
      }, 'dcsc_rack_position_rule failed'),
  );
}
