/** Nested chassis workspaces: website-imported native seed against MCP import, clone/copy/edit, restart and browser handoff. */
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page, Response } from 'playwright';

import { groupedCommercial } from '../lib/groupedRackParity.js';
import { nativeFloorLayouts } from '../lib/xconfigParity.js';
import { openBrowserImportHome } from './browser.js';
import type { Harness, Json } from './harness.js';

const NATIVE_MODE = 'AI & HPC – ThinkSystem Hardware';
const MCP_MODE = 'HPC and AI - Systems';
const GROUPED_SEED = path.resolve('test/fixtures/parity/xml/nested-grouped-native.xml');
const COPIED_SEED = path.resolve('test/fixtures/parity/xml/nested-copied-native.xml');
const RACKED_SEED = path.resolve('test/fixtures/parity/xml/nested-racked-browser.xml');
const PERSISTED_KEYS = ['configurations', 'rackArea', 'nonRackArea', 'serverState', 'revision'];
const PSU = { section: 'POWERSUPPLY', code: 'C2NC', quantity: 2 };

export interface NestedVariant {
  /** clone/copy: the MCP starts from the unnested racked seed and creates the nested chassis itself. */
  create?: 'clone' | 'copy';
  linkedCopy?: 'root' | 'member';
  parentEdit?: boolean;
}

const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const byJson = (left: unknown, right: unknown) => JSON.stringify(left).localeCompare(JSON.stringify(right));
const physical = (racks: Json[]) => racks.flatMap(rack => rows(rack['rackItems']).map(item => ({
  rack: rack['code'], code: item['code'], position: item['position'], size: item['size'],
  nodes: rows(item['nodes']).map(node => ({ code: node['code'], occupiedBay: node['occupiedBay'] })).sort(byJson),
}))).sort(byJson);
const sectionsOf = (configuration: Json) => rows(object(configuration['raw'])['tabs']).flatMap(tab => rows(tab['subTabs'])).flatMap(tab => rows(tab['sections']));
const retains = (configuration: Json | undefined, code: unknown, quantity: number) =>
  !!configuration && sectionsOf(configuration).some(section => rows(section['results']).some(result => result['code'] === code && result['quantity'] === quantity));
const rawConfigurations = (state: Json) => rows(state['configurations']).map(entry => ({ id: entry['configurationId'], raw: entry['raw'] }))
  .sort((left, right) => String(left.id).localeCompare(String(right.id)));
const dependencyOf = (state: Json) => object(object(state['serverState'])['cloneDependency']);
const rackedNodeIds = (state: Json) => rows(state['rackArea']).flatMap(rack => rows(rack['rackItems']))
  .flatMap(item => rows(item['nodes'])).map(node => String(node['configurationId'] ?? node['id']));

async function nativeImport(h: Harness, file: string, label: string) {
  const page: Page = await h.web.newPage();
  const layouts: Json[] = [];
  const captures: Promise<void>[] = [];
  page.on('response', (response: Response) => {
    if (!/\/ctos\/racks\/customize\?/.test(response.url())) return;
    captures.push((async () => { layouts.push(object(await response.json())); })());
  });
  await openBrowserImportHome(page, NATIVE_MODE, { diagnosticsDir: h.out });
  const pending = page.waitForResponse(response => response.url().includes('/multiple/cfxml_import') && response.request().method() === 'POST', { timeout: 120_000 });
  await page.locator('input[type=file]').first().setInputFiles(file);
  const response = await pending;
  assert.equal(response.status(), 200, `${label}: native import status`);
  const raw: unknown = await response.json();
  await page.waitForURL(/rack-summary/, { timeout: 120_000 });
  await page.waitForTimeout(5_000);
  await page.waitForLoadState('networkidle', { timeout: 60_000 });
  await Promise.all(captures);
  assert(layouts.length > 0, `${label}: native import must complete physical customization`);
  return { native: object(Array.isArray(raw) ? raw[0] : raw), layout: layouts.at(-1)! };
}

