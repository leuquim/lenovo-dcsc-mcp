/** Services page product search, Export (one product's catalog) and Download Catalog (country catalog). */
import path from 'node:path';

import { zipListing } from '../archives.js';
import { array, object, pages } from '../continuations.js';
import type { ParityCase } from '../harness.js';
import { openHome, settle } from '../settingsUi.js';
import { downloadByClick, openServiceProduct, SERVICE_PRODUCT } from '../serviceUi.js';
import { DCSC_HOME } from '../web.js';

const SEARCH_TEXT = '7D73';
const SEARCH_PAGE_SIZE = 50;

export default {
  id: 'services-downloads',
  tags: ['services', 'export'],
  async run(h) {
    const { mcp, web, step, compare, out } = h;

    const native = await step('browser', async () => {
      const page = await web.newPage();
      const { productSearch } = await openServiceProduct(page);
      const exportPath = path.join(out, 'browser-service-export.zip');
      await downloadByClick(page, () => page.getByText('Export', { exact: true }).first().click(), exportPath);

      const catalogPage = await web.newPage();
      await openHome(catalogPage, `${DCSC_HOME}#/services`);
      await settle(catalogPage);
      const catalogPath = path.join(out, 'browser-service-catalog.zip');
      await downloadByClick(catalogPage, () => catalogPage.getByRole('button', { name: 'Download Catalog' }).click(), catalogPath);
      return { productSearch: [...new Set(productSearch)].sort(), exportPath, catalogPath };
    });

    await step('mcp', async () => {
      const codes: string[] = [];
      for await (const page of pages(mcp, { tool: 'dcsc_search',
        arguments: { search: { kind: 'serviceProducts', query: SEARCH_TEXT, limit: SEARCH_PAGE_SIZE } } })) {
        codes.push(...array(page['products']).map(row => String(object(row)['code'])));
      }
      compare('product-search', native.productSearch, [...new Set(codes)].sort());

      const exported = await mcp.call('dcsc_export', { kind: 'servicesCatalog', productCode: SERVICE_PRODUCT, fileName: 'mcp-service-export' });
      compare('export-archive', await zipListing(native.exportPath), await zipListing(String(exported['zipPath'])));

      const catalog = await mcp.call('dcsc_export', { kind: 'servicesCatalog', fileName: 'mcp-service-catalog' });
      compare('download-catalog-archive', await zipListing(native.catalogPath), await zipListing(String(catalog['zipPath'])));
    });
  },
} satisfies ParityCase;
