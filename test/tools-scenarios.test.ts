import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

import { reduceConfiguration } from '../src/domain/reduce.js';
import { buildIndex } from '../src/model/index.js';
import { projectWorkspaceSummary, workspaceDetailSource } from '../src/model/workspaceProjection.js';
import type { RawConfiguration } from '../src/model/types.js';
import { registerTools } from '../src/mcp/tools.js';
import type { DcscService } from '../src/mcp/service.js';
import type { ConfigSession, WorkspaceSession } from '../src/model/session.js';

type ToolReply = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean | undefined;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolReply>;

function register(service: DcscService): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool(
      name: string,
      _config: unknown,
      handler: ToolHandler,
    ): { remove(): void; update(): void } {
      handlers.set(name, handler);
      return { remove() {}, update() {} };
    },
  };
  registerTools(server as unknown as McpServer, service);
  return handlers;
}

function parse(reply: ToolReply): Record<string, unknown> {
  return JSON.parse(reply.content[0]?.text ?? '{}') as Record<string, unknown>;
}

function configuration(input: {
  id: string;
  workspaceId: string;
  currency?: string;
  code?: string;
  type?: string;
  quantity?: number;
  price?: number;
  maxPowerW?: number;
}): ConfigSession {
  const code = input.code ?? 'NODE';
  const raw: RawConfiguration = {
    id: `${input.id}-configuration`,
    sliceCtoCode: code,
    description: code,
    type: input.type ?? 'server',
    quantity: input.quantity ?? 1,
    totalPrice: input.price ?? 100,
    tabs: [],
    ...(input.maxPowerW !== undefined
      ? {
          powerReportResponse: {
            powerReport: {
              inputPower: {
                idle: input.maxPowerW * 0.2,
                loadFactorResult: input.maxPowerW * 0.8,
                max: input.maxPowerW,
                worst: input.maxPowerW * 1.1,
              },
              inputCurrent: { idle: 1, loadFactorResult: 2, max: 3, worst: 4 },
              apparentPower: {
                idle: input.maxPowerW * 0.25,
                loadFactorResult: input.maxPowerW * 0.85,
                max: input.maxPowerW * 1.05,
                worst: input.maxPowerW * 1.15,
              },
              heatGeneration: {
                idle: 100,
                loadFactorResult: 200,
                max: 300,
                worst: 400,
              },
              operatingVoltage: '230V-AC',
              empty: false,
              warningMessages: [],
            },
          },
        }
      : {}),
  };
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    locale: {
      country: input.currency === 'EUR' ? 'DE' : 'US',
      geo: input.currency === 'EUR' ? 'EMEA' : 'NA',
      language: 'en',
      currency: input.currency ?? 'USD',
    },
    solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
    product: { code, description: code, type: input.type ?? 'server' },
    mode: 'cto',
    validationMode: 'guided',
    autoCorrect: true,
    raw,
    configurationId: `${input.id}-configuration`,
    reduced: reduceConfiguration(raw, `${input.id}-configuration`),
    primed: true,
    configurable: true,
    index: buildIndex(raw),
    revision: 1,
    intents: [],
    snapshots: [],
    createdAt: 1,
    lastAccessAt: 1,
    pricedAt: 1,
  };
}

function workspace(
  id: string,
  configs: ConfigSession[],
  racks: WorkspaceSession['rackSummaries'] = [],
): WorkspaceSession {
  const first = configs[0];
  if (!first) throw new Error('workspace fixture requires a configuration');
  return {
    id,
    locale: first.locale,
    solution: first.solution,
    validationMode: 'guided',
    configurations: new Map(configs.map((config) => [config.id, config])),
    rackArea: [],
    nonRackArea: [],
    serverState: {},
    rackSummaries: racks,
    cables: [],
    floorItems: [],
    powerSelections: [],
    integrity: 'verified',
    integrityWarnings: [],
    revision: 1,
    createdAt: 1,
    lastAccessAt: 1,
    pricedAt: 1,
  };
}

