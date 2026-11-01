import { afterEach, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { buildAutoDeriveRequest, buildExportData, buildGroups, reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import { buildExportGroups } from '../src/domain/exportGroups.js';
import { projectWorkspaceLayout, workspaceDetailSource } from '../src/model/workspaceProjection.js';

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const solution = { solutionMode: 'HPC and AI - Systems', masterSlices: ['HPCGP'] };
  const serverRaw = { id: 'server', code: '7D73CTOHWW', type: 'server', tabs: [], quantity: 1, totalPrice: 100 };
  const server = service.sessions.create({ locale: service.locale, solution, mode: 'cto', configurationId: 'server',
    raw: serverRaw, reduced: reduceConfiguration(serverRaw, 'server'), primed: true });
  const controllerRaw = { id: 'controller', code: '7DJ0CTO1WW', type: 'storage', quantity: 1, totalPrice: 200,
    tabs: [{ title: 'Cable Options', type: 'hardware', subTabs: [{ title: 'Cables', sections: [{ name: 'DAC_SFP28_CABLE',
      features: [{ code: 'AV1W', max: 10, description: 'SFP28 cable' }], results: [{ code: 'AV1W', quantity: 2, type: 'hardware' }] }] }] }] };
  const controller = service.sessions.create({ locale: service.locale, solution, mode: 'cto', configurationId: 'controller',
    raw: controllerRaw, reduced: reduceConfiguration(controllerRaw, 'controller'), primed: true, workspaceId: server.workspaceId });
  const workspace = service.sessions.getWorkspace(server.workspaceId)!;
  workspace.serverState.storageConnectionNetworks = [{ name: 'SAN', controller: {
    id: 'controller', option: '7DJ0CTO1WW', featureCode: '', hardwareType: 'storage',
  }, expansion: {}, mainSwitch: {}, maximumExpansions: 0, type: 'General Storage', layout: 'Fully Redundant' }];
  return { service, server, controller, workspace, solution };
}

it('clears a server assignment while accepting separate editable and physical storage patches', async () => {
  const { service, server, controller, workspace } = setup();
  server.raw.selectedStorageNetwork = 'SAN';
  server.raw.connectors = [];
  workspace.rackArea = [{ id: 'rack', code: 'RACK', type: 'rack', size: 42, rackItems: [
    { id: 'controller-instance', code: '7DJ0CTO1WW', type: 'storage', size: 2, position: 1 },
  ] }];
  workspace.serverState.cloneDependency = { controller: ['controller', 'controller-instance'] };
  vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { configurations: [
    { ...structuredClone(server.raw), selectedStorageNetwork: '' },
    { ...structuredClone(controller.raw), totalPrice: 210, updateConfigurationIds: ['controller'] },
    { ...structuredClone(controller.raw), totalPrice: 260, updateConfigurationIds: ['controller-instance'] },
  ] } } as never);
  const result = await service.assignStorageNetwork(server.id, { networkName: null, ctx: service.newCtx() });
  expect(result.selectedStorageNetwork).toBe('');
  expect(server.raw.selectedStorageNetwork).toBe('');
  expect(controller.raw.totalPrice).toBe(210);
  expect(workspace.serverState.storagePhysicalConfigurations).toMatchObject({
    'controller-instance': { totalPrice: 260 },
  });
});

it.each([false, true])('never synthesizes managed controller physical data (explicit server placement: %s)', explicit => {
  const { workspace, solution } = setup();
  if (explicit) workspace.nonRackArea = [{ id: 'server', code: '7D73CTOHWW', type: 'server', size: 1, quantity: 1 }];
  const derive = buildAutoDeriveRequest(workspace, { validationMode: 'guided' });
  const exported = buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode: 'guided' });
  expect(derive.workspaceInformation).toMatchObject({ nonRackData: [{ id: 'server' }] });
  expect(exported.workspaceInformation).toMatchObject({ nonRackData: [{ id: 'server' }] });
  expect(exported.workspace).toMatchObject({ nonRackArea: [{ id: 'server' }] });
  expect(derive.configurations).toHaveLength(2);
  expect(exported.configurations).toHaveLength(2);
  expect(buildGroups(workspace)[0]!.products).toHaveLength(2);
});

