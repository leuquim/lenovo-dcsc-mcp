import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { buildAutoDeriveRequest, buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import type { RackObject } from '../src/domain/rack.js';
import type { SendInput } from '../src/http/request.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';
import type { RawConfiguration } from '../src/model/types.js';
import { workspaceDetailSource } from '../src/model/workspaceProjection.js';

type Obj = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/nested-node-copy.json', import.meta.url), 'utf8')) as {
  rackArea: RackObject[]; nonRackArea: RackObject[];
};
const removalContract = JSON.parse(readFileSync(new URL('./fixtures/parity/nested-removal-contracts.json', import.meta.url), 'utf8')) as {
  identities: { rack: string; chassis: string; looseSourceNode: string; copiedNestedNode: string };
  wireSequence: { customize: { path: string; query: Obj }; derive: { path: string; query: Obj }; finalCustomize: boolean };
  deleteNode: { configurationIds: string[]; deriveCloneDependencyIds: string[] };
  moveNodeToNonRack: { configurationIds: string[]; deriveCloneDependencyIds: string[] };
};
const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const solution = { solutionMode: 'HPC and AI - Systems', masterSlices: ['HPCGP'] };
  const sourceRaw: RawConfiguration = { id: 'node-source', workspaceId: 'node-source', code: '7DD1CTOLWW',
    sliceCtoCode: '7DD1CTOLWW', type: 'node', name: 'Node', quantity: 1, totalPrice: 1000,
    tabs: [{ title: 'Base', type: 'hardware', subTabs: [{ title: 'Base', sections: [{
      name: 'BASE', features: [{ code: 'BWSY' }], results: [{ code: 'BWSY', quantity: 1 }],
    }] }] }] };
  const source = service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw: sourceRaw,
    configurationId: sourceRaw.id!, reduced: reduceConfiguration(sourceRaw, sourceRaw.id!), primed: true });
  for (const item of [fixture.rackArea[0]!, (fixture.rackArea[0]!.rackItems as RackObject[])[0]!]) {
    const raw: RawConfiguration = { id: String(item.id), code: String(item.code), type: String(item.type),
      quantity: 1, totalPrice: 500, tabs: [] };
    service.sessions.create({ locale: service.locale, solution, mode: 'cto', raw, configurationId: raw.id!,
      reduced: reduceConfiguration(raw, raw.id!), primed: true, workspaceId: source.workspaceId });
  }
  const workspace = service.sessions.getWorkspace(source.workspaceId)!;
  workspace.rackArea = structuredClone(fixture.rackArea);
  workspace.nonRackArea = structuredClone(fixture.nonRackArea);
  workspace.serverState.cloneDependency = { 'node-source': ['node-source'], 'rack-1': ['rack-1'], 'chassis-1': ['chassis-1'] };
  const calls: SendInput[] = [];
  vi.spyOn(service.http, 'send').mockImplementation(async request => {
    calls.push(request);
    if (request.path === '/ctos/racks/customize/non_rack') return { raw: [{
      ...structuredClone(fixture.nonRackArea[0]), id: null, features: [], quantity: 0, endPosition: 1,
    }] } as never;
    if (request.path === '/ctos/racks/compatible_categories') return { raw: [{ products: [{
      code: request.query?.masterCode === '7D6DCTO1WW' ? '7DD0CTOLWW' : '7DD1CTOLWW',
      hardwareType: request.query?.masterCode === '7D6DCTO1WW' ? 'chassis' : 'node',
    }] }] } as never;
    if (request.path === '/ctos/autoDerive') return { raw: { configurations: [] } } as never;
    if (request.path !== '/ctos/racks/customize') throw new Error(`Unexpected endpoint ${request.path}`);
    const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
    return { raw: { rackArea: body.rackArea, nonRackArea: body.nonRackArea, connections: [] } } as never;
  });
  const place = () => service.placeInRack(workspace.id, { rackId: 'rack-1', chassisId: 'chassis-1',
    sessionId: source.id, expectedRevision: workspace.revision, ctx: service.newCtx() });
  return { service, source, workspace, calls, place, solution };
}

