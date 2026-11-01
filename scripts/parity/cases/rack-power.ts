/** Rack PDU and line-cord edits: the website's Customize > Power flow against the MCP on one and two racks, with export workbooks and re-import. */
import assert from 'node:assert/strict';

import { object, persistedWorkspace, rows, text, websiteImport, type Obj } from '../fabric.js';
import type { ParityCase } from '../harness.js';
import { FINAL_CORD, FINAL_PDU, FIRST_CORD, FIRST_PDU, RACK_CODE, SOURCE_XML, assertPowerWorkbook, enterRackPower,
  fillerLines, inspectExportWorkbook, powerLines, rackConfiguration, selectQuantity, selectedWorkbookLines, websiteExport,
  type DeriveStep } from '../rackPower.js';

const SEQUENCE = [[FIRST_PDU, 1], [FIRST_CORD, 1], [FIRST_PDU, 0], [FINAL_PDU, 1], [FIRST_CORD, 0], [FINAL_CORD, 1]] as const;
const FINAL_SELECTION = [{ section: 'LINECORD', code: FINAL_CORD, quantity: 1 }, { section: 'PDU', code: FINAL_PDU, quantity: 1 }];
const SECOND_RACK_SELECTION = [{ section: 'LINECORD', code: FIRST_CORD, quantity: 1 }, { section: 'PDU', code: FIRST_PDU, quantity: 1 }];
const EXPORT_TYPES = ['XML', 'QUOTE', 'FLOOR', 'RACK_REPORT', 'RACK_DIAGRAM', 'POWER_REPORT', 'QUOTE_GROUP', 'SUMMARY', 'MESSAGE_HISTORY'];
const keyed = (lines: Array<{ section: string; code: string; quantity: number }>) => lines.map(({ section, code, quantity }) => ({ section, code, quantity }));

