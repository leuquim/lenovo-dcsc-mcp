/** Catalog tree, product search and the withdrawn-since setting against the website's own catalog responses. */
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import { type Catalog, flatten, searchCatalogPage } from '../../../src/domain/catalog.js';
import { CategoryHierarchySchema } from '../../../src/schemas/catalog.js';
import { array, continuation, detailField, enumerateIds, object, pages } from '../continuations.js';
import type { Harness, ParityCase } from '../harness.js';
import { chooseWithdrawnSince } from '../settingsUi.js';
import { DCSC_HOME } from '../web.js';

const SOLUTION_MODE = 'General Purpose';
const SEARCH_TEXT = 'ThinkSystem';
const PAGE = 50;

const webCatalog = (raw: unknown): Catalog => {
  const tree = CategoryHierarchySchema.parse(raw);
  return { tree, entries: flatten(tree), fetchedAt: 0 };
};
const sorted = (values: string[]) => [...values].sort();

async function browseLevel(h: Harness, categoryPath: string[]) {
  const categories: string[] = [];
  const products: string[] = [];
  for await (const page of pages(h.mcp, { tool: 'dcsc_search', arguments: { search: {
    kind: 'tree', categoryPath, categoryOffset: 0, offset: 0, limit: PAGE, solutionMode: SOLUTION_MODE } } })) {
    for (const raw of array(page['categories'])) {
      const item = object(raw);
      categories.push(String(typeof item['name'] === 'string' ? item['name'] : await detailField(h.mcp, continuation(item['detail']), 'name')));
    }
    for (const raw of array(page['products'])) {
      const item = object(raw);
      products.push(String(typeof item['code'] === 'string' ? item['code'] : await detailField(h.mcp, continuation(item['detail']), 'code')));
    }
  }
  return { categories, products };
}