it('materializes a freshly launched loose node from its envelope before copying its selected parts', async () => {
  const { workspace, calls, place } = setup();
  workspace.nonRackArea = [];
  const result = await place();
  expect(calls.map(call => call.path)).toEqual([
    '/ctos/racks/customize/non_rack', '/ctos/racks/compatible_categories',
    '/ctos/racks/compatible_categories', '/ctos/racks/customize',
  ]);
  const expected = { size: 0, quantity: 0, endPosition: 1, occupiedBay: 1,
    opaqueNode: { retained: true }, features: [{ name: 'BASE', results: [{ code: 'BWSY', quantity: 1 }] }] };
  expect(workspace.nonRackArea).toMatchObject([{ ...expected, id: 'node-source' }]);
  const chassis = (workspace.rackArea[0]!.rackItems as RackObject[])[0]!;
  expect(chassis.nodes).toMatchObject([{ ...expected, id: result.nestedPlacement!.nodeId }]);
  const body = calls[3]!.body?.kind === 'json' ? calls[3]!.body.value as Obj : {};
  expect((body.configurations as Obj[]).map(raw => raw.id)).toEqual(['node-source', 'rack-1', 'chassis-1']);
});

it('does not materialize a second physical source when the node is already nested', async () => {
  const { workspace, calls, place } = setup();
  (workspace.rackArea[0]!.rackItems as RackObject[])[0]!.nodes = workspace.nonRackArea;
  workspace.nonRackArea = [];
  await expect(place()).rejects.toThrow(/already physically placed/);
  expect(calls).toHaveLength(0);
});

it('does not retain a newly materialized node after a failed persistence commit', async () => {
  const { service, workspace, place } = setup();
  workspace.nonRackArea = [];
  const revision = workspace.revision;
  service.sessions.setPersistenceWriter(() => { throw new Error('disk full'); });
  await expect(place()).rejects.toThrow();
  expect(workspace.nonRackArea).toEqual([]);
  expect((workspace.rackArea[0]!.rackItems as RackObject[])[0]!.nodes).toEqual([]);
  expect(workspace.configurations.size).toBe(3);
  expect(workspace.revision).toBe(revision);
});

it('uses one customize with original configurations, then commits an independent nested copy and exports it once', async () => {
  const { service, source, workspace, calls, place, solution } = setup();
  source.raw.autoDerivedResultId = 'source-derived';
  source.raw.expansionMessages = [{ type: 'info', value: 'source-message' }];
  const sourceBefore = structuredClone(source.raw);
  const write = vi.fn(); service.sessions.setPersistenceWriter(write);
  const revision = workspace.revision;
  const result = await place();
  const placed = result.nestedPlacement!;
  expect(calls.map(call => call.path)).toEqual([
    '/ctos/racks/compatible_categories', '/ctos/racks/compatible_categories', '/ctos/racks/customize',
  ]);
  expect(calls[2]!.query).toEqual({ autoArrange: true, autoConnect: true, cogValidation: true });
  const body = calls[2]!.body?.kind === 'json' ? calls[2]!.body.value as Obj : {};
  expect((body.configurations as Obj[]).map(raw => raw.id)).toEqual(['node-source', 'rack-1', 'chassis-1']);
  const copy = workspace.configurations.get(placed.session)!;
  expect(copy.configurationId).toBe(placed.nodeId);
  expect(copy.raw).toMatchObject({ id: placed.nodeId, workspaceId: placed.nodeId, quantity: 1, totalPrice: 1000,
    name: 'Copy_Node', autoDerivedResultId: null, expansionMessages: [{ type: 'info', value: null }] });
  expect(source.raw).toEqual(sourceBefore);
  expect(workspace.nonRackArea).toMatchObject(fixture.nonRackArea);
  expect(workspace.configurations.size).toBe(4);
  expect(workspace.serverState.cloneDependency).toMatchObject({ [placed.nodeId]: [placed.nodeId], 'node-source': ['node-source'] });
  expect(workspace.serverState.cloneDependencyColor).toMatchObject({ [placed.nodeId]: { dependBy: [placed.nodeId] } });
  expect(workspace.revision).toBe(revision + 1);
  expect(write).toHaveBeenCalledTimes(1);
  const exported = buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode: 'guided' });
  expect(exported.workspace).toMatchObject({ nonRackArea: [{ id: 'node-source' }], rackArea: [{
    children: [{ id: 'chassis-1', children: [{ id: placed.nodeId }] }],
  }] });
  expect(((exported.workspace as Obj).nonRackArea as Obj[]).map(item => item.id)).toEqual(['node-source']);
});

