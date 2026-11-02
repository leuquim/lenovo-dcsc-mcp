/** Services page product search, Export (one product's catalog) and Download Catalog (country catalog). */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readZip, zipNames } from '../archives.js';
import { array, object, pages } from '../continuations.js';
import type { ParityCase } from '../harness.js';
import { openHome, settle } from '../settingsUi.js';
import { downloadByClick, openServiceProduct, SERVICE_PRODUCT } from '../serviceUi.js';
import { DCSC_HOME } from '../web.js';

const SEARCH_TEXT = '7D73';

/** The catalog workbooks' parts by content hash; docProps carry the generation time, so they are left out. */
async function workbookParts(zipPath: string, out: string, label: string): Promise<Array<{ name: string; sha256: string }>> {
  const workbooks = await readZip(zipPath);
  const parts: Array<{ name: string; sha256: string }> = [];
  for (const [index, workbook] of workbooks.entries()) {
    const inner = path.join(out, `${label}-${index}.xlsx`);
    await writeFile(inner, workbook.bytes);
    for (const part of await readZip(inner)) {
      if (!part.name.startsWith('docProps/')) parts.push({ name: part.name, sha256: createHash('sha256').update(part.bytes).digest('hex') });
    }
  }
  return parts.sort((left, right) => left.name.localeCompare(right.name));
}
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
      await catalogPage.getByText('Select Services', { exact: true }).click();
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
      compare('export-archive', await zipNames(native.exportPath), await zipNames(String(exported['zipPath'])));
      compare('export-content', await workbookParts(native.exportPath, out, 'web-export'), await workbookParts(String(exported['zipPath']), out, 'mcp-export'));

      const catalog = await mcp.call('dcsc_export', { kind: 'servicesCatalog', fileName: 'mcp-service-catalog' });
      compare('download-catalog-archive', await zipNames(native.catalogPath), await zipNames(String(catalog['zipPath'])));
      compare('download-catalog-content', await workbookParts(native.catalogPath, out, 'web-catalog'),
        await workbookParts(String(catalog['zipPath']), out, 'mcp-catalog'));
    });
  },
} satisfies ParityCase;
