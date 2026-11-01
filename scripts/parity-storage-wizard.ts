/** Storage wizard over stdio: linked option/component edits, recovery and native CFXML handoff. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { storageWizardOption } from '../src/domain/storageWizard.js';
import type { RawConfiguration } from '../src/model/types.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];
const values = (page: Obj): Obj => Object.fromEntries(rows(page['items']).map(item => [String(item['key']), item['value']]));

const selection = (raw: Obj) => {
  const option = object(storageWizardOption(raw as RawConfiguration));
  return { optionId: option['configId'], userSelected: option['userSelected'],
    features: rows(option['storageWizardTargetGroups']).flatMap(g => rows(g['features']))
      .filter(f => Number(f['defaultValue']) > 0).map(f => ({ code: String(f['featureCode']), quantity: Number(f['defaultValue']) }))
      .sort((a, b) => a.code.localeCompare(b.code)) };
};
const sr850 = process.argv.includes('--sr850');
const productCode = sr850 ? '7DJUCTO1WW' : '7DJRCTO1WW';
const referenceId = sr850 ? 'SID0001066' : 'SID0001064';
const targetOption = sr850 ? '13-4' : '4-2';
const configured = { optionId: targetOption, userSelected: true,
  features: [{ code: 'B8NZ', quantity: 1 }, { code: 'C3RT', quantity: 2 },
    ...(sr850 ? [{ code: 'C3RU', quantity: 1 }] : [])] };
const clear = process.argv.includes('--clear');
const raidReverse = process.argv.includes('--raid-reverse');
const raid = process.argv.includes('--raid') || raidReverse;
assert(!(clear && raid), 'Run clear and RAID-mode gates separately');
assert(!(sr850 && (clear || raid)), 'SR850 gate covers mixed backplane option/component edits; run mode gates separately.');
const expected = raid ? { optionId: undefined, userSelected: raidReverse ? false : undefined, features: [] } :
  clear ? { optionId: undefined, userSelected: false, features: [] } : configured;
function assertRaidState(raw: Obj) {
  const subTabs = rows(raw['tabs']).flatMap(t => rows(t['subTabs']));
  const sections = subTabs.flatMap(t => rows(t['sections']));
  assert.deepEqual(rows(sections.find(s => s['name'] === 'RAID_CONFIG')?.['results']).map(r => ({ code: r['code'], quantity: r['quantity'] })),
    [{ code: raidReverse ? '5977' : '5978', quantity: 1 }]);
  for (const tab of subTabs.filter(t => ['Controller and Backplane', 'Controllers', 'Internal Storage', 'RAID Configuration', 'Backplane'].includes(String(t['title'])))) {
    assert.equal(rows(tab['sections']).flatMap(s => rows(s['results'])).filter(r => Number(r['quantity']) > 0).length, 0,
      `RAID switch retained old storage selections in ${tab['title']}`);
  }
}


async function verifyBrowserImport(xmlPath: string, out: string, expected: ReturnType<typeof selection>) {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const [label, inputXml] of [['mcp', xmlPath]]) {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      // Capture the page's own XHR body: large linked imports can outlive Chromium's inspector cache.
      await page.addInitScript(() => {
        const original = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function (...args: Parameters<XMLHttpRequest['send']>) {
          this.addEventListener('load', () => {
            if (!this.responseURL.includes('/multiple/cfxml_import')) return;
            (window as unknown as { storageImportCapture: unknown }).storageImportCapture = {
              status: this.status, raw: typeof this.response === 'string' ? JSON.parse(this.response) : this.response,
            };
          });
          return original.apply(this, args);
        };
      });
      await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const input = page.locator('input[type="file"]').first();
      await input.waitFor({ state: 'attached', timeout: 60_000 });
      await input.setInputFiles(inputXml!);
      await page.waitForFunction('window.storageImportCapture !== undefined', undefined, { timeout: 120_000 });
      const capture = await page.evaluate(() => (window as unknown as { storageImportCapture: { status: number; raw: unknown } }).storageImportCapture);
      assert.equal(capture.status, 200);
      const raw = capture.raw;
      await writeFile(path.join(out, `${label}-browser-import.json`), JSON.stringify(raw, null, 2));
      const body = object(Array.isArray(raw) ? raw[0] : raw);
      const configurations = rows(body['configuration'] ?? body['configurations']);
      const nodes = configurations.filter(item => item['code'] === productCode || item['sliceCtoCode'] === productCode);
      assert(nodes.length > 0, 'Native import omitted the storage-wizard server');
      for (const node of nodes) { assert.deepEqual(selection(node), expected); if (raid) assertRaidState(node); }
      const products = rows(body['groups']).flatMap(g => rows(g['products'])).filter(p => p['code'] === productCode && p['type'] === 'hardware');
      assert.equal(products.reduce((sum, p) => sum + Number(p['quantity']), 0), 4, 'Native import lost linked commercial quantity');
      await context.close();
      }
    } finally { await browser.close(); }
}

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const out = path.resolve(outIndex >= 0 ? process.argv[outIndex + 1]! :
    `artifacts/parity-storage-wizard/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(out, { recursive: true });
  const browserOnlyIndex = process.argv.indexOf('--browser-only');
  if (browserOnlyIndex >= 0) {
    const xmlPath = path.resolve(process.argv[browserOnlyIndex + 1]!);
    await verifyBrowserImport(xmlPath, out, expected);
    const report = { status: 'pass', scope: 'browser-import-only', xmlPath, commercialQuantity: 4 };
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    return;
  }
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
    client = new Client({ name: 'storage-wizard-parity', version: '1.0.0' });
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
    const launched = await call('dcsc_launch', { mode: 'reference-solution', sid: referenceId, solutionMode: 'General Purpose' });
    const workspace = String(launched['session']);
    const saved = async () => {
      const state = object(JSON.parse(await readFile(sessionFile, 'utf8')));
      return rows(state['workspaces']).find(w => w['id'] === workspace)!;
    };
    const initial = await saved();
    const members = rows(initial['configurations']).filter(c => object(c['raw'])['code'] === productCode);
    assert.equal(members.length, 4);
    const roots = Object.keys(object(object(initial['serverState'])['cloneDependency']));
    const configuration = members.find(c => !roots.includes(String(c['configurationId'])))!;
    assert(configuration, 'Fixture must exercise a non-root member');
    const session = String(configuration['id']);
    const current = async () => object(rows((await saved())['configurations']).find(c => c['id'] === session)!['raw']);
    const checkMembers = async (expectedSelection: ReturnType<typeof selection>) => {
      const currentMembers = rows((await saved())['configurations']).map(c => object(c['raw'])).filter(r => r['code'] === productCode);
      assert.equal(currentMembers.length, 4);
      for (const raw of currentMembers) {
        assert.deepEqual(selection(raw), expectedSelection);
        if (raid && expectedSelection === expected) assertRaidState(raw);
      }
    };
    const before = await call('dcsc_wizard_get', { wizard: 'storage', session });
    assert.equal(values(before)['available'], true);
    await call('dcsc_wizard_get', { wizard: 'storage', session, expectedRevision: before['revision'], path: ['options'] });
    stage = 'select-option';
    const option = await call('dcsc_wizard_set', { wizard: 'storage', session, expectedRevision: before['revision'], optionId: targetOption });
    assert.equal(option['affectedConfigurationCount'], 4);
    const optionSelection = { optionId: targetOption, userSelected: true,
      features: [{ code: 'BM50', quantity: 1 }, { code: 'C3RT', quantity: 2 },
        ...(sr850 ? [{ code: 'C3RU', quantity: 1 }] : [])] };
    await checkMembers(optionSelection);
    stage = 'crash-restart';
    const snapshot = JSON.parse(await readFile(sessionFile, 'utf8')) as unknown;
    assert(transport!.pid); process.kill(transport!.pid!, 'SIGKILL');
    await client!.close(); client = undefined; transport = undefined; await start();
    const restarted = await call('dcsc_wizard_get', { wizard: 'storage', session });
    assert.deepEqual(JSON.parse(await readFile(sessionFile, 'utf8')), snapshot);
    await checkMembers(optionSelection);
    stage = 'stale-and-history';
    await call('dcsc_wizard_set', { wizard: 'storage', session, expectedRevision: before['revision'], optionId: targetOption }, true);
    await call('dcsc_undo', { session: workspace, action: 'undo', expectedRevision: restarted['revision'] });
    assert.deepEqual(selection(await current()), selection(object(configuration['raw'])));
    await call('dcsc_undo', { session: workspace, action: 'redo' });
    await checkMembers(optionSelection);
    stage = 'controller-edit';
    const added = await call('dcsc_wizard_set', { wizard: 'storage', session, expectedRevision: (await saved())['revision'],
      optionId: targetOption, feature: { groupIndex: 1, code: 'B8NZ', quantity: 1 } });
    assert(Number(added['storageWizardErrorCount']) > 0, 'Adding a second controller must retain native combination diagnostics');
    const removed = await call('dcsc_wizard_set', { wizard: 'storage', session, expectedRevision: added['revision'],
      optionId: targetOption, feature: { groupIndex: 1, code: 'BM50', quantity: 0 } });
    assert.equal(removed['storageWizardErrorCount'], 0);
    await checkMembers(configured);
    stage = 'component-crash-restart';
    assert(transport!.pid); process.kill(transport!.pid!, 'SIGKILL');
    await client!.close(); client = undefined; transport = undefined; await start();
    await call('dcsc_wizard_get', { wizard: 'storage', session });
    await checkMembers(configured);
    stage = 'subsequent-derive';
    const raw = await current();
    const uefi = rows(raw['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']))
      .find(s => s['name'] === 'UEFI_OPERATING_MODES');
    const selectedUefi = rows(uefi?.['results'])[0];
    assert(selectedUefi);
    await call('dcsc_configure', { session, changes: [{ section: 'UEFI_OPERATING_MODES', code: selectedUefi['code'], quantity: 1 }] });
    await checkMembers(configured);
    if (clear) {
      stage = 'clear-drive-guard';
      const beforeRejectedClear = await readFile(sessionFile, 'utf8');
      await call('dcsc_wizard_set', { wizard: 'storage', session, expectedRevision: (await saved())['revision'], optionId: null }, true);
      assert.equal(await readFile(sessionFile, 'utf8'), beforeRejectedClear);
      stage = 'clear-option';
      await call('dcsc_configure', { session, changes: [{ section: 'NONRAID_HDD', code: 'BYLR', quantity: 0 }] });
      await call('dcsc_wizard_set', { wizard: 'storage', session, expectedRevision: (await saved())['revision'], optionId: null });
      await checkMembers(expected);
      await call('dcsc_undo', { session: workspace, action: 'undo' });
      await checkMembers(configured);
      await call('dcsc_undo', { session: workspace, action: 'redo' });
      await checkMembers(expected);
      stage = 'clear-crash-restart';
      assert(transport!.pid); process.kill(transport!.pid!, 'SIGKILL');
      await client!.close(); client = undefined; transport = undefined; await start();
      await call('dcsc_wizard_get', { wizard: 'storage', session });
      await checkMembers(expected);
      await call('dcsc_configure', { session, changes: [{ section: 'UEFI_OPERATING_MODES', code: selectedUefi['code'], quantity: 1 }] });
      await checkMembers(expected);
    }
    if (raid) {
      stage = 'raid-mode-switch';
      await call('dcsc_configure', { session, changes: [{ section: 'RAID_CONFIG', code: '5978', quantity: 1 }] });
      let undoSelection = configured as ReturnType<typeof selection>;
      if (raidReverse) {
        undoSelection = selection(await current());
        assert.equal(undoSelection.optionId, undefined);
        await call('dcsc_configure', { session, changes: [{ section: 'RAID_CONFIG', code: '5977', quantity: 1 }] });
      }
      await checkMembers(expected);
      await call('dcsc_undo', { session: workspace, action: 'undo' });
      await checkMembers(undoSelection);
      await call('dcsc_undo', { session: workspace, action: 'redo' });
      await checkMembers(expected);
      stage = 'raid-crash-restart';
      assert(transport!.pid); process.kill(transport!.pid!, 'SIGKILL');
      await client!.close(); client = undefined; transport = undefined; await start();
      await call('dcsc_wizard_get', { wizard: 'storage', session });
      await checkMembers(expected);
      await call('dcsc_configure', { session, changes: [{ section: 'UEFI_OPERATING_MODES', code: selectedUefi['code'], quantity: 1 }] });
      await checkMembers(expected);
    }
    stage = 'export';
    const exported = await call('dcsc_export', { kind: 'reports', session: workspace, fileName: 'storage-wizard', fileTypes: ['XML'] });
    const xmlPath = String(exported['xml']);
    stage = 'mcp-import';
    const imported = await call('dcsc_import', { filePath: xmlPath });
    const state = object(JSON.parse(await readFile(sessionFile, 'utf8')));
    const importedWorkspace = rows(state['workspaces']).find(w => w['id'] === imported['session'])!;
    assert(importedWorkspace);
    const importedMembers = rows(importedWorkspace['configurations']).map(c => object(c['raw'])).filter(r => r['code'] === productCode);
    assert.equal(importedMembers.length, 4);
    for (const raw of importedMembers) { assert.deepEqual(selection(raw), expected); if (raid) assertRaidState(raw); }
    stage = 'browser-import';
    await verifyBrowserImport(xmlPath, out, expected);
    const report = { status: 'pass', productCode, referenceId, targetOption, calls: calls.length, maxResponseBytes: Math.max(...calls.map(item => Number(item['bytes']))),
      crashRestart: true, undoRedo: true, staleRejected: true, subsequentDeriveRetainsSettings: true,
      storageWizardIntentExportImport: true, freshBrowserImport: true, nativeOptionComparison: true, controllerReplacement: true, linkedNonRootEdit: true, wholeOptionClear: clear, raidModeSwitch: raid, reverseRaidModeSwitch: raidReverse,
      limitations: ['Live case covers the reported product/reference/option linked edits; LFO and other option families require separate native comparisons; RAID-mode switching is covered only when raidModeSwitch is true.'] };
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'fail', stage, error: String(error) }, null, 2));
    throw error;
  } finally { await client?.close().catch(() => undefined); }
}
await main();