it('rejects stale revisions and conflicting placement arguments before any HTTP', async () => {
  const { service, workspace, source, calls } = setup();
  const args = { rackId: 'rack-1', chassisId: 'chassis-1', sessionId: source.id, ctx: service.newCtx() };
  await expect(service.placeInRack(workspace.id, { ...args, expectedRevision: workspace.revision + 1 })).rejects.toThrow(/revision/i);
  await expect(service.placeInRack(workspace.id, { ...args, position: 1 })).rejects.toThrow(/omit uPosition/);
  await expect(service.placeInRack(workspace.id, { ...args, rackId: 'other' })).rejects.toThrow(/does not belong/);
  workspace.serverState.cloneDependency = { 'chassis-1': ['chassis-1', source.configurationId] };
  await expect(service.placeInRack(workspace.id, args)).rejects.toThrow(/linked cloned chassis/);
  expect(calls).toHaveLength(0);
});

it('exports an unplaced chassis with its copied node nested exactly once', async () => {
  const { workspace, place, solution } = setup();
  const result = await place();
  const chassis = (workspace.rackArea[0]!.rackItems as RackObject[])[0]!;
  workspace.rackArea[0]!.rackItems = [];
  workspace.nonRackArea.push(chassis);
  const exported = buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode: 'guided' });
  const loose = (exported.workspace as Obj).nonRackArea as Obj[];
  expect(loose.map(item => item.id)).toEqual(['node-source', 'chassis-1']);
  expect(loose[1]).toMatchObject({ children: [{ id: result.nestedPlacement!.nodeId }] });
  expect(((exported.workspaceInformation as Obj).nonRackData as Obj[]).map(item => item.id))
    .toEqual(['node-source', 'chassis-1']);
});

it('projects nested manufacturing groups and physical filler into export without changing source selections', async () => {
  const { workspace, source, place, solution } = setup();
  const manufacturing = [{ name: 'MI_P', description: 'MI_P', features: [{ code: '7501' }], results: [] }];
  source.raw.unSelectableCharacters = structuredClone(manufacturing);
  const chassisSession = [...workspace.configurations.values()].find(session => session.configurationId === 'chassis-1')!;
  chassisSession.raw.unSelectableCharacters = structuredClone(manufacturing);
  (workspace.rackArea[0]!.rackItems as RackObject[])[0]!.filler = { code: 'BWJQ', size: 3 };
  const result = await place();
  const exported = buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode: 'guided' });
  const configurations = exported.configurations as Obj[];
  for (const id of ['chassis-1', result.nestedPlacement!.nodeId]) {
    expect((configurations.find(config => config.id === id)!.sections as Obj[]).find(section => section.name === 'MI_P'))
      .toMatchObject({ results: [{ code: '7501', quantity: 1 }] });
  }
  expect((configurations.find(config => config.id === 'node-source')!.sections as Obj[]).some(section => section.name === 'MI_P')).toBe(false);
  expect(source.raw.unSelectableCharacters).toEqual(manufacturing);
  expect(chassisSession.raw.unSelectableCharacters).toEqual(manufacturing);
  const children = (((exported.workspace as Obj).rackArea as Obj[])[0]!.children as Obj[]);
  expect(children[0]!.derivedResults).toContainEqual({ featureCode: 'BWJQ', quantity: 3 });
});