export default {
  id: 'rack-power',
  tags: ['power', 'rack', 'import', 'export'],
  async run(h) {
    const { mcp, web, step, compare } = h;

    const browser = await step('website-power-sequence', async () => {
      const page = await web.newPage();
      try {
        await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
        const cookie = page.locator('.dcsc-cookie-close').first();
        if (await cookie.isVisible({ timeout: 2_000 }).catch(() => false)) await cookie.click();
        const input = page.locator('input[type="file"]').first();
        await input.waitFor({ state: 'attached', timeout: 30_000 });
        const response = page.waitForResponse(candidate => candidate.url().includes('/multiple/cfxml_import') && candidate.request().method() === 'POST', { timeout: 120_000 });
        await input.setInputFiles(SOURCE_XML);
        const imported = await response;
        assert.equal(imported.status(), 200);
        const body: unknown = await imported.json();
        const initial = rackConfiguration(object(Array.isArray(body) ? body[0] : body));
        const rackId = text(initial['id']);
        const baselinePrice = Number(initial['totalPrice']);
        await page.waitForURL(/#\/(?:rack-summary|summary)\//, { timeout: 120_000 });
        await enterRackPower(page);
        const steps: DeriveStep[] = [];
        for (const [code, quantity] of SEQUENCE) steps.push(await selectQuantity(page, code, quantity));
        const final = steps.at(-1)!;
        assert.deepEqual(keyed(final.selected), FINAL_SELECTION);
        assert(steps.every(item => item.guideMode === 'true'));
        assert(final.totalPrice >= baselinePrice, 'Rack total fell below the baseline after adding power options.');
        const exported = await websiteExport(page, h.out, 'website-rack-power');
        const workbook = await inspectExportWorkbook(exported.zipPath);
        assertPowerWorkbook(workbook, 'website', { rackCount: 1, selections: [{ code: FINAL_PDU, quantity: 1 }, { code: FINAL_CORD, quantity: 1 }] });
        const restored = (await websiteImport(h, exported.xmlPath, 'website-own-export')).payload;
        const restoredRack = rackConfiguration(restored, rackId);
        compare('website-own-export-roundtrip', { totalPrice: final.totalPrice, lines: keyed(final.selected) },
          { totalPrice: Number(restoredRack['totalPrice']), lines: keyed(powerLines(restoredRack)) });
        return { finalPrice: final.totalPrice, workbook };
      } finally { await page.context().close(); }
    });

    const workspace = await step('mcp-two-racks', async () => {
      const imported = await mcp.call('dcsc_import', { filePath: SOURCE_XML, solutionMode: 'General Purpose' });
      const workspace = String(imported['session']);
      const racksOf = () => rows(persistedWorkspace(h, workspace)['rackArea']).map(rack => text(rack['id']));
      const set = (rackId: string, args: Obj) => mcp.call('dcsc_pdu_set', { session: workspace, rackId, expectedRevision: persistedWorkspace(h, workspace)['revision'], ...args });
      const [first] = racksOf();
      assert(first && racksOf().length === 1);
      let rackOne: Obj = {};
      for (const [code, quantity] of SEQUENCE) {
        rackOne = await set(first, code === FIRST_PDU || code === FINAL_PDU ? { pduCode: code, quantity } : { cordCode: code, quantity });
      }
      compare('rack-one-price-vs-website', browser.finalPrice, rackOne['totalPrice']);
      await mcp.call('dcsc_rack_add', { session: workspace, rackCode: RACK_CODE, expectedRevision: persistedWorkspace(h, workspace)['revision'] });
      const [, second] = racksOf();
      assert(second && racksOf().length === 2);
      const configuration = (rackId: string) => object(rows(persistedWorkspace(h, workspace)['configurations']).find(item => item['configurationId'] === rackId)?.['raw']);
      compare('rack-one-lines-survive-second-rack', FINAL_SELECTION, keyed(powerLines(configuration(first))));
      await set(second, { pduCode: FIRST_PDU, quantity: 1 });
      const rackTwo = await set(second, { cordCode: FIRST_CORD, quantity: 1 });
      assert.equal(object(rackTwo['powerReadiness'])['complete'], true);
      const selections = [{ rackId: first, pduCode: FINAL_PDU, cordCode: FINAL_CORD }, { rackId: second, pduCode: FIRST_PDU, cordCode: FIRST_CORD }];
      compare('power-selections', selections, persistedWorkspace(h, workspace)['powerSelections']);
      await mcp.call('dcsc_undo', { session: workspace, action: 'undo', expectedRevision: persistedWorkspace(h, workspace)['revision'] });
      compare('undo-removes-second-rack-cord-only', [selections[0], { rackId: second, pduCode: FIRST_PDU }], persistedWorkspace(h, workspace)['powerSelections']);
      await mcp.call('dcsc_undo', { session: workspace, action: 'redo', expectedRevision: persistedWorkspace(h, workspace)['revision'] });
      return workspace;
    });

    await step('export-restart-website-reimport', async () => {
      const exported = await mcp.call('dcsc_export', { kind: 'reports', session: workspace, fileName: 'mcp-two-rack-power', fileTypes: EXPORT_TYPES });
      const workbook = await inspectExportWorkbook(String(exported['zipPath']));
      assertPowerWorkbook(workbook, 'MCP', { rackCount: 2, selections: [{ code: FINAL_PDU, quantity: 1 }, { code: FINAL_CORD, quantity: 1 }, { code: FIRST_PDU, quantity: 1 }, { code: FIRST_CORD, quantity: 1 }] });
      compare('rack-one-workbook-lines-vs-website', selectedWorkbookLines(browser.workbook, [FINAL_PDU, FINAL_CORD]), selectedWorkbookLines(workbook, [FINAL_PDU, FINAL_CORD]));
      const before = mcp.persistedWorkspaces();
      await mcp.killAndRestart();
      compare('restart-retains-power-selections', before, mcp.persistedWorkspaces());
      const saved = persistedWorkspace(h, workspace);
      const website = (await websiteImport(h, String(exported['xml']), 'mcp-two-rack')).payload;
      for (const [rackId, expected] of [[text(rows(saved['rackArea'])[0]!['id']), FINAL_SELECTION], [text(rows(saved['rackArea'])[1]!['id']), SECOND_RACK_SELECTION]] as const) {
        const source = object(rows(saved['configurations']).find(item => item['configurationId'] === rackId)?.['raw']);
        const restored = rackConfiguration(website, rackId);
        assert.deepEqual(keyed(powerLines(restored)), expected);
        compare(`website-import-rack-${rackId}`, { price: source['totalPrice'], lines: keyed(powerLines(source)), filler: fillerLines(source) },
          { price: restored['totalPrice'], lines: keyed(powerLines(restored)), filler: fillerLines(restored) });
      }
      compare('website-import-power-selection', object(object(saved['serverState'])['networkingInformation'])['powerSelection'],
        object(website['networkingInformation'])['powerSelection']);
    });
  },
} satisfies ParityCase;
