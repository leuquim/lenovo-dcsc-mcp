/** Live MCP storage lifecycle gate. Browser graph/handoff parity is a separate gate. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildExportGroups } from '../src/domain/exportGroups.js';
import type { RawConfiguration } from '../src/model/types.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out');
  const out = path.resolve(outIndex >= 0 ? process.argv[outIndex + 1]! :
    `artifacts/parity-storage/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(out, { recursive: true });
  const configFile = path.join(out, 'config.json');
  const sessionFile = path.join(out, 'sessions.json');
  await writeFile(configFile, JSON.stringify({ logLevel: 'error', files: {
    persistSessions: true, sessionFile, artifactDir: path.join(out, 'exports'),
  } }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !entry[0].startsWith('DCSC_')));
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let sequence = 0;
  let stage = 'start';
  const calls: Obj[] = [];
  const start = async () => {
    transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/server.ts'], stderr: 'pipe',
      env: { ...env, DCSC_CONFIG: configFile } });
    client = new Client({ name: 'storage-parity', version: '1.0.0' });
    await client.connect(transport);
    const listed = await client.listTools();
    for (const name of ['dcsc_storage_set', 'dcsc_storage_get', 'dcsc_network_get']) {
      assert(listed.tools.some(tool => tool.name === name), `${name} is not registered.`);
    }
  };
  const call = async (name: string, args: Obj, error = false): Promise<Obj> => {
    const result = await client!.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find(item => item.type === 'text')?.text ?? '';
    const json = object(JSON.parse(text));
    const entry = { name, arguments: args, isError: result.isError === true, bytes: Buffer.byteLength(text), result: json };
    calls.push(entry);
    await writeFile(path.join(out, `${String(++sequence).padStart(3, '0')}-${name}.json`), JSON.stringify(entry, null, 2));
    assert.equal(result.isError === true, error, `${name}: ${text}`);
    assert(entry.bytes <= 8000, `${name} exceeds the tool response budget.`);
    return json;
  };
  const snapshot = async (): Promise<Obj> => {
    const saved = object(JSON.parse(await readFile(sessionFile, 'utf8')));
    assert.equal(saved.version, 2);
    return rows(saved.workspaces)[0]!;
  };
  try {
    await start();
    stage = 'launch';
    const launched = await call('dcsc_launch', { productCode: '7D73CTOHWW', mode: 'cto', solutionMode: 'HPC and AI - Systems' });
    const server = String(launched.session);
    const workspace = String(launched.workspace);
    stage = 'hba';
    const options = await call('dcsc_configuration_get', { view: 'options', session: server, query: 'ATZV', limit: 10 });
    const hba = rows(options.options).find(option => option.code === 'ATZV');
    assert(hba?.sectionId, 'Current server catalog has no ATZV HBA target.');
    await call('dcsc_configure', { session: server, changes: [{ section: hba.sectionId, code: 'ATZV', quantity: 1 }] });
    stage = 'rack';
    await call('dcsc_rack_add', { session: workspace, rackCode: '7D6DCTO1WW' });
    stage = 'storage-definition';
    const catalog = await call('dcsc_network_get', { session: workspace, collection: 'storageControllers',
      limit: 100, fields: ['option', 'featureCode'] });
    const choice = rows(catalog.items).find(item => item.option === '7DJ0CTO1WW' && !item.featureCode);
    assert(choice?.id, 'Current catalog has no captured DM3200F controller choice.');
    await call('dcsc_storage_set', { session: workspace, change: { action: 'add', name: 'Live Storage', controllerId: choice.id, expansionQuantity: 0, switchId: 'direct-attached' } });
    stage = 'controller-open';
    const opened = await call('dcsc_storage_set', { session: workspace, change: { action: 'customize', component: 'controller', name: 'Live Storage' } });
    assert.equal(opened.created, true);
    const controllerId = String(opened.controllerId);
    const first = await snapshot();
    const configs = rows(first.configurations);
    assert.equal(configs.length, 3);
    assert(configs.some(item => item.configurationId === controllerId && object(item.raw).type === 'storage'));
    assert(!JSON.stringify([first.rackArea, first.nonRackArea]).includes(controllerId), 'Controller was synthesized as a physical item.');
    const definitions = rows(object(first.serverState).storageConnectionNetworks);
    assert.equal(object(definitions[0]?.controller).id, controllerId);
    stage = 'controller-reopen';
    const reopened = await call('dcsc_storage_set', { session: workspace, expectedRevision: opened.revision, change: { action: 'customize', component: 'controller', name: 'Live Storage' } });
    assert.equal(reopened.created, false);
    assert.equal(reopened.configuration, opened.configuration);
    assert.equal(reopened.revision, opened.revision);
    stage = 'controller-edit';
    const controllerOptions = await call('dcsc_configuration_get', { view: 'options', session: opened.configuration, query: 'AV1W', limit: 10 });
    const controllerCable = rows(controllerOptions.options).find(option => option.code === 'AV1W');
    assert(controllerCable?.sectionId, 'Current controller catalog has no captured AV1W cable option.');
    await call('dcsc_configure', { session: opened.configuration,
      changes: [{ section: controllerCable.sectionId, code: 'AV1W', quantity: 4 }] });
    const afterEdit = await snapshot();
    const editedRaw = object(rows(afterEdit.configurations).find(item => item.configurationId === controllerId)?.raw);
    const cableSelections = rows(editedRaw.tabs).flatMap(tab => rows(tab.subTabs))
      .flatMap(tab => rows(tab.sections)).filter(section => section.name === 'DAC_SFP28_CABLE')
      .flatMap(section => rows(section.results)).filter(result => result.code === 'AV1W');
    assert.equal(cableSelections.length, 1);
    assert.equal(cableSelections[0]!.quantity, 4);
    assert(!JSON.stringify([afterEdit.rackArea, afterEdit.nonRackArea]).includes(controllerId));
    stage = 'assignment';
    await call('dcsc_storage_set', { session: workspace, change: { action: 'assign', networkName: 'Live Storage' } }, true);
    const assigned = await call('dcsc_storage_set', { session: server, change: { action: 'assign', networkName: 'Live Storage', autoConnect: false } });
    assert.equal(assigned.selectedStorageNetwork, 'Live Storage');
    assert.equal(assigned.autoConnectRequired, true);
    const beforeKill = await snapshot();
    const savedServer = rows(beforeKill.configurations).find(item => item.id === server);
    assert.equal(object(savedServer?.raw).selectedStorageNetwork, 'Live Storage');
    stage = 'sigkill-restart';
    const pid = transport!.pid;
    assert(pid);
    process.kill(pid, 'SIGKILL');
    await client!.close();
    client = undefined;
    await start();
    const restored = await call('dcsc_storage_set', { session: workspace, change: { action: 'customize', component: 'controller', name: 'Live Storage' } });
    assert.equal(restored.created, false);
    assert.equal(restored.configuration, opened.configuration);
    assert.equal(restored.controllerId, controllerId);
    assert.equal(restored.revision, assigned.revision);
    const afterRestart = await snapshot();
    assert.deepEqual(afterRestart, beforeKill);
    stage = 'clear-assignment';
    const cleared = await call('dcsc_storage_set', { session: server, change: { action: 'assign', networkName: null, autoConnect: false } });
    assert.equal(cleared.selectedStorageNetwork, '');
    stage = 'managed-commercial-groups';
    const commercial = await snapshot();
    const groupInput = { serverState: object(commercial.serverState), rackArea: rows(commercial.rackArea),
      nonRackArea: rows(commercial.nonRackArea), configurations: new Map(rows(commercial.configurations).map(item => [String(item.id), {
        configurationId: String(item.configurationId), raw: object(item.raw) as RawConfiguration,
        product: { code: String(object(item.product).code) }, mode: 'cto' as const,
      }])) };
    const fields = (product: Obj) => Object.fromEntries(['code', 'type', 'quantity', 'price', 'unitPrice'].map(key => [key, product[key]]));
    const actualGroups = buildExportGroups(groupInput)[0]!.products.filter(item => item.id === controllerId).map(fields);
    const fixture = JSON.parse(await readFile('test/fixtures/parity/storage-controller-customization.json', 'utf8'));
    const expectedGroups = fixture.configuredControllerLifecycle.configuredExport.groupProducts.map(fields);
    await writeFile(path.join(out, 'managed-groups-comparison.json'), JSON.stringify({ actualGroups, expectedGroups }, null, 2));
    assert.deepEqual(actualGroups, expectedGroups, 'Controller commercial groups differ from the contemporaneous browser capture.');
    const info = await call('dcsc_workspace_get', { session: workspace });
    const expectedTotal = rows(commercial.configurations).filter(item => item.configurationId !== controllerId)
      .reduce((total, item) => total + Number(object(item.raw).totalPrice) * Number(object(item.raw).quantity ?? 1), 0);
    assert.equal(info.totalPrice, Math.round(expectedTotal * 100) / 100, 'Workspace total charged an unplaced controller template.');
    stage = 'export';
    const exported = await call('dcsc_export', { kind: 'reports', session: workspace, fileName: 'managed-controller', fileTypes: ['XML', 'QUOTE'] });
    assert.equal(typeof exported.xml, 'string');
    assert((await readFile(String(exported.xml))).length > 0);
    stage = 'remove-controller';
    await call('dcsc_session_close', { session: opened.configuration }, true);
    const removed = await call('dcsc_storage_set', { session: workspace, change: { action: 'remove', name: 'Live Storage' } });
    assert.equal(removed.removedConfigurations, 1);
    const afterRemoval = await snapshot();
    assert.equal(rows(afterRemoval.configurations).length, 2);
    assert.equal(rows(object(afterRemoval.serverState).storageConnectionNetworks).length, 0);
    stage = 'removed-controller-restart';
    assert(transport!.pid);
    process.kill(transport!.pid!, 'SIGKILL');
    await client!.close();
    client = undefined;
    await start();
    await call('dcsc_storage_set', { session: workspace, change: { action: 'customize', component: 'controller', name: 'Live Storage' } }, true);
    assert.deepEqual(await snapshot(), afterRemoval);
    stage = 'selected-base-controller';
    const baseController = rows(catalog.items).find(item => item.option === '7D4FCTO6WW' && item.featureCode === 'BCBN');
    assert(baseController?.id, 'Current catalog has no captured BCBN controller choice.');
    await call('dcsc_storage_set', { session: workspace, change: { action: 'add', name: 'Selected Base', controllerId: baseController.id, expansionQuantity: 0, switchId: 'direct-attached' } });
    const selectedBase = await call('dcsc_storage_set', { session: workspace, change: { action: 'customize', component: 'controller', name: 'Selected Base' } });
    const withBase = await snapshot();
    const baseRaw = object(rows(withBase.configurations).find(item => item.configurationId === selectedBase.controllerId)?.raw);
    assert(rows(baseRaw.unSelectableCharacters).flatMap(section => rows(section.results))
      .some(result => result.code === 'BCBN' && Number(result.quantity) > 0), 'BCBN was available but not selected.');
    assert(!JSON.stringify([withBase.rackArea, withBase.nonRackArea]).includes(String(selectedBase.controllerId)));
    await call('dcsc_storage_set', { session: workspace, change: { action: 'remove', name: 'Selected Base' } });
    stage = 'san-switch-definition';
    const sanController = rows(catalog.items).find(item => item.option === '7DP4CTO1WW');
    assert(sanController?.id, 'Current catalog has no captured DS3200 controller.');
    const sanChoices = await call('dcsc_network_get', { session: workspace, collection: 'storageSwitches',
      limit: 50, fields: ['option', 'featureCode'] });
    const sanChoice = rows(sanChoices.items).find(item => item.option === '7DHNCTO1WW' && item.featureCode === 'C1FM');
    assert(sanChoice?.id, 'Current catalog has no captured DB710S C1FM switch.');
    await call('dcsc_storage_set', { session: workspace, change: { action: 'add', name: 'Live SAN', controllerId: sanController.id, switchId: sanChoice.id, expansionQuantity: 0 } });
    const sanControllerOpened = await call('dcsc_storage_set', { session: workspace, change: { action: 'customize', component: 'controller', name: 'Live SAN' } });
    stage = 'san-switch-open';
    const sanOpened = await call('dcsc_storage_set', { session: workspace, change: { action: 'customize', component: 'switch', name: 'Live SAN' } });
    assert.equal(sanOpened.created, true);
    const sanReopened = await call('dcsc_storage_set', { session: workspace, expectedRevision: sanOpened.revision, change: { action: 'customize', component: 'switch', name: 'Live SAN' } });
    assert.equal(sanReopened.created, false);
    assert.equal(sanReopened.configuration, sanOpened.configuration);
    assert.equal(sanReopened.revision, sanOpened.revision);
    const sanSnapshot = await snapshot();
    const sanIds = [String(sanControllerOpened.controllerId), String(sanOpened.switchId)];
    assert.equal(rows(sanSnapshot.configurations).length, 4);
    for (const id of sanIds) assert(!JSON.stringify([sanSnapshot.rackArea, sanSnapshot.nonRackArea]).includes(id));
    const switchRaw = object(rows(sanSnapshot.configurations).find(item => item.configurationId === sanOpened.switchId)?.raw);
    assert.equal(switchRaw.name, 'Switch');
    assert([...rows(switchRaw.unSelectableCharacters), ...rows(switchRaw.tabs).flatMap(tab => rows(tab.subTabs))
      .flatMap(tab => rows(tab.sections))].flatMap(section => rows(section.results))
      .some(result => result.code === 'C1FM' && Number(result.quantity) > 0));
    assert(!JSON.stringify(object(sanSnapshot.serverState).switchMap ?? []).includes(String(sanOpened.switchId)));
    const sanGroupInput = { serverState: object(sanSnapshot.serverState), rackArea: rows(sanSnapshot.rackArea),
      nonRackArea: rows(sanSnapshot.nonRackArea), configurations: new Map(rows(sanSnapshot.configurations).map(item => [String(item.id), {
        configurationId: String(item.configurationId), raw: object(item.raw) as RawConfiguration,
        product: { code: String(object(item.product).code) }, mode: 'cto' as const,
      }])) };
    const actualSanGroups = buildExportGroups(sanGroupInput)[0]!.products.filter(item => sanIds.includes(String(item.id))).map(fields);
    const expectedSanGroups = fixture.sanSwitchLifecycle.configuredLifecycle.configuredExport.groupProducts.map(fields);
    await writeFile(path.join(out, 'san-groups-comparison.json'), JSON.stringify({ actualSanGroups, expectedSanGroups }, null, 2));
    assert.deepEqual(actualSanGroups, expectedSanGroups, 'SAN template commercial groups differ from browser r37.');
    stage = 'san-switch-crash-restart';
    assert(transport!.pid);
    process.kill(transport!.pid!, 'SIGKILL');
    await client!.close(); client = undefined;
    await start();
    const sanRestored = await call('dcsc_storage_set', { session: workspace, change: { action: 'customize', component: 'switch', name: 'Live SAN' } });
    assert.equal(sanRestored.created, false);
    assert.equal(sanRestored.configuration, sanOpened.configuration);
    assert.deepEqual(await snapshot(), sanSnapshot);
    stage = 'san-switch-export';
    const sanExported = await call('dcsc_export', { kind: 'reports', session: workspace, fileName: 'managed-san-switch', fileTypes: ['XML', 'QUOTE'] });
    assert((await readFile(String(sanExported.xml))).length > 0);
    await call('dcsc_session_close', { session: sanOpened.configuration }, true);
    stage = 'san-switch-remove-history';
    const sanRemoved = await call('dcsc_storage_set', { session: workspace, change: { name: 'Live SAN', action: 'remove' } });
    assert.equal(sanRemoved.removedConfigurations, 2);
    assert.equal(rows((await snapshot()).configurations).length, 2);
    await call('dcsc_undo', { session: workspace, action: 'undo' });
    assert.equal(rows((await snapshot()).configurations).length, 4);
    await call('dcsc_undo', { session: workspace, action: 'redo' });
    assert.equal(rows((await snapshot()).configurations).length, 2);
    await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'pass', scope: 'live-stdio-storage-lifecycle-and-crash-restart',
      browserGraphParity: 'not-tested', browserReimport: 'not-tested', commercialGroups: 'matched-captured-browser',
      selectedBaseController: 'BCBN-verified', sanSwitch: 'DB710S-launch-reopen-commercial-export-crash-history-verified',
      sanExportXml: sanExported.xml, exportXml: exported.xml, workspace, server, controllerId, calls: calls.length }, null, 2));
    console.log(`PASS storage lifecycle, explicit scope, reuse and SIGKILL/restart (${calls.length} MCP calls).`);
  } catch (error) {
    await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'fail', stage,
      error: error instanceof Error ? error.message : String(error), calls: calls.length }, null, 2));
    throw error;
  } finally {
    await client?.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