function fakeService(workspaces: WorkspaceSession[]): DcscService {
  const byWorkspace = new Map(workspaces.map((item) => [item.id, item]));
  const bySession = new Map(
    workspaces.flatMap((item) => [...item.configurations].map(([id, value]) => [id, value] as const)),
  );
  const sessions = {
    resolveHandle(id: string) {
      const ws = byWorkspace.get(id);
      if (ws) return { kind: 'workspace' as const, workspace: ws, session: [...ws.configurations.values()][0] };
      const session = bySession.get(id);
      if (!session) return undefined;
      return {
        kind: 'configuration' as const,
        session,
        workspace: byWorkspace.get(session.workspaceId),
      };
    },
    get(id: string) {
      return bySession.get(id);
    },
    getWorkspace(id: string) {
      const direct = byWorkspace.get(id);
      if (direct) return direct;
      const session = bySession.get(id);
      return session ? byWorkspace.get(session.workspaceId) : undefined;
    },
    list() {
      return [...bySession.values()];
    },
    async transact(
      handle: string,
      _options: unknown,
      callback: (draft: WorkspaceSession, target?: ConfigSession) => unknown,
    ) {
      const resolved = this.resolveHandle(handle);
      if (!resolved?.workspace) throw new Error('not found');
      const target = resolved.kind === 'configuration' ? resolved.session : undefined;
      return callback(resolved.workspace, target);
    },
  };
  return {
    sessions,
    locale: workspaces[0]?.locale,
    newCtx: vi.fn(() => ({ corrId: 'test' })),
    fabricOptions: vi.fn(async () => ({
      nodeRoles: [{ role: 'Compute', description: 'Compute node' }],
    })),
  } as unknown as DcscService;
}