it('canonicalizes an unplaced managed template color while dropping inactive empty presentation colors', () => {
  const { workspace, solution } = setup();
  workspace.serverState.cloneDependency = { server: ['server'], controller: ['controller'] };
  workspace.serverState.cloneDependencyColor = {
    server: { color: '#111111', dependBy: ['server'] },
    controller: { color: '#222222', future: true, dependBy: [] },
    'missing-storage-template': { color: '#333333', dependBy: [] },
  };
  const before = structuredClone(workspace.serverState);

  const exported = buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode: 'guided' });

  expect(exported.cloneDependencyColor).toMatchObject({
    server: { dependBy: ['server'] },
    controller: { color: '#222222', future: true, dependBy: ['controller'] },
  });
  expect(exported.cloneDependencyColor).not.toHaveProperty('missing-storage-template');
  expect(workspace.serverState).toEqual(before);
});

it('retains an explicitly returned controller placement instead of silently deleting it', () => {
  const { workspace, solution } = setup();
  workspace.nonRackArea = [{ id: 'server', code: '7D73CTOHWW' },
    { id: 'controller', code: '7DJ0CTO1WW', type: 'storage', size: 2 }];
  const exported = buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode: 'guided' });
  expect(exported.workspaceInformation).toMatchObject({ nonRackData: [{ id: 'server' }, { id: 'controller', size: 2 }] });
  expect(exported.workspace).toMatchObject({ nonRackArea: [{ id: 'server' }, { id: 'controller' }] });
});

it('exports every unplaced storage alias as a singleton hierarchy identity without dropping other loose products', () => {
  const { workspace, solution } = setup();
  workspace.nonRackArea = ['controller-1', 'controller-2'].map(id => ({
    id, code: '7DJ0CTO1WW', type: 'storage', size: 2, quantity: 0,
  }));
  workspace.serverState.cloneDependency = { controller: ['controller', 'controller-1', 'controller-2'] };
  const before = structuredClone(workspace.nonRackArea);
  const exported = buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode: 'guided' });
  expect(exported.toggle7116On).toBe(true);
  expect(exported.workspace).toMatchObject({ nonRackArea: [
    { id: 'controller-1', type: 'storage', quantity: 1, size: 2,
      originalIds: ['controller-1'] },
    { id: 'controller-2', type: 'storage', quantity: 1, size: 2,
      originalIds: ['controller-2'] },
    { id: 'server', quantity: 1 },
  ] });
  expect(exported.workspaceInformation).toMatchObject({ nonRackData: [
    { id: 'controller-1', quantity: 0 }, { id: 'controller-2', quantity: 0 }, { id: 'server' },
  ] });
  expect((exported.configurations as Array<{ id: string }>).map(item => item.id)).toEqual(['server', 'controller']);
  expect((exported.workspaceInformation as Record<string, unknown>).cloneDependency).toEqual({
    controller: ['controller', 'controller-1', 'controller-2'],
    server: ['server'],
  });
  expect(exported.cloneDependencyColor).toMatchObject({
    controller: { dependBy: ['controller', 'controller-1', 'controller-2'] },
  });
  expect(workspace.nonRackArea).toEqual(before);
});

it.each(['General Purpose', 'HPC and AI - Systems'])('matches the website physical clone export mode for %s', solutionMode => {
  const { workspace, controller } = setup();
  const solution = { solutionMode, masterSlices: ['HPCGP'] };
  for (const input of [{ workspace }, { raw: controller.raw, config: controller.reduced }]) {
    const exported = buildExportData({ ...input, solution, fileTypes: ['XML'], validationMode: 'guided' });
    expect(exported.toggle7116On).toBe(solutionMode !== 'General Purpose');
  }
});

