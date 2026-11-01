/** Managed storage controller and SAN switch lifecycle, commercial groups against the browser capture, and website re-import of the export. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { HPC_MODE, HPC_MODE_LABEL, commercialRows, object, persistedWorkspace, rows, selectedQuantity, text, websiteImport, type Obj } from '../fabric.js';
import type { ParityCase } from '../harness.js';

const SERVER_CODE = '7D73CTOHWW';
const RACK_CODE = '7D6DCTO1WW';
const CAPTURE = path.resolve('test/fixtures/parity/storage-controller-customization.json');
const WEBSITE_EXPORT = path.resolve('test/fixtures/parity/xml/storage-managed-controller.xml');
const CONTROLLER_OPTION = '7DJ0CTO1WW';
const COMMERCIAL_FIELDS = ['code', 'type', 'quantity', 'price', 'unitPrice'];
const pickFields = (product: Obj) => Object.fromEntries(COMMERCIAL_FIELDS.map(key => [key, product[key]]));
const hasNoPhysicalItem = (workspace: Obj, id: string) => !JSON.stringify([workspace['rackArea'], workspace['nonRackArea']]).includes(id);
const configurationById = (workspace: Obj, configurationId: string) =>
  object(rows(workspace['configurations']).find(item => item['configurationId'] === configurationId)?.['raw']);
const allResults = (raw: Obj) => [...rows(raw['unSelectableCharacters']), ...rows(raw['tabs']).flatMap(tab => rows(tab['subTabs'])).flatMap(tab => rows(tab['sections']))]
  .flatMap(section => rows(section['results']));

export default {
  id: 'storage-lifecycle',
  tags: ['storage', 'import', 'export'],
  async run(h) {
    const { mcp, step, compare } = h;
    const capture = object(JSON.parse(await readFile(CAPTURE, 'utf8')));
    const call = (tool: string, args: Obj, expectError = false) => mcp.call(tool, args, { expectError });
    const workspaceState = (id: string) => persistedWorkspace(h, id);
    const storage = (workspace: string, change: Obj, extra: Obj = {}, expectError = false) => call('dcsc_storage_set', { session: workspace, ...extra, change }, expectError);

    const { server, workspace, catalog } = await step('launch-hba-rack', async () => {
      const launched = await call('dcsc_launch', { productCode: SERVER_CODE, mode: 'cto', solutionMode: HPC_MODE });
      const server = String(launched['session']);
      const workspace = String(launched['workspace']);
      const options = await call('dcsc_configuration_get', { view: 'options', session: server, query: 'ATZV', limit: 10 });
      const hba = rows(options['options']).find(option => option['code'] === 'ATZV');
      assert(hba?.['sectionId'], 'Current server catalog has no ATZV HBA target.');
      await call('dcsc_configure', { session: server, changes: [{ section: hba['sectionId'], code: 'ATZV', quantity: 1 }] });
      await call('dcsc_rack_add', { session: workspace, rackCode: RACK_CODE });
      const catalog = await call('dcsc_network_get', { session: workspace, collection: 'storageControllers', limit: 100, fields: ['option', 'featureCode'] });
      return { server, workspace, catalog };
    });

    const opened = await step('controller-open-edit-assign', async () => {
      const choice = rows(catalog['items']).find(item => item['option'] === CONTROLLER_OPTION && !item['featureCode']);
      assert(choice?.['id'], 'Current catalog has no captured DM3200F controller choice.');
      await storage(workspace, { action: 'add', name: 'Live Storage', controllerId: choice['id'], expansionQuantity: 0, switchId: 'direct-attached' });
      const opened = await storage(workspace, { action: 'customize', component: 'controller', name: 'Live Storage' });
      assert.equal(opened['created'], true);
      const controllerId = String(opened['controllerId']);
      const first = workspaceState(workspace);
      assert.equal(rows(first['configurations']).length, 3);
      assert(rows(first['configurations']).some(item => item['configurationId'] === controllerId && object(item['raw'])['type'] === 'storage'));
      assert(hasNoPhysicalItem(first, controllerId), 'Controller was synthesized as a physical item.');
      assert.equal(object(rows(object(first['serverState'])['storageConnectionNetworks'])[0]?.['controller'])['id'], controllerId);
      const reopened = await storage(workspace, { action: 'customize', component: 'controller', name: 'Live Storage' }, { expectedRevision: opened['revision'] });
      assert.equal(reopened['created'], false);
      assert.equal(reopened['configuration'], opened['configuration']);
      assert.equal(reopened['revision'], opened['revision']);
      const controllerOptions = await call('dcsc_configuration_get', { view: 'options', session: opened['configuration'], query: 'AV1W', limit: 10 });
      const cable = rows(controllerOptions['options']).find(option => option['code'] === 'AV1W');
      assert(cable?.['sectionId'], 'Current controller catalog has no captured AV1W cable option.');
      await call('dcsc_configure', { session: opened['configuration'], changes: [{ section: cable['sectionId'], code: 'AV1W', quantity: 4 }] });
      const edited = workspaceState(workspace);
      assert.equal(selectedQuantity(configurationById(edited, controllerId), 'DAC_SFP28_CABLE', 'AV1W'), 4);
      assert(hasNoPhysicalItem(edited, controllerId));
      await storage(workspace, { action: 'assign', networkName: 'Live Storage' }, {}, true);
      const assigned = await storage(server, { action: 'assign', networkName: 'Live Storage', autoConnect: false });
      assert.equal(assigned['selectedStorageNetwork'], 'Live Storage');
      assert.equal(assigned['autoConnectRequired'], true);
      assert.equal(object(rows(workspaceState(workspace)['configurations']).find(item => item['id'] === server)?.['raw'])['selectedStorageNetwork'], 'Live Storage');
      return { opened, controllerId, assigned };
    });

    await step('sigkill-restart', async () => {
      const beforeKill = mcp.persistedWorkspaces();
      await mcp.killAndRestart();
      const restored = await storage(workspace, { action: 'customize', component: 'controller', name: 'Live Storage' });
      assert.equal(restored['created'], false);
      assert.equal(restored['configuration'], opened.opened['configuration']);
      assert.equal(restored['revision'], opened.assigned['revision']);
      compare('restart-retains-storage-state', beforeKill, mcp.persistedWorkspaces());
      const cleared = await storage(server, { action: 'assign', networkName: null, autoConnect: false });
      assert.equal(cleared['selectedStorageNetwork'], '');
    });

    const exportXml = await step('commercial-groups-and-export', async () => {
      const commercial = workspaceState(workspace);
      const actual = commercialRows(commercial, [opened.controllerId]).map(pickFields);
      const expected = rows(object(object(capture['configuredControllerLifecycle'])['configuredExport'])['groupProducts']).map(pickFields);
      compare('controller-commercial-groups-vs-browser-capture', expected, actual);
      const info = await call('dcsc_workspace_get', { session: workspace });
      const expectedTotal = rows(commercial['configurations']).filter(item => item['configurationId'] !== opened.controllerId)
        .reduce((total, item) => total + Number(object(item['raw'])['totalPrice']) * Number(object(item['raw'])['quantity'] ?? 1), 0);
      compare('workspace-total-excludes-unplaced-controller', Math.round(expectedTotal * 100) / 100, info['totalPrice']);
      const exported = await call('dcsc_export', { kind: 'reports', session: workspace, fileName: 'managed-controller', fileTypes: ['XML', 'QUOTE'] });
      assert((await readFile(String(exported['xml']))).length > 0);
      return String(exported['xml']);
    });

    await step('website-reimport-differential', async () => {
      const normalizeDefinition = (definition: Obj) => ({ maximumExpansions: definition['maximumExpansions'], type: definition['type'],
        layout: definition['layout'], controller: object(definition['controller']), expansion: object(definition['expansion']),
        mainSwitch: object(definition['mainSwitch']) });
      const summarize = async (file: string, label: string) => {
        const imported = await websiteImport(h, file, label, { mode: HPC_MODE_LABEL });
        const networking = object(imported.payload['networkingInformation']);
        const definitions = rows(networking['storageNetworks']);
        const codes = rows(imported.payload['configuration']).map(item => text(item['code'])).filter(Boolean);
        const products = rows(imported.payload['groups']).flatMap(group => rows(group['products']));
        assert.equal(imported.status, 200);
        assert.match(imported.route, /#\/rack-summary\//);
        assert.equal(definitions.length, 1, `${label} lost its storage definition.`);
        assert.equal(text(object(definitions[0]!['controller'])['option']), CONTROLLER_OPTION);
        assert(!codes.includes(CONTROLLER_OPTION), `${label} hydrated the managed controller; update the importer contract.`);
        assert.equal(rows(networking['storageConnectionNetworks']).length, 0, `${label} restored assignment state.`);
        return { codes: codes.sort(), definition: normalizeDefinition(definitions[0]!),
          controllerProducts: products.filter(product => text(product['code']) === CONTROLLER_OPTION).map(product => ({
            ...Object.fromEntries(['code', 'type', 'quantity', 'price', 'unitPrice', 'targetCtoUnitPrice'].map(key => [key, product[key]])),
            prices: rows(product['prices']).map(price => ({ priceTypeId: price['priceTypeId'], price: price['price'], priceNotAvailable: price['priceNotAvailable'] })) })) };
      };
      const website = await summarize(WEBSITE_EXPORT, 'website-own');
      const mcpImport = await summarize(exportXml, 'mcp');
      assert(mcpImport.controllerProducts.some(product => { const row = product as Record<string, unknown>; return row['quantity'] === 0 && row['type'] === 'hardware'; }), 'MCP export lost the zero-quantity controller row.');
      compare('reimport-configurations', website.codes, mcpImport.codes);
      compare('reimport-controller-commercial-rows', website.controllerProducts, mcpImport.controllerProducts);
      compare('reimport-storage-definition', website.definition, mcpImport.definition);
    });

    await step('remove-controller-and-selected-base', async () => {
      await call('dcsc_session_close', { session: opened.opened['configuration'] }, true);
      const removed = await storage(workspace, { action: 'remove', name: 'Live Storage' });
      assert.equal(removed['removedConfigurations'], 1);
      const afterRemoval = mcp.persistedWorkspaces();
      assert.equal(rows(workspaceState(workspace)['configurations']).length, 2);
      assert.equal(rows(object(workspaceState(workspace)['serverState'])['storageConnectionNetworks']).length, 0);
      await mcp.killAndRestart();
      await storage(workspace, { action: 'customize', component: 'controller', name: 'Live Storage' }, {}, true);
      compare('removal-survives-restart', afterRemoval, mcp.persistedWorkspaces());
      const baseController = rows(catalog['items']).find(item => item['option'] === '7D4FCTO6WW' && item['featureCode'] === 'BCBN');
      assert(baseController?.['id'], 'Current catalog has no captured BCBN controller choice.');
      await storage(workspace, { action: 'add', name: 'Selected Base', controllerId: baseController['id'], expansionQuantity: 0, switchId: 'direct-attached' });
      const base = await storage(workspace, { action: 'customize', component: 'controller', name: 'Selected Base' });
      const baseRaw = configurationById(workspaceState(workspace), String(base['controllerId']));
      assert(allResults(baseRaw).some(result => result['code'] === 'BCBN' && Number(result['quantity']) > 0), 'BCBN was available but not selected.');
      assert(hasNoPhysicalItem(workspaceState(workspace), String(base['controllerId'])));
      await storage(workspace, { action: 'remove', name: 'Selected Base' });
    });

    await step('san-switch', async () => {
      const sanController = rows(catalog['items']).find(item => item['option'] === '7DP4CTO1WW');
      assert(sanController?.['id'], 'Current catalog has no captured DS3200 controller.');
      const sanChoices = await call('dcsc_network_get', { session: workspace, collection: 'storageSwitches', limit: 50, fields: ['option', 'featureCode'] });
      const sanChoice = rows(sanChoices['items']).find(item => item['option'] === '7DHNCTO1WW' && item['featureCode'] === 'C1FM');
      assert(sanChoice?.['id'], 'Current catalog has no captured DB710S C1FM switch.');
      await storage(workspace, { action: 'add', name: 'Live SAN', controllerId: sanController['id'], switchId: sanChoice['id'], expansionQuantity: 0 });
      const controller = await storage(workspace, { action: 'customize', component: 'controller', name: 'Live SAN' });
      const sanOpened = await storage(workspace, { action: 'customize', component: 'switch', name: 'Live SAN' });
      assert.equal(sanOpened['created'], true);
      const reopened = await storage(workspace, { action: 'customize', component: 'switch', name: 'Live SAN' }, { expectedRevision: sanOpened['revision'] });
      assert.equal(reopened['created'], false);
      assert.equal(reopened['configuration'], sanOpened['configuration']);
      assert.equal(reopened['revision'], sanOpened['revision']);
      const snapshot = workspaceState(workspace);
      const sanIds = [String(controller['controllerId']), String(sanOpened['switchId'])];
      assert.equal(rows(snapshot['configurations']).length, 4);
      for (const id of sanIds) assert(hasNoPhysicalItem(snapshot, id));
      const switchRaw = configurationById(snapshot, String(sanOpened['switchId']));
      assert.equal(switchRaw['name'], 'Switch');
      assert(allResults(switchRaw).some(result => result['code'] === 'C1FM' && Number(result['quantity']) > 0));
      assert(!JSON.stringify(object(snapshot['serverState'])['switchMap'] ?? []).includes(String(sanOpened['switchId'])));
      const expected = rows(object(object(object(capture['sanSwitchLifecycle'])['configuredLifecycle'])['configuredExport'])['groupProducts']).map(pickFields);
      compare('san-commercial-groups-vs-browser-capture', expected, commercialRows(snapshot, sanIds).map(pickFields));
      const accepted = mcp.persistedWorkspaces();
      await mcp.killAndRestart();
      const restored = await storage(workspace, { action: 'customize', component: 'switch', name: 'Live SAN' });
      assert.equal(restored['created'], false);
      assert.equal(restored['configuration'], sanOpened['configuration']);
      compare('san-restart-retains-state', accepted, mcp.persistedWorkspaces());
      const exported = await call('dcsc_export', { kind: 'reports', session: workspace, fileName: 'managed-san-switch', fileTypes: ['XML', 'QUOTE'] });
      assert((await readFile(String(exported['xml']))).length > 0);
      await call('dcsc_session_close', { session: sanOpened['configuration'] }, true);
      const removed = await storage(workspace, { name: 'Live SAN', action: 'remove' });
      assert.equal(removed['removedConfigurations'], 2);
      assert.equal(rows(workspaceState(workspace)['configurations']).length, 2);
      await call('dcsc_undo', { session: workspace, action: 'undo' });
      assert.equal(rows(workspaceState(workspace)['configurations']).length, 4);
      await call('dcsc_undo', { session: workspace, action: 'redo' });
      assert.equal(rows(workspaceState(workspace)['configurations']).length, 2);
    });
  },
} satisfies ParityCase;
