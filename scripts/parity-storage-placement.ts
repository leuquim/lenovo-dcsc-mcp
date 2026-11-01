/** Live MCP storage physical-placement/export gate. Fresh-browser reimport is a separate gate. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildExportGroups } from '../src/domain/exportGroups.js';
import type { RawConfiguration } from '../src/model/types.js';
import { readJsonProjection } from './lib/read-json-projection.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out');
  const seedIndex = process.argv.indexOf('--seed');
  const out = path.resolve(outIndex >= 0 ? process.argv[outIndex + 1]! :
    `artifacts/parity-storage-placement/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const seed = path.resolve(seedIndex >= 0 ? process.argv[seedIndex + 1]! :
    'test/fixtures/parity/xml/storage-managed-controller.xml');
  await Promise.all([mkdir(out, { recursive: true }), readFile(seed)]);
  const configFile = path.join(out, 'config.json');
  const sessionFile = path.join(out, 'sessions.json');
  await writeFile(configFile, JSON.stringify({ logLevel: 'error', files: {
    persistSessions: true, sessionFile, artifactDir: path.join(out, 'exports'),
  } }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !entry[0].startsWith('DCSC_')));
  let transport: StdioClientTransport | undefined;
  let client: Client | undefined;
  const calls: Obj[] = [];
  let stage = 'start';
  const start = async (): Promise<void> => {
    transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/server.ts'], stderr: 'pipe', env: { ...env, DCSC_CONFIG: configFile } });
    client = new Client({ name: 'storage-placement-parity', version: '1.0.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    assert(tools.tools.some(tool => tool.name === 'dcsc_place_storage_network'));
  };
  const call = async (name: string, args: Obj): Promise<Obj> => {
    const response = await client!.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
    const text = (response.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text')?.text ?? '';
    const result = object(JSON.parse(text));
    calls.push({ name, arguments: args, isError: response.isError === true, result });
    await writeFile(path.join(out, 'calls.json'), JSON.stringify(calls, null, 2));
    assert.notEqual(response.isError, true, `${name}: ${text}`);
    assert(Buffer.byteLength(text) <= 8_000, `${name} exceeded response budget.`);
    return result;
  };
  const restoredState = async (workspace: string): Promise<Obj> => {
    const layout = await call('dcsc_workspace_layout', { session: workspace });
    const inspection = object(object(object(layout.pages).rawRackArea).inspect);
    const args = object(inspection.arguments);
    assert.equal(typeof args.expectedRevision, 'number', 'Layout omitted its revision-bound continuation.');
    const result: Obj = {};
    for (const field of ['rawRackArea', 'rawNonRackArea', 'floorItems', 'powerSelections',
      'storageNetworks', 'detachedStorageComponents', 'cloneDependency', 'cloneDependencyColor']) {
      result[field] = await readJsonProjection(call, { tool: 'dcsc_workspace_layout',
        arguments: { ...args, path: [field], offset: 0, limit: 50 } },
      field.startsWith('cloneDependency') ? 'object' : 'array');
    }
    return result;
  };
  const persistedProjection = (saved: Obj, workspace: string): Obj => {
    const stored = rows(saved.workspaces).find(item => item.id === workspace);
    assert(stored, 'Acknowledged workspace was not persisted.');
    const state = object(stored.serverState);
    assert(Array.isArray(state.storageConnectionNetworks), 'Storage definitions were not persisted.');
    return { rawRackArea: stored.rackArea, rawNonRackArea: stored.nonRackArea,
      floorItems: stored.floorItems, powerSelections: stored.powerSelections,
      storageNetworks: state.storageConnectionNetworks,
      detachedStorageComponents: state.detachedStorageComponents ?? [],
      cloneDependency: state.cloneDependency ?? {}, cloneDependencyColor: state.cloneDependencyColor ?? {} };
  };
  try {
    await start();
    stage = 'import';
    const imported = await call('dcsc_import', { filePath: seed, solutionMode: 'HPC and AI - Systems' });
    const workspace = String(imported.workspace);
    stage = 'layout';
    const layout = await call('dcsc_workspace_layout', { session: workspace, offset: 0, limit: 20 });
    const rack = rows(layout.racks)[0];
    const rackId = String(rack?.rackId ?? rack?.id ?? '');
    assert(rackId, 'Seed import returned no rack identity.');
    stage = 'settings';
    await call('dcsc_add_cabling', { session: workspace, mode: 'auto',
      settings: { autoAddPDU: false, autoAddSwitch: false, p2pCabling: false } });
    stage = 'catalog';
    const controllers = await call('dcsc_fabric_options', { session: workspace,
      collection: 'storageControllers', limit: 100, fields: ['option', 'featureCode'] });
    const switches = await call('dcsc_fabric_options', { session: workspace,
      collection: 'storageSwitches', limit: 100, fields: ['option', 'featureCode'] });
    const controller = rows(controllers.items).find(item => item.option === '7DP4CTO1WW' && item.featureCode === 'BF3C');
    const sanSwitch = rows(switches.items).find(item => item.option === '7DHNCTO1WW' && item.featureCode === 'C1FM');
    assert(controller?.id, 'Current catalog has no captured DS3200 BF3C controller.');
    assert(sanSwitch?.id, 'Current catalog has no captured DB710S C1FM SAN switch.');
    stage = 'definition';
    await call('dcsc_add_storage_network', { session: workspace, name: 'Physical Placement Gate',
      controllerId: controller.id, switchId: sanSwitch.id, expansionQuantity: 0 });
    stage = 'first-placement';
    const first = await call('dcsc_place_storage_network', { session: workspace,
      name: 'Physical Placement Gate', rackId });
    assert.equal(rows(first.placements).length, 2);
    assert(rows(first.placements).every(item => !('raw' in item)), 'Tool leaked raw physical state.');
    stage = 'second-placement';
    const second = await call('dcsc_place_storage_network', { session: workspace,
      name: 'Physical Placement Gate', rackId, expectedRevision: first.revision });
    assert.equal(rows(second.placements).length, 2);
    assert(rows(second.templates).every(item => item.created === false), 'Repeated placement relaunched a template.');
    stage = 'assign-and-clear-storage';
    const assignmentSource = object(JSON.parse(await readFile(sessionFile, 'utf8')));
    const assignmentWorkspace = rows(assignmentSource.workspaces).find(item => item.id === workspace)!;
    const serverConfiguration = rows(assignmentWorkspace.configurations).find(item => {
      const raw = object(item.raw);
      return raw.type === 'server' && object(item.product).code === '7D73CTOHWW';
    });
    const serverSession = String(serverConfiguration?.id ?? '');
    assert(serverSession, 'Seed import returned no server configuration handle for assignment testing.');
    const assigned = await call('dcsc_assign_storage_network', { session: serverSession,
      networkName: 'Physical Placement Gate' });
    assert.equal(assigned.selectedStorageNetwork, 'Physical Placement Gate');
    const cleared = await call('dcsc_assign_storage_network', { session: serverSession,
      networkName: null, expectedRevision: assigned.configurationRevision });
    assert.equal(cleared.selectedStorageNetwork, '');
    stage = 'sigkill-restart';
    const beforeKill = object(JSON.parse(await readFile(sessionFile, 'utf8')));
    assert(transport!.pid, 'MCP transport has no child PID.');
    process.kill(transport!.pid!, 'SIGKILL');
    await client!.close();
    client = undefined;
    transport = undefined;
    await start();
    assert.deepEqual(await restoredState(workspace), persistedProjection(beforeKill, workspace),
      'Storage physical state read through MCP changed across immediate SIGKILL/restart.');
    assert.deepEqual(object(JSON.parse(await readFile(sessionFile, 'utf8'))), beforeKill,
      'Storage aliases/colors changed across immediate SIGKILL and restart.');
    stage = 'state-projection';
    const persisted = object(JSON.parse(await readFile(sessionFile, 'utf8')));
    const savedWorkspace = rows(persisted.workspaces)[0]!;
    const state = object(savedWorkspace.serverState);
    const definitions = rows(state.storageConnectionNetworks);
    const selected = definitions.find(item => item.name === 'Physical Placement Gate')!;
    const controllerId = String(object(selected.controller).id);
    const switchId = String(object(selected.mainSwitch).id);
    const dependency = object(state.cloneDependency);
    assert.equal(rows(savedWorkspace.configurations).filter(item =>
      item.configurationId === controllerId || item.configurationId === switchId).length, 2);
    assert.equal(Array.isArray(dependency[controllerId]) ? dependency[controllerId].length : 0, 3);
    assert.equal(Array.isArray(dependency[switchId]) ? dependency[switchId].length : 0, 3);
    const dependencyColor = object(state.cloneDependencyColor);
    for (const templateId of [controllerId, switchId]) {
      const color = object(dependencyColor[templateId]);
      assert.deepEqual(color.dependBy, dependency[templateId],
        `Storage template ${templateId} has no browser-equivalent color dependency.`);
      for (const name of ['colorRGB', 'darkColorRGB']) {
        const rgb = object(color[name]);
        for (const channel of ['r', 'g', 'b']) {
          assert(Number.isInteger(rgb[channel]) && Number(rgb[channel]) >= 0 && Number(rgb[channel]) <= 255,
            `Storage template ${templateId} ${name}.${channel} must be an unsigned RGB byte.`);
        }
      }
    }
    const groupInput = { serverState: state, rackArea: rows(savedWorkspace.rackArea),
      nonRackArea: rows(savedWorkspace.nonRackArea), configurations: new Map(rows(savedWorkspace.configurations).map(item => [String(item.id), {
        configurationId: String(item.configurationId), raw: object(item.raw) as RawConfiguration,
        product: { code: String(object(item.product).code) }, mode: 'cto' as const,
      }])) };
    const products = buildExportGroups(groupInput).flatMap(group => group.products) as Obj[];
    const commercial = products.filter(item => item.id === controllerId || item.id === switchId)
      .map(item => Object.fromEntries(['id', 'code', 'type', 'quantity', 'price', 'unitPrice'].map(key => [key, item[key]])));
    assert(commercial.some(item => item.id === controllerId && item.code === '7DP4CTO1WW' && item.quantity === 2));
    assert(commercial.some(item => item.id === switchId && item.code === '7DHNCTO1WW' && item.quantity === 2));
    const stateProjection = { controllerId, switchId, cloneDependency: {
      [controllerId]: dependency[controllerId], [switchId]: dependency[switchId],
    }, cloneDependencyColor: {
      [controllerId]: dependencyColor[controllerId], [switchId]: dependencyColor[switchId],
    }, commercial };
    await writeFile(path.join(out, 'pre-export.json'), JSON.stringify(stateProjection, null, 2));
    stage = 'export';
    const exported = await call('dcsc_export', { session: workspace,
      fileName: 'storage-physical-placement', fileTypes: ['XML', 'QUOTE'] });
    assert.equal(typeof exported.xml, 'string');
    stage = 'move-storage-alias';
    const firstControllerAlias = String(rows(first.placements)
      .find(item => item.role === 'controller')?.physicalId ?? '');
    assert(firstControllerAlias, 'First placement returned no controller physical identity.');
    const moved = await call('dcsc_place_in_rack', { session: workspace, rackId,
      configuration: firstControllerAlias, uPosition: 10, expectedRevision: cleared.revision });
    const movedItem = rows(moved.racks).flatMap(rack => rows(rack.items))
      .find(item => item.id === firstControllerAlias);
    assert.equal(movedItem?.position, 10, 'DCSC did not retain the requested managed-storage move.');
    stage = 'export-after-storage-alias-move';
    const afterMoveState = object(JSON.parse(await readFile(sessionFile, 'utf8')));
    const afterMoveWorkspace = rows(afterMoveState.workspaces)[0]!;
    const afterMoveServerState = object(afterMoveWorkspace.serverState);
    const movedTemplate = rows(afterMoveWorkspace.configurations)
      .find(item => item.configurationId === controllerId)!;
    const physicalRaws = object(afterMoveServerState.storagePhysicalConfigurations);
    const movedPhysicalRaw = object(physicalRaws[firstControllerAlias]);
    assert.equal(movedPhysicalRaw.id, controllerId,
      'Moved physical state lost its editable storage template identity.');
    assert(JSON.stringify(movedPhysicalRaw).includes('B6Y7'),
      'Moved DS3200 physical state did not retain the captured rack rail B6Y7.');
    assert(JSON.stringify(object(movedTemplate.raw)).includes('B6Y6') &&
      !JSON.stringify(object(movedTemplate.raw)).includes('B6Y7'),
    'Physical move overwrote the editable DS3200 template rail selection.');
    assert.deepEqual(afterMoveServerState.cloneDependency, state.cloneDependency,
      'Physical move changed the template-to-alias dependency identities.');
    const afterMoveInput = { serverState: afterMoveServerState, rackArea: rows(afterMoveWorkspace.rackArea),
      nonRackArea: rows(afterMoveWorkspace.nonRackArea), configurations: new Map(rows(afterMoveWorkspace.configurations)
        .map(item => [String(item.id), { configurationId: String(item.configurationId),
          raw: object(item.raw) as RawConfiguration, product: { code: String(object(item.product).code) },
          mode: 'cto' as const,
        }])) };
    const afterMoveCommercial = buildExportGroups(afterMoveInput).flatMap(group => group.products)
      .filter(item => item.id === controllerId || item.id === switchId)
      .map(item => Object.fromEntries(['id', 'code', 'type', 'quantity', 'price', 'unitPrice']
        .map(key => [key, item[key]])));
    assert(afterMoveCommercial.some(item => item.id === controllerId && item.code === '7DP4CTO1WW' &&
      item.quantity === 2 && item.price === 425_035.02 && item.unitPrice === 212_517.51),
    'Moved DS3200 commercial row did not use the captured physical rack-derived price.');
    const movedExport = await call('dcsc_export', { session: workspace,
      fileName: 'storage-physical-alias-moved', fileTypes: ['XML', 'QUOTE'] });
    assert.equal(typeof movedExport.xml, 'string');
    stage = 'undo-storage-alias-move';
    const undone = await call('dcsc_workspace_history', { session: workspace,
      action: 'undo', expectedRevision: moved.revision });
    assert.equal(undone.changed, true);
    stage = 'post-placement-controller-edit';
    const controllerSession = String(rows(second.templates)
      .find(item => item.configurationId === controllerId)?.session ?? '');
    assert(controllerSession, 'Placement did not return the managed controller session handle.');
    const controllerOptions = await call('dcsc_list_options', { session: controllerSession,
      query: 'C4A8', limit: 10 });
    const fibreAdapter = rows(controllerOptions.options).find(option => option.code === 'C4A8');
    assert(fibreAdapter?.sectionId, 'Current DS3200 controller has no configurable C4A8 section.');
    const configuredController = await call('dcsc_configure', { session: controllerSession,
      changes: [{ section: fibreAdapter.sectionId, code: 'C4A8', quantity: 2 }] });
    assert.equal(configuredController.applied, true);
    const afterControllerEdit = object(JSON.parse(await readFile(sessionFile, 'utf8')));
    const afterControllerWorkspace = rows(afterControllerEdit.workspaces)[0]!;
    const editedTemplate = object(rows(afterControllerWorkspace.configurations)
      .find(item => item.configurationId === controllerId)?.raw);
    const selectedFeature = (raw: Obj, sectionName: string, featureCode: string): Obj | undefined =>
      rows(raw.tabs).flatMap(tab => rows(tab.subTabs)).flatMap(tab => rows(tab.sections))
        .filter(section => section.name === sectionName).flatMap(section => rows(section.results))
        .find(result => result.code === featureCode);
    assert.equal(selectedFeature(editedTemplate, 'NETWORK_ADAPTER', 'C4A8')?.quantity, 2,
      'Controller template did not retain C4A8 quantity two.');
    const editedPhysicalItems = rows(afterControllerWorkspace.rackArea).flatMap(rack => rows(rack.rackItems))
      .filter(item => controllerAliasesFrom(dependency, controllerId).includes(String(item.id)));
    assert.equal(editedPhysicalItems.length, 2, 'Post-edit rack state lost a controller physical alias.');
    for (const item of editedPhysicalItems) {
      const physicalFeature = rows(item.features).filter(section => section.name === 'NETWORK_ADAPTER')
        .flatMap(section => rows(section.results)).find(result => result.code === 'C4A8');
      assert.equal(physicalFeature?.quantity, 2, `Physical controller ${String(item.id)} did not retain C4A8 quantity two.`);
      assert.equal(rows(physicalFeature?.installations).length, 2,
        `Physical controller ${String(item.id)} did not retain C4A8 PCI installations.`);
    }
    const editedExport = await call('dcsc_export', { session: workspace,
      fileName: 'storage-post-placement-controller-edited', fileTypes: ['XML', 'QUOTE'] });
    assert.equal(typeof editedExport.xml, 'string');
    stage = 'unplace-storage-template-group';
    const controllerAliases = controllerAliasesFrom(dependency, controllerId);
    const grouped = await call('dcsc_edit_layout', { session: workspace, action: 'unplace',
      configuration: controllerId, expectedRevision: Number(afterControllerWorkspace.revision) });
    const unplacedIds = rows(grouped.unplaced).map(item => String(item.id));
    assert(controllerAliases.every(id => unplacedIds.includes(id)),
      'Managed-template unplace did not retain every controller physical alias as non-rack.');
    const groupedRackIds = rows(grouped.racks).flatMap(rack => rows(rack.items)).map(item => String(item.id));
    assert(controllerAliases.every(id => !groupedRackIds.includes(id)),
      'Managed-template unplace left a controller physical alias in the rack.');
    const afterGroupState = object(JSON.parse(await readFile(sessionFile, 'utf8')));
    const afterGroupWorkspace = rows(afterGroupState.workspaces)[0]!;
    const afterGroupServerState = object(afterGroupWorkspace.serverState);
    const afterGroupInput = { serverState: afterGroupServerState, rackArea: rows(afterGroupWorkspace.rackArea),
      nonRackArea: rows(afterGroupWorkspace.nonRackArea), configurations: new Map(rows(afterGroupWorkspace.configurations)
        .map(item => [String(item.id), { configurationId: String(item.configurationId),
          raw: object(item.raw) as RawConfiguration, product: { code: String(object(item.product).code) },
          mode: 'cto' as const,
        }])) };
    const afterGroupCommercial = buildExportGroups(afterGroupInput).flatMap(group => group.products)
      .filter(item => item.id === controllerId || item.id === switchId)
      .map(item => Object.fromEntries(['id', 'code', 'type', 'quantity', 'price', 'unitPrice']
        .map(key => [key, item[key]])));
    assert(afterGroupCommercial.some(item => item.id === switchId && item.code === '7DHNCTO1WW' &&
      item.quantity === 2 && item.price === 22_576.02 && item.unitPrice === 11_288.01),
    'Summary derive did not preserve the captured DB710S physical price.');
    stage = 'export-after-group-unplace';
    const groupedExport = await call('dcsc_export', { session: workspace,
      fileName: 'storage-physical-group-unplaced', fileTypes: ['XML', 'QUOTE'] });
    assert.equal(typeof groupedExport.xml, 'string');
    stage = 'post-placement-san-edit';
    const switchSession = String(rows(second.templates)
      .find(item => item.configurationId === switchId)?.session ?? '');
    assert(switchSession, 'Placement did not return the managed SAN switch session handle.');
    const sanOptions = await call('dcsc_list_options', { session: switchSession, query: 'C1FP', limit: 10 });
    const portLicense = rows(sanOptions.options).find(option => option.code === 'C1FP');
    assert(portLicense?.sectionId, 'Current DB710S has no configurable C1FP port license.');
    const configuredSwitch = await call('dcsc_configure', { session: switchSession,
      changes: [{ section: portLicense.sectionId, code: 'C1FP', quantity: 1 }] });
    assert.equal(configuredSwitch.applied, true);
    const afterSwitchEdit = object(JSON.parse(await readFile(sessionFile, 'utf8')));
    const afterSwitchWorkspace = rows(afterSwitchEdit.workspaces)[0]!;
    const editedSwitchTemplate = object(rows(afterSwitchWorkspace.configurations)
      .find(item => item.configurationId === switchId)?.raw);
    assert.equal(selectedFeature(editedSwitchTemplate, 'SFP_PORT_LICENSE', 'C1FP')?.quantity, 1);
    const switchAliases = controllerAliasesFrom(dependency, switchId);
    const switchItems = rows(afterSwitchWorkspace.rackArea).flatMap(rack => rows(rack.rackItems))
      .filter(item => switchAliases.includes(String(item.id)));
    assert.equal(switchItems.length, 2, 'SAN option edit lost a physical switch.');
    for (const item of switchItems) {
      const license = rows(item.features).filter(section => section.name === 'SFP_PORT_LICENSE')
        .flatMap(section => rows(section.results)).find(result => result.code === 'C1FP');
      assert.equal(license?.quantity, 1, `SAN instance ${String(item.id)} lost its port license.`);
    }
    const switchExport = await call('dcsc_export', { session: workspace,
      fileName: 'storage-post-placement-san-edited', fileTypes: ['XML', 'QUOTE'] });
    assert.equal(typeof switchExport.xml, 'string');
    assert((await readFile(String(switchExport.xml), 'utf8')).includes('C1FP'),
      'Exported XML lost the accepted SAN port license.');
    stage = 'restart-after-storage-edits';
    const afterGroupUnplace = object(JSON.parse(await readFile(sessionFile, 'utf8')));
    assert(transport!.pid, 'MCP transport has no child PID before group-unplace restart.');
    process.kill(transport!.pid!, 'SIGKILL');
    await client!.close();
    client = undefined;
    transport = undefined;
    await start();
    const restartedLayout = await call('dcsc_workspace_layout', { session: workspace, offset: 0, limit: 20 });
    const restartedState = object(JSON.parse(await readFile(sessionFile, 'utf8')));
    assert.deepEqual(restartedState, afterGroupUnplace,
      'Storage option edits and group unplace changed across immediate SIGKILL and restart.');
    const restartedWorkspace = rows(restartedState.workspaces).find(item => item.id === workspace)!;
    const restartedUnrackedIds = rows(restartedWorkspace.nonRackArea).map(item => String(item.id));
    assert(controllerAliases.every(id => restartedUnrackedIds.includes(id)),
      'Managed-template unplace aliases were not visible after restart.');
    const unrackedInspect = object(object(object(restartedLayout.pages).unracked).inspect);
    assert.equal(unrackedInspect.tool, 'dcsc_workspace_layout',
      'Layout did not return its documented unracked inspection continuation.');
    const unrackedPage = await call(String(unrackedInspect.tool), object(unrackedInspect.arguments));
    const projectedUnrackedIds = rows(unrackedPage.items).map(item => object(item.value))
      .map(item => String(item.configurationId ?? item.id));
    assert(controllerAliases.every(id => projectedUnrackedIds.includes(id)),
      'Managed-template unplace aliases were not visible through dcsc_workspace_layout after restart.');
    stage = 'replace-san-with-direct-attached';
    const detached = await call('dcsc_edit_storage_network', { session: workspace, action: 'update',
      name: 'Physical Placement Gate', changes: { switchId: 'direct-attached' },
      expectedRevision: Number(restartedWorkspace.revision), autoConnect: true });
    const retained = rows(detached.retainedComponents);
    assert.deepEqual(retained.map(item => ({ templateId: item.templateId, code: item.code,
      type: item.type, roles: item.roles, physicalCount: item.physicalCount,
      reason: item.reason, nativeCommercialDifference: item.nativeCommercialDifference })), [{
      templateId: switchId, code: '7DHNCTO1WW', type: 'switch', roles: ['mainSwitch'],
      physicalCount: 2, reason: 'definition-replaced',
      nativeCommercialDifference: 'website-counts-detached-template',
    }]);
    const detachedState = object(JSON.parse(await readFile(sessionFile, 'utf8')));
    const detachedWorkspace = rows(detachedState.workspaces).find(item => item.id === workspace)!;
    const detachedServerState = object(detachedWorkspace.serverState);
    const detachedDefinitions = rows(detachedServerState.storageConnectionNetworks);
    assert.deepEqual(object(detachedDefinitions.find(item => item.name === 'Physical Placement Gate')?.mainSwitch),
      { hardwareType: 'switch', option: '', featureCode: '' });
    assert.deepEqual(rows(detachedServerState.detachedStorageComponents).map(item => ({
      templateId: item.templateId, code: item.code, type: item.type, roles: item.roles,
      physicalIds: item.physicalIds, sourceNetworkName: item.sourceNetworkName,
      reason: item.reason, nativeCommercialDifference: item.nativeCommercialDifference,
    })), [{ templateId: switchId, code: '7DHNCTO1WW', type: 'switch', roles: ['mainSwitch'],
      physicalIds: switchAliases, sourceNetworkName: 'Physical Placement Gate', reason: 'definition-replaced',
      nativeCommercialDifference: 'website-counts-detached-template' }]);
    const detachedPhysicalIds = rows(detachedWorkspace.rackArea).flatMap(rack => rows(rack.rackItems))
      .map(item => String(item.id));
    assert(switchAliases.every(id => detachedPhysicalIds.includes(id)),
      'SAN replacement removed a retained physical switch alias.');
    const detachedInput = { serverState: detachedServerState, rackArea: rows(detachedWorkspace.rackArea),
      nonRackArea: rows(detachedWorkspace.nonRackArea), configurations: new Map(rows(detachedWorkspace.configurations)
        .map(item => [String(item.id), { configurationId: String(item.configurationId),
          raw: object(item.raw) as RawConfiguration, product: { code: String(object(item.product).code) },
          mode: 'cto' as const,
        }])) };
    const detachedCommercial = buildExportGroups(detachedInput).flatMap(group => group.products)
      .filter(item => item.id === switchId)
      .map(item => Object.fromEntries(['id', 'code', 'type', 'quantity', 'price', 'unitPrice']
        .map(key => [key, item[key]])));
    assert(detachedCommercial.some(item => item.code === '7DHNCTO1WW' && item.type === 'hardware' &&
      item.quantity === 2),
    'Detached SAN commercial projection counted the editable template in addition to its two physical aliases.');
    assert(!detachedCommercial.some(item => Number(item.quantity) === 3),
      'Detached SAN reproduced the native website template-plus-alias double count.');
    const detachedExport = await call('dcsc_export', { session: workspace,
      fileName: 'storage-san-detached-direct-attached', fileTypes: ['XML', 'QUOTE'] });
    assert.equal(typeof detachedExport.xml, 'string');
    stage = 'restart-after-san-replacement';
    const beforeDetachedKill = object(JSON.parse(await readFile(sessionFile, 'utf8')));
    assert(transport!.pid, 'MCP transport has no child PID before detached-SAN restart.');
    process.kill(transport!.pid!, 'SIGKILL');
    await client!.close();
    client = undefined;
    transport = undefined;
    await start();
    assert.deepEqual(await restoredState(workspace), persistedProjection(beforeDetachedKill, workspace),
      'Detached SAN state read through MCP changed across immediate SIGKILL/restart.');
    assert.deepEqual(object(JSON.parse(await readFile(sessionFile, 'utf8'))), beforeDetachedKill,
      'Detached SAN identity, aliases or commercial metadata changed across immediate SIGKILL and restart.');
    const report = { status: 'pass', seed, workspace, rackId, first: { revision: first.revision,
      placements: first.placements, templates: first.templates }, second: { revision: second.revision,
      placements: second.placements, templates: second.templates }, assignment: {
        session: serverSession, assignedRevision: assigned.revision, clearedRevision: cleared.revision,
      }, commercial, export: exported,
      move: { physicalId: firstControllerAlias, requestedPosition: 10, acceptedPosition: movedItem.position,
        revision: moved.revision, commercial: afterMoveCommercial, export: movedExport,
        undoRevision: undone.revision },
      controllerEdit: { session: controllerSession, code: 'C4A8', quantity: 2,
        configurationRevision: configuredController.revision,
        workspaceRevision: afterControllerWorkspace.revision, export: editedExport },
      sanEdit: { session: switchSession, code: 'C1FP', quantity: 1, physicalIds: switchAliases,
        configurationRevision: configuredSwitch.revision, workspaceRevision: afterSwitchWorkspace.revision,
        export: switchExport },
      sanReplacement: { switchId, physicalIds: switchAliases, retainedComponents: retained,
        commercial: detachedCommercial, export: detachedExport, revision: detached.revision },
      groupUnplace: { templateId: controllerId, physicalIds: controllerAliases,
        revision: grouped.revision, commercial: afterGroupCommercial, export: groupedExport },
    };
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`PASS storage physical placement; report: ${path.join(out, 'report.json')}`);
  } catch (error) {
    await writeFile(path.join(out, 'failure.json'), JSON.stringify({ status: 'fail', stage,
      error: String((error as Error)?.stack ?? error), calls }, null, 2));
    throw error;
  } finally {
    await client?.close().catch(() => undefined);
  }
}

function controllerAliasesFrom(dependency: Obj, controllerId: string): string[] {
  return Array.isArray(dependency[controllerId])
    ? (dependency[controllerId] as unknown[]).filter((id): id is string => typeof id === 'string' && id !== controllerId)
    : [];
}

await main();
