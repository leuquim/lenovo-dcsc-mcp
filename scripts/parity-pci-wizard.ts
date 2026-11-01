/** Native PCI wizard over stdio: slot selection, recovery, history and CFXML browser handoff. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { pciWizardWireFields } from '../src/domain/pciWizard.js';
import type { RawConfiguration } from '../src/model/types.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];
const values = (page: Obj): Obj => Object.fromEntries(rows(page['items']).map(item => [String(item['key']), item['value']]));

const slots = (raw: Obj) => rows(object(pciWizardWireFields(raw as RawConfiguration)['pciWizardOption'])['results'])
      .map(r => ({ code: r['code'], adapterCode: r['adapterCode'] ?? '' })).sort((a, b) => String(a.code).localeCompare(String(b.code)));

async function verifyBrowserImport(xmlPath: string, out: string, expected: Array<{ code: string; adapterCode: string }>, linked: boolean) {
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
            (window as unknown as { pciImportCapture: unknown }).pciImportCapture = {
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
      await page.waitForFunction('window.pciImportCapture !== undefined', undefined, { timeout: 120_000 });
      const capture = await page.evaluate(() => (window as unknown as { pciImportCapture: { status: number; raw: unknown } }).pciImportCapture);
      assert.equal(capture.status, 200);
      const raw = capture.raw;
      await writeFile(path.join(out, `${label}-browser-import.json`), JSON.stringify(raw, null, 2));
      const body = object(Array.isArray(raw) ? raw[0] : raw);
      const configurations = rows(body['configuration'] ?? body['configurations']);
      const nodes = configurations.filter(item => item['code'] === '7DGDCTO1WW' || item['sliceCtoCode'] === '7DGDCTO1WW');
      assert.equal(nodes.length, linked ? 2 : 1, 'Browser import returned different configuration multiplicity');
      for (const node of nodes) assert.deepEqual(slots(node), expected);
      await context.close();
      }
    } finally { await browser.close(); }
}

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const out = path.resolve(outIndex >= 0 ? process.argv[outIndex + 1]! :
    `artifacts/parity-pci-wizard/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(out, { recursive: true });
  const browserOnlyIndex = process.argv.indexOf('--browser-only');
  if (browserOnlyIndex >= 0) {
    const xmlPath = path.resolve(process.argv[browserOnlyIndex + 1]!);
    const linked = process.argv.includes('--linked');
    await verifyBrowserImport(xmlPath, out, [{ code: 'C3R4', adapterCode: '' },
      { code: 'C3R9', adapterCode: 'B8NY' }, { code: 'C4U8', adapterCode: 'BK1H' }], linked);
    const report = { status: 'pass', scope: 'browser-import-only', xmlPath, configurations: linked ? 2 : 1 };
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
    client = new Client({ name: 'pci-wizard-parity', version: '1.0.0' });
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
    const launched = await call('dcsc_launch_reference_solution', { crnId: 'SID0000978', solutionMode: 'General Purpose' });
    const workspace = String(launched['workspace']);
    const saved = async () => {
      const state = object(JSON.parse(await readFile(sessionFile, 'utf8')));
      return rows(state['workspaces']).find(w => w['id'] === workspace)!;
    };
    const initial = await saved();
    const configuration = rows(initial['configurations']).find(c => object(c['raw'])['code'] === '7DGDCTO1WW')!;
    assert(configuration);
    let session = String(configuration['id']);
    const linked = process.argv.includes('--linked');
    if (linked) {
      stage = 'linked-setup';
      await call('dcsc_add_rack', { session: workspace, rackCode: '7D6DCTO1WW' });
      const rackId = String(rows((await saved())['rackArea'])[0]!['id']);
      await call('dcsc_place_in_rack', { session: workspace, rackId, configuration: session, uPosition: 1 });
      const cloned = await call('dcsc_clone_configuration', { session, count: 1, placement: 'same-rack' });
      session = String(rows(cloned['created'])[0]!['session']);
      assert(session && session !== 'undefined');
    }
    let expected = [{ code: 'C3R4', adapterCode: '' }, { code: 'C3R9', adapterCode: 'B8NY' },
      { code: 'C4U8', adapterCode: 'BK1H' }, { code: 'C62D', adapterCode: '' }];
    const current = async () => object(rows((await saved())['configurations']).find(c => c['id'] === session)!['raw']);
    const checkMembers = async () => {
      const members = rows((await saved())['configurations']).map(c => object(c['raw'])).filter(r => r['code'] === '7DGDCTO1WW');
      assert.equal(members.length, linked ? 2 : 1);
      for (const raw of members) assert.deepEqual(slots(raw), expected);
    };
    const before = await call('dcsc_pci_wizard', { session });
    assert.equal(values(before)['available'], true);
    await call('dcsc_pci_wizard', { session, expectedRevision: before['workspaceRevision'], path: ['options', '0', 'adapterSlots'] });
    stage = 'edit';
    await call('dcsc_set_pci_wizard', { session, expectedRevision: before['workspaceRevision'],
      optionId: '1P Rear5-a', rowId: '2', enabled: true });
    assert.deepEqual(slots(await current()), expected);
    stage = 'crash-restart';
    const snapshot = JSON.parse(await readFile(sessionFile, 'utf8')) as unknown;
    assert(transport!.pid);
    process.kill(transport!.pid!, 'SIGKILL');
    await client!.close(); client = undefined; transport = undefined;
    await start();
    const restarted = await call('dcsc_pci_wizard', { session });
    assert.deepEqual(JSON.parse(await readFile(sessionFile, 'utf8')), snapshot);
    assert.deepEqual(slots(await current()), expected);
    stage = 'stale-and-undo';
    await call('dcsc_set_pci_wizard', { session, expectedRevision: before['workspaceRevision'], optionId: '1P Rear5-a' }, true);
    await call('dcsc_workspace_history', { session: workspace, action: 'undo', expectedRevision: restarted['workspaceRevision'] });
    assert.deepEqual(slots(await current()), slots(object(configuration['raw'])));
    await call('dcsc_workspace_history', { session: workspace, action: 'redo' });
    assert.deepEqual(slots(await current()), expected);
    stage = 'remove-spare';
    const removal = await call('dcsc_set_pci_wizard', { session, expectedRevision: (await saved())['revision'],
      optionId: '1P Rear5-a', rowId: '0', enabled: false });
    assert.equal(removal['affectedConfigurationCount'], linked ? 2 : 1);
    expected = expected.filter(slot => slot.code !== 'C62D');
    await checkMembers();
    stage = 'removal-crash-restart';
    assert(transport!.pid);
    process.kill(transport!.pid!, 'SIGKILL');
    await client!.close(); client = undefined; transport = undefined;
    await start();
    await call('dcsc_pci_wizard', { session });
    await checkMembers();
    stage = 'subsequent-derive';
    const uefi = rows((await current())['tabs']).flatMap(t => rows(t['subTabs'])).flatMap(t => rows(t['sections']))
      .find(section => section['name'] === 'UEFI_OPERATING_MODES');
    const selectedUefi = rows(uefi?.['results'])[0];
    assert(selectedUefi, 'Reference has no UEFI selection to rederive');
    await call('dcsc_configure', { session, changes: [{ section: 'UEFI_OPERATING_MODES', code: selectedUefi['code'], quantity: 1 }] });
    assert.deepEqual(slots(await current()), expected);
    await call('dcsc_configure', { session, changes: [{ section: 'REAR_SLOT1', code: 'C3R9', quantity: 1 }] }, true);
    stage = 'export';
    const exported = await call('dcsc_export', { session: workspace, fileName: 'pci-wizard', fileTypes: ['XML'] });
    const xmlPath = String(exported['xml']);
    stage = 'mcp-import';
    const imported = await call('dcsc_import', { filePath: xmlPath });
    const state = object(JSON.parse(await readFile(sessionFile, 'utf8')));
    const importedWorkspace = rows(state['workspaces']).find(w => w['id'] === imported['workspace'])!;
    assert(importedWorkspace);
    const importedMembers = rows(importedWorkspace['configurations']).map(c => object(c['raw'])).filter(r => r['code'] === '7DGDCTO1WW');
    assert.equal(importedMembers.length, linked ? 2 : 1);
    for (const raw of importedMembers) assert.deepEqual(slots(raw), expected);
    stage = 'browser-import';
    await verifyBrowserImport(xmlPath, out, expected, linked);
    const report = { status: 'pass', calls: calls.length, maxResponseBytes: Math.max(...calls.map(item => Number(item['bytes']))),
      crashRestart: true, undoRedo: true, staleRejected: true, subsequentDeriveRetainsSettings: true,
      pciSlotExportImport: true, freshBrowserImport: true, nativeSlotComparison: true, spareRemoval: true, linkedNonRootEdit: linked,
      limitations: ['Live case covers SR650 V4 optional slot addition and spare removal; other option families require separate native comparisons.'] };
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'fail', stage, error: String(error) }, null, 2));
    throw error;
  } finally { await client?.close().catch(() => undefined); }
}
await main();
