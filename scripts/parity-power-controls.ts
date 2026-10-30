/** Live power controls over MCP: Save, SIGKILL/restart, undo/redo, export/import and browser handoff. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { inspectPowerControls } from '../src/domain/powerControls.js';
import type { RawConfiguration } from '../src/model/types.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];
const values = (page: Obj): Obj => Object.fromEntries(rows(page['items']).map(item => [String(item['key']), item['value']]));

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const out = path.resolve(outIndex >= 0 ? process.argv[outIndex + 1]! :
    `artifacts/parity-power-controls/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(out, { recursive: true });
  const configFile = path.join(out, 'config.json');
  const sessionFile = path.join(out, 'sessions.json');
  await writeFile(configFile, JSON.stringify({ logLevel: 'error', files: {
    persistSessions: true, sessionFile, artifactDir: path.join(out, 'exports'),
  } }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !entry[0].startsWith('DCSC_')));
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  const calls: Obj[] = [];
  let stage = 'start';
  const start = async () => {
    transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/server.ts'], stderr: 'pipe', env: { ...env, DCSC_CONFIG: configFile } });
    client = new Client({ name: 'power-controls-parity', version: '1.0.0' });
    await client.connect(transport);
  };
  const call = async (name: string, args: Obj, expectedError = false) => {
    const response = await client!.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
    const text = (response.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text')?.text ?? '';
    let result: Obj;
    try { result = object(JSON.parse(text)); } catch { result = { error: text }; }
    calls.push({ name, arguments: args, isError: response.isError === true, bytes: Buffer.byteLength(text), result });
    await writeFile(path.join(out, 'calls.json'), JSON.stringify(calls, null, 2));
    assert.equal(response.isError === true, expectedError, `${name}: ${text}`);
    assert(Buffer.byteLength(text) < 8_000, `${name} exceeded response budget`);
    return result;
  };
  try {
    await start();
    stage = 'launch';
    const launched = await call('dcsc_launch', { productCode: '7D73CTO1WW', solutionMode: 'General Purpose' });
    const session = String(launched['session']);
    assert(session && session !== 'undefined');
    const before = await call('dcsc_power_controls', { session });
    assert.equal(values(before)['available'], true);
    const workspace = String(before['workspace']);
    stage = 'set-controls';
    const edited = await call('dcsc_set_power_controls', { session, expectedWorkspaceRevision: before['workspaceRevision'],
      voltage: '230V@AC', loadFactor: 100, powerPolicy: 5 });
    assert.deepEqual(edited['current'], { voltage: '230V@AC', loadFactor: 100, powerPolicy: 5 });
    stage = 'crash-restart';
    const snapshot = JSON.parse(await readFile(sessionFile, 'utf8')) as unknown;
    assert(transport!.pid);
    process.kill(transport!.pid!, 'SIGKILL');
    await client!.close(); client = undefined; transport = undefined;
    await start();
    const restarted = await call('dcsc_power_controls', { session });
    assert.deepEqual(values(restarted)['current'], edited['current']);
    assert.deepEqual(JSON.parse(await readFile(sessionFile, 'utf8')), snapshot);
    stage = 'stale-and-undo';
    await call('dcsc_set_power_controls', { session, expectedWorkspaceRevision: before['workspaceRevision'], loadFactor: 30 }, true);
    await call('dcsc_workspace_history', { session: workspace, action: 'undo', expectedRevision: restarted['workspaceRevision'] });
    assert.deepEqual(values(await call('dcsc_power_controls', { session }))['current'], values(before)['current']);
    await call('dcsc_workspace_history', { session: workspace, action: 'redo' });
    assert.deepEqual(values(await call('dcsc_power_controls', { session }))['current'], edited['current']);
    stage = 'subsequent-derive';
    await call('dcsc_configure', { session, changes: [{ section: 'UEFI_OPERATING_MODES', code: 'BFYE', quantity: 1 }] });
    assert.deepEqual(values(await call('dcsc_power_controls', { session }))['current'], edited['current']);
    stage = 'export';
    const exported = await call('dcsc_export', { session, fileName: 'power-controls', fileTypes: ['XML', 'POWER_REPORT'] });
    const xmlPath = String(exported['xml']);
    const xml = await readFile(xmlPath, 'utf8');
    assert(xml.includes('BK15'), 'Export lost 230V metadata');
    assert.match(String(exported['powerSettingsWarning']), /reset/);
    stage = 'mcp-import';
    const imported = await call('dcsc_import', { filePath: xmlPath });
    const importedSession = String(rows(imported['sessions'])[0]!['id']);
    const expectedReimport = { voltage: '230V@AC', loadFactor: 70, powerPolicy: 5 };
    const importedControls = await call('dcsc_power_controls', { session: importedSession });
    assert.deepEqual(values(importedControls)['current'], expectedReimport,
      'MCP import differs from the captured native CFXML load-factor reset.');
    const reapplied = await call('dcsc_set_power_controls', { session: importedSession,
      expectedWorkspaceRevision: importedControls['workspaceRevision'], loadFactor: 100 });
    assert.deepEqual(reapplied['current'], edited['current']);
    stage = 'browser-import';
    const browser = await chromium.launch({ headless: true });
    try {
      for (const [label, inputXml] of [['mcp', xmlPath], ['native', path.resolve('test/fixtures/parity/xml/power-controls-native.xml')]]) {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const input = page.locator('input[type="file"]').first();
      await input.waitFor({ state: 'attached', timeout: 60_000 });
      const pending = page.waitForResponse(response => response.url().includes('/multiple/cfxml_import') && response.request().method() === 'POST', { timeout: 120_000 });
      await input.setInputFiles(inputXml!);
      const response = await pending;
      assert.equal(response.status(), 200);
      const raw = await response.json() as unknown;
      await writeFile(path.join(out, `${label}-browser-import.json`), JSON.stringify(raw, null, 2));
      const body = object(Array.isArray(raw) ? raw[0] : raw);
      const configurations = rows(body['configuration'] ?? body['configurations']);
      const node = configurations.find(item => item['code'] === '7D73CTO1WW' || item['sliceCtoCode'] === '7D73CTO1WW');
      assert(node, 'Browser import returned no matching server');
      assert.deepEqual(inspectPowerControls(node as RawConfiguration).current, expectedReimport);
      await context.close();
      }
    } finally { await browser.close(); }
    const report = { status: 'pass', calls: calls.length, maxResponseBytes: Math.max(...calls.map(item => Number(item['bytes']))),
      crashRestart: true, undoRedo: true, staleRejected: true, subsequentDeriveRetainsSettings: true,
      voltagePolicyExportImport: true, freshBrowserImport: true, nativeImportControl: true,
      limitations: ['Native and MCP CFXML reset load factor 100 to 70 on import; verified explicit reapplication restores 100.'] };
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'fail', stage, error: String(error) }, null, 2));
    throw error;
  } finally { await client?.close().catch(() => undefined); }
}
await main();