it('does not list a node inside a racked chassis as an unplaced configuration', async () => {
  const { workspace, place } = setup();
  const placed = await place();
  const source = workspaceDetailSource(workspace);
  expect((source.unracked as Obj[]).map(item => item.configurationId)).toEqual(['node-source']);
  expect((source.configurations as Obj[]).map(item => item.configurationId))
    .toContain(placed.nestedPlacement!.nodeId);
});

it.each(['racked', 'loose'])('does not orphan nested configurations when closing a %s populated chassis', async area => {
  const { service, workspace, place } = setup();
  await place();
  if (area === 'loose') {
    workspace.nonRackArea.push((workspace.rackArea[0]!.rackItems as RackObject[]).pop()!);
  }
  const chassis = [...workspace.configurations.values()].find(session => session.configurationId === 'chassis-1')!;
  const physicalBefore = structuredClone({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea });
  const idsBefore = [...workspace.configurations.keys()];
  const revision = workspace.revision;
  await expect(service.closeSession(chassis.id)).rejects.toThrow(/contains configurations.*dcsc_edit_layout/);
  expect({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea }).toEqual(physicalBefore);
  expect([...workspace.configurations.keys()]).toEqual(idsBefore);
  expect(workspace.revision).toBe(revision);
});

it.each(['delete', 'unplace'] as const)('removes a populated chassis with explicit %s child disposition and atomic history', async contents => {
  const { service, workspace, calls, place } = setup();
  const placed = await place();
  const childId = placed.nestedPlacement!.nodeId;
  const before = structuredClone({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
    dependency: workspace.serverState.cloneDependency });
  const originalIds = [...workspace.configurations.values()].map(session => session.configurationId);
  calls.length = 0;
  await service.editLayout(workspace.id, { action: 'remove', configurationId: 'chassis-1', contents,
    expectedRevision: workspace.revision, ctx: service.newCtx() });
  expect(calls.map(call => call.path)).toEqual(['/ctos/racks/customize', '/ctos/autoDerive']);
  const customize = calls[0]!.body?.kind === 'json' ? calls[0]!.body.value as Obj : {};
  expect((customize.configurations as Obj[]).map(raw => raw.id)).toEqual(originalIds);
  expect(customize.cloneDependency).toEqual(before.dependency);
  expect((customize.rackArea as RackObject[])[0]!.rackItems).toEqual([]);
  expect(calls[0]!.query).toEqual({ autoArrange: true, autoConnect: true, cogValidation: true });
  const survivingIds = contents === 'delete' ? ['node-source', 'rack-1'] : ['node-source', 'rack-1', childId];
  expect([...workspace.configurations.values()].map(session => session.configurationId)).toEqual(survivingIds);
  expect(workspace.nonRackArea.map(item => item.id)).toEqual(contents === 'delete' ? ['node-source'] : ['node-source', childId]);
  const derive = calls[1]!.body?.kind === 'json' ? calls[1]!.body.value as Obj : {};
  expect((derive.configurations as Obj[]).map(raw => raw.id)).toEqual(survivingIds);
  expect(Object.keys((derive.workspaceInformation as Obj).cloneDependency as Obj)).toEqual(survivingIds);
  expect(derive).not.toHaveProperty('customizingIds');
  expect(calls[1]!.query).toEqual({ guideMode: true });
  await service.sessions.undoWorkspace(workspace.id);
  expect({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
    dependency: workspace.serverState.cloneDependency }).toEqual(before);
  expect([...workspace.configurations.values()].map(session => session.configurationId)).toEqual(originalIds);
  await service.sessions.redoWorkspace(workspace.id);
  expect([...workspace.configurations.values()].map(session => session.configurationId)).toEqual(survivingIds);
});