describe('tool power accounting', () => {
  it('counts storage aliases in workspace cost and rack power without duplicating editable templates', async () => {
    const controller = configuration({ id: 'controller', workspaceId: 'placed-storage', code: 'STORAGE',
      type: 'storage', price: 20000, maxPowerW: 2500 });
    const ws = workspace('placed-storage', [controller]);
    ws.serverState.storageConnectionNetworks = [{ name: 'SAN', controller: {
      id: controller.configurationId, option: 'STORAGE', hardwareType: 'storage',
    } }];
    const items = [1, 2].map(index => ({ id: `physical-${index}`, code: 'STORAGE', type: 'storage',
      position: index * 2 - 1, size: 2, quantity: 0 }));
    ws.rackArea = [{ id: 'rack', rackItems: items }];
    ws.rackSummaries = [{ id: 'rack', code: 'RACK', description: 'Rack', sizeU: 42, usedU: 4, freeU: 38,
      emptyWeightKg: 0, totalWeightKg: 0, items, errors: [] }] as unknown as WorkspaceSession['rackSummaries'];
    ws.serverState.cloneDependency = { [controller.configurationId]: [controller.configurationId, 'physical-1', 'physical-2'] };
    const handlers = register(fakeService([ws]));
    const power = parse(await handlers.get('dcsc_power_get')!({ session: ws.id }));
    expect(power).toMatchObject({ total: { maxKW: 5 }, perConfiguration: [{ salesQuantity: 2 }],
      perRack: [{ maxKW: 5, physicallyPlacedUnits: 2 }], unplacedSalesUnits: [] });
    expect(parse(await handlers.get('dcsc_compare_scenarios')!({ sessions: [ws.id] }))).toMatchObject({
      scenarios: [{ listPrice: 40000, maxKW: 5 }],
    });
    expect(projectWorkspaceSummary(ws, { tool: 'dcsc_session_info', arguments: { session: ws.id } }))
      .toMatchObject({ totalPrice: 40000 });
    expect(workspaceDetailSource(ws)).toMatchObject({ configurations: [{ quantity: 2, configurationQuantity: 1,
      managedStorageTemplate: true, extendedPrice: 40000 }], unracked: [], racks: [{ items: [
      { id: 'physical-1', session: controller.id, templateConfigurationId: controller.configurationId },
      { id: 'physical-2', session: controller.id, templateConfigurationId: controller.configurationId },
    ] }] });
    expect(controller.raw.quantity).toBe(1);

    const firstPhysical = configuration({ id: 'physical-first', workspaceId: ws.id, code: 'STORAGE',
      type: 'storage', price: 21000, maxPowerW: 3000 }).raw;
    const secondPhysical = configuration({ id: 'physical-second', workspaceId: ws.id, code: 'STORAGE',
      type: 'storage', price: 22000, maxPowerW: 4000 }).raw;
    firstPhysical.id = secondPhysical.id = controller.configurationId;
    ws.serverState.storagePhysicalConfigurations = { 'physical-1': firstPhysical, 'physical-2': secondPhysical };
    expect(parse(await handlers.get('dcsc_power_get')!({ session: ws.id }))).toMatchObject({
      total: { maxKW: 7 }, perRack: [{ maxKW: 7 }], perConfiguration: [{ salesQuantity: 2, physicalInstances: [
        { physicalId: 'physical-1', power: { inputPowerW: { max: 3000 } } },
        { physicalId: 'physical-2', power: { inputPowerW: { max: 4000 } } },
      ] }],
    });
    expect(parse(await handlers.get('dcsc_compare_scenarios')!({ sessions: [ws.id] }))).toMatchObject({
      scenarios: [{ listPrice: 43000, maxKW: 7 }],
    });
    expect(workspaceDetailSource(ws)).toMatchObject({ configurations: [{ unitPrice: null,
      extendedPrice: 43000, priceAvailable: true, physicalInstances: [
        { physicalId: 'physical-1', unitPrice: 21000, configuration: { id: controller.configurationId, totalPrice: 21000 } },
        { physicalId: 'physical-2', unitPrice: 22000, configuration: { id: controller.configurationId, totalPrice: 22000 } },
      ] }] });
    expect(controller.raw.totalPrice).toBe(20000);
    delete secondPhysical.totalPrice;
    delete secondPhysical.powerReportResponse;
    expect(projectWorkspaceSummary(ws, { tool: 'dcsc_session_info', arguments: { session: ws.id } }))
      .toMatchObject({ totalPrice: null, knownPriceSubtotal: 21000 });
    expect(parse(await handlers.get('dcsc_compare_scenarios')!({ sessions: [ws.id] }))).toMatchObject({
      scenarios: [{ listPrice: null, priceAvailable: false, knownListPriceSubtotal: 21000,
        powerAvailable: false, knownPowerSubtotal: { maxKW: 3 } }],
    });
    expect(parse(await handlers.get('dcsc_power_get')!({ session: ws.id }))).toMatchObject({
      totalPowerAvailable: false, knownPowerSubtotal: { maxKW: 3 }, perRack: [{ powerAvailable: false, knownPowerSubtotal: { maxKW: 3 } }],
    });
  });

  it('labels partial workspace and rack power as a known subtotal rather than a complete budget', async () => {
    const known = configuration({ id: 'known', workspaceId: 'partial', maxPowerW: 1000 });
    const unknown = configuration({ id: 'unknown', workspaceId: 'partial', type: 'switch' });
    const ws = workspace('partial', [known, unknown], [{ id: 'rack', code: 'RACK',
      sizeU: 42, usedU: 2, freeU: 40, errors: [], items: [known, unknown].map((config, index) => ({
        id: config.configurationId, code: config.product.code, position: index + 1, endPosition: index + 1, sizeU: 1,
      })) }]);
    const result = parse(await register(fakeService([ws])).get('dcsc_power_get')!({ session: ws.id }));
    expect(result).toMatchObject({ totalPowerAvailable: false, missingPowerConfigurations: ['unknown'],
      knownPowerSubtotal: { maxKW: 1 }, perRack: [{ powerAvailable: false,
        missingPowerConfigurations: ['unknown'], knownPowerSubtotal: { maxKW: 1 } }] });
    expect(result).not.toHaveProperty('total');
    expect((result.perRack as object[])[0]).not.toHaveProperty('maxKW');
  });

  it('excludes managed controller templates from workspace cost and power while preserving configuration inspection', async () => {
    const node = configuration({ id: 'node', workspaceId: 'managed', price: 100, maxPowerW: 1000 });
    const controller = configuration({ id: 'controller', workspaceId: 'managed', code: 'STORAGE',
      type: 'storage', price: 20000, maxPowerW: 2500 });
    const ws = workspace('managed', [node, controller]);
    ws.serverState.storageConnectionNetworks = [{ name: 'SAN', controller: { id: controller.configurationId } }];
    const handlers = register(fakeService([ws]));
    const power = handlers.get('dcsc_power_get')!;
    const compare = handlers.get('dcsc_compare_scenarios')!;
    const workspacePower = parse(await power({ session: ws.id }));
    expect(workspacePower.total).toMatchObject({ maxKW: 1 });
    expect(workspacePower.perConfiguration).toEqual(expect.arrayContaining([
      expect.objectContaining({ session: controller.id, salesQuantity: 0, managedStorageTemplate: true }),
    ]));
    expect(workspacePower.unplacedSalesUnits).toEqual([
      expect.objectContaining({ session: node.id, unplacedUnits: 1 }),
    ]);
    expect(parse(await power({ session: controller.id })).total).toMatchObject({ maxKW: 2.5 });
    expect(parse(await compare({ sessions: [ws.id, controller.id] })).scenarios).toEqual([
      expect.objectContaining({ listPrice: 100, maxKW: 1 }),
      expect.objectContaining({ listPrice: 20000, maxKW: 2.5 }),
    ]);
    expect(parse(await compare({ sessions: [node.id], nodes: 8 })).scenarios).toEqual([
      expect.objectContaining({ listPrice: 800, maxKW: 8 }),
    ]);
    expect(projectWorkspaceSummary(ws, { tool: 'dcsc_session_info', arguments: { session: ws.id } }))
      .toMatchObject({ totalPrice: 100 });
    expect(workspaceDetailSource(ws)).toMatchObject({
      configurations: [expect.objectContaining({ quantity: 1 }), expect.objectContaining({
        quantity: 0, configurationQuantity: 1, managedStorageTemplate: true, extendedPrice: 0,
      })], unracked: [expect.objectContaining({ session: node.id })],
    });
    expect(controller.raw.quantity).toBe(1);

    // An actual returned placement converts the template into physical supply.
    ws.nonRackArea = [{ id: controller.configurationId, type: 'storage' }];
    expect(parse(await power({ session: ws.id })).total).toMatchObject({ maxKW: 3.5 });
    expect(parse(await compare({ sessions: [ws.id] })).scenarios).toEqual([
      expect.objectContaining({ listPrice: 20100, maxKW: 3.5 }),
    ]);
    expect(projectWorkspaceSummary(ws, { tool: 'dcsc_session_info', arguments: { session: ws.id } }))
      .toMatchObject({ totalPrice: 20100 });
  });

  it('uses physical placements per rack and reports unplaced sales units separately', async () => {
    const node = configuration({
      id: 'node-session',
      workspaceId: 'workspace',
      quantity: 4,
      maxPowerW: 1000,
    });
    const ws = workspace('workspace', [node], [
      {
        id: 'rack-1',
        code: 'RACK',
        sizeU: 42,
        usedU: 1,
        freeU: 41,
        totalWeightKg: 150,
        items: [
          {
            id: node.configurationId,
            code: node.product.code,
            position: 1,
            endPosition: 1,
            sizeU: 1,
          },
        ],
        errors: [],
      },
    ]);
    const handler = register(fakeService([ws])).get('dcsc_power_get');
    if (!handler) throw new Error('power tool not registered');

    const body = parse(await handler({ session: ws.id }));
    expect(body.currency).toBe('USD');
    expect(body.total).toMatchObject({ maxKW: 4 });
    expect(body.perRack).toEqual([
      expect.objectContaining({
        rackId: 'rack-1',
        physicallyPlacedUnits: 1,
        powerContributors: 1,
        maxKW: 1,
      }),
    ]);
    expect(body.unplacedSalesUnits).toEqual([
      expect.objectContaining({
        session: node.id,
        salesQuantity: 4,
        physicallyPlacedUnits: 1,
        unplacedUnits: 3,
      }),
    ]);
  });
});

