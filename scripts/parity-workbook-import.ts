/** Real stdio Excel import, persistence, export and independent browser control. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const rows = (v: unknown): Obj[] => Array.isArray(v) ? v.map(object) : [];
const summary = (configs: Obj[]) => configs.map(c => ({ code: c['code'], quantity: c['quantity'] ?? 1 }))
  .sort((a, b) => String(a.code).localeCompare(String(b.code)));
// Independent control: Lenovo compresses loose clones into one configuration
// and explicitly lists their physical IDs and total count in nonRackArea.
function nativeProducts(body: Obj) {
  const loose = rows(object(body['workspace'])['nonRackArea']);
  return summary(rows(body['configuration']).flatMap(c => {
    const item = loose.find(i => (i['configurationId'] ?? i['id']) === c['id']);
    const ids = item?.['originalIds'];
    if (!Array.isArray(ids) || ids.length < 2) return [c];
    assert.equal(item?.['quantity'], ids.length);
    assert.equal(new Set(ids).size, ids.length);
    assert(ids.includes(c['id']));
    assert.equal(c['quantity'], 1);
    return ids.map(() => c);
  }));
}
const flag = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const out = path.resolve(flag('--out') ?? `artifacts/parity-workbook-import/${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(out, { recursive: true });
const configFile = path.join(out, 'config.json');
const sessionFile = path.join(out, 'sessions.json');
await writeFile(configFile, JSON.stringify({ logLevel: 'error', files: { persistSessions: true,
  sessionFile, artifactDir: path.join(out, 'exports') } }));
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] =>
  e[1] !== undefined && !e[0].startsWith('DCSC_')));
let client: Client | undefined;
let transport: StdioClientTransport;
let stage = 'start';
const calls: Obj[] = [];
async function start() {
  transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp/server.ts'],
    stderr: 'pipe', env: { ...env, DCSC_CONFIG: configFile } });
  client = new Client({ name: 'workbook-import-parity', version: '1.0.0' });
  await client.connect(transport);
}
async function call(name: string, args: Obj): Promise<Obj> {
  const response = await client!.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const text = (response.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '';
  assert(Buffer.byteLength(text) <= 8_000, `${name} exceeded response budget`);
  let result: Obj;
  try { result = object(JSON.parse(text)); } catch { result = { error: text }; }
  calls.push({ name, args, result, bytes: Buffer.byteLength(text) });
  await writeFile(path.join(out, 'calls.json'), JSON.stringify(calls, null, 2));
  assert(!response.isError, `${name}: ${text}`);
  return result;
}
async function saved(id: string) {
  const state = object(JSON.parse(await readFile(sessionFile, 'utf8')));
  const ws = rows(state['workspaces']).find(w => w['id'] === id);
  assert(ws, 'Workspace missing from persisted snapshot');
  return ws;
}
async function browserImport(file: string, label: string): Promise<Obj> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded' });
    const pending = page.waitForResponse(r => r.url().includes('/multiple/cfxml_import') && r.request().method() === 'POST', { timeout: 120_000 });
    await page.locator('input[type=file]').first().setInputFiles(file);
    const response = await pending;
    const raw: unknown = await response.json();
    await writeFile(path.join(out, `${label}-browser.json`), JSON.stringify(raw, null, 2));
    assert.equal(response.status(), 200);
    return object(Array.isArray(raw) ? raw[0] : raw);
  } finally { await browser.close(); }
}

try {
  await start();
  stage = 'seed-and-export';
  const seed = await call('dcsc_import', { filePath: path.resolve(flag('--seed') ?? 'test/fixtures/parity/xml/sr630-v3-qty4.xml'),
    solutionMode: 'General Purpose' });
  const original = await saved(String(seed['session']));
  const exportedProducts = summary(rows(original['configurations']).map(c => object(c['raw'])));
  const exported = await call('dcsc_export', { kind: 'reports', session: seed['session'], fileName: 'workbook-source',
    fileTypes: ['XML', 'QUOTE', 'QUOTE_GROUP', 'SUMMARY', 'POWER_REPORT', 'MESSAGE_HISTORY', 'FLOOR', 'RACK_REPORT', 'RACK_DIAGRAM', 'P2P_REPORT'] });
  const workbook = (exported['workbooks'] as string[])[0];
  assert(workbook, 'Export did not return a workbook');
  stage = 'native-workbook-control';
  const native = await browserImport(workbook, 'workbook');
  const expected = nativeProducts(native);
  assert.deepEqual(expected, exportedProducts);
  stage = 'workbook-import';
  const imported = await call('dcsc_import', { filePath: workbook, solutionMode: 'General Purpose' });
  const id = String(imported['session']);
  const before = await saved(id);
  assert.deepEqual(summary(rows(before['configurations']).map(c => object(c['raw']))), expected);
  assert.equal(rows(before['rackArea']).length, rows(original['rackArea']).length);
  assert.equal(rows(before['nonRackArea']).length, rows(original['nonRackArea']).length);
  stage = 'crash-restart';
  assert(transport!.pid); process.kill(transport!.pid!, 'SIGKILL');
  await client!.close().catch(() => undefined);
  await start();
  await call('dcsc_workspace_get', { session: id });
  const after = await saved(id);
  for (const key of ['configurations', 'rackArea', 'nonRackArea', 'serverState', 'revision']) {
    assert.deepEqual(after[key], before[key], `Restart changed ${key}`);
  }
  stage = 're-export';
  const reexported = await call('dcsc_export', { kind: 'reports', session: id, fileName: 'workbook-roundtrip', fileTypes: ['XML', 'QUOTE', 'RACK_REPORT'] });
  stage = 'browser-controls';
  const nativeXml = await browserImport(String(reexported['xml']), 'reexported-xml');
  assert.deepEqual(nativeProducts(nativeXml), expected);
  assert.equal(rows(object(nativeXml['workspace'])['rackArea']).length, rows(before['rackArea']).length);
  const report = { status: 'pass', calls: calls.length, maxResponseBytes: Math.max(...calls.map(c => Number(c['bytes']))),
    exportedProducts, importedProducts: expected, quantityRoundtripPreserved: JSON.stringify(expected) === JSON.stringify(exportedProducts), crashRestart: true, nativeWorkbookImport: true, nativeXmlHandoff: true,
    scope: 'General Purpose workbook; legacy recovery and populated cabling still require separate verification.' };
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'fail', stage, error: String(error) }, null, 2));
  throw error;
} finally { await client?.close().catch(() => undefined); }
