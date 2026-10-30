/** Native HPC switch Clone Multiple: capacity, linked ownership and exported state. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { selectBrowserSolutionMode } from './lib/browser-solution-mode.js';
import { assertGroupedCommercialParity } from './lib/groupedRackParity.js';
import { assertNativeConnectionsRetained } from '../src/domain/nativeManualCabling.js';
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const rows = (v: unknown): Obj[] => Array.isArray(v) ? v.map(object) : [];
const edit = process.argv.includes('--edit');
const index = process.argv.indexOf('--out');
const out = path.resolve(index >= 0 ? process.argv[index + 1]! : `artifacts/parity-switch-clone/${Date.now()}`);
await mkdir(out, { recursive: true });
const configFile = path.join(out, 'config.json'); const sessionFile = path.join(out, 'sessions.json');
await writeFile(configFile, JSON.stringify({ logLevel: 'error', files: { persistSessions: true,
  sessionFile, artifactDir: path.join(out, 'exports') } }));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
  entry[1] !== undefined && !entry[0].startsWith('DCSC_')));
let client: Client | undefined; let transport: StdioClientTransport; let stage = 'start'; let count = 0;
const start = async () => {
  transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp/server.ts'],
    stderr: 'pipe', env: { ...env, DCSC_CONFIG: configFile } });
  client = new Client({ name: 'switch-clone-parity', version: '1' }); await client.connect(transport);
};
const call = async (name: string, args: Obj) => {
  const response = await client!.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
  const text = (response.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')!.text!;
  const result = object(JSON.parse(text));
  await writeFile(path.join(out, `${++count}-${name}.json`), JSON.stringify({ arguments: args, response }, null, 2));
  assert(!response.isError, text); assert(Buffer.byteLength(text) <= 8000); return result;
};
const snapshot = async (): Promise<Obj> => object(JSON.parse(await readFile(sessionFile, 'utf8')));
const workspace = (snapshot: Obj) => rows(snapshot['workspaces'])[0]!;
const physical = (racks: unknown) => rows(racks).flatMap(r => rows(r['rackItems']).map(i => ({
  rack: r['id'], id: i['id'], code: i['code'], position: i['position'], size: i['size'],
}))).sort((a, b) => String(a.id).localeCompare(String(b.id)));
try {
  await start(); stage = 'import';
  const imported = await call('dcsc_import', { filePath: path.resolve('test/fixtures/parity/xml/manual-cabling-shared-network.xml'),
    solutionMode: 'HPC and AI - Systems' });
  const id = String(imported['workspace']); const before = workspace(await snapshot());
  const target = rows(before['configurations']).find(c => object(c['raw'])['code'] === '7D5FCTOFWW')!;
  assert(target); stage = 'clone';
  const cloned = await call('dcsc_clone_configuration', { session: target['id'], count: 1, placement: 'same-rack',
    expectedRevision: before['revision'] });
  const cloneId = String(rows(cloned['created'])[0]!['configurationId']);
  assert.equal(rows(cloned['placements'])[0]!['position'], 7, 'Native switch clone should use the next free allowed U.');
  const accepted = workspace(await snapshot());
  assert.equal(rows(accepted['configurations']).length, 6);
  assert.deepEqual(object(object(accepted['serverState'])['cloneDependency'])[String(target['configurationId'])], [target['configurationId'], cloneId]);
  const placed = physical(accepted['rackArea']); assert.equal(placed.length, 5);
  stage = 'history';
  await call('dcsc_workspace_history', { session: id, action: 'undo', expectedRevision: accepted['revision'] });
  assert.deepEqual(physical(workspace(await snapshot())['rackArea']), physical(before['rackArea']));
  await call('dcsc_workspace_history', { session: id, action: 'redo', expectedRevision: workspace(await snapshot())['revision'] });
  let persisted = await snapshot(); assert.deepEqual(physical(workspace(persisted)['rackArea']), placed);
  if (edit) {
    stage = 'linked-switch-edit';
    const clone = rows(workspace(persisted)['configurations']).find(c => c['configurationId'] === cloneId)!;
    await call('dcsc_configure', { session: clone['id'], changes: [{ section: 'ETHERNET_CABLE', code: '3791', quantity: 2 }] });
    const assertQuantities = (snapshot: Obj) => {
      for (const configuration of rows(workspace(snapshot)['configurations']).filter(c =>
        [target['configurationId'], cloneId].includes(String(c['configurationId'])))) {
        const selected = rows(object(configuration['raw'])['tabs']).flatMap(t => rows(t['subTabs']))
          .flatMap(t => rows(t['sections'])).filter(s => s['name'] === 'ETHERNET_CABLE')
          .flatMap(s => rows(s['results'])).find(r => r['code'] === '3791');
        assert.equal(selected?.['quantity'], 2, 'Linked switch lost its requested cable quantity.');
      }
    };
    assertQuantities(await snapshot());
    await call('dcsc_add_cabling', { session: id, mode: 'auto', settings: { autoAddSwitch: false, autoAddPDU: false } });
    persisted = await snapshot(); assertQuantities(persisted);
  }
  stage = 'crash-restart'; assert(transport!.pid); process.kill(transport!.pid!, 'SIGKILL'); await client!.close();
  await start(); await call('dcsc_cabling_connections', { session: id });
  assert.deepEqual(await snapshot(), persisted);
  stage = 'export';
  const exported = await call('dcsc_export', { session: id, fileName: 'hpc-switch-clone', fileTypes: ['XML', 'QUOTE'] });
  const xml = String(exported['xml']); assert((await readFile(xml)).length);
  stage = 'browser-import'; const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); const layouts: Obj[] = []; const pending: Promise<void>[] = [];
    page.on('response', response => {
      if (response.url().includes('/ctos/racks/customize?')) pending.push(response.json().then(v => { layouts.push(object(v)); }));
    });
    await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded' });
    await selectBrowserSolutionMode(page, 'AI & HPC – ThinkSystem Hardware', { diagnosticsDir: out });
    const response = page.waitForResponse(r => r.url().includes('/multiple/cfxml_import') && r.request().method() === 'POST', { timeout: 120000 });
    await page.locator('input[type=file]').first().setInputFiles(xml);
    const payload: unknown = await (await response).json(); const native = object(Array.isArray(payload) ? payload[0] : payload);
    assertGroupedCommercialParity(native, workspace(persisted));
    await page.waitForURL(/rack-summary/, { timeout: 120000 }); await page.waitForTimeout(5000);
    await page.waitForLoadState('networkidle', { timeout: 60000 }); await Promise.all(pending);
    assert(layouts.length); const final = layouts.at(-1)!;
    assert.deepEqual(physical(final['rackArea']), physical(workspace(persisted)['rackArea']));
    const graph = rows(object(workspace(persisted)['serverState'])['connections']);
    assert.equal(rows(final['connections']).length, graph.length); assertNativeConnectionsRetained(graph, rows(final['connections']));
    await writeFile(path.join(out, 'native-import.json'), JSON.stringify(native));
    await writeFile(path.join(out, 'native-layouts.json'), JSON.stringify(layouts));
  } finally { await browser.close(); }
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'pass', calls: count, cloneId, edit,
    scope: 'hpc-switch-clone-capacity-history-crash-export-browser', xml }, null, 2));
  console.log(`PASS HPC switch clone, history, crash and browser handoff (${count} calls).`);
} catch (error) {
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'fail', stage, error: String(error) }, null, 2)); throw error;
} finally { await client?.close(); }