describe('scenario comparison scope and currency', () => {
  it.each(['missing', 'null', 'unavailable', 'nonfinite'])('does not rank a %s price as free or a partial power subtotal as the lowest', async kind => {
    const known = configuration({ id: 'known', workspaceId: 'partial', price: 100, maxPowerW: 1000 });
    const unknown = configuration({ id: 'unknown', workspaceId: 'partial', type: 'switch', price: 200 });
    if (kind === 'missing') delete unknown.raw.totalPrice;
    else if (kind === 'null') unknown.raw.totalPrice = null as never;
    else if (kind === 'nonfinite') unknown.raw.totalPrice = Number.NaN;
    else unknown.raw.priceNotAvailable = true;
    const complete = configuration({ id: 'complete', workspaceId: 'complete-ws', price: 500, maxPowerW: 2000 });
    const handler = register(fakeService([workspace('partial', [known, unknown]), workspace('complete-ws', [complete])]))
      .get('dcsc_compare_scenarios')!;
    const result = parse(await handler({ sessions: ['partial', 'complete-ws'] }));
    expect(result).not.toHaveProperty('cheapest');
    expect(result).not.toHaveProperty('lowestPower');
    expect(result.priceRanking).toMatchObject({ status: 'unavailable' });
    expect(result.powerRanking).toMatchObject({ status: 'unavailable' });
    const scenarios = result.scenarios as Array<Record<string, unknown>>;
    expect(scenarios[0]).toMatchObject({ listPrice: null, priceAvailable: false,
      knownListPriceSubtotal: 100, unpricedConfigurations: ['unknown'], powerAvailable: false,
      missingPowerConfigurations: ['unknown'], knownPowerSubtotal: { maxKW: 1 } });
    expect(scenarios[0]).not.toHaveProperty('expectedKW');
    expect(scenarios[0]).not.toHaveProperty('pricePerExpectedKW');
    expect(scenarios[1]).toMatchObject({ listPrice: 500, priceAvailable: true, maxKW: 2, powerAvailable: true });
  });

  it('scales an explicit configuration, preserves fixed products, and omits unsupported rack totals', async () => {
    const nodeA = configuration({ id: 'node-a', workspaceId: 'ws-a', maxPowerW: 1000 });
    const fixedA = configuration({
      id: 'switch-a',
      workspaceId: 'ws-a',
      code: 'SWITCH',
      type: 'switch',
      price: 500,
      maxPowerW: 200,
    });
    const nodeB = configuration({ id: 'node-b', workspaceId: 'ws-b', maxPowerW: 1000 });
    const fixedB = configuration({
      id: 'switch-b',
      workspaceId: 'ws-b',
      code: 'SWITCH',
      type: 'switch',
      price: 500,
      maxPowerW: 200,
    });
    const rack = {
      id: 'rack', code: 'RACK', sizeU: 42, usedU: 1, freeU: 41, totalWeightKg: 150,
      items: [], errors: [],
    };
    const handler = register(
      fakeService([workspace('ws-a', [nodeA, fixedA], [rack]), workspace('ws-b', [nodeB, fixedB], [rack])]),
    ).get('dcsc_compare_scenarios');
    if (!handler) throw new Error('scenario tool not registered');

    const body = parse(await handler({ sessions: [nodeA.id, nodeB.id], nodes: 8 }));
    expect(body.currency).toBe('USD');
    expect(body.cheapest).toBe(nodeA.id);
    const scenarios = body.scenarios as Array<Record<string, unknown>>;
    expect(scenarios[0]).toMatchObject({
      scope: 'scaled-configuration-with-fixed-workspace-products',
      scaledToNodes: 8,
      listPrice: 1300,
      maxKW: 8.2,
      physicalLayout: 'not-calculated',
    });
    expect(scenarios[0]).not.toHaveProperty('racks');
    expect(scenarios[0]?.products).toEqual([
      expect.objectContaining({ session: nodeA.id, quantity: 8, role: 'repeated' }),
      expect.objectContaining({ session: fixedA.id, quantity: 1, role: 'fixed' }),
    ]);
    expect(nodeA.raw.quantity).toBe(1);
    expect(fixedA.raw.quantity).toBe(1);

    const ambiguous = await handler({ sessions: ['ws-a', 'ws-b'], nodes: 8 });
    expect(ambiguous.isError).toBe(true);
    expect(parse(ambiguous).error).toContain('Pass the configuration session ID');
  });

  it('returns scenario details but rejects rankings across currencies', async () => {
    const usd = configuration({ id: 'usd', workspaceId: 'ws-usd', currency: 'USD', price: 100 });
    const eur = configuration({ id: 'eur', workspaceId: 'ws-eur', currency: 'EUR', price: 90 });
    const handler = register(
      fakeService([workspace('ws-usd', [usd]), workspace('ws-eur', [eur])]),
    ).get('dcsc_compare_scenarios');
    if (!handler) throw new Error('scenario tool not registered');

    const body = parse(await handler({ sessions: [usd.id, eur.id] }));
    expect(body.scenarios).toEqual([
      expect.objectContaining({ session: usd.id, currency: 'USD', listPrice: 100 }),
      expect.objectContaining({ session: eur.id, currency: 'EUR', listPrice: 90 }),
    ]);
    expect(body.ranking).toMatchObject({ status: 'rejected' });
    expect(body).not.toHaveProperty('cheapest');
    expect(JSON.stringify(body.ranking)).toContain('USD, EUR');
  });
});