it.each([false, true])('derives a controller edit with full context and target-only delta (placed aliases: %s)', async placed => {
  const { service, server, controller, workspace } = setup();
  if (placed) {
    workspace.rackArea = [{ id: 'rack', code: 'RACK', type: 'rack', size: 42, rackItems: [
      { id: 'controller-instance', code: '7DJ0CTO1WW', type: 'storage', size: 2, position: 1, quantity: 0 },
    ] }];
    workspace.serverState.cloneDependency = { controller: ['controller', 'controller-instance'] };
  }
  const beforeServer = structuredClone(server.raw);
  vi.spyOn(service.http, 'send').mockImplementation(async request => {
    if (placed && request.path === '/switch_calculation') return { raw: [] } as never;
    if (placed && request.path === '/ctos/racks/customize') {
      const body = request.body?.kind === 'json' ? request.body.value as Record<string, unknown> : {};
      expect(body.rackArea).toMatchObject([{ rackItems: [{ id: 'controller-instance', features: [
        { name: 'DAC_SFP28_CABLE', results: [{ code: 'AV1W', quantity: 4 }] },
      ] }] }]);
      return { raw: { rackArea: body.rackArea, nonRackArea: body.nonRackArea, connections: [], errors: [] } } as never;
    }
    expect(request.path).toBe('/ctos/autoDerive');
    expect(request.query).toEqual({ configurationId: 'controller', guideMode: true });
    const body = request.body?.kind === 'json' ? request.body.value as Record<string, unknown> : {};
    expect(body.customizingIds).toEqual(placed ? ['controller-instance', 'controller'] : ['controller']);
    expect(body.configurations).toHaveLength(2);
    expect(body.workspaceInformation).toMatchObject({ nonRackData: [{ id: 'server' }] });
    if (placed) expect(body.workspaceInformation).toMatchObject({
      cloneDependency: { controller: ['controller', 'controller-instance'] },
    });
    expect(body.configurations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'controller', delta: expect.objectContaining({
      section: 'DAC_SFP28_CABLE', featureCode: 'AV1W', quantity: 4, isClear: false, type: 'hardware',
    }) })]));
    const accepted = structuredClone(controller.raw);
    accepted.tabs![0]!.subTabs![0]!.sections![0]!.results![0]!.quantity = 4;
    return { raw: { configurations: [accepted, ...(placed ? [{ ...structuredClone(accepted), totalPrice: 250,
      updateConfigurationIds: ['controller-instance'],
    }] : [])] } } as never;
  });
  await service.configure(controller, [{ section: 'DAC_SFP28_CABLE', code: 'AV1W', quantity: 4 }], service.newCtx(), controller.revision);
  expect(server.raw).toEqual(beforeServer);
  expect(workspace.nonRackArea).toEqual([]);
  expect(controller.index.selected.get('AV1W')).toBe(4);
  if (placed) {
    const beforeUndo = structuredClone({ raw: controller.raw, rack: workspace.rackArea, state: workspace.serverState });
    await expect(service.undo(controller, controller.revision)).rejects.toThrow('dcsc_undo');
    expect({ raw: controller.raw, rack: workspace.rackArea, state: workspace.serverState }).toEqual(beforeUndo);
    await service.sessions.undoWorkspace(workspace.id, workspace.revision);
    expect(controller.index.selected.get('AV1W')).toBe(2);
    expect(workspace.serverState.storagePhysicalConfigurations).toBeUndefined();
  }
});

it('preserves placed storage aliases in derive/export dependencies without inventing raw configurations', () => {
  const { service, workspace, solution } = setup();
  const rackRaw = { id: 'rack', code: 'RACK', type: 'rack', quantity: 1, totalPrice: 50, tabs: [] };
  service.sessions.create({ locale: service.locale, solution, mode: 'cto', configurationId: 'rack',
    raw: rackRaw, reduced: reduceConfiguration(rackRaw, 'rack'), primed: true, workspaceId: workspace.id });
  workspace.rackArea = [{ id: 'rack', code: 'RACK', type: 'rack', size: 42, rackItems: [
    { id: 'physical-controller-1', code: '7DJ0CTO1WW', type: 'storage', size: 2, position: 1, quantity: 0 },
    { id: 'physical-controller-2', code: '7DJ0CTO1WW', type: 'storage', size: 2, position: 3, quantity: 0 },
  ] }];
  workspace.serverState.cloneDependency = { controller: ['controller', 'physical-controller-1', 'physical-controller-2'] };
  const derive = buildAutoDeriveRequest(workspace, { validationMode: 'guided' });
  const exported = buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode: 'guided' });
  for (const body of [derive, exported]) {
    expect((body.configurations as Array<{ id: string }>).map(config => config.id)).toEqual(['server', 'controller', 'rack']);
    expect(body.workspaceInformation).toMatchObject({ cloneDependency: {
      controller: ['controller', 'physical-controller-1', 'physical-controller-2'],
    } });
  }
  expect(exported.workspace).toMatchObject({ rackArea: [{ children: [
    { id: 'physical-controller-1' }, { id: 'physical-controller-2' },
  ] }] });
  const colors = exported.cloneDependencyColor as Record<string, Record<string, unknown>>;
  expect(colors.controller).toMatchObject({ dependBy: ['controller', 'physical-controller-1', 'physical-controller-2'],
    color: expect.stringMatching(/^#[0-9a-f]{6}$/), darkColor: expect.stringMatching(/^#[0-9a-f]{6}$/) });
  expect(Object.values(colors.controller!.colorRGB as Record<string, number>).every(value => value >= 0 && value <= 255)).toBe(true);
  expect(workspace.serverState.cloneDependencyColor).toBeUndefined();
  expect(buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode: 'guided' }).cloneDependencyColor).toEqual(colors);
  workspace.serverState.cloneDependencyColor = { controller: { color: '#abcdef', darkColor: '#123456',
    colorRGB: { r: -85, g: -51, b: -17 }, dependBy: ['controller', 'stale-alias'], future: true },
    server: { color: '#cccccc', dependBy: ['server'] } };
  expect(buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode: 'guided' }).cloneDependencyColor)
    .toMatchObject({ controller: { color: '#abcdef', colorRGB: { r: -85, g: -51, b: -17 }, future: true,
      dependBy: ['controller', 'physical-controller-1', 'physical-controller-2'] }, server: { dependBy: ['server'] } });
});

