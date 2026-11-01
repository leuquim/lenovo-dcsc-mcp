import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getHardwareRuleInRack, type RackPositionRuleInput } from '../domain/rackPositionRule.js';
import { fetchRackCabinets } from '../domain/rack.js';
import { z } from 'zod';

import { configurationListPrice } from '../domain/pricing.js';
import type { LayoutResult } from '../domain/rack.js';
import { projectCatalogPage } from '../model/catalogPage.js';
import { projectSummary } from '../model/project.js';
import type { WorkspaceSession } from '../model/session.js';
import type { DcscService } from './service.js';
import { requireWorkspaceOf } from '../app/workspaceView.js';
import { requireSession, writeHeader } from './sessionTools.js';
import { guard } from './toolSupport.js';
import { jsonBytes } from '../util/jsonBytes.js';
import { PAGE_BYTE_BUDGET } from '../config/constants.js';

/**
 * Presents a rack layout the way an architect reads one.
 *
 * Everything here is DCSC's verdict, not ours — in particular `unplaced` and
 * `errors`, which are how the server says a placement was refused.
 */
export function projectLayout(layout: LayoutResult, workspace: WorkspaceSession): Record<string, unknown> {
  const unstable = layout.racks.filter((r) => r.stableStatus && r.stableStatus !== 'PASSED');
  const page = (path: string[]) => ({
    tool: 'dcsc_workspace_get',
    arguments: {
      session: workspace.id,
      view: 'layout',
      expectedRevision: workspace.revision,
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
  if (jsonBytes(full) <= PAGE_BYTE_BUDGET) return full;

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
  if (jsonBytes(compact) > PAGE_BYTE_BUDGET) {
    throw new Error('Layout result context exceeds the response budget. Use dcsc_recovery_export to inspect the workspace.');
  }
  return compact;
}

const workspaceRevision = z.number().int().min(1).optional().describe('Workspace revision you last read; the call fails if it moved.');

const floorChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('place'), rackId: z.string().describe('Rack id from dcsc_rack_add.'),
    x: z.number().int().min(0).describe('Floor tile X (0-based).'), y: z.number().int().min(0).describe('Floor tile Y (0-based).') }),
  z.object({ kind: z.literal('color'), rackId: z.string(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('Hex colour, e.g. "#21bbbb".') }),
  z.object({
    kind: z.literal('preferences'),
    rowCount: z.number().int().min(2).max(100).optional().describe('Grid rows.'),
    colCount: z.number().int().min(1).max(100).optional().describe('Grid columns.'),
    growthRatioHorizontal: z.number().min(0).optional(), growthRatioVertical: z.number().min(0).optional(),
    rackDist: z.number().min(0).optional().describe('Distance between racks, metres.'),
    vertDist: z.number().min(0).optional().describe('Vertical distance, metres.'),
    coldDist: z.number().min(0).optional().describe('Cold aisle distance, metres.'),
    hotDist: z.number().min(0).optional().describe('Hot aisle distance, metres.'),
    slackDist: z.number().min(0).optional().describe('Cable slack, metres.'),
    useTrayCabling: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('controls'),
    autoArrange: z.boolean().optional().describe('false keeps manual rack placement during layout requests.'),
    cogValidation: z.boolean().optional().describe('Centre-of-gravity validation.'),
  }),
]);

function projectPduListing(service: DcscService, session: string, result: Awaited<ReturnType<DcscService['configurePdu']>>) {
  const catalog = result.catalog;
  if (!catalog) throw new Error('DCSC returned no PDU options for this rack.');
  const project = (o: (typeof catalog.options)[number]) => ({
    code: o.code, desc: o.description.slice(0, 64), max: o.max, unitPrice: o.unitPrice,
    ...(o.selectedQty > 0 ? { selectedQty: o.selectedQty } : {}),
  });
  const bucket = (pred: (s: string) => boolean, limit: number) => {
    const all = catalog.options.filter((o) => pred(o.section.toUpperCase()));
    return { total: all.length, truncated: all.length > limit, options: all.slice(0, limit).map(project) };
  };
  return {
    session,
    revision: requireWorkspaceOf(service, session).revision,
    rackId: result.rackId,
    rackSession: result.rackSessionId,
    pduOptions: bucket((s) => s === 'PDU', 14),
    lineCordOptions: bucket((s) => s === 'LINECORD', 18),
    jumperCordOptions: bucket((s) => s === 'RACK_POWERCABLE', 6),
    otherPowerOptions: bucket((s) => s !== 'PDU' && s !== 'LINECORD' && s !== 'RACK_POWERCABLE', 4),
    placementRules: catalog.placementRules,
    totalCombinedSlots: catalog.totalCombinedSlots,
    selected: result.selected,
    totalPrice: result.totalPrice,
    priceType: 'LIST',
    note: 'A PDU needs a LINECORD to reach facility power; jumper cords only connect equipment to the PDU.',
  };
}

