/** Genuine x-config export: native import, derive and layout against the MCP import, restart and XML handoff. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { nativeFloorLayouts } from '../../lib/xconfigParity.js';
import { normalizers, type Json, type ParityCase } from '../harness.js';

const FIXTURE = path.resolve('test/fixtures/parity/xml/xconfig-native-physical.xml');
const PERSISTED_KEYS = ['configurations', 'rackArea', 'nonRackArea', 'serverState', 'revision'];
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const placement = (racks: Json[]) => racks.flatMap(rack => rows(rack['rackItems'])
  .map(item => ({ rack: rack['code'], code: item['code'], position: item['position'], size: item['size'] })));

export default {
  id: 'xconfig-import',
  tags: ['import'],
  async run(h) {
    const { mcp, web, step, compare, out } = h;
    const saved = (id: string) => {
      const workspace = mcp.persistedWorkspaces().find(entry => entry['id'] === id);
      assert(workspace, `Workspace ${id} was not persisted.`);
      return workspace;
    };

    const native = await step('native-import', async () => {
      const page = await web.newPage();
      const derived: Json[] = [];
      const layouts: Json[] = [];
      const requests: Json[] = [];
      const captures: Promise<void>[] = [];
      page.on('response', response => {
        if (!/\/ctos\/(autoDerive|racks\/customize)\?/.test(response.url())) return;
        captures.push((async () => {
          const data = object(await response.json());
          if (response.url().includes('/autoDerive?')) derived.push(...rows(data['configurations']));
          else {
            layouts.push(data);
            requests.push(object(JSON.parse(response.request().postData() ?? '{}')));
          }
        })());
      });
      await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded' });
      const pending = page.waitForResponse(response =>
        response.url().includes('cfxml_import') && response.request().method() === 'POST', { timeout: 120_000 });
      await page.locator('input[type=file]').first().setInputFiles(FIXTURE);
      const response = await pending;
      assert.equal(response.status(), 200);
      const raw: unknown = await response.json();
      const imported = object(Array.isArray(raw) ? raw[0] : raw);
      await page.getByText('Upload Successfully', { exact: true }).waitFor({ timeout: 60_000 });
      await page.locator('.ant-modal-close').last().click();
      await page.waitForURL(/rack-summary/, { timeout: 120_000 });
      await page.waitForTimeout(5000);
      await page.waitForFunction(() => !/Grand Total\s*\$0\.00/.test(document.body.innerText) &&
        !document.body.innerText.includes('loading ...'), undefined, { timeout: 120_000 });
      await page.waitForLoadState('networkidle', { timeout: 60_000 });
      await Promise.all(captures);
      assert(derived.length > 0 && layouts.length > 0, 'Native import must complete customization and derivation');
      const configuration = rows(imported['configuration']).map(entry =>
        derived.filter(candidate => candidate['id'] === entry['id']).reduce((merged, candidate) => ({ ...merged, ...candidate }), entry));
      const completed = { ...imported, configuration };
      await writeFile(path.join(out, 'native-completed.json'), JSON.stringify({ native: completed, layouts, requests }, null, 2));
      return { body: completed, layout: layouts.at(-1)!, request: requests.at(-1)! };
    });

    const { id, before } = await step('mcp-import', async () => {
      const imported = await mcp.call('dcsc_import', { filePath: FIXTURE });
      const id = String(imported['session']);
      const before = saved(id);
      compare('import-selections', normalizers.configurations(native.body['configuration']),
        normalizers.configurations(rows(before['configurations']).map(entry => entry['raw'])));
      compare('rack-placement', placement(rows(native.layout['rackArea'])), placement(rows(before['rackArea'])));
      const nativeCodes = new Map(rows(native.body['configuration']).map(entry => [entry['id'], entry['code']]));
      const actualCodes = new Map(rows(before['configurations']).map(entry => [entry['configurationId'], object(entry['raw'])['code']]));
      compare('floor-items',
        rows(native.request['floorItems']).filter(item => object(item['rackItem'])['id']).map(item => ({
          code: nativeCodes.get(object(item['rackItem'])['id']), x: item['col'], y: item['row'] })),
        rows(before['floorItems']).map(item => ({ code: actualCodes.get(item['rackId']), x: item['x'], y: item['y'] })));
      const warnings = JSON.stringify(object(object(before['serverState'])['lastImportDiagnostics'])['warnings']);
      compare('absent-native-sections-warned', {
        cabling: native.body['networkingInformation'] || native.body['connectionData'] ? true : warnings.includes('saved cabling'),
        floor: native.body['floorInformation'] ? true : warnings.includes('saved floor'),
      }, { cabling: true, floor: true });
      return { id, before };
    });

    const after = await step('restart', async () => {
      await mcp.killAndRestart();
      await mcp.call('dcsc_workspace_get', { session: id });
      const after = saved(id);
      compare('restart-persisted-state', Object.fromEntries(PERSISTED_KEYS.map(key => [key, before[key]])),
        Object.fromEntries(PERSISTED_KEYS.map(key => [key, after[key]])));
      return after;
    });

    await step('export-handoff', async () => {
      const exported = await mcp.call('dcsc_export', { kind: 'reports', session: id, fileName: 'xconfig-migrated', fileTypes: ['XML'] });
      const body = await web.importCfxml(String(exported['xml']), 'reimport');
      compare('reimport-selections', normalizers.configurations(rows(after['configurations']).map(entry => entry['raw'])),
        normalizers.configurations(body['configuration']));
      const floor = nativeFloorLayouts(body, after);
      compare('reimport-floor-layout', floor.expected, floor.actual);
    });
  },
} satisfies ParityCase;