it.each(['/switch_calculation', '/ctos/racks/customize'])('rolls back placed option state when Back fails at %s', async failedPath => {
  const { service, controller, workspace } = setup();
  workspace.rackArea = [{ id: 'rack', code: 'RACK', type: 'rack', size: 42, rackItems: [
    { id: 'controller-instance', code: '7DJ0CTO1WW', type: 'storage', size: 2, position: 1,
      features: [{ name: 'DAC_SFP28_CABLE', results: [{ code: 'AV1W', quantity: 2 }] }] },
  ] }];
  workspace.serverState.cloneDependency = { controller: ['controller', 'controller-instance'] };
  workspace.serverState.storagePhysicalConfigurations = {
    'controller-instance': { ...structuredClone(controller.raw), totalPrice: 220 },
  };
  const before = structuredClone({ raw: controller.raw, rack: workspace.rackArea,
    state: workspace.serverState, revision: workspace.revision });
  vi.spyOn(service.http, 'send').mockImplementation(async request => {
    if (request.path === failedPath) throw new Error('Back failed');
    if (request.path === '/switch_calculation') return { raw: [] } as never;
    expect(request.path).toBe('/ctos/autoDerive');
    const accepted = structuredClone(controller.raw);
    accepted.tabs![0]!.subTabs![0]!.sections![0]!.results![0]!.quantity = 4;
    return { raw: { configurations: [accepted, { ...accepted, totalPrice: 250,
      updateConfigurationIds: ['controller-instance'] }] } } as never;
  });
  await expect(service.configure(controller, [{ section: 'DAC_SFP28_CABLE', code: 'AV1W', quantity: 4 }],
    service.newCtx(), controller.revision)).rejects.toThrow('Back failed');
  expect({ raw: controller.raw, rack: workspace.rackArea,
    state: workspace.serverState, revision: workspace.revision }).toEqual(before);
  expect(controller.index.selected.get('AV1W')).toBe(2);
});

it('moves one existing storage alias while retaining its template, sibling and commercial quantity', async () => {
  const { service, controller, workspace } = setup();
  workspace.rackArea = [{ id: 'rack', code: 'RACK', type: 'rack', size: 42, lockedSpace: [], rackItems: [
    { id: 'controller-1', code: '7DJ0CTO1WW', type: 'storage', size: 2, position: 1, quantity: 0 },
    { id: 'controller-2', code: '7DJ0CTO1WW', type: 'storage', size: 2, position: 3, quantity: 0 },
  ] }];
  workspace.serverState.cloneDependency = { controller: ['controller', 'controller-1', 'controller-2'] };
  const revision = workspace.revision;
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
    if (request.path.endsWith('/non_rack')) return { raw: [{ code: '7DJ0CTO1WW', type: 'storage', size: 2 }] } as never;
    if (request.path.endsWith('/autoDerive')) {
      expect(request.query).toEqual({ guideMode: true });
      expect(request.body?.kind === 'json' && request.body.value).not.toHaveProperty('customizingIds');
      return { raw: { configurations: [{ ...controller.raw, totalPrice: 210,
        updateConfigurationIds: ['controller-1', 'controller-2'] }] } } as never;
    }
    const body = request.body?.kind === 'json' ? request.body.value as Record<string, unknown> : {};
    expect((body.configurations as Array<{ id: string }>).map(config => config.id)).toEqual(['server', 'controller']);
    return { raw: { rackArea: body.rackArea, nonRackArea: body.nonRackArea, connections: [], errors: [] } } as never;
  });
  await expect(service.placeInRack(workspace.id, { rackId: 'rack', sessionId: controller.id, ctx: service.newCtx() }))
    .rejects.toThrow('dcsc_place_storage_network');
  expect(send).not.toHaveBeenCalled();
  await service.placeInRack(workspace.id, { rackId: 'rack', sessionId: 'controller-2', position: 8,
    expectedRevision: revision, ctx: service.newCtx() });
  expect(workspace.rackArea[0]!.rackItems).toEqual([
    expect.objectContaining({ id: 'controller-1', position: 1 }),
    expect.objectContaining({ id: 'controller-2', position: 8, size: 2 }),
  ]);
  expect(workspace.configurations.size).toBe(2);
  expect(controller.raw.quantity).toBe(1);
  expect(controller.raw.totalPrice).toBe(200);
  expect(send).toHaveBeenCalledTimes(3);
  expect(workspace.serverState.storagePhysicalConfigurations).toMatchObject({
    'controller-1': { id: 'controller', totalPrice: 210 }, 'controller-2': { id: 'controller', totalPrice: 210 },
  });
  expect(workspace.serverState.cloneDependency).toEqual({ controller: ['controller', 'controller-1', 'controller-2'] });
  expect(buildExportGroups(workspace)[0]!.products.find(product => product.id === 'controller'))
    .toMatchObject({ quantity: 2, price: 420 });
  const exported = buildExportData({ workspace, solution: workspace.solution, fileTypes: ['XML'], validationMode: 'guided' });
  expect(exported.configurations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'controller' })]));
  expect((exported.configurations as Array<{ id: string }>).some(config => config.id === 'controller-1')).toBe(false);
  await service.sessions.undoWorkspace(workspace.id);
  expect(workspace.rackArea[0]!.rackItems).toEqual([
    expect.objectContaining({ id: 'controller-1', position: 1 }),
    expect.objectContaining({ id: 'controller-2', position: 3 }),
  ]);
  expect(workspace.serverState.storagePhysicalConfigurations).toBeUndefined();
  expect(buildExportGroups(workspace)[0]!.products.find(product => product.id === 'controller')).toMatchObject({ price: 400 });
});