export default {
  id: 'catalogs',
  tags: ['catalog'],
  async run(h) {
    const { mcp, web, step, compare, out } = h;

    const home = await step('website-catalog', async () => {
      const page = await web.newPage();
      page.setDefaultTimeout(90_000);
      const isCatalog = (response: { url(): string; request(): { method(): string } }) =>
        response.url().includes('/api/category_hierarchies') && response.request().method() === 'GET';
      const pending = page.waitForResponse(isCatalog, { timeout: 90_000 });
      await page.goto(DCSC_HOME, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      const catalog = webCatalog(await (await pending).json());
      await writeFile(path.join(out, 'website-category-hierarchies.json'), JSON.stringify(catalog.tree));
      return { catalog };
    });

    await step('tree', async () => {
      const root = await browseLevel(h, []);
      compare('root-categories', home.catalog.tree.map(node => node.name ?? node.id), root.categories);
      const leaf = home.catalog.entries.find(entry => !entry.withdrawn);
      if (!leaf) throw new Error('The website catalog has no available product.');
      const nested = await browseLevel(h, leaf.path.slice(0, 1));
      const topNode = home.catalog.tree.find(node => (node.name ?? node.id) === leaf.path[0]);
      compare('nested-categories', (topNode?.children ?? []).map(node => node.name ?? node.id), nested.categories);
      const leafLevel = await browseLevel(h, leaf.path);
      compare('leaf-products', sorted(home.catalog.entries.filter(entry => !entry.withdrawn
        && entry.path.length === leaf.path.length && leaf.path.every((segment, index) => entry.path[index] === segment)).map(entry => entry.code)),
      sorted(leafLevel.products));
    });

    const firstProduct = await step('product-search', async () => {
      const found = await enumerateIds(mcp, 'dcsc_search', { search: { kind: 'products', query: SEARCH_TEXT, type: 'CTO',
        solutionMode: SOLUTION_MODE, offset: 0, limit: PAGE } }, 'products', 'code');
      const expected = searchCatalogPage(home.catalog, { query: SEARCH_TEXT, type: 'CTO', limit: home.catalog.entries.length, offset: 0 })
        .items.map(entry => entry.code);
      compare('products-enumerated', sorted(expected), sorted(found.ids));
      compare('products-unique', found.ids.length, new Set(found.ids).size);
      compare('products-fingerprint', true, typeof found.fingerprint === 'string');
      return found.ids[0]!;
    });

    await step('withdrawn-since', async () => {
      const page = await web.newPage();
      page.setDefaultTimeout(90_000);
      await page.goto(DCSC_HOME, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      const pending = page.waitForResponse(response => response.url().includes('/api/category_hierarchies')
        && response.url().includes('withdrawnDate='), { timeout: 120_000 });
      const date = await chooseWithdrawnSince(page, 1);
      const response = await pending;
      const withdrawnCatalog = webCatalog(await response.json());
      compare('website-query-date', date, new URL(response.url()).searchParams.get('withdrawnDate'));

      const set = await mcp.call('dcsc_settings_set', { withdrawnSince: date });
      compare('setting-echoed', date, set['withdrawnSince']);
      const found = await enumerateIds(mcp, 'dcsc_search', { search: { kind: 'products', query: SEARCH_TEXT,
        solutionMode: SOLUTION_MODE, offset: 0, limit: PAGE } }, 'products', 'code');
      const expected = searchCatalogPage(withdrawnCatalog, { query: SEARCH_TEXT, includeWithdrawn: true,
        limit: withdrawnCatalog.entries.length, offset: 0 }).items.map(entry => entry.code);
      compare('withdrawn-products', sorted(expected), sorted(found.ids));
      await mcp.call('dcsc_settings_set', { withdrawnSince: '' });
    });

    await step('parts', async () => {
      const first = await mcp.call('dcsc_search', { search: { kind: 'parts', query: 'Premier', types: ['SERVICE'], mode: 'CTO',
        solutionMode: SOLUTION_MODE, offset: 0, limit: PAGE } });
      const page = object(first['page']);
      compare('parts-contract', { source: 'GET /api/findpart', completeness: 'unknown', pagination: 'none-reported', scope: 'local-snapshot', total: false },
        { source: page['source'], completeness: page['upstreamCompleteness'], pagination: page['upstreamPagination'],
          scope: page['continuationScope'], total: Object.hasOwn(first, 'total') });
      compare('parts-large-response', true, Number(page['itemsInFetchedResponse']) > 1_000);
      const next = continuation(first['next']);
      const second = await mcp.call(next.tool, next.arguments);
      const codes = [...array(first['parts']), ...array(second['parts'])].map(item => String(object(item)['code']));
      compare('parts-pages-disjoint', codes.length, new Set(codes).size);
    });

    await step('racks-fabric-software', async () => {
      const racks = await enumerateIds(mcp, 'dcsc_rack_get', { solutionMode: SOLUTION_MODE, offset: 0, limit: PAGE }, 'racks', 'code');
      compare('racks-unique', racks.ids.length, new Set(racks.ids).size);
      const compatible = await mcp.call('dcsc_rack_get', { solutionMode: SOLUTION_MODE, productCode: firstProduct, offset: 0, limit: 20 });
      compare('racks-compatible-lookup', firstProduct, compatible['compatibleWith']);

      for (const collection of ['topologies', 'networkDevices', 'networkTypes', 'cables', 'selectedServices', 'nodeRoles', 'storageSwitches', 'storageControllers']) {
        const first = await mcp.call('dcsc_network_get', { solutionMode: SOLUTION_MODE, collection, offset: 0, limit: PAGE });
        if (Number(first['total'] ?? 0) === 0) continue;
        const enumerated = await enumerateIds(mcp, 'dcsc_network_get', { solutionMode: SOLUTION_MODE, collection, offset: 0, limit: PAGE }, 'items', 'id');
        compare(`${collection}-unique`, enumerated.ids.length, new Set(enumerated.ids).size);
        const byId = await mcp.call('dcsc_network_get', { solutionMode: SOLUTION_MODE, collection, optionId: enumerated.ids[0], offset: 0, limit: 20 });
        const item = object(array(byId['items'])[0]);
        compare(`${collection}-option-id-executable`, enumerated.ids[0],
          typeof item['id'] === 'string' ? item['id'] : await detailField(mcp, continuation(item['detail']), 'id'));
      }

      const launched = await mcp.call('dcsc_launch', { mode: 'software', replace: false, refresh: false });
      const workspace = String(launched['session']);
      const software = await enumerateIds(mcp, 'dcsc_basket_browse', { basket: 'software', session: workspace, offset: 0, limit: PAGE }, 'software', 'code');
      compare('software-unique', software.ids.length, new Set(software.ids).size);
      const selected = await mcp.call('dcsc_basket_set', { basket: 'software', action: 'select', session: workspace, code: software.ids[0], quantity: 1 });
      compare('software-selected', true, array(selected['selections']).map(object).some(item => item['code'] === software.ids[0]));
      const removed = await mcp.call('dcsc_basket_set', { basket: 'software', action: 'remove', session: workspace, code: software.ids[0] });
      compare('software-removed', false, array(removed['selections']).map(object).some(item => item['code'] === software.ids[0]));
      await mcp.call('dcsc_session_close', { session: workspace });
    });
  },
} satisfies ParityCase;