export async function runNestedChassis(h: Harness, variant: NestedVariant): Promise<void> {
  const { mcp, step, compare } = h;
  const copyOrClone = variant.create !== undefined;
  const nestedCount = variant.linkedCopy ? 3 : 2;
  const seed = variant.create === 'copy' ? COPIED_SEED : GROUPED_SEED;
  const native = await step('website-import', () => nativeImport(h, seed, 'native-source'));

  const saved = (id: string) => mcp.persistedWorkspaces().find(entry => entry['id'] === id)!;
  const edit = (session: unknown, args: Json) => mcp.call('dcsc_rack_edit', { session, ...args });
  const undo = (id: string, action: 'undo' | 'redo', revision: unknown) => mcp.call('dcsc_undo', { session: id, action, expectedRevision: revision });

  const { id, state } = await step('mcp', async () => {
    const imported = await mcp.call('dcsc_import', { filePath: copyOrClone ? RACKED_SEED : seed, solutionMode: MCP_MODE });
    const id = String(imported['session']);
    let state = saved(id);
    if (variant.create) {
      const chassis = rows(state['configurations']).find(entry => object(entry['raw'])['type'] === 'chassis')!;
      const created = variant.create === 'copy'
        ? await edit(chassis['id'], { action: 'copy', expectedRevision: state['revision'] })
        : await edit(chassis['id'], { action: 'clone', count: 1, placement: 'same-rack', expectedRevision: state['revision'] });
      compare('create-nested-chassis', { nestedConfigurationsCreated: 1, ...(variant.create === 'clone' ? { totalConfigurations: 4 } : {}) },
        { nestedConfigurationsCreated: created['nestedConfigurationsCreated'], ...(variant.create === 'clone' ? { totalConfigurations: created['totalConfigurations'] } : {}) });
      const created2 = saved(id);
      await undo(id, 'undo', created2['revision']);
      const undone = saved(id);
      compare('create-undo', { configurations: 4, racked: 1 }, { configurations: rows(undone['configurations']).length, racked: physical(rows(undone['rackArea'])).length });
      await undo(id, 'redo', undone['revision']);
      state = saved(id);
      compare('create-redo', physical(rows(created2['rackArea'])), physical(rows(state['rackArea'])));
    }
    return { id, state };
  });

  let current = state;
  const comparePhysical = (name: string, website: { native: Json; layout: Json }, workspace: Json) => {
    const commercial = groupedCommercial(website.native, workspace);
    compare(`${name}-commercial`, commercial.native, commercial.mcp);
    compare(`${name}-physical`, physical(rows(website.layout['rackArea'])), physical(rows(workspace['rackArea'])));
  };
  compare('seed-shape', { configurations: 6, racked: 2, singleNodePerItem: true },
    { configurations: rows(current['configurations']).length, racked: physical(rows(current['rackArea'])).length,
      singleNodePerItem: physical(rows(current['rackArea'])).every(item => item.nodes.length === 1) });
  comparePhysical('seed', native, current);

  if (variant.linkedCopy) {
    await step('linked-copy', async () => {
      const original = current;
      const dependency = dependencyOf(current);
      let source = rows(current['configurations']).find(entry => object(entry['raw'])['type'] === 'chassis' &&
        Array.isArray(dependency[String(entry['configurationId'])]) && (dependency[String(entry['configurationId'])] as unknown[]).length === 2);
      assert(source, 'Missing linked chassis root');
      if (variant.linkedCopy === 'member') {
        const memberId = (dependency[String(source['configurationId'])] as unknown[])[1];
        source = rows(current['configurations']).find(entry => entry['configurationId'] === memberId);
        assert(source, 'Missing linked chassis member');
      }
      const copied = await edit(source['id'], { action: 'copy', expectedRevision: current['revision'] });
      current = saved(id);
      const copiedState = current;
      compare('linked-copy-result', { nestedConfigurationsCreated: 1, configurations: 8, racked: 3, groupsPreserved: true },
        { nestedConfigurationsCreated: copied['nestedConfigurationsCreated'], configurations: rows(current['configurations']).length,
          racked: physical(rows(current['rackArea'])).length,
          groupsPreserved: Object.entries(dependency).every(([root, members]) => JSON.stringify(dependencyOf(current)[root]) === JSON.stringify(members)) });
      await undo(id, 'undo', current['revision']);
      const undone = saved(id);
      compare('linked-copy-undo', { layout: physical(rows(original['rackArea'])), dependency, configurations: 6 },
        { layout: physical(rows(undone['rackArea'])), dependency: dependencyOf(undone), configurations: rows(undone['configurations']).length });
      await undo(id, 'redo', undone['revision']);
      current = saved(id);
      compare('linked-copy-redo', { layout: physical(rows(copiedState['rackArea'])), dependency: dependencyOf(copiedState) },
        { layout: physical(rows(current['rackArea'])), dependency: dependencyOf(current) });
    });
  }

  if (variant.create === 'copy' || variant.linkedCopy) {
    await step('independent-copy-node-edit', async () => {
      const configurations = rows(current['configurations']);
      const copiedNode = configurations.find(entry => object(entry['raw'])['type'] === 'node' && object(entry['raw'])['name'] === 'Copy_Copy_Node');
      const originalNode = configurations.find(entry => object(entry['raw'])['type'] === 'node' && object(entry['raw'])['name'] === 'Copy_Node');
      assert(copiedNode && originalNode, 'Native seed must identify source and copied nested nodes');
      const untouchedBefore = configurations.filter(entry => entry['id'] !== copiedNode['id']).map(entry => ({ id: entry['id'], raw: structuredClone(entry['raw']) }));
      const dependenciesBefore = structuredClone(dependencyOf(current));
      const options = await mcp.call('dcsc_configuration_get', { session: copiedNode['id'], view: 'options', query: 'processor', limit: 20 });
      const choice = rows(options['options']).find(option => option['selected'] !== true && option['sectionId'] && option['code']);
      assert(choice, 'No alternative processor for independent copied-node edit');
      await mcp.call('dcsc_configure', { session: copiedNode['id'], changes: [{ section: choice['sectionId'], code: choice['code'], quantity: 1 }] });
      current = saved(id);
      const after = rows(current['configurations']);
      const singletons = (variant.linkedCopy ? [copiedNode] : [originalNode, copiedNode]).map(node => dependencyOf(current)[String(node['configurationId'])]);
      compare('copied-node-edit-isolated', {
        copyRetainsChoice: true, othersUnchanged: untouchedBefore.map(entry => entry.raw), dependencies: dependenciesBefore,
        singletons: (variant.linkedCopy ? [copiedNode] : [originalNode, copiedNode]).map(node => [node['configurationId']]),
      }, {
        copyRetainsChoice: retains(after.find(entry => entry['id'] === copiedNode['id']), choice['code'], 1),
        othersUnchanged: untouchedBefore.map(entry => after.find(candidate => candidate['id'] === entry.id)?.['raw']),
        dependencies: dependencyOf(current), singletons,
      });
    });
  }

  if (variant.parentEdit) {
    await step('linked-chassis-parent-edit', async () => {
      const members = rows(current['configurations']).filter(entry => object(entry['raw'])['type'] === 'chassis');
      assert.equal(members.length, 2);
      const group = Object.entries(dependencyOf(current)).find(([, ids]) => Array.isArray(ids) && members.every(entry => ids.includes(entry['configurationId'])));
      assert(group, 'Chassis must share a dependency group');
      const target = members.find(entry => entry['configurationId'] !== group[0])!;
      const original = current;
      await mcp.call('dcsc_configure', { session: target['id'], changes: [PSU] });
      current = saved(id);
      const edited = current;
      const children = new Set(rackedNodeIds(current));
      const unrelated = rows(original['configurations']).filter(entry => object(entry['raw'])['type'] !== 'chassis' && !children.has(String(entry['configurationId'])));
      compare('parent-edit-linked', { psuOnEveryChassis: members.map(() => true), unrelated: unrelated.map(entry => entry['raw']) },
        { psuOnEveryChassis: members.map(member => retains(rows(current['configurations']).find(entry => entry['configurationId'] === member['configurationId']), PSU.code, PSU.quantity)),
          unrelated: unrelated.map(entry => rows(current['configurations']).find(candidate => candidate['configurationId'] === entry['configurationId'])?.['raw']) });
      await undo(id, 'undo', current['revision']);
      const undone = saved(id);
      compare('parent-edit-undo', rawConfigurations(original), rawConfigurations(undone));
      await undo(id, 'redo', undone['revision']);
      current = saved(id);
      compare('parent-edit-redo', rawConfigurations(edited), rawConfigurations(current));
    });
  }

  if (variant.create === 'clone') {
    await step('linked-clone-node-edit', async () => {
      const configurations = rows(current['configurations']);
      const nodeIds = rackedNodeIds(current);
      const members = configurations.filter(entry => nodeIds.includes(String(entry['configurationId'])));
      assert.equal(members.length, 2);
      const group = Object.entries(dependencyOf(current)).find(([, ids]) => Array.isArray(ids) && members.every(entry => ids.includes(entry['configurationId'])));
      assert(group, 'Nested clones must share a dependency group');
      const target = members.find(entry => entry['configurationId'] !== group[0])!;
      const options = await mcp.call('dcsc_configuration_get', { session: target['id'], view: 'options', query: 'processor', limit: 20 });
      const choice = rows(options['options']).find(option => option['selected'] !== true && option['sectionId'] && option['code']);
      assert(choice, 'No alternative processor for linked-node edit');
      const beforeEdit = current;
      await mcp.call('dcsc_configure', { session: target['id'], changes: [{ section: choice['sectionId'], code: choice['code'], quantity: 1 }] });
      current = saved(id);
      const edited = current;
      const untouched = configurations.filter(entry => !nodeIds.includes(String(entry['configurationId'])) && object(entry['raw'])['type'] !== 'chassis');
      compare('linked-node-edit', { membersRetain: members.map(() => true), unrelated: untouched.map(entry => entry['raw']), group: group[1] },
        { membersRetain: members.map(member => retains(rows(current['configurations']).find(entry => entry['id'] === member['id']), choice['code'], 1)),
          unrelated: untouched.map(entry => rows(current['configurations']).find(candidate => candidate['id'] === entry['id'])?.['raw']),
          group: dependencyOf(current)[group[0]] });
      await undo(id, 'undo', current['revision']);
      const undone = saved(id);
      compare('linked-node-edit-undo', rawConfigurations(beforeEdit), rawConfigurations(undone));
      await undo(id, 'redo', undone['revision']);
      current = saved(id);
      compare('linked-node-edit-redo', rawConfigurations(edited), rawConfigurations(current));
    });
  }

  await step('restart-export-reimport', async () => {
    await mcp.killAndRestart();
    const info = await mcp.call('dcsc_workspace_get', { session: id });
    const after = saved(id);
    compare('restart', { integrity: 'verified', ...Object.fromEntries(PERSISTED_KEYS.map(key => [key, current[key]])) },
      { integrity: info['integrity'], ...Object.fromEntries(PERSISTED_KEYS.map(key => [key, after[key]])) });
    const exported = await mcp.call('dcsc_export', { kind: 'reports', session: id, fileName: 'nested-grouped', fileTypes: ['XML', 'QUOTE'] });
    const reimport = await nativeImport(h, String(exported['xml']), 'native-reimport');
    const floor = nativeFloorLayouts(reimport.native, after);
    compare('reimport-floor-layout', floor.expected, floor.actual);
    comparePhysical('reimport', reimport, after);
    compare('reimport-nested-chassis', nestedCount, rows(after['configurations']).filter(entry => object(entry['raw'])['type'] === 'chassis').length);
  });
}