it('moves all managed-template instances to non-rack as the native Summary action does', async () => {
  const { service, controller, workspace } = setup();
  workspace.rackArea = [{ id: 'rack', code: 'RACK', type: 'rack', size: 42, rackItems: [
    { id: 'controller-1', code: '7DJ0CTO1WW', type: 'storage', size: 2, position: 1, quantity: 0 },
    { id: 'controller-2', code: '7DJ0CTO1WW', type: 'storage', size: 2, position: 3, quantity: 0 },
  ] }];
  workspace.serverState.cloneDependency = { controller: ['controller', 'controller-1', 'controller-2'] };
  const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
    const body = request.body?.kind === 'json' ? request.body.value as Record<string, unknown> : {};
    if (request.path.endsWith('/autoDerive')) {
      expect(request.query).toEqual({ guideMode: true });
      expect(body).not.toHaveProperty('customizingIds');
      return { raw: { configurations: [{ ...controller.raw,
        updateConfigurationIds: ['controller-1', 'controller-2'] }] } } as never;
    }
    expect(request.path).toBe('/ctos/racks/customize');
    expect(body.nonRackArea).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'controller-1' }), expect.objectContaining({ id: 'controller-2' }),
    ]));
    return { raw: { rackArea: body.rackArea, nonRackArea: body.nonRackArea, connections: [], errors: [] } } as never;
  });
  await service.editLayout(workspace.id, { action: 'unplace', configurationId: controller.id,
    expectedRevision: workspace.revision, ctx: service.newCtx() });
  expect(send).toHaveBeenCalledTimes(2);
  expect(workspace.rackArea[0]!.rackItems).toEqual([]);
  expect(workspace.nonRackArea.map(item => item.id)).toEqual(['controller-1', 'controller-2']);
  expect(workspaceDetailSource(workspace).unracked).toEqual(expect.arrayContaining([
    { configurationId: 'controller-1', templateConfigurationId: 'controller', session: controller.id,
      code: controller.product.code, description: controller.product.description },
    { configurationId: 'controller-2', templateConfigurationId: 'controller', session: controller.id,
      code: controller.product.code, description: controller.product.description },
  ]));
  expect(projectWorkspaceLayout(workspace, { tool: 'dcsc_workspace_layout', arguments: { session: workspace.id } }).unracked)
    .toEqual(expect.arrayContaining([expect.objectContaining({ configurationId: 'controller-1', templateConfigurationId: 'controller' })]));
  expect(workspace.configurations.size).toBe(2);
  expect(controller.raw.totalPrice).toBe(200);
  expect(buildExportGroups(workspace)[0]!.products.find(product => product.id === 'controller')).toMatchObject({ quantity: 2, price: 400 });
});
