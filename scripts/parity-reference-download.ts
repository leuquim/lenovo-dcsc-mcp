/** Native reference catalog/customize, real stdio persistence and browser export handoff. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

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
const out = path.resolve(outIndex < 0 ? `artifacts/parity-reference-download/${new Date().toISOString().replace(/[:.]/g, '-')}` : process.argv[outIndex + 1]!);
await mkdir(out, { recursive: true });
const configFile = path.join(out, 'config.json');
const sessionFile = path.join(out, 'sessions.json');
await writeFile(configFile, JSON.stringify({ logLevel: 'error', files: { persistSessions: true,
  sessionFile, artifactDir: path.join(out, 'exports') } }));
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith('DCSC_')));
const categoryId = '57d87668ec5695ab80433cf8866bf525';
const crnId = 'SID0000978';
let client: Client | undefined;
let transport: StdioClientTransport;
let stage = 'start';
const calls: Obj[] = [];
async function start() {
  transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp/server.ts'], stderr: 'pipe', env: { ...env, DCSC_CONFIG: configFile } });
  client = new Client({ name: 'reference-download-parity', version: '1.0.0' });
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
  stage = 'mcp-download';
  const artifact = await call('dcsc_download_reference_solution', { crnId, solutionMode: 'General Purpose' });
  const original = await readFile(String(artifact['path']));
  const browser = await chromium.launch({ headless: true });
  let nativeImport: Obj;
  try {
    stage = 'native-download';
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, acceptDownloads: true });
    await page.goto(`https://dcsc.lenovo.com/#/reference-solution/categories/${categoryId}/solutions`, { waitUntil: 'domcontentloaded' });
    const button = page.locator(`#${crnId}`).getByRole('button', { name: 'Export', exact: true });
    await button.waitFor({ timeout: 60_000 });
    const pendingDownload = page.waitForEvent('download', { timeout: 120_000 });
    await button.evaluate(e => (e as HTMLElement).click());
    const download = await pendingDownload;
    const nativePath = path.join(out, 'native-original.xml');
    await download.saveAs(nativePath);
    assert.deepEqual(await readFile(nativePath), original, 'Original download bytes differ from native Export');
    stage = 'native-import';
    const context = await browser.newContext(); const importer = await context.newPage();
    await importer.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded' });
    const pending = importer.waitForResponse(r => r.url().includes('/multiple/cfxml_import') && r.request().method() === 'POST', { timeout: 180_000 });
    await importer.locator('input[type=file]').first().setInputFiles(nativePath);
    const response = await pending; assert.equal(response.status(), 200);
    const raw: unknown = await response.json(); nativeImport = object(Array.isArray(raw) ? raw[0] : raw);
    await writeFile(path.join(out, 'native-import.json'), JSON.stringify(nativeImport, null, 2));
  } finally { await browser.close(); }
  stage = 'mcp-import';
  const imported = await call('dcsc_import', { filePath: artifact['path'] });
  const id = String(imported['workspace']);
  const before = await saved(id);
  assert.deepEqual(summary(rows(before['configurations']).map(c => object(c['raw']))), summary(rows(nativeImport['configuration'])));
  stage = 'restart';
  assert(transport!.pid); process.kill(transport!.pid!, 'SIGKILL');
  await client!.close().catch(() => undefined); await start();
  await call('dcsc_session_info', { session: id });
  const after = await saved(id);
  for (const key of ['configurations', 'rackArea', 'nonRackArea', 'serverState', 'revision']) assert.deepEqual(after[key], before[key]);
  const report = { status: 'pass', crnId, bytes: original.length, nativeDownloadByteParity: true, nativeImportParity: true,
    crashRestart: true, calls: calls.length, maxResponseBytes: Math.max(...calls.map(c => Number(c['bytes']))),
    scope: 'One original General Purpose reference template, downloaded through the native Export button.' };
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'fail', stage, error: String(error) }, null, 2)); throw error;
} finally { await client?.close().catch(() => undefined); }
