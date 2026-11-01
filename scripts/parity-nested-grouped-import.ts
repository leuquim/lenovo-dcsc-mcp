/** Native reference catalog/customize, real stdio persistence and browser export handoff. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { selectBrowserSolutionMode } from './parity/browser.js';
import { assertGroupedCommercialParity } from './lib/groupedRackParity.js';
import { assertNativeFloorHandoff } from './lib/xconfigParity.js';

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const rows = (v: unknown): Obj[] => Array.isArray(v) ? v.map(object) : [];
const outIndex = process.argv.indexOf('--out');
const out = path.resolve(outIndex < 0 ? `artifacts/parity-nested-grouped-import/${new Date().toISOString().replace(/[:.]/g, '-')}` : process.argv[outIndex + 1]!);
await mkdir(out, { recursive: true });
const configFile = path.join(out, 'config.json');
const sessionFile = path.join(out, 'sessions.json');
await writeFile(configFile, JSON.stringify({ logLevel: 'error', files: { persistSessions: true,
  sessionFile, artifactDir: path.join(out, 'exports') } }));
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith('DCSC_')));
const copyMode = process.argv.includes('--copy');
const memberCopyMode = process.argv.includes('--member-copy');
const linkedCopyMode = process.argv.includes('--linked-copy') || memberCopyMode;
assert(!(copyMode && linkedCopyMode), 'Choose one Copy scenario.');
const parentEdit = process.argv.includes('--parent-edit');
assert(!(copyMode && parentEdit), 'Parent linked edit requires a linked group, not an independent copy.');
const seed = path.resolve(copyMode ? 'test/fixtures/parity/xml/nested-copied-native.xml' : 'test/fixtures/parity/xml/nested-grouped-native.xml');
let client: Client | undefined;
let transport: StdioClientTransport;
let stage = 'start';
const calls: Obj[] = [];
async function start() {
  transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp/server.ts'], stderr: 'pipe', env: { ...env, DCSC_CONFIG: configFile } });
  client = new Client({ name: 'reference-solutions-parity', version: '1.0.0' });
  await client.connect(transport);
}
async function call(name: string, args: Obj, expectedError = false): Promise<Obj> {
  const response = await client!.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const text = (response.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '';
  let result: Obj;
  try { result = object(JSON.parse(text)); } catch { result = { error: text }; }
  calls.push({ name, args, result, isError: response.isError === true, bytes: Buffer.byteLength(text) });
  await writeFile(path.join(out, 'calls.json'), JSON.stringify(calls, null, 2));
  assert.equal(response.isError === true, expectedError, `${name}: ${text}`);
  assert(Buffer.byteLength(text) <= 8_000, `${name} exceeded response budget`);
  return result;
}
async function saved(id: string) {
  const state = object(JSON.parse(await readFile(sessionFile, 'utf8')));
  const ws = rows(state['workspaces']).find(w => w['id'] === id);
  assert(ws); return ws;
}
const physical = (racks: Obj[]) => racks.flatMap(r => rows(r['rackItems']).map(c => ({
  rack: r['code'], code: c['code'], position: c['position'], size: c['size'],
  nodes: rows(c['nodes']).map(n => ({ code: n['code'], occupiedBay: n['occupiedBay'] }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
}))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
async function nativeImport(file: string, label: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const layouts: Obj[] = []; const captures: Promise<void>[] = [];
    page.on('response', response => {
      if (!/\/ctos\/racks\/customize\?/.test(response.url())) return;
      captures.push((async () => { layouts.push(object(await response.json())); })());
    });
    await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded' });
    await selectBrowserSolutionMode(page, 'AI & HPC – ThinkSystem Hardware', { diagnosticsDir: out });
    const pending = page.waitForResponse(r => r.url().includes('/multiple/cfxml_import') && r.request().method() === 'POST', { timeout: 120_000 });
    await page.locator('input[type=file]').first().setInputFiles(file);
    const response = await pending; assert.equal(response.status(), 200);
    const raw: unknown = await response.json(); const native = object(Array.isArray(raw) ? raw[0] : raw);
    await page.waitForURL(/rack-summary/, { timeout: 120_000 });
    await page.waitForTimeout(5000); await page.waitForLoadState('networkidle', { timeout: 60_000 });
    await Promise.all(captures);
    assert(layouts.length > 0, 'Native import must complete physical customization');
    await writeFile(path.join(out, `${label}.json`), JSON.stringify({ native, layouts }, null, 2));
    return { native, layout: layouts.at(-1)! };
  } finally { await browser.close(); }
}
try {
  await start(); stage = 'native-import';
  const native = await nativeImport(seed, 'native-source');
  stage = 'mcp-import';
  const cloneMode = process.argv.includes('--clone') || copyMode;
  const imported = await call('dcsc_import', { filePath: cloneMode ? path.resolve('test/fixtures/parity/xml/nested-racked-browser.xml') : seed,
    solutionMode: 'HPC and AI - Systems' });
  const id = String(imported['workspace']); let before = await saved(id);
  if (cloneMode) {
    stage = 'mcp-chassis-clone';
    const chassis = rows(before['configurations']).find(c => object(c['raw'])['type'] === 'chassis');
    assert(chassis);
    const result = copyMode
      ? await call('dcsc_copy_rack_item', { session: chassis['id'], expectedRevision: before['revision'] })
      : await call('dcsc_clone_configuration', { session: chassis['id'], count: 1,
        placement: 'same-rack', expectedRevision: before['revision'] });
    assert.equal(result['nestedConfigurationsCreated'], 1);
    if (!copyMode) assert.equal(result['totalConfigurations'], 4);
    before = await saved(id);
    stage = 'clone-history';
    const cloned = before;
    await call('dcsc_workspace_history', { session: id, action: 'undo', expectedRevision: before['revision'] });
    const undone = await saved(id);
    assert.equal(rows(undone['configurations']).length, 4);
    assert.equal(physical(rows(undone['rackArea'])).length, 1);
    await call('dcsc_workspace_history', { session: id, action: 'redo', expectedRevision: undone['revision'] });
    before = await saved(id);
    assert.deepEqual(physical(rows(before['rackArea'])), physical(rows(cloned['rackArea'])));
  }
  assert.equal(rows(before['configurations']).length, 6);
  assertGroupedCommercialParity(native.native, before);
  assert.deepEqual(physical(rows(before['rackArea'])), physical(rows(native.layout['rackArea'])));
  assert.equal(physical(rows(before['rackArea'])).length, 2);
  assert(physical(rows(before['rackArea'])).every(c => c.nodes.length === 1));
  if (linkedCopyMode) {
    stage = memberCopyMode ? 'linked-member-copy' : 'linked-root-copy';
    const original = before;
    const dependency = object(object(before['serverState'])['cloneDependency']);
    let source = rows(before['configurations']).find(c => object(c['raw'])['type'] === 'chassis' &&
      Array.isArray(dependency[String(c['configurationId'])]) && (dependency[String(c['configurationId'])] as unknown[]).length === 2);
    assert(source, 'Missing linked chassis root');
    if (memberCopyMode) {
      const memberId = (dependency[String(source['configurationId'])] as unknown[])[1];
      source = rows(before['configurations']).find(c => c['configurationId'] === memberId);
      assert(source, 'Missing linked chassis member');
    }
    const copied = await call('dcsc_copy_rack_item', { session: source['id'], expectedRevision: before['revision'] });
    assert.equal(copied['nestedConfigurationsCreated'], 1);
    before = await saved(id);
    assert.equal(rows(before['configurations']).length, 8);
    assert.equal(physical(rows(before['rackArea'])).length, 3);
    for (const [root, members] of Object.entries(dependency)) assert.deepEqual(object(object(before['serverState'])['cloneDependency'])[root], members);
    const copiedState = before;
    await call('dcsc_workspace_history', { session: id, action: 'undo', expectedRevision: before['revision'] });
    const undone = await saved(id);
    assert.deepEqual(physical(rows(undone['rackArea'])), physical(rows(original['rackArea'])));
    assert.deepEqual(object(undone['serverState'])['cloneDependency'], dependency);
    assert.equal(rows(undone['configurations']).length, 6);
    await call('dcsc_workspace_history', { session: id, action: 'redo', expectedRevision: undone['revision'] });
    before = await saved(id);
    assert.deepEqual(physical(rows(before['rackArea'])), physical(rows(copiedState['rackArea'])));
    assert.deepEqual(object(before['serverState'])['cloneDependency'], object(copiedState['serverState'])['cloneDependency']);
  }
  if (copyMode || linkedCopyMode) {
    stage = 'independent-copy-node-edit';
    const configurations = rows(before['configurations']);
    const copiedNode = configurations.find(c => object(c['raw'])['type'] === 'node' && object(c['raw'])['name'] === 'Copy_Copy_Node');
    const originalNode = configurations.find(c => object(c['raw'])['type'] === 'node' && object(c['raw'])['name'] === 'Copy_Node');
    assert(copiedNode && originalNode, 'Native seed must identify source and copied nested nodes');
    const sourceBefore = structuredClone(originalNode['raw']);
    const originalsBefore = configurations.filter(c => c['id'] !== copiedNode['id']).map(c => ({ id: c['id'], raw: structuredClone(c['raw']) }));
    const dependenciesBefore = structuredClone(object(object(before['serverState'])['cloneDependency']));
    const options = await call('dcsc_list_options', { session: copiedNode['id'], query: 'processor', limit: 20 });
    const choice = rows(options['options']).find(option => option['selected'] !== true && option['sectionId'] && option['code']);
    assert(choice, 'No alternative processor for independent copied-node edit');
    await call('dcsc_configure', { session: copiedNode['id'],
      changes: [{ section: choice['sectionId'], code: choice['code'], quantity: 1 }] });
    before = await saved(id);
    const updated = rows(before['configurations']).find(c => c['id'] === copiedNode['id']);
    assert(updated);
    assert.deepEqual(rows(before['configurations']).find(c => c['id'] === originalNode['id'])?.['raw'], sourceBefore,
      'Editing copied node changed original nested node');
    const sections = rows(object(updated['raw'])['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']));
    assert(sections.some(section => rows(section['results']).some(result => result['code'] === choice['code'] && result['quantity'] === 1)),
      'Copied node did not retain the requested processor');
    assert.notDeepEqual(updated['raw'], copiedNode['raw']);
    for (const original of originalsBefore) assert.deepEqual(rows(before['configurations']).find(c => c['id'] === original.id)?.['raw'], original.raw, 'Copied-node edit changed an original configuration');
    const dependencies = object(object(before['serverState'])['cloneDependency']);
    assert.deepEqual(dependencies, dependenciesBefore);
    for (const node of linkedCopyMode ? [copiedNode] : [originalNode, copiedNode]) assert.deepEqual(dependencies[String(node['configurationId'])], [node['configurationId']]);
    await writeFile(path.join(out, 'independent-edit.json'), JSON.stringify({
      source: originalNode['configurationId'], copy: copiedNode['configurationId'], choice,
      sourceUnchanged: true, requestedSelectionAccepted: true, copySingletonGroup: true, originalGroupsPreserved: true,
    }, null, 2));
  }
  if (parentEdit) {
    stage = 'linked-chassis-parent-edit';
    const members = rows(before['configurations']).filter(c => object(c['raw'])['type'] === 'chassis');
    assert.equal(members.length, 2);
    const dependency = object(object(before['serverState'])['cloneDependency']);
    const group = Object.entries(dependency).find(([, ids]) => Array.isArray(ids) && members.every(c => ids.includes(c['configurationId'])));
    assert(group);
    const target = members.find(c => c['configurationId'] !== group[0]); assert(target);
    const original = before;
    await call('dcsc_configure', { session: target['id'], changes: [{ section: 'POWERSUPPLY', code: 'C2NC', quantity: 2 }] });
    before = await saved(id);
    for (const member of members) {
      const updated = rows(before['configurations']).find(c => c['configurationId'] === member['configurationId']); assert(updated);
      const selected = rows(object(updated['raw'])['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']))
        .filter(s => s['name'] === 'POWERSUPPLY').flatMap(s => rows(s['results']));
      assert(selected.some(r => r['code'] === 'C2NC' && r['quantity'] === 2), 'Linked chassis did not retain selected PSU');
    }
    const children = rows(before['rackArea']).flatMap(r => rows(r['rackItems'])).flatMap(c => rows(c['nodes']))
      .map(n => String(n['configurationId'] ?? n['id']));
    for (const item of rows(original['configurations']).filter(c => object(c['raw'])['type'] !== 'chassis' && !children.includes(String(c['configurationId'])))) {
      assert.deepEqual(rows(before['configurations']).find(c => c['configurationId'] === item['configurationId'])?.['raw'], item['raw']);
    }
    const raws = (state: Obj) => rows(state['configurations']).map(c => ({ id: c['configurationId'], raw: c['raw'] }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const edited = before;
    await call('dcsc_workspace_history', { session: id, action: 'undo', expectedRevision: before['revision'] });
    const undone = await saved(id); assert.deepEqual(raws(undone), raws(original));
    await call('dcsc_workspace_history', { session: id, action: 'redo', expectedRevision: undone['revision'] });
    before = await saved(id); assert.deepEqual(raws(before), raws(edited));
  }
  if (cloneMode && !copyMode && !parentEdit) {
    stage = 'linked-clone-node-edit';
    const configurations = rows(before['configurations']);
    const nodeIds = rows(before['rackArea']).flatMap(r => rows(r['rackItems']))
      .flatMap(c => rows(c['nodes'])).map(n => String(n['configurationId'] ?? n['id']));
    const members = configurations.filter(c => nodeIds.includes(String(c['configurationId'])));
    assert.equal(members.length, 2);
    const groups = object(object(before['serverState'])['cloneDependency']);
    const group = Object.entries(groups).find(([, ids]) => Array.isArray(ids) && members.every(c => ids.includes(c['configurationId'])));
    assert(group, 'Nested clones must share a dependency group');
    const target = members.find(c => c['configurationId'] !== group[0]);
    assert(target, 'Edit must originate from the cloned member');
    const options = await call('dcsc_list_options', { session: target['id'], query: 'processor', limit: 20 });
    const choice = rows(options['options']).find(option => option['selected'] !== true && option['sectionId'] && option['code']);
    assert(choice, 'No alternative processor for linked-node edit');
    const beforeLinkedEdit = before;
    await call('dcsc_configure', { session: target['id'], changes: [{ section: choice['sectionId'], code: choice['code'], quantity: 1 }] });
    before = await saved(id);
    for (const member of members) {
      const updated = rows(before['configurations']).find(c => c['id'] === member['id']);
      assert(updated);
      const sections = rows(object(updated['raw'])['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']));
      assert(sections.some(section => rows(section['results']).some(result => result['code'] === choice['code'] && result['quantity'] === 1)),
        'Linked node did not retain requested processor');
    }
    for (const untouched of configurations.filter(c => !nodeIds.includes(String(c['configurationId'])) && object(c['raw'])['type'] !== 'chassis')) {
      assert.deepEqual(rows(before['configurations']).find(c => c['id'] === untouched['id'])?.['raw'], untouched['raw'],
        'Linked node edit changed an unrelated configuration');
    }
    assert.deepEqual(object(object(before['serverState'])['cloneDependency'])[group[0]], group[1]);
    await writeFile(path.join(out, 'linked-edit.json'), JSON.stringify({ target: target['configurationId'],
      group, choice, allMembersUpdated: true, unrelatedUnchanged: true }, null, 2));
    const edited = before;
    const rawConfigurations = (state: Obj) => rows(state['configurations'])
      .map(c => ({ id: c['configurationId'], raw: c['raw'] })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    await call('dcsc_workspace_history', { session: id, action: 'undo', expectedRevision: before['revision'] });
    const undoneEdit = await saved(id);
    assert.deepEqual(rawConfigurations(undoneEdit), rawConfigurations(beforeLinkedEdit), 'Undo must restore nodes and dependent chassis');
    await call('dcsc_workspace_history', { session: id, action: 'redo', expectedRevision: undoneEdit['revision'] });
    before = await saved(id);
    assert.deepEqual(rawConfigurations(before), rawConfigurations(edited), 'Redo must restore the entire linked edit');

  }
  stage = 'restart';
  assert(transport!.pid); process.kill(transport!.pid!, 'SIGKILL');
  await client!.close().catch(() => undefined); await start();
  const info = await call('dcsc_session_info', { session: id });
  assert.equal(info['integrity'], 'verified');
  const after = await saved(id);
  for (const key of ['configurations', 'rackArea', 'nonRackArea', 'serverState', 'revision']) assert.deepEqual(after[key], before[key]);
  stage = 'export';
  const exported = await call('dcsc_export', { session: id, fileName: 'nested-grouped', fileTypes: ['XML', 'QUOTE'] });
  stage = 'browser-reimport';
  const reimport = await nativeImport(String(exported['xml']), 'native-reimport');
  assertNativeFloorHandoff(reimport.native, after);
  assertGroupedCommercialParity(reimport.native, after);
  assert.deepEqual(physical(rows(reimport.layout['rackArea'])), physical(rows(after['rackArea'])));
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'pass', configurations: linkedCopyMode ? 8 : 6, chassis: linkedCopyMode ? 3 : 2, cloneCreation: cloneMode && !copyMode, copyCreation: copyMode || linkedCopyMode, linkedSourceCopy: linkedCopyMode, linkedCopyUndoRedo: linkedCopyMode, cloneUndoRedo: cloneMode,
    linkedMemberCopy: memberCopyMode, nestedNodes: linkedCopyMode ? 3 : 2, independentCopyNodeEdit: copyMode || linkedCopyMode, linkedChassisParentEdit: parentEdit, linkedCloneNodeEdit: cloneMode && !copyMode && !parentEdit, linkedEditUndoRedo: parentEdit || cloneMode && !copyMode, restart: true, freshBrowserExportHandoff: true, calls: calls.length,
    maxBytes: Math.max(...calls.map(c => Number(c['bytes']))) }, null, 2));
} catch (error) {
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'fail', stage, error: String(error) }, null, 2));
  console.error(String(error)); process.exitCode = 1;
} finally { await client?.close().catch(() => undefined); }