describe('configuration targeting and mutation', () => {
  it('rejects a multi-configuration workspace where a configuration is required', async () => {
    const first = configuration({ id: 'first', workspaceId: 'multi' });
    const second = configuration({ id: 'second', workspaceId: 'multi' });
    const handler = register(fakeService([workspace('multi', [first, second])])).get(
      'dcsc_list_options',
    );
    if (!handler) throw new Error('list options tool not registered');

    const response = await handler({ session: 'multi', filter: 'all', limit: 25, offset: 0 });
    expect(response.isError).toBe(true);
    expect(parse(response).error).toContain('configuration target is ambiguous');
    expect(parse(response).error).toContain('first, second');
  });

  it('changes node role through the atomic session transaction', async () => {
    const node = configuration({ id: 'node', workspaceId: 'role-workspace' });
    const service = fakeService([workspace('role-workspace', [node])]);
    const transact = vi.spyOn(service.sessions, 'transact');
    const handler = register(service).get('dcsc_network_set');
    if (!handler) throw new Error('node role tool not registered');

    const body = parse(await handler({ session: node.id, change: { kind: 'nodeRole', role: 'compute' } }));
    expect(transact).toHaveBeenCalledOnce();
    expect(transact.mock.calls[0]?.[0]).toBe('role-workspace');
    expect(node.raw.nodeRole).toBe('Compute');
    expect(body).toMatchObject({ session: node.id, nodeRole: 'Compute' });
  });
});
