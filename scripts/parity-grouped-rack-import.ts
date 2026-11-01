/** Native reference catalog/customize, real stdio persistence and browser export handoff. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { assertGroupedCommercialParity } from './lib/groupedRackParity.js';
import { assertNativeFloorHandoff } from './lib/xconfigParity.js';

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const rows = (v: unknown): Obj[] => Array.isArray(v) ? v.map(object) : [];
const outIndex = process.argv.indexOf('--out');
const out = path.resolve(outIndex < 0 ? `artifacts/parity-grouped-rack-import/${new Date().toISOString().replace(/[:.]/g, '-')}` : process.argv[outIndex + 1]!);
await mkdir(out, { recursive: true });
const configFile = path.join(out, 'config.json');
const sessionFile = path.join(out, 'sessions.json');
await writeFile(configFile, JSON.stringify({ logLevel: 'error', files: { persistSessions: true,
  sessionFile, artifactDir: path.join(out, 'exports') } }));
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith('DCSC_')));
const categoryId = '5dd22135ca5b4482bea9d764089ca99d';
const crnId = 'SID0001325';
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
try {
  await start();
  stage = 'native-customize';
  const browser = await chromium.launch({ headless: true });
  let native: Obj;
  try {
    const page = await browser.newPage();
    const requests: Obj[] = [];
    const captures: Promise<void>[] = [];
    page.on('response', response => {
      if (!/\/ctos\/(autoDerive|racks\/customize)\?/.test(response.url())) return;
      captures.push((async () => { requests.push({ url: response.url(),
        request: JSON.parse(response.request().postData() ?? '{}'), response: await response.json() }); })());
    });
    await page.goto(`https://dcsc.lenovo.com/#/reference-solution/categories/${categoryId}/solutions`, { waitUntil: 'domcontentloaded' });
    const button = page.locator(`#${crnId}`).getByRole('button', { name: 'Customize', exact: true });
    await button.waitFor({ timeout: 60_000 });
    const pending = page.waitForResponse(r => r.url().includes(`/reference_solution/CRNs/${crnId}/customize`), { timeout: 180_000 });
    await button.evaluate(element => (element as HTMLElement).click());
    const response = await pending; assert.equal(response.status(), 200);
    native = object(await response.json());
    await writeFile(path.join(out, 'native-customize.json'), JSON.stringify(native, null, 2));
    await page.waitForURL(/rack-summary/, { timeout: 120_000 });
    await page.waitForTimeout(5000);
    await page.waitForLoadState('networkidle', { timeout: 60_000 });
    await Promise.all(captures);
    await writeFile(path.join(out, 'native-completed.json'), JSON.stringify({ requests, text: await page.locator('body').innerText() }, null, 2));
  } finally { await browser.close(); }
  const codes = new Map(rows(native['configuration']).map(c => [c['id'], c['code']]));
  const expected = rows(object(native['floorInformation'])['floorGrid']).filter(f => f['type'] === 'rack')
    .flatMap(r => rows(r['items']).map(i => ({ rack: codes.get(r['id']), code: i['code'], position: i['position'], size: i['size'] })));
  assert.equal(expected.length, 29);
  stage = 'mcp-launch';
  const launched = await call('dcsc_launch', { mode: 'reference-solution', sid: crnId, solutionMode: 'General Purpose' });
  const id = String(launched['session']);
  const before = await saved(id);
  const actual = rows(before['rackArea']).flatMap(r => rows(r['rackItems']).map(i => ({ rack: r['code'], code: i['code'], position: i['position'], size: i['size'] })));
  const sorted = (list: Obj[]) => list.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(sorted(actual), sorted(expected));
  assert.equal(rows(before['configurations']).length, 31);
  assert.equal(rows(before['nonRackArea']).length, 1);
  assertGroupedCommercialParity(native, before);
  stage = 'restart';
  assert(transport!.pid); process.kill(transport!.pid!, 'SIGKILL');
  await client!.close().catch(() => undefined); await start();
  const info = await call('dcsc_workspace_get', { session: id });
  assert.notEqual(info['integrity'], 'damaged', 'Restored workspace must remain exportable');
  const after = await saved(id);
  for (const key of ['configurations', 'rackArea', 'nonRackArea', 'serverState', 'revision']) assert.deepEqual(after[key], before[key]);
  stage = 'export';
  const exported = await call('dcsc_export', { kind: 'reports', session: id, fileName: crnId, fileTypes: ['XML', 'QUOTE'] });
  stage = 'browser-reimport';
  const importer = await chromium.launch({ headless: true });
  try {
    const page = await importer.newPage();
    await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded' });
    const pending = page.waitForResponse(r => r.url().includes('/multiple/cfxml_import') && r.request().method() === 'POST', { timeout: 180_000 });
    await page.locator('input[type=file]').first().setInputFiles(String(exported['xml']));
    const response = await pending; assert.equal(response.status(), 200);
    const raw: unknown = await response.json();
    const body = object(Array.isArray(raw) ? raw[0] : raw);
    await writeFile(path.join(out, 'browser-reimport.json'), JSON.stringify(body, null, 2));
    assertNativeFloorHandoff(body, after);
    assertGroupedCommercialParity(body, after);
  } finally { await importer.close(); }
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'pass', crnId, physicalCount: actual.length,
    configurationCount: 31, restart: true, freshBrowserExportHandoff: true, calls: calls.length, maxBytes: Math.max(...calls.map(c => Number(c['bytes']))) }, null, 2));
} catch (error) {
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'fail', stage, error: String(error) }, null, 2));
  throw error;
} finally { await client?.close().catch(() => undefined); }
