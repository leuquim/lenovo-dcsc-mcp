/** Native reference catalog/customize, real stdio persistence and browser export handoff. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { captureUnconfiguredEdit } from './lib/unconfiguredBrowser.js';
import { buildExportGroups } from '../src/domain/exportGroups.js';
import type { RawConfiguration } from '../src/model/types.js';

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
const out = path.resolve(outIndex < 0 ? `artifacts/parity-reference-solutions/${new Date().toISOString().replace(/[:.]/g, '-')}` : process.argv[outIndex + 1]!);
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
  stage = 'catalog';
  let page = await call('dcsc_reference_solutions', { view: 'categories', limit: 15 });
  const categoryTotal = Number(page['total']); let seen = rows(page['entries']).length;
  while (page['next']) {
    page = await call('dcsc_reference_solutions', object(object(page['next'])['arguments']));
    seen += rows(page['entries']).length;
  }
  assert.equal(seen, categoryTotal);
  const listed = await call('dcsc_reference_solutions', { view: 'solutions', categoryId, limit: 1 });
  assert.equal(rows(listed['entries'])[0]?.['crnId'], crnId);
  await call('dcsc_reference_solutions', { view: 'solutions', categoryId,
    offset: 1, expectedCatalogFingerprint: 'stale' }, true);
  await call('dcsc_reference_solutions', { view: 'validation', crnId });
  stage = 'native-customize';
  const browser = await chromium.launch({ headless: true });
  let native: Obj;
  let nativeEditedGroups: Obj[] | undefined;
  try {
    const nativePage = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await nativePage.goto(`https://dcsc.lenovo.com/#/reference-solution/categories/${categoryId}/solutions`, { waitUntil: 'domcontentloaded' });
    const button = nativePage.locator(`#${crnId}`).getByRole('button', { name: 'Customize', exact: true });
    await button.waitFor({ timeout: 60_000 });
    const pending = nativePage.waitForResponse(r => r.url().includes(`/reference_solution/CRNs/${crnId}/customize`), { timeout: 180_000 });
    await button.evaluate(element => (element as HTMLElement).click());
    const response = await pending; assert.equal(response.status(), 200);
    native = object(await response.json());
    await writeFile(path.join(out, 'native-customize.json'), JSON.stringify(native, null, 2));
    await writeFile(path.join(out, 'native-request.json'), JSON.stringify({ url: response.request().url(), method: response.request().method() }));
    if (process.argv.includes('--edit-unconfigured')) {
      stage = 'native-unconfigured-edit';
      const raw = rows(native['configuration'])[0]!;
      const section = rows(raw['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']))
        .find(s => s['name'] === 'UNCONFIGURED_COMMVAULT_SOFTWARE');
      const unit = rows(section?.['features']).find(f => f['code'] === '7S1M004HWW')?.['unitPrice'];
      assert.equal(typeof unit, 'number');
      nativeEditedGroups = await captureUnconfiguredEdit(nativePage, out, Math.round((Number(raw['totalPrice']) - 4 * Number(unit)) * 100) / 100);
    }
  } finally { await browser.close(); }
  let expected = summary(rows(native['configuration']));
  assert(expected.length > 0);
  stage = 'mcp-customize';
  const launched = await call('dcsc_launch_reference_solution', { crnId, solutionMode: 'General Purpose' });
  const id = String(launched['workspace']);
  let before = await saved(id);
  assert.equal(object(before['serverState'])['crnId'], crnId);
  assert.deepEqual(summary(rows(before['configurations']).map(c => object(c['raw']))), expected);
  if (process.argv.includes('--edit-unconfigured')) {
    stage = 'unconfigured-edit';
    const session = String(rows(before['configurations'])[0]!['id']);
    const loaded = await call('dcsc_load_unconfigured', { session, expectedWorkspaceRevision: before['revision'] });
    const changes = [{ section: 'UNCONFIGURED_COMMVAULT_SOFTWARE', code: '7S1M004HWW', quantity: 4 }];
    await call('dcsc_set_unconfigured', { session, changes, expectedWorkspaceRevision: loaded['workspaceRevision'] });
    await call('dcsc_set_unconfigured', { session, changes, expectedWorkspaceRevision: loaded['workspaceRevision'] }, true);
    before = await saved(id);
    const changed = expected[0]!.selections.find(s => s.section === changes[0]!.section && s.code === changes[0]!.code);
    assert(changed); assert.equal(changed.quantity, 8);
    const source = rows(native['configuration'])[0]!;
    const feature = rows(source['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']))
      .find(s => s['name'] === changes[0]!.section);
    const unitPrice = rows(feature?.['features']).find(f => f['code'] === changes[0]!.code)?.['unitPrice'];
    assert.equal(typeof unitPrice, 'number');
    expected = structuredClone(expected);
    expected[0]!.selections.find(s => s.section === changes[0]!.section && s.code === changes[0]!.code)!.quantity = 4;
    expected[0]!.totalPrice = Math.round((Number(expected[0]!.totalPrice) - 4 * Number(unitPrice)) * 100) / 100;
    assert.deepEqual(summary(rows(before['configurations']).map(c => object(c['raw']))), expected);
    assert(nativeEditedGroups);
    const products = (groups: Obj[]) => groups.flatMap(g => rows(g['products']))
      .map(p => ({ code: p['code'], type: p['type'], quantity: p['quantity'], price: p['price'], unitPrice: p['unitPrice'] }));
    const raw = object(rows(before['configurations'])[0]!['raw']) as RawConfiguration;
    assert.deepEqual(products(buildExportGroups(raw, String(raw.id)) as unknown as Obj[]), products(nativeEditedGroups));
  }
  stage = 'crash-restart';
  assert(transport!.pid); process.kill(transport!.pid!, 'SIGKILL');
  await client!.close().catch(() => undefined); await start();
  const diagnostics = object(object(launched['diagnostics'])['inspect']);
  await call(String(diagnostics['tool']), { ...object(diagnostics['arguments']), expectedWorkspaceRevision: before['revision'] });
  const after = await saved(id);
  for (const key of ['configurations', 'rackArea', 'nonRackArea', 'serverState', 'revision']) assert.deepEqual(after[key], before[key]);
  stage = 'export';
  const exported = await call('dcsc_export', { session: id, fileName: crnId, fileTypes: ['XML', 'QUOTE'] });
  stage = 'browser-import';
  const importer = await chromium.launch({ headless: true });
  try {
    const p = await importer.newPage(); await p.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded' });
    const pending = p.waitForResponse(r => r.url().includes('/multiple/cfxml_import') && r.request().method() === 'POST', { timeout: 180_000 });
    await p.locator('input[type=file]').first().setInputFiles(String(exported['xml']));
    const response = await pending; assert.equal(response.status(), 200);
    const raw: unknown = await response.json();
    await writeFile(path.join(out, 'browser-reimport.json'), JSON.stringify(raw, null, 2));
    const body = object(Array.isArray(raw) ? raw[0] : raw);
    assert.deepEqual(summary(rows(body['configuration'])), expected);
  } finally { await importer.close(); }
  const report = { status: 'pass', categoryTotal, crnId, calls: calls.length,
    maxResponseBytes: Math.max(...calls.map(c => Number(c['bytes']))), nativeCustomize: true,
    selectionParity: true, crashRestart: true, freshBrowserImport: true,
    unconfiguredEdit: process.argv.includes('--edit-unconfigured'), nativeUnconfiguredUiEdit: !!nativeEditedGroups,
    scope: 'Deployment-Ready catalog and one General Purpose server/software solution; other reference families and original-template download require broader coverage.' };
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'fail', stage, error: String(error) }, null, 2)); throw error;
} finally { await client?.close().catch(() => undefined); }
