/** Services page product search, Export (one product's catalog) and Download Catalog (country catalog). */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { memberListing, readZip } from '../archives.js';
import { array, object, pages } from '../continuations.js';
import { sha256, type ParityCase } from '../harness.js';
import { openHome, settle } from '../settingsUi.js';
import { downloadByClick, openServiceProduct, SERVICE_PRODUCT } from '../serviceUi.js';
import { DCSC_HOME } from '../web.js';

const SEARCH_TEXT = '7D73';

/** The archive's member names and its catalog workbooks' parts by content hash; docProps carry the generation time, so they are left out. */
async function readExport(zipPath: string, out: string, label: string): Promise<{ names: string[]; parts: Array<{ name: string; sha256: string }> }> {
  const workbooks = await readZip(zipPath);
  const parts: Array<{ name: string; sha256: string }> = [];
  for (const [index, workbook] of workbooks.entries()) {
    const inner = path.join(out, `${label}-${index}.xlsx`);
    await writeFile(inner, workbook.bytes);
    for (const part of await readZip(inner)) {
      if (!part.name.startsWith('docProps/')) parts.push({ name: part.name, sha256: sha256(part.bytes) });
    }
  }
  return { names: memberListing(workbooks).map(member => member.name), parts: parts.sort((left, right) => left.name.localeCompare(right.name)) };
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
      const [webExport, mcpExport] = [await readExport(native.exportPath, out, 'web-export'), await readExport(String(exported['zipPath']), out, 'mcp-export')];
      compare('export-archive', webExport.names, mcpExport.names);
      compare('export-content', webExport.parts, mcpExport.parts);

      const catalog = await mcp.call('dcsc_export', { kind: 'servicesCatalog', fileName: 'mcp-service-catalog' });
      const [webCatalog, mcpCatalog] = [await readExport(native.catalogPath, out, 'web-catalog'), await readExport(String(catalog['zipPath']), out, 'mcp-catalog')];
      compare('download-catalog-archive', webCatalog.names, mcpCatalog.names);
      compare('download-catalog-content', webCatalog.parts, mcpCatalog.parts);
    });
  },
} satisfies ParityCase;