export function registerRackLayoutTools(server: McpServer, service: DcscService): void {

  server.registerTool(
    'dcsc_rack_get',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: 'List rack cabinets and PDU options',
      description:
        "Lists rack cabinets, or compatible chassis or nodes, optionally filtered by a session or product. With session and rackId, lists that rack's PDU and power cord options instead.",
      inputSchema: {
        solutionMode: z.string().optional(), session: z.string().optional(), productCode: z.string().optional(),
        hardwareType: z.enum(['rack', 'chassis', 'node']).optional().default('rack'),
        rackId: z.string().optional().describe('With session: list PDU and power cord options for this rack.'),
        path: z.array(z.string()).optional().describe('Detail path from a returned continuation.'),
        expectedCatalogFingerprint: z.string().optional().describe('Fingerprint from a returned continuation.'),
        offset: z.number().int().min(0).optional().default(0), limit: z.number().int().min(1).max(50).optional().default(20),
      },
    },
    async (args) =>
      guard(async () => {
        if (args.rackId !== undefined) {
          if (!args.session) throw new Error('session is required to list PDU options for a rack.');
          const result = await service.configurePdu(args.session, args.rackId, { ctx: service.newCtx() });
          return projectPduListing(service, args.session, result);
        }
        const session = args.session ? requireSession(service, args.session) : undefined;
        if (session && args.productCode && args.productCode !== session.product.code) throw new Error('productCode conflicts with the selected configuration.');
        const masterCode = session?.product.code ?? args.productCode;
        const ctx = service.newCtx(session ? { locale: session.locale, solution: session.solution } : {});
        const solution = session?.solution ?? await service.resolveSolution(ctx, args.solutionMode);
        if (session && args.solutionMode && (await service.resolveSolution(ctx, args.solutionMode)).solutionMode !== solution.solutionMode) throw new Error('solutionMode conflicts with the selected configuration.');
        const hardwareType = args.hardwareType ?? 'rack';
        const racks = await fetchRackCabinets(service.http, { ...ctx, solution }, masterCode, hardwareType);
        const result = projectCatalogPage({
          tool: 'dcsc_rack_get', collection: 'racks', context: ctx.locale,
          arguments: { session: args.session, productCode: args.productCode, solutionMode: solution.solutionMode, hardwareType },
          offset: args.offset, limit: args.limit, path: args.path,
          expectedCatalogFingerprint: args.expectedCatalogFingerprint, items: racks.map(rack => ({ ...rack })),
          base: { solutionMode: solution.solutionMode, hardwareType, total: racks.length, compatibleWith: masterCode ?? null,
            offset: args.offset },
        });
        return args.path !== undefined ? result : { ...result, returned: (result.page as Record<string, unknown>).returned };
      }, 'dcsc_rack_get failed'),
  );

  server.registerTool(
    'dcsc_rack_add',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: 'Add a rack',
      description: 'Adds a rack cabinet (rackCode from dcsc_rack_get) to a workspace and returns the DCSC-validated layout.',
      inputSchema: {
        session: z.string().describe('Workspace or configuration handle.'),
        rackCode: z.string().describe('Rack product code, e.g. "7D6DCTO1WW".'),
        expectedRevision: workspaceRevision,
      },
    },
    async (args) =>
      guard(async () => {
        const workspaceId = requireWorkspaceOf(service, args.session).id;
        const layout = await service.addRack(workspaceId, args.rackCode, service.newCtx(), args.expectedRevision);
        const workspace = service.sessions.getWorkspace(workspaceId)!;
        return { ...writeHeader(service, args.session), ...projectLayout(layout, workspace) };
      }, 'dcsc_rack_add failed'),
  );

  server.registerTool(
    'dcsc_rack_edit',
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      title: 'Edit rack contents',
      description:
        'Places, moves, unplaces, detaches or removes items, arranges rack contents, locks or unlocks an item or empty U, clones a configuration, or copies a racked item. Layout actions return the validated layout.',
      inputSchema: {
        session: z.string().describe('Workspace handle, or a configuration handle in it.'),
        action: z.enum(['place', 'move', 'unplace', 'detach', 'remove', 'arrange', 'lock', 'unlock', 'clone', 'copy']),
        configuration: z.string().optional().describe('Configuration or physical item to act on.'),
        rackId: z.string().optional().describe('place, move: destination rack. lock: rack of an empty U.'),
        uPosition: z.number().int().min(1).max(60).optional().describe('place, move: starting U (omit to let DCSC choose). lock: the empty U.'),
        chassisId: z.string().optional().describe('place: placed chassis to copy a non-rack node into.'),
        itemId: z.string().optional().describe('lock, unlock: physical item id.'),
        contents: z.enum(['unplace', 'delete']).optional().default('unplace').describe('remove: what happens to products inside a removed rack or chassis.'),
        count: z.number().int().min(1).max(32).optional().default(1).describe('clone: additional copies.'),
        placement: z.enum(['none', 'same-rack']).optional().describe('clone: same-rack performs the website Clone Multiple.'),
        labelPrefix: z.string().optional().describe('clone: name prefix for the copies.'),
        expectedRevision: workspaceRevision,
      },
    },
    async (args) => guard(async () => {
      const workspace = requireWorkspaceOf(service, args.session);
      const ctx = service.newCtx({ locale: workspace.locale, solution: workspace.solution });
      const need = (value: string | undefined, name: string): string => {
        if (!value) throw new Error(`${name} is required for action ${args.action}.`);
        return value;
      };
      const layoutResult = (layout: LayoutResult, extra: Record<string, unknown> = {}) => ({
        ...writeHeader(service, args.session), ...projectLayout(layout, service.sessions.getWorkspace(workspace.id)!), ...extra });
      switch (args.action) {
        case 'place': {
          const configuration = need(args.configuration, 'configuration');
          const quantity = service.sessions.get(configuration)?.raw.quantity ?? 1;
          const layout = await service.placeInRack(workspace.id, {
            rackId: need(args.rackId, 'rackId'), expectedRevision: args.expectedRevision, sessionId: configuration,
            ...(args.chassisId !== undefined ? { chassisId: args.chassisId } : {}),
            ...(args.uPosition !== undefined ? { position: args.uPosition } : {}), ctx });
          return layoutResult(layout, {
            ...(layout.nestedPlacement ? { nestedPlacement: layout.nestedPlacement } : {}),
            ...(quantity > 1 ? { quantityWarning:
              `${configuration} has quantity ${quantity}, but placement added ONE item to the rack. ` +
              `Use action clone with count ${quantity - 1} and place each copy to model the real cabinet.` } : {}) });
        }
        case 'move': {
          const layout = await service.placeInRack(workspace.id, { rackId: need(args.rackId, 'rackId'),
            sessionId: need(args.configuration, 'configuration'), position: args.uPosition,
            expectedRevision: args.expectedRevision, ctx });
          return layoutResult(layout);
        }
        case 'unplace': case 'detach': case 'remove': case 'arrange': {
          if (args.action !== 'arrange') need(args.configuration, 'configuration');
          const layout = await service.editLayout(workspace.id, { action: args.action, configurationId: args.configuration,
            contents: args.contents, expectedRevision: args.expectedRevision, ctx });
          return layoutResult(layout, args.action === 'detach' ? { warning:
            'The node configuration remains in this workspace and its commercial export. Lenovo reimport drops detached nodes. Undo this action and use unplace to retain the node through an export/import roundtrip.' } : {});
        }
        case 'lock': case 'unlock': {
          const position = args.uPosition;
          if (args.itemId === undefined && position === undefined) throw new Error('itemId, or rackId with uPosition, is required to lock.');
          const target = args.itemId !== undefined ? { itemId: args.itemId } : { rackId: need(args.rackId, 'rackId'), position: position! };
          const { layout: _layout, ...accepted } = await service.setRackLock(workspace.id, {
            target, locked: args.action === 'lock', expectedRevision: args.expectedRevision, ctx });
          return { ...writeHeader(service, args.session), ...accepted };
        }
        case 'clone': {
          const { source, clones, placements, nestedConfigurations } = await service.cloneConfiguration({
            sessionHandle: args.configuration ?? args.session, count: args.count,
            expectedRevision: args.expectedRevision, placement: args.placement, ctx,
            ...(args.labelPrefix !== undefined ? { labelPrefix: args.labelPrefix } : {}) });
          const configurations = [source, ...clones, ...nestedConfigurations ?? []];
          const priceAvailable = configurations.every(session => configurationListPrice(session.raw) !== null);
          const total = configurations.reduce((sum, session) =>
            sum + (configurationListPrice(session.raw) ?? 0) * (session.raw.quantity ?? 1), 0);
          return { ...writeHeader(service, args.session),
            source: { session: source.id, productCode: source.product.code, unitPrice: configurationListPrice(source.raw) },
            created: clones.map(c => ({ session: c.id, configurationId: c.configurationId, label: c.label, unitPrice: configurationListPrice(c.raw) })),
            totalConfigurations: configurations.length,
            combinedListPrice: priceAvailable ? Math.round(total * 100) / 100 : null, priceAvailable,
            ...(!priceAvailable ? { knownListPriceSubtotal: Math.round(total * 100) / 100 } : {}),
            currency: source.locale.currency, priceType: 'LIST', nodeRole: source.reduced.nodeRole,
            ...(placements ? { placements } : {}) };
        }
        default: {
          const { source, copy, placement, nestedCopies } = await service.copyRackItem(args.configuration ?? args.session, {
            expectedRevision: args.expectedRevision, ctx });
          return { ...writeHeader(service, args.session),
            copy: projectSummary({ sessionId: copy.id, revision: service.sessions.getWorkspace(copy.workspaceId)!.revision, raw: copy.raw, index: copy.index,
              currency: copy.locale.currency, country: copy.locale.country, pricedAt: copy.pricedAt }),
            configurationId: copy.configurationId, name: copy.raw.name,
            nestedConfigurationsCreated: nestedCopies.length,
            source: { session: source.id, configurationId: source.configurationId }, placement };
        }
      }
    }, 'dcsc_rack_edit failed'),
  );

  server.registerTool(
    'dcsc_floor_set',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Set floor layout and layout switches',
      description: 'Places a rack on floor tiles, sets its colour, edits the Floor Preference (grid size, aisle and slack distances) or flips the workspace Auto Arrange and COG Validation switches. Floor state is client-side planning data that exports carry.',
      inputSchema: {
        session: z.string().describe('Workspace or configuration handle.'),
        change: floorChangeSchema,
        expectedRevision: workspaceRevision,
      },
    },
    async (args) =>
      guard(async () => {
        const { change } = args;
        switch (change.kind) {
          case 'place': {
            const result = await service.placeOnFloor(args.session, change.rackId, change.x, change.y, args.expectedRevision);
            return { ...writeHeader(service, args.session), floorPlacement: result.item, clientSide: result.clientSide, warning: result.warning };
          }
          case 'color':
            await service.setRackColor(args.session, change.rackId, change.color, args.expectedRevision);
            return { ...writeHeader(service, args.session), rackId: change.rackId, color: change.color, clientSide: true };
          case 'preferences': {
            const { kind: _kind, ...preferences } = change;
            return { ...writeHeader(service, args.session), floorPreference: await service.setFloorPreferences(args.session, preferences, args.expectedRevision), clientSide: true };
          }
          default: {
            const { kind: _kind, ...controls } = change;
            const current = await service.setLayoutControls(args.session, controls, args.expectedRevision);
            return { ...writeHeader(service, args.session), ...current };
          }
        }
      }, 'dcsc_floor_set failed'),
  );

  server.registerTool(
    'dcsc_pdu_set',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: 'Select PDUs and power cords',
      description: 'Sets PDUs and line or jumper cords on a rack cabinet. List the options first with dcsc_rack_get and rackId.',
      inputSchema: {
        session: z.string().describe('Workspace or configuration handle.'),
        rackId: z.string().describe('Rack id from dcsc_rack_add.'),
        pduCode: z.string().optional().describe('PDU feature code, e.g. "C0CS".'),
        cordCode: z.string().optional().describe('Line cord or rack power cable feature code, e.g. "6500".'),
        quantity: z.number().int().min(0).optional().default(1).describe('Quantity for the codes. 0 removes.'),
        expectedRevision: workspaceRevision,
      },
    },
    async (args) =>
      guard(async () => {
        if (!args.pduCode && !args.cordCode) throw new Error('Provide pduCode or cordCode.');
        const result = await service.configurePdu(args.session, args.rackId, {
          ...(args.pduCode !== undefined ? { pduCode: args.pduCode } : {}),
          ...(args.cordCode !== undefined ? { cordCode: args.cordCode } : {}),
          quantity: args.quantity, expectedRevision: args.expectedRevision, ctx: service.newCtx(),
        });
        return { ...writeHeader(service, args.session), rackId: result.rackId, rackSession: result.rackSessionId,
          powerSelection: result.selection, selected: result.selected, totalPrice: result.totalPrice, priceType: 'LIST',
          powerReadiness: result.powerReadiness };
      }, 'dcsc_pdu_set failed'),
  );

  server.registerTool(
    'dcsc_rack_position_rule',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: 'Get U-position rules in a rack',
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
        return getHardwareRuleInRack(service.http, await service.ctxWithSolution(undefined, 'HPC and AI - Systems'), args as unknown as RackPositionRuleInput);
      }, 'dcsc_rack_position_rule failed'),
  );
}
