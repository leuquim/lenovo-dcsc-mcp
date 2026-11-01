/** Product-bound base service and add-on: select, remove, re-add, summary, Save and fresh-browser reimport. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { zipText } from '../archives.js';
import { normalizers, type ParityCase } from '../harness.js';
import { downloadByClick, openServiceProduct, openServiceSummary, SERVICE_PRODUCT, toggleService } from '../serviceUi.js';

const BASE = '5WS7B99623';
const ADD_ON = '5PS7B99638';
const EXPECTED_TOTAL = 1810;

export default {
  id: 'services',
  tags: ['services', 'export'],
  async run(h) {
    const { mcp, web, step, compare, out } = h;

    const browser = await step('browser-flow', async () => {
      const page = await web.newPage();
      await openServiceProduct(page);
      await toggleService(page, BASE);
      await toggleService(page, ADD_ON);
      await toggleService(page, ADD_ON);
      await toggleService(page, ADD_ON);
      const summary = await openServiceSummary(page);
      const zipPath = path.join(out, 'browser-services.zip');
      await downloadByClick(page, () => page.getByText('Save', { exact: true }).click(), zipPath);
      const xml = await zipText(zipPath, '.xml');
      const xmlPath = path.join(out, 'browser-services.xml');
      await writeFile(xmlPath, xml);
      return { summary, xml, xmlPath };
    });

    await step('mcp-flow', async () => {
      const launched = await mcp.call('dcsc_launch', { mode: 'services', productCode: SERVICE_PRODUCT, productQuantity: 1, subCategory: 'Point of Sale' });
      const session = String(launched['session']);
      const select = (code: string) => mcp.call('dcsc_basket_set', { basket: 'services', action: 'select', session, code, quantity: 1 });
      await select(BASE);
      await select(ADD_ON);
      await mcp.call('dcsc_basket_set', { basket: 'services', action: 'remove', session, code: ADD_ON });
      const readded = await select(ADD_ON);
      compare('summary', normalizers.serviceSummary(browser.summary), normalizers.serviceSummary(readded['summary']));
      compare('summary-total', EXPECTED_TOTAL, normalizers.serviceSummary(readded['summary']).total);

      const exported = await mcp.call('dcsc_export', { kind: 'reports', session, fileName: 'mcp-services' });
      const mcpXml = readFileSync(String(exported['xml']), 'utf8');
      compare('commercial-lines', normalizers.cfxml(browser.xml), normalizers.cfxml(mcpXml));
      compare('output-type', true, /<OutputType>Multiple Services<\/OutputType>/.test(mcpXml) &&
        /<OutputType>Multiple Services<\/OutputType>/.test(browser.xml));

      const webImport = await web.importCfxml(browser.xmlPath, 'browser-xml');
      const mcpImport = await web.importCfxml(String(exported['xml']), 'mcp-xml');
      compare('reimport-browser-xml', normalizers.serviceSummary(browser.summary), normalizers.serviceSummary(webImport['summary']));
      compare('reimport-mcp-xml', normalizers.serviceSummary(browser.summary), normalizers.serviceSummary(mcpImport['summary']));

      const before = mcp.persistedWorkspaces().find(entry => entry['id'] === session);
      assert(before, 'Services workspace was not persisted.');
      const rejected = await mcp.call('dcsc_basket_set', { basket: 'services', action: 'setQuantity', session, code: BASE, quantity: 2,
        expectedRevision: before['revision'] }, { expectError: true });
      compare('normalized-quantity-fails-closed', true,
        /requestedQuantity=2, acceptedQuantity=1/.test(String(rejected['error'])) && /No workspace change was saved/.test(String(rejected['error'])));
      const after = mcp.persistedWorkspaces().find(entry => entry['id'] === session);
      compare('rejected-quantity-leaves-workspace', before['serverState'], after?.['serverState']);
    });
  },
} satisfies ParityCase;
