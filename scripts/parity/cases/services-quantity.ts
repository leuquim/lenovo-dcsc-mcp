/** Imported product-bound services: product-quantity resize keeps the service quantity; export, reimport and restart. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { normalizers, type Json, type ParityCase } from '../harness.js';
import { openHome, settle } from '../settingsUi.js';
import { clickProductQuantity } from '../serviceUi.js';
import { DCSC_HOME } from '../web.js';

const FIXTURE = path.resolve('test/fixtures/parity/xml/service-p3-s2.xml');
const BASE = '5WS7B99623';
const IMPORTED_PRODUCT_QUANTITY = 3;
const UPDATED_PRODUCT_QUANTITY = 4;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const dollars = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default {
  id: 'services-quantity',
  tags: ['services', 'import'],
  async run(h) {
    const { mcp, web, step, compare } = h;

    const native = await step('native-import-and-resize', async () => {
      const page = await web.newPage();
      page.setDefaultTimeout(90_000);
      await openHome(page, DCSC_HOME);
      const pending = page.waitForResponse(response =>
        response.request().method() === 'POST' && response.url().includes('/multiple/cfxml_import'), { timeout: 120_000 });
      await page.locator('input[type=file]').first().setInputFiles(FIXTURE);
      const response = await pending;
      assert.equal(response.status(), 200);
      const raw: unknown = await response.json();
      const envelope = object(Array.isArray(raw) ? raw[0] : raw);
      await page.waitForURL(/#\/summary\/service$/, { timeout: 120_000 });
      await settle(page);
      const clicked = await clickProductQuantity(page, 'control-add', String(UPDATED_PRODUCT_QUANTITY));
      const amounts = [...(await page.locator('body').innerText()).matchAll(/\$[\d,]+\.\d{2}/g)].map(match => match[0]);
      return { summary: envelope['summary'], clicked, amounts };
    });

    const { session, browsed } = await step('mcp-import-and-resize', async () => {
      const imported = await mcp.call('dcsc_import', { filePath: FIXTURE, solutionMode: 'General Purpose' });
      const session = String(imported['session']);
      const browsed = await mcp.call('dcsc_basket_browse', { basket: 'services', session });
      compare('import-summary', normalizers.serviceSummary(native.summary), normalizers.serviceSummary(browsed['summary']));
      compare('imported-product-quantity', IMPORTED_PRODUCT_QUANTITY, object(browsed['product'])['quantity']);
      return { session, browsed };
    });

    const resized = await step('resize', async () => {
      const resized = await mcp.call('dcsc_basket_set', { basket: 'services', action: 'setProductQuantity', session,
        quantity: UPDATED_PRODUCT_QUANTITY, expectedRevision: browsed['revision'] });
      compare('native-resize-is-local', 0, native.clicked.servicePosts);
      compare('native-resized-quantity', String(UPDATED_PRODUCT_QUANTITY), native.clicked.value);
      compare('native-shows-mcp-total', true, native.amounts.includes(dollars(Number(normalizers.serviceSummary(resized['summary']).total))));
      compare('service-quantity-preserved', normalizers.serviceSummary(native.summary).lines.map(line => line.quantity),
        normalizers.serviceSummary(resized['summary']).lines.map(line => line.quantity));
      return resized;
    });

    await step('export-and-reimport', async () => {
      const exported = await mcp.call('dcsc_export', { kind: 'reports', session, fileName: 'mcp-imported-service-quantity' });
      const lines = normalizers.cfxml(readFileSync(String(exported['xml']), 'utf8'));
      const unit = normalizers.serviceSummary(native.summary).lines.find(line => line.code === BASE);
      compare('export-lines', [{ code: BASE, quantity: UPDATED_PRODUCT_QUANTITY * Number(unit?.quantity), unitPrice: unit?.unitPrice }],
        lines.map(line => ({ code: line.code, quantity: line.quantity, unitPrice: line.unitPrice })));
      const reimported = await web.importCfxml(String(exported['xml']), 'resized');
      compare('reimport-summary', normalizers.serviceSummary(reimported['summary']), normalizers.serviceSummary(resized['summary']));
    });

    await step('restart', async () => {
      await mcp.killAndRestart();
      const restored = await mcp.call('dcsc_basket_browse', { basket: 'services', session });
      compare('restart-summary', normalizers.serviceSummary(resized['summary']), normalizers.serviceSummary(restored['summary']));
    });
  },
} satisfies ParityCase;
