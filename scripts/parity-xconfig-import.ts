/** Native reference catalog/customize, real stdio persistence and browser export handoff. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { assertNativeFloorHandoff } from './lib/xconfigParity.js';

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const rows = (v: unknown): Obj[] => Array.isArray(v) ? v.map(object) : [];
function selections(c: Obj) {
  return rows(c['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']))
    .flatMap(s => rows(s['results']).filter(r => Number(r['quantity']) > 0)
      .map(r => ({ section: s['name'] ?? s['characterName'], code: r['code'], quantity: r['quantity'] })))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
const summary = (configs: Obj[]) => configs.map(c => ({ code: c['code'], quantity: c['quantity'] ?? 1,
  totalPrice: c['totalPrice'], selections: selections(c) }))
  .sort((a, b) => String(a.code).localeCompare(String(b.code)));
const outIndex = process.argv.indexOf('--out');
const out = path.resolve(outIndex < 0 ? `artifacts/parity-xconfig-import/${new Date().toISOString().replace(/[:.]/g, '-')}` : process.argv[outIndex + 1]!);
await mkdir(out, { recursive: true });
const configFile = path.join(out, 'config.json');
const sessionFile = path.join(out, 'sessions.json');
await writeFile(configFile, JSON.stringify({ logLevel: 'error', files: { persistSessions: true,
  sessionFile, artifactDir: path.join(out, 'exports') } }));
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith('DCSC_')));
const fixture = path.resolve('test/fixtures/parity/xml/xconfig-native-physical.xml');
let client: Client | undefined;
let transport: StdioClientTransport;
let stage = 'start';
const calls: Obj[] = [];
async function start() {
  transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp/server.ts'], stderr: 'pipe', env: { ...env, DCSC_CONFIG: configFile } });
  client = new Client({ name: 'xconfig-import-parity', version: '1.0.0' });
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
try {
  await start();
  stage = 'native-import';
  const browser = await chromium.launch({ headless: true });
  let native: Obj;
  const nativeDerived: Obj[] = [];
  const nativeLayouts: Obj[] = [];
  const nativeRequests: Obj[] = [];
  const captures: Promise<void>[] = [];
  try {
    const page = await browser.newPage();
    page.on('response', response => {
      if (!/\/ctos\/(autoDerive|racks\/customize)\?/.test(response.url())) return;
      captures.push((async () => {
        const data = object(await response.json());
        if (response.url().includes('/autoDerive?')) nativeDerived.push(...rows(data['configurations']));
        else { nativeLayouts.push(data); nativeRequests.push(object(JSON.parse(response.request().postData() ?? '{}'))); }
      })());
    });
    await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded' });
    const pending = page.waitForResponse(r => r.url().includes('cfxml_import') && r.request().method() === 'POST', { timeout: 120_000 });
    await page.locator('input[type=file]').first().setInputFiles(fixture);
    const response = await pending; assert.equal(response.status(), 200);
    assert.equal(new URL(response.url()).pathname, '/api/cfxml_import');
    const raw: unknown = await response.json(); native = object(Array.isArray(raw) ? raw[0] : raw);
    await writeFile(path.join(out, 'native-import.json'), JSON.stringify(native, null, 2));
    await page.getByText('Upload Successfully', { exact: true }).waitFor({ timeout: 60_000 });
    await page.locator('.ant-modal-close').last().click();
    await page.waitForURL(/rack-summary/, { timeout: 120_000 });
    await page.waitForTimeout(5000);
    await page.waitForFunction(() => !/Grand Total\s*\$0\.00/.test(document.body.innerText) &&
      !document.body.innerText.includes('loading ...'), undefined, { timeout: 120_000 });
    await page.waitForLoadState('networkidle', { timeout: 60_000 });
    await Promise.all(captures);
    assert(nativeDerived.length > 0 && nativeLayouts.length > 0, 'Native import must complete customization and derivation');
    const configurations = rows(native['configuration']).map(c => {
      let updated = c;
      for (const derived of nativeDerived) if (derived['id'] === c['id']) updated = { ...updated, ...derived };
      return updated;
    });
    native = { ...native, configuration: configurations };
    await writeFile(path.join(out, 'native-completed.json'), JSON.stringify({ native, nativeLayouts, nativeRequests }, null, 2));
  } finally { await browser.close(); }
  stage = 'mcp-import';
  const imported = await call('dcsc_import', { filePath: fixture });
  const id = String(imported['session']);
  const before = await saved(id);
  assert.deepEqual(summary(rows(before['configurations']).map(c => object(c['raw']))), summary(rows(native['configuration'])));
  const placement = (racks: Obj[]) => racks.flatMap(r => rows(r['rackItems']).map(i => ({ rack: r['code'], code: i['code'], position: i['position'], size: i['size'] })));
  assert.deepEqual(placement(rows(before['rackArea'])), placement(rows(nativeLayouts.at(-1)!['rackArea'])));
  const nativeCodes = new Map(rows(native['configuration']).map(c => [c['id'], c['code']]));
  const actualCodes = new Map(rows(before['configurations']).map(c => [c['configurationId'], object(c['raw'])['code']]));
  assert.deepEqual(rows(before['floorItems']).map(f => ({ code: actualCodes.get(f['rackId']), x: f['x'], y: f['y'] })),
    rows(nativeRequests.at(-1)!['floorItems']).filter(f => object(f['rackItem'])['id']).map(f => ({
      code: nativeCodes.get(object(f['rackItem'])['id']), x: f['col'], y: f['row'],
    })));
  const diagnostics = object(object(before['serverState'])['lastImportDiagnostics']);
  const warnings = JSON.stringify(diagnostics['warnings']);
  if (!native['networkingInformation'] && !native['connectionData']) assert(warnings.includes('saved cabling'));
  if (!native['floorInformation']) assert(warnings.includes('saved floor'));
  stage = 'restart';
  assert(transport!.pid); process.kill(transport!.pid!, 'SIGKILL');
  await client!.close().catch(() => undefined); await start();
  await call('dcsc_workspace_get', { session: id });
  const after = await saved(id);
  for (const key of ['configurations', 'rackArea', 'nonRackArea', 'serverState', 'revision']) assert.deepEqual(after[key], before[key]);
  stage = 'export-handoff';
  const exported = await call('dcsc_export', { kind: 'reports', session: id, fileName: 'xconfig-migrated', fileTypes: ['XML'] });
  const importerBrowser = await chromium.launch({ headless: true });
  try {
    const page = await importerBrowser.newPage(); await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded' });
    const pending = page.waitForResponse(r => r.url().includes('/multiple/cfxml_import') && r.request().method() === 'POST', { timeout: 180_000 });
    await page.locator('input[type=file]').first().setInputFiles(String(exported['xml']));
    const response = await pending; assert.equal(response.status(), 200);
    const raw: unknown = await response.json(); const body = object(Array.isArray(raw) ? raw[0] : raw);
    await writeFile(path.join(out, 'native-reimport.json'), JSON.stringify(body, null, 2));
    assert.deepEqual(summary(rows(body['configuration'])), summary(rows(after['configurations']).map(c => object(c['raw']))));
    assertNativeFloorHandoff(body, after);
  } finally { await importerBrowser.close(); }
  const report = { status: 'pass', nativeImportParity: true, physicalPreservationWarnings: true, needImportExcel: native['needImportExcel'],
    crashRestart: true, physicalLayoutParity: true, freshBrowserExportHandoff: true, calls: calls.length, maxResponseBytes: Math.max(...calls.map(c => Number(c['bytes']))),
    scope: 'One genuine x-config export with saved floor and power cables. This does not verify cable recovery.' };
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'fail', stage, error: String(error) }, null, 2)); throw error;
} finally { await client?.close().catch(() => undefined); }
