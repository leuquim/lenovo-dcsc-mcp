/** Physical placement of managed storage templates: durability, commercial rows against browser captures, and website re-import of the exports. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readJsonProjection } from '../../lib/read-json-projection.js';
import { HPC_MODE, HPC_MODE_LABEL, commercialRows, object, persistedWorkspace, rows, selectedQuantity, text, websiteImport, type Obj } from '../fabric.js';
import type { ParityCase } from '../harness.js';

const SEED = path.resolve('test/fixtures/parity/xml/storage-managed-controller.xml');
const STORAGE_NAME = 'Physical Placement Gate';
const CONTROLLER_OPTION = '7DP4CTO1WW';
const SWITCH_OPTION = '7DHNCTO1WW';
const MANAGED_CODES = [CONTROLLER_OPTION, SWITCH_OPTION];
const RAIL_TEMPLATE = 'B6Y6';
const RAIL_PHYSICAL = 'B6Y7';
const MOVE_TO_U = 10;
const MOVED_CONTROLLER_PRICE = { price: 425_035.02, unitPrice: 212_517.51 };
const UNPLACED_SWITCH_PRICE = { price: 22_576.02, unitPrice: 11_288.01 };
const PHYSICAL_COPIES = 2;
const COMMERCIAL_FIELDS = ['id', 'code', 'type', 'quantity', 'price', 'unitPrice'];
const aliasesOf = (dependency: Obj, templateId: string): string[] =>
  Array.isArray(dependency[templateId]) ? (dependency[templateId] as unknown[]).filter((id): id is string => typeof id === 'string' && id !== templateId) : [];
const physicalFeature = (item: Obj, section: string, code: string) =>
  rows(item['features']).filter(candidate => candidate['name'] === section).flatMap(candidate => rows(candidate['results'])).find(result => result['code'] === code);

export default {
  id: 'storage-placement',
  tags: ['storage', 'import', 'export'],
  async run(h) {
    const { mcp, step, compare } = h;
    const call = (tool: string, args: Obj) => mcp.call(tool, args);
    const state = (workspace: string) => persistedWorkspace(h, workspace);
    const exportXml = async (workspace: string, fileName: string) => {
      const exported = await call('dcsc_export', { kind: 'reports', session: workspace, fileName, fileTypes: ['XML', 'QUOTE'] });
      assert.equal(typeof exported['xml'], 'string');
      return String(exported['xml']);
    };
    const projectionOf = (stored: Obj): Obj => {
      const server = object(stored['serverState']);
      return { rawRackArea: stored['rackArea'], rawNonRackArea: stored['nonRackArea'], floorItems: stored['floorItems'],
        powerSelections: stored['powerSelections'], storageNetworks: server['storageConnectionNetworks'],
        detachedStorageComponents: server['detachedStorageComponents'] ?? [], cloneDependency: server['cloneDependency'] ?? {},
        cloneDependencyColor: server['cloneDependencyColor'] ?? {} };
    };
    const projectedThroughTools = async (workspace: string): Promise<Obj> => {
      const layout = await call('dcsc_workspace_get', { view: 'layout', session: workspace });
      const args = object(object(object(layout['pages'])['rawRackArea'])['inspect'])['arguments'] as Obj;
      assert.equal(typeof args['expectedRevision'], 'number', 'Layout omitted its revision-bound continuation.');
      const result: Obj = {};
      for (const field of ['rawRackArea', 'rawNonRackArea', 'floorItems', 'powerSelections', 'storageNetworks',
        'detachedStorageComponents', 'cloneDependency', 'cloneDependencyColor']) {
        result[field] = await readJsonProjection((tool, toolArgs) => mcp.call(tool, toolArgs),
          { tool: 'dcsc_workspace_get', arguments: { ...args, path: [field], offset: 0, limit: 50 } }, field.startsWith('cloneDependency') ? 'object' : 'array');
      }
      return result;
    };

    const { workspace, rackId, first, second, cleared } = await step('placement-and-assignment', async () => {
      const imported = await call('dcsc_import', { filePath: SEED, solutionMode: HPC_MODE });
      const workspace = String(imported['session']);
      const layout = await call('dcsc_workspace_get', { view: 'layout', session: workspace, offset: 0, limit: 20 });
      const rack = rows(layout['racks'])[0];
      const rackId = text(rack?.['rackId'] ?? rack?.['id']);
      assert(rackId, 'Seed import returned no rack identity.');
      await call('dcsc_auto_connect', { session: workspace, settings: { autoAddPDU: false, autoAddSwitch: false, p2pCabling: false } });
      const [controllers, switches] = await Promise.all(['storageControllers', 'storageSwitches'].map(collection =>
        call('dcsc_network_get', { session: workspace, collection, limit: 100, fields: ['option', 'featureCode'] })));
      const controller = rows(controllers?.['items']).find(item => item['option'] === CONTROLLER_OPTION && item['featureCode'] === 'BF3C');
      const sanSwitch = rows(switches?.['items']).find(item => item['option'] === SWITCH_OPTION && item['featureCode'] === 'C1FM');
      assert(controller?.['id'], 'Current catalog has no captured DS3200 BF3C controller.');
      assert(sanSwitch?.['id'], 'Current catalog has no captured DB710S C1FM SAN switch.');
      await call('dcsc_storage_set', { session: workspace, change: { action: 'add', name: STORAGE_NAME, controllerId: controller['id'], switchId: sanSwitch['id'], expansionQuantity: 0 } });
      const first = await call('dcsc_storage_set', { session: workspace, change: { action: 'place', name: STORAGE_NAME, rackId } });
      assert.equal(rows(first['placements']).length, PHYSICAL_COPIES);
      assert(rows(first['placements']).every(item => !('raw' in item)), 'Tool leaked raw physical state.');
      const second = await call('dcsc_storage_set', { session: workspace, expectedRevision: first['revision'], change: { action: 'place', name: STORAGE_NAME, rackId } });
      assert.equal(rows(second['placements']).length, PHYSICAL_COPIES);
      assert(rows(second['templates']).every(item => item['created'] === false), 'Repeated placement relaunched a template.');
      const serverSession = String(rows(state(workspace)['configurations']).find(item => object(item['raw'])['type'] === 'server' && object(item['product'])['code'] === '7D73CTOHWW')?.['id'] ?? '');
      assert(serverSession, 'Seed import returned no server configuration handle.');
      const assigned = await call('dcsc_storage_set', { session: serverSession, change: { action: 'assign', networkName: STORAGE_NAME } });
      assert.equal(assigned['selectedStorageNetwork'], STORAGE_NAME);
      const cleared = await call('dcsc_storage_set', { session: serverSession, expectedRevision: assigned['revision'], change: { action: 'assign', networkName: null } });
      assert.equal(cleared['selectedStorageNetwork'], '');
      return { workspace, rackId, first, second, cleared };
    });

    const restart = async (label: string) => {
      const before = mcp.persistedWorkspaces();
      await mcp.killAndRestart();
      compare(`${label}-persisted-state`, before, mcp.persistedWorkspaces());
      compare(`${label}-tool-projection`, projectionOf(before.find(item => item['id'] === workspace)!), await projectedThroughTools(workspace));
    };
    await step('sigkill-restart', () => restart('restart'));

    const template = await step('template-state-and-first-export', async () => {
      const saved = state(workspace);
      const server = object(saved['serverState']);
      const selected = rows(server['storageConnectionNetworks']).find(item => item['name'] === STORAGE_NAME)!;
      const controllerId = String(object(selected['controller'])['id']);
      const switchId = String(object(selected['mainSwitch'])['id']);
      const dependency = object(server['cloneDependency']);
      const colors = object(server['cloneDependencyColor']);
      assert.equal(rows(saved['configurations']).filter(item => [controllerId, switchId].includes(String(item['configurationId']))).length, 2);
      for (const id of [controllerId, switchId]) {
        const group = Array.isArray(dependency[id]) ? dependency[id] as unknown[] : [];
        assert.equal(group.length, PHYSICAL_COPIES + 1);
        compare(`color-dependency-${id}`, group, object(colors[id])['dependBy']);
        for (const name of ['colorRGB', 'darkColorRGB']) for (const channel of ['r', 'g', 'b']) {
          const value = object(object(colors[id])[name])[channel];
          assert(Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 255, `${id} ${name}.${channel} must be an unsigned RGB byte.`);
        }
      }
      const commercial = commercialRows(saved, [controllerId, switchId], COMMERCIAL_FIELDS);
      assert(commercial.some(item => item['id'] === controllerId && item['code'] === CONTROLLER_OPTION && item['quantity'] === PHYSICAL_COPIES));
      assert(commercial.some(item => item['id'] === switchId && item['code'] === SWITCH_OPTION && item['quantity'] === PHYSICAL_COPIES));
      const exported = await exportXml(workspace, 'storage-physical-placement');
      return { controllerId, switchId, dependency, commercial, firstXml: exported, aliases: aliasesOf(dependency, controllerId), switchAliases: aliasesOf(dependency, switchId) };
    });

    await step('move-alias-and-undo', async () => {
      const alias = String(rows(first['placements']).find(item => item['role'] === 'controller')?.['physicalId'] ?? '');
      assert(alias, 'First placement returned no controller physical identity.');
      const moved = await call('dcsc_rack_edit', { action: 'place', session: workspace, rackId, configuration: alias, uPosition: MOVE_TO_U, expectedRevision: cleared['revision'] });
      assert.equal(rows(moved['racks']).flatMap(rack => rows(rack['items'])).find(item => item['id'] === alias)?.['position'], MOVE_TO_U, 'DCSC did not retain the requested move.');
      const afterMove = state(workspace);
      const server = object(afterMove['serverState']);
      const physical = object(object(server['storagePhysicalConfigurations'])[alias]);
      assert.equal(physical['id'], template.controllerId, 'Moved physical state lost its editable template identity.');
      assert(JSON.stringify(physical).includes(RAIL_PHYSICAL), 'Moved DS3200 physical state did not retain the captured rack rail.');
      const templateJson = JSON.stringify(object(rows(afterMove['configurations']).find(item => item['configurationId'] === template.controllerId)?.['raw']));
      assert(templateJson.includes(RAIL_TEMPLATE) && !templateJson.includes(RAIL_PHYSICAL), 'Physical move overwrote the template rail selection.');
      compare('move-keeps-clone-dependency', template.dependency, server['cloneDependency']);
      const movedRow = commercialRows(afterMove, [template.controllerId], COMMERCIAL_FIELDS)
        .find(item => item['code'] === CONTROLLER_OPTION && item['quantity'] === PHYSICAL_COPIES);
      compare('moved-controller-price-vs-browser-capture', MOVED_CONTROLLER_PRICE, { price: movedRow?.['price'], unitPrice: movedRow?.['unitPrice'] });
      await exportXml(workspace, 'storage-physical-alias-moved');
      assert.equal((await call('dcsc_undo', { session: workspace, action: 'undo', expectedRevision: moved['revision'] }))['changed'], true);
    });

    const afterEdits = await step('post-placement-edits', async () => {
      const controllerSession = String(rows(second['templates']).find(item => item['configurationId'] === template.controllerId)?.['session'] ?? '');
      assert(controllerSession, 'Placement did not return the managed controller session handle.');
      const adapter = rows((await call('dcsc_configuration_get', { view: 'options', session: controllerSession, query: 'C4A8', limit: 10 }))['options']).find(option => option['code'] === 'C4A8');
      assert(adapter?.['sectionId'], 'Current DS3200 controller has no configurable C4A8 section.');
      assert.equal((await call('dcsc_configure', { session: controllerSession, changes: [{ section: adapter['sectionId'], code: 'C4A8', quantity: PHYSICAL_COPIES }] }))['applied'], true);
      const edited = state(workspace);
      assert.equal(selectedQuantity(object(rows(edited['configurations']).find(item => item['configurationId'] === template.controllerId)?.['raw']), 'NETWORK_ADAPTER', 'C4A8'), PHYSICAL_COPIES);
      const physicalItems = rows(edited['rackArea']).flatMap(rack => rows(rack['rackItems'])).filter(item => template.aliases.includes(String(item['id'])));
      assert.equal(physicalItems.length, PHYSICAL_COPIES, 'Post-edit rack state lost a controller physical alias.');
      for (const item of physicalItems) {
        const feature = physicalFeature(item, 'NETWORK_ADAPTER', 'C4A8');
        assert.equal(feature?.['quantity'], PHYSICAL_COPIES);
        assert.equal(rows(feature?.['installations']).length, PHYSICAL_COPIES, `Physical controller ${text(item['id'])} lost its C4A8 PCI installations.`);
      }
      await exportXml(workspace, 'storage-post-placement-controller-edited');
      const grouped = await call('dcsc_rack_edit', { session: workspace, action: 'unplace', configuration: template.controllerId, expectedRevision: Number(edited['revision']) });
      assert(template.aliases.every(id => rows(grouped['unplaced']).map(item => String(item['id'])).includes(id)), 'Template unplace did not keep every controller alias as non-rack.');
      assert(template.aliases.every(id => !rows(grouped['racks']).flatMap(rack => rows(rack['items'])).map(item => String(item['id'])).includes(id)), 'Template unplace left an alias in the rack.');
      const groupCommercial = commercialRows(state(workspace), [template.controllerId, template.switchId], COMMERCIAL_FIELDS);
      const afterGroup = groupCommercial.find(item => item['id'] === template.switchId && item['code'] === SWITCH_OPTION && item['quantity'] === PHYSICAL_COPIES);
      compare('unplaced-switch-price-vs-browser-capture', UNPLACED_SWITCH_PRICE, { price: afterGroup?.['price'], unitPrice: afterGroup?.['unitPrice'] });
      await exportXml(workspace, 'storage-physical-group-unplaced');
      const switchSession = String(rows(second['templates']).find(item => item['configurationId'] === template.switchId)?.['session'] ?? '');
      assert(switchSession, 'Placement did not return the managed SAN switch session handle.');
      const license = rows((await call('dcsc_configuration_get', { view: 'options', session: switchSession, query: 'C1FP', limit: 10 }))['options']).find(option => option['code'] === 'C1FP');
      assert(license?.['sectionId'], 'Current DB710S has no configurable C1FP port license.');
      assert.equal((await call('dcsc_configure', { session: switchSession, changes: [{ section: license['sectionId'], code: 'C1FP', quantity: 1 }] }))['applied'], true);
      const switchEdited = state(workspace);
      assert.equal(selectedQuantity(object(rows(switchEdited['configurations']).find(item => item['configurationId'] === template.switchId)?.['raw']), 'SFP_PORT_LICENSE', 'C1FP'), 1);
      const switchItems = rows(switchEdited['rackArea']).flatMap(rack => rows(rack['rackItems'])).filter(item => template.switchAliases.includes(String(item['id'])));
      assert.equal(switchItems.length, PHYSICAL_COPIES, 'SAN option edit lost a physical switch.');
      for (const item of switchItems) assert.equal(physicalFeature(item, 'SFP_PORT_LICENSE', 'C1FP')?.['quantity'], 1, `SAN instance ${text(item['id'])} lost its port license.`);
      const sanXml = await exportXml(workspace, 'storage-post-placement-san-edited');
      assert((await readFile(sanXml, 'utf8')).includes('C1FP'), 'Exported XML lost the accepted SAN port license.');
      return { groupedAliases: template.aliases, controllerAfterGroup: groupCommercial.filter(item => item['id'] === template.controllerId) };
    });

    await step('restart-and-unracked-projection', async () => {
      await restart('restart-after-edits');
      const layout = await call('dcsc_workspace_get', { view: 'layout', session: workspace, offset: 0, limit: 20 });
      const unracked = object(object(object(layout['pages'])['unracked'])['inspect']);
      assert.equal(unracked['tool'], 'dcsc_workspace_get');
      const page = await call(String(unracked['tool']), object(unracked['arguments']));
      const projected = rows(page['items']).map(item => object(item['value'])).map(item => String(item['configurationId'] ?? item['id']));
      assert(afterEdits.groupedAliases.every(id => projected.includes(id)), 'Template-unplace aliases were not visible through dcsc_workspace_get after restart.');
    });

    const detachedXml = await step('replace-san-with-direct-attached', async () => {
      const revision = Number(state(workspace)['revision']);
      const detached = await call('dcsc_storage_set', { session: workspace, expectedRevision: revision,
        change: { action: 'update', name: STORAGE_NAME, changes: { switchId: 'direct-attached' }, autoConnect: true } });
      compare('retained-components', [{ templateId: template.switchId, code: SWITCH_OPTION, type: 'switch', roles: ['mainSwitch'], physicalCount: PHYSICAL_COPIES,
        reason: 'definition-replaced', nativeCommercialDifference: 'website-counts-detached-template' }],
      rows(detached['retainedComponents']).map(item => ({ templateId: item['templateId'], code: item['code'], type: item['type'], roles: item['roles'],
        physicalCount: item['physicalCount'], reason: item['reason'], nativeCommercialDifference: item['nativeCommercialDifference'] })));
      const saved = state(workspace);
      const server = object(saved['serverState']);
      compare('detached-definition-main-switch', { hardwareType: 'switch', option: '', featureCode: '' },
        object(rows(server['storageConnectionNetworks']).find(item => item['name'] === STORAGE_NAME)?.['mainSwitch']));
      compare('detached-components', [{ templateId: template.switchId, code: SWITCH_OPTION, type: 'switch', roles: ['mainSwitch'], physicalIds: template.switchAliases,
        sourceNetworkName: STORAGE_NAME, reason: 'definition-replaced', nativeCommercialDifference: 'website-counts-detached-template' }],
      rows(server['detachedStorageComponents']).map(item => ({ templateId: item['templateId'], code: item['code'], type: item['type'], roles: item['roles'],
        physicalIds: item['physicalIds'], sourceNetworkName: item['sourceNetworkName'], reason: item['reason'], nativeCommercialDifference: item['nativeCommercialDifference'] })));
      const ids = rows(saved['rackArea']).flatMap(rack => rows(rack['rackItems'])).map(item => String(item['id']));
      assert(template.switchAliases.every(id => ids.includes(id)), 'SAN replacement removed a retained physical switch alias.');
      const detachedRows = commercialRows(saved, [template.switchId], COMMERCIAL_FIELDS);
      assert(detachedRows.some(item => item['code'] === SWITCH_OPTION && item['type'] === 'hardware' && item['quantity'] === PHYSICAL_COPIES), 'Detached SAN counted the template in addition to its physical aliases.');
      assert(!detachedRows.some(item => Number(item['quantity']) === PHYSICAL_COPIES + 1), 'Detached SAN reproduced the native template-plus-alias double count.');
      const xml = await exportXml(workspace, 'storage-san-detached-direct-attached');
      await restart('restart-after-san-replacement');
      return { xml, commercial: detachedRows };
    });

    await step('website-reimport', async () => {
      const producer = [
        { xml: template.firstXml, label: 'mcp-first', hardware: template.commercial.filter(item => item['type'] === 'hardware' && MANAGED_CODES.includes(text(item['code']))) },
        { xml: detachedXml.xml, label: 'mcp-detached', hardware: [...afterEdits.controllerAfterGroup.filter(item => item['type'] === 'hardware' && item['code'] === CONTROLLER_OPTION),
          ...detachedXml.commercial.filter(item => item['type'] === 'hardware' && item['code'] === SWITCH_OPTION)] },
      ];
      const identities = [...rows(first['placements']), ...rows(second['placements'])].map(item => text(item['physicalId'])).filter(Boolean).sort();
      assert.equal(new Set(identities).size, 2 * PHYSICAL_COPIES, 'Placements must identify four distinct controller/SAN physical aliases.');
      for (const entry of producer) {
        assert.equal(entry.hardware.length, MANAGED_CODES.length, `${entry.label} must describe both managed hardware rows.`);
        const website = await websiteImport(h, entry.xml, entry.label, { mode: HPC_MODE_LABEL });
        assert.equal(website.status, 200);
        assert.match(website.route, /#\/rack-summary\/rack-cto$/);
        const configurations = rows(website.payload['configuration']);
        for (const code of MANAGED_CODES) assert.equal(configurations.filter(item => item['code'] === code).length, PHYSICAL_COPIES, `${entry.label} must hydrate two ${code} physical configurations.`);
        compare(`${entry.label}-physical-identities`, identities, configurations.filter(item => MANAGED_CODES.includes(text(item['code']))).map(item => text(item['id'])).sort());
        const products = rows(website.payload['groups']).flatMap(group => rows(group['products'])).filter(item => item['type'] === 'hardware');
        for (const code of MANAGED_CODES) {
          const picked = (row: Obj | undefined) => ({ quantity: row?.['quantity'], price: row?.['price'], unitPrice: row?.['unitPrice'] });
          compare(`${entry.label}-${code}-commercial`, picked(entry.hardware.find(item => item['code'] === code)), picked(products.find(item => item['code'] === code)));
        }
        const dependencies = Object.values(object(website.payload['cloneDependencyColor'])).map(value => object(value)['dependBy']).filter(value => Array.isArray(value) && value.length > 1);
        compare(`${entry.label}-dependency-groups`, [PHYSICAL_COPIES, PHYSICAL_COPIES], dependencies.map(value => (value as unknown[]).length));
        const definition = rows(object(website.payload['networkingInformation'])['storageNetworks']).find(item => item['name'] === STORAGE_NAME);
        compare(`${entry.label}-main-switch-option`, entry.label === 'mcp-first' ? SWITCH_OPTION : '', text(object(definition?.['mainSwitch'])['option']));
      }
    });
  },
} satisfies ParityCase;