it.each(['detach', 'unplace'] as const)('preserves the complete configuration when applying nested node %s', async action => {
  const { service, workspace, calls, place, solution } = setup();
  const placed = await place();
  const childId = placed.nestedPlacement!.nodeId;
  const before = structuredClone({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
    dependency: workspace.serverState.cloneDependency, colors: workspace.serverState.cloneDependencyColor });
  const ids = [...workspace.configurations.values()].map(session => session.configurationId);
  calls.length = 0;
  await service.editLayout(workspace.id, { action, configurationId: childId,
    expectedRevision: workspace.revision, ctx: service.newCtx() });
  expect(calls.map(call => call.path)).toEqual(['/ctos/racks/customize', '/ctos/autoDerive']);
  const native = action === 'detach' ? removalContract.deleteNode : removalContract.moveNodeToNonRack;
  const identityMap: Record<string, string> = {
    [removalContract.identities.rack]: 'rack-1',
    [removalContract.identities.chassis]: 'chassis-1',
    [removalContract.identities.looseSourceNode]: 'node-source',
    [removalContract.identities.copiedNestedNode]: childId,
  };
  expect(calls.map(call => `/api${call.path}`)).toEqual([
    removalContract.wireSequence.customize.path, removalContract.wireSequence.derive.path,
  ]);
  expect(calls[0]!.query).toEqual(removalContract.wireSequence.customize.query);
  expect(calls[1]!.query).toEqual(removalContract.wireSequence.derive.query);
  expect(ids.slice().sort()).toEqual(native.configurationIds.map(id => identityMap[id]).sort());
  for (const call of calls) {
    const body = call.body?.kind === 'json' ? call.body.value as Obj : {};
    expect((body.configurations as Obj[]).map(raw => raw.id)).toEqual(ids);
    expect(body).not.toHaveProperty('customizingIds');
  }
  expect(workspace.rackArea[0]!.rackItems).toMatchObject([{ id: 'chassis-1', nodes: [] }]);
  expect(workspace.nonRackArea.map(item => item.id)).toEqual(action === 'detach' ? ['node-source'] : ['node-source', childId]);
  expect([...workspace.configurations.values()].map(session => session.configurationId)).toEqual(ids);
  const expectedDependency = structuredClone(before.dependency) as Obj;
  const expectedColors = structuredClone(before.colors) as Obj;
  if (action === 'detach') { delete expectedDependency[childId]; delete expectedColors[childId]; }
  expect(workspace.serverState.cloneDependency).toEqual(expectedDependency);
  expect(workspace.serverState.cloneDependencyColor).toEqual(expectedColors);
  const derive = calls[1]!.body?.kind === 'json' ? calls[1]!.body.value as Obj : {};
  expect((derive.workspaceInformation as Obj).cloneDependency).toEqual(expectedDependency);
  expect(Object.keys(expectedDependency).sort()).toEqual(native.deriveCloneDependencyIds.map(id => identityMap[id]).sort());
  const exported = buildExportData({ workspace, solution, fileTypes: ['XML'], validationMode: 'guided' });
  expect((exported.configurations as Obj[]).map(raw => raw.id)).toEqual(ids);
  expect((exported.workspaceInformation as Obj).cloneDependency).toEqual(expectedDependency);
  const exportedColors = exported.cloneDependencyColor as Obj;
  // Native export reconstructs missing presentation colors for independent
  // roots in older imports. Keep accepted colors exact and require complete
  // root membership, including exclusion of a physically detached node.
  expect(Object.keys(exportedColors).sort()).toEqual(native.deriveCloneDependencyIds.map(id => identityMap[id]).sort());
  for (const [root, members] of Object.entries(expectedDependency)) {
    if (Object.hasOwn(expectedColors, root)) expect(exportedColors[root]).toEqual(expectedColors[root]);
    else expect(exportedColors[root]).toMatchObject({ dependBy: members,
      color: expect.stringMatching(/^#[0-9a-f]{6}$/), darkColor: expect.stringMatching(/^#[0-9a-f]{6}$/) });
  }
  expect(((exported.workspaceInformation as Obj).nonRackData as Obj[]).map(item => item.id))
    .toEqual(action === 'detach' ? ['node-source'] : ['node-source', childId]);
  expect(((exported.workspace as Obj).nonRackArea as Obj[]).map(item => item.id))
    .toEqual(action === 'detach' ? ['node-source'] : ['node-source', childId]);
  const detail = workspaceDetailSource(workspace);
  if (action === 'detach') expect((detail.unracked as Obj[]).find(item => item.configurationId === childId))
    .toMatchObject({ physicalState: 'detached; Lenovo reimport drops this node' });
  expect((exported.workspace as Obj).rackArea).toMatchObject([{ children: [{ id: 'chassis-1', children: [] }] }]);
  await service.sessions.undoWorkspace(workspace.id);
  expect({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
    dependency: workspace.serverState.cloneDependency, colors: workspace.serverState.cloneDependencyColor }).toEqual(before);
  await service.sessions.redoWorkspace(workspace.id);
  expect(workspace.rackArea[0]!.rackItems).toMatchObject([{ id: 'chassis-1', nodes: [] }]);
  expect([...workspace.configurations.values()].map(session => session.configurationId)).toEqual(ids);
});

it('never synthesizes a second loose copy of a nested node when non-rack state is empty', async () => {
  const { workspace, place } = setup();
  const placed = await place();
  workspace.nonRackArea = [];
  const body = buildAutoDeriveRequest(workspace, { validationMode: 'guided' });
  const nonRack = (body.workspaceInformation as Obj).nonRackData as Obj[];
  expect(nonRack.map(item => item.id)).toEqual(['node-source']);
  expect(nonRack.some(item => item.id === placed.nestedPlacement!.nodeId)).toBe(false);
});

it('does not turn a detached node back into a physical source by copying it', async () => {
  const { service, workspace, calls, place } = setup();
  const placed = await place();
  await service.editLayout(workspace.id, { action: 'detach', configurationId: placed.nestedPlacement!.nodeId,
    ctx: service.newCtx() });
  calls.length = 0;
  const revision = workspace.revision;
  await expect(service.placeInRack(workspace.id, { rackId: 'rack-1', chassisId: 'chassis-1',
    sessionId: placed.nestedPlacement!.session, ctx: service.newCtx() })).rejects.toThrow(/Undo detach/);
  expect(calls).toHaveLength(0);
  expect(workspace.revision).toBe(revision);
});

it('rejects detach for a loose node or populated chassis without sending a request', async () => {
  const { service, workspace, calls, place } = setup();
  await place();
  calls.length = 0;
  const before = structuredClone({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
    configurations: workspace.configurations, revision: workspace.revision });
  for (const configurationId of ['node-source', 'chassis-1']) {
    await expect(service.editLayout(workspace.id, { action: 'detach', configurationId,
      ctx: service.newCtx() })).rejects.toThrow(/requires a node inside a chassis/);
  }
  expect(calls).toHaveLength(0);
  expect({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
    configurations: workspace.configurations, revision: workspace.revision }).toEqual(before);
});

it.each([
  ['remove', 'derive'], ['remove', 'disk'], ['detach', 'derive'], ['detach', 'disk'],
] as const)('rolls back nested %s after %s failure', async (action, failure) => {
  const { service, workspace, place } = setup();
  const placed = await place();
  const before = structuredClone({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
    state: workspace.serverState, configurations: workspace.configurations, revision: workspace.revision });
  if (failure === 'disk') service.sessions.setPersistenceWriter(() => { throw new Error('disk full'); });
  else vi.mocked(service.http.send).mockImplementation(async request => {
    if (request.path === '/ctos/autoDerive') throw new Error('derive failed');
    const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
    return { raw: { rackArea: body.rackArea, nonRackArea: body.nonRackArea, connections: [] } } as never;
  });
  await expect(service.editLayout(workspace.id, { action,
    configurationId: action === 'detach' ? placed.nestedPlacement!.nodeId : 'chassis-1',
    contents: 'delete', ctx: service.newCtx() })).rejects.toThrow();
  expect({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
    state: workspace.serverState, configurations: workspace.configurations, revision: workspace.revision }).toEqual(before);
});

it.each(['restore-node', 'drop-parent', 'rerack-unplaced-node'] as const)(
  'rejects a successful backend response that changes nested intent: %s', async correction => {
    const { service, workspace, place } = setup();
    const placed = await place();
    const before = structuredClone({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
      state: workspace.serverState, configurations: workspace.configurations, revision: workspace.revision });
    vi.mocked(service.http.send).mockImplementation(async request => {
      if (request.path === '/ctos/autoDerive') return { raw: { configurations: [] } } as never;
      const body = request.body?.kind === 'json' ? request.body.value as Obj : {};
      const rackArea = structuredClone(body.rackArea) as RackObject[];
      const nonRackArea = structuredClone(body.nonRackArea) as RackObject[];
      const chassis = (rackArea[0]!.rackItems as RackObject[])[0]!;
      if (correction === 'drop-parent') rackArea[0]!.rackItems = [];
      else if (correction === 'restore-node') {
        chassis.nodes = structuredClone((before.rackArea[0]!.rackItems as RackObject[])[0]!.nodes);
      } else {
        chassis.nodes = nonRackArea.splice(nonRackArea.findIndex(item => item.id === placed.nestedPlacement!.nodeId), 1);
      }
      return { raw: { rackArea, nonRackArea, connections: [] } } as never;
    });
    await expect(service.editLayout(workspace.id, { action: correction === 'rerack-unplaced-node' ? 'unplace' : 'detach',
      configurationId: placed.nestedPlacement!.nodeId, ctx: service.newCtx() })).rejects.toThrow(/DCSC did not/);
    expect({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
      state: workspace.serverState, configurations: workspace.configurations, revision: workspace.revision }).toEqual(before);
  },
);

it('counts a nested node as physically placed in configuration-scoped power results', async () => {
  const { service, source, place } = setup();
  const captured = JSON.parse(readFileSync(new URL('./fixtures/parity/sr630-launch.json', import.meta.url), 'utf8')) as RawConfiguration;
  source.raw.powerReportResponse = captured.powerReportResponse;
  const result = await place();
  type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  const handlers = new Map<string, Handler>();
  registerTools({ registerTool(name: string, _definition: unknown, callback: Handler) {
    handlers.set(name, callback); return { remove() {}, update() {} };
  } } as unknown as McpServer, service);
  const reply = await handlers.get('dcsc_power')!({ session: result.nestedPlacement!.session });
  const report = JSON.parse(reply.content[0]!.text);
  expect(report.perRack).toMatchObject([{ rackId: 'rack-1', physicallyPlacedUnits: 1, powerContributors: 1, powerAvailable: true }]);
  expect(report.unplacedSalesUnits).toEqual([]);
});

it.each(['incompatible', 'dropped-copy', 'disk'])('rolls back the complete nested operation on %s', async failure => {
  const { service, source, workspace, place } = setup();
  const beforeRack = structuredClone(workspace.rackArea);
  const beforeLoose = structuredClone(workspace.nonRackArea);
  const revision = workspace.revision;
  if (failure === 'incompatible') vi.mocked(service.http.send).mockResolvedValue({ raw: [] } as never);
  if (failure === 'dropped-copy') vi.mocked(service.http.send).mockImplementation(async request => {
    if (request.path.includes('compatible_categories')) return { raw: [{ products: [
      { code: '7DD0CTOLWW', hardwareType: 'chassis' }, { code: '7DD1CTOLWW', hardwareType: 'node' },
    ] }] } as never;
    return { raw: { rackArea: beforeRack, nonRackArea: beforeLoose, connections: [] } } as never;
  });
  if (failure === 'disk') service.sessions.setPersistenceWriter(() => { throw new Error('disk full'); });
  await expect(place()).rejects.toThrow();
  expect(workspace.rackArea).toEqual(beforeRack);
  expect(workspace.nonRackArea).toEqual(beforeLoose);
  expect(workspace.configurations.size).toBe(3);
  expect(workspace.configurations.has(source.id)).toBe(true);
  expect(workspace.revision).toBe(revision);
});
