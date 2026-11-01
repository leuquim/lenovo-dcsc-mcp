/** Second power code and non-unit PDU/cord quantities on one rack: the website against the MCP, then re-imported by the website. */
import assert from 'node:assert/strict';

import { object, persistedWorkspace, rows, text, websiteImport, type Obj } from '../fabric.js';
import type { ParityCase } from '../harness.js';
import { FINAL_CORD, FINAL_PDU, FIRST_CORD, FIRST_PDU, SOURCE_XML, enterRackPower, powerLines, rackConfiguration, selectQuantity, websiteExport } from '../rackPower.js';

const REQUESTED = [
  { section: 'PDU', code: FIRST_PDU, quantity: 2 }, { section: 'PDU', code: FINAL_PDU, quantity: 3 },
  { section: 'LINECORD', code: FIRST_CORD, quantity: 4 }, { section: 'LINECORD', code: FINAL_CORD, quantity: 2 },
];
const bySectionCode = (left: { section: string; code: string }, right: { section: string; code: string }) => `${left.section}:${left.code}`.localeCompare(`${right.section}:${right.code}`);
const EXPECTED = [...REQUESTED].sort(bySectionCode);
const keyed = (lines: Array<{ section: string; code: string; quantity: number }>) => lines.map(({ section, code, quantity }) => ({ section, code, quantity }));

export default {
  id: 'rack-power-multi',
  tags: ['power', 'rack', 'import', 'export'],
  async run(h) {
    const { mcp, web, step, compare } = h;

    const website = await step('website-multi-power', async () => {
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
        const rackId = text(rackConfiguration(object(Array.isArray(body) ? body[0] : body))['id']);
        await page.waitForURL(/#\/(?:rack-summary|summary)\//, { timeout: 120_000 });
        await enterRackPower(page);
        const steps = [];
        for (const item of REQUESTED) steps.push(await selectQuantity(page, item.code, item.quantity));
        const final = steps.at(-1)!;
        assert.deepEqual(keyed(final.selected), EXPECTED);
        const exported = await websiteExport(page, h.out, 'website-rack-power-multi');
        const restored = rackConfiguration((await websiteImport(h, exported.xmlPath, 'website-own-multi')).payload, rackId);
        compare('website-multi-roundtrip', { totalPrice: final.totalPrice, lines: EXPECTED }, { totalPrice: Number(restored['totalPrice']), lines: keyed(powerLines(restored)) });
        return { finalPrice: final.totalPrice };
      } finally { await page.context().close(); }
    });

    await step('mcp-multi-power', async () => {
      const imported = await mcp.call('dcsc_import', { filePath: SOURCE_XML, solutionMode: 'General Purpose' });
      const workspace = String(imported['session']);
      const rackId = text(rows(persistedWorkspace(h, workspace)['rackArea'])[0]?.['id']);
      let last: Obj = {};
      for (const selection of [{ pduCode: FIRST_PDU, quantity: 2 }, { pduCode: FINAL_PDU, quantity: 3 }, { cordCode: FIRST_CORD, quantity: 4 }, { cordCode: FINAL_CORD, quantity: 2 }]) {
        last = await mcp.call('dcsc_pdu_set', { session: workspace, rackId, expectedRevision: persistedWorkspace(h, workspace)['revision'], ...selection });
      }
      compare('mcp-multi-selected-vs-website', EXPECTED, keyed(rows(last['selected']) as unknown as Array<{ section: string; code: string; quantity: number }>).sort(bySectionCode));
      compare('mcp-multi-price-vs-website', website.finalPrice, last['totalPrice']);
      const source = (): Obj => object(rows(persistedWorkspace(h, workspace)['configurations']).find(item => item['configurationId'] === rackId)?.['raw']);
      compare('mcp-multi-persisted-lines', EXPECTED, keyed(powerLines(source())));
      const exported = await mcp.call('dcsc_export', { kind: 'reports', session: workspace, fileName: 'mcp-rack-power-multi', fileTypes: ['XML', 'QUOTE'], scope: 'workspace' });
      await mcp.killAndRestart();
      compare('mcp-multi-restart-lines', EXPECTED, keyed(powerLines(source())));
      const restored = rackConfiguration((await websiteImport(h, String(exported['xml']), 'mcp-multi')).payload, rackId);
      compare('website-import-of-mcp-export', { totalPrice: website.finalPrice, lines: EXPECTED }, { totalPrice: Number(restored['totalPrice']), lines: keyed(powerLines(restored)) });
    });
  },
} satisfies ParityCase;
