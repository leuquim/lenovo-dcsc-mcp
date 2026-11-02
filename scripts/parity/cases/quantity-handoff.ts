/** SR630 V3 launch, and quantity 1/4/8 hardware plus standalone software CFXML handoff between the website and the MCP. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

import { CAPTURE_EXPORT_FORMS } from '../exportUi.js';
import { normalizers, type Harness, type Json, type ParityCase } from '../harness.js';
import { rows } from '../rackUi.js';
import { array, captureBrowserExport, money, object, importInBrowser, SOFTWARE_CODE } from '../softwareSummaryUi.js';
import { watchImportResponse } from '../web.js';

const SERVER = '7D73CTO1WW';
const QUANTITY_FIXTURE = JSON.parse(readFileSync('test/fixtures/parity/browser-quantity-matrix.json', 'utf8')) as Json;
const LAUNCH_FIXTURE = JSON.parse(readFileSync('test/fixtures/parity/sr630-launch.json', 'utf8')) as Json;
const QUANTITY_XML = new Map([[1, 'sr630-v3-qty1.xml'], [4, 'sr630-v3-qty4.xml'], [8, 'sr630-v3-qty8.xml']]);
const SOFTWARE_XML = path.resolve('test/fixtures/parity/xml/standalone-software-qty3.xml');
const SUMMARY_ROUTE = /#\/(?:rack-summary|summary)\//;
const GROUPED_CODES = ['7D73CTO1WW', '7S0XCTO6WW', '7S0XCTO5WW', '7Q01CTO2WW', '7Q01CTS4WW', '7Q01CTSAWW'];
const xmlPath = (file: string) => path.resolve('test/fixtures/parity/xml', file);
const text = (value: unknown) => value === undefined || value === null ? '' : String(value);

const selectedBom = (configuration: unknown) => rows(array(object(configuration)['tabs']).flatMap(tab => array(object(tab)['subTabs']))
  .flatMap(tab => array(object(tab)['sections'])).flatMap(section => array(object(section)['results'])))
  .filter(result => typeof result['code'] === 'string').map(result => ({ code: result['code'], quantity: Number(result['quantity'] ?? 1) }))
  .sort((left, right) => String(left.code).localeCompare(String(right.code)));

/** Lines of the products by code, summed over configurations, for comparing sales quantities. */
const quantitiesByCode = (envelopeOrXml: { groups?: unknown; lines?: ReturnType<typeof normalizers.cfxml> }) => {
  const result: Record<string, number> = {};
  const add = (code: string, quantity: number) => { if (code) result[code] = (result[code] ?? 0) + quantity; };
  for (const group of array(envelopeOrXml.groups)) for (const product of array(object(group)['products']).map(object)) add(text(product['code']).replaceAll('-', ''), Number(product['quantity'] ?? 0));
  for (const line of envelopeOrXml.lines ?? []) add(line.code, line.quantity);
  return result;
};

/** Hardware, type, price and selected feature quantities as Lenovo's XML states them. */
const xmlProducts = (xml: string) => {
  const result = new Map<string, number>();
  for (const line of normalizers.cfxml(xml)) {
    const key = JSON.stringify([line.type, line.code, line.unitPrice, line.children.map(child => [child.code, child.quantity])]);
    result.set(key, (result.get(key) ?? 0) + line.quantity);
  }
  return [...result].sort(([left], [right]) => left.localeCompare(right));
};

/** Commercial rows aggregated by product and unit price; hipo/service `price` is per configuration, hardware `price` is extended. */
const aggregateGroups = (fieldsOrGroups: unknown) => {
  const fields = object(fieldsOrGroups);
  const groups = normalizers.wireRequest({ groups: typeof fields['groups'] === 'string' ? fields['groups'] : JSON.stringify(fieldsOrGroups) }).groups;
  const result = new Map<string, { quantity: number; extendedPrice: number; wirePrice: number }>();
  for (const product of groups) {
    assert(product.unitPrice !== null && product.price !== null, 'Commercial price unavailable.');
    const key = JSON.stringify([product.type, product.code, product.unitPrice]);
    const current = result.get(key) ?? { quantity: 0, extendedPrice: 0, wirePrice: 0 };
    current.quantity += product.quantity;
    current.extendedPrice = money(current.extendedPrice + product.unitPrice * product.quantity);
    current.wirePrice = money(current.wirePrice + product.price * (product.type === 'hardware' ? 1 : product.quantity));
    result.set(key, current);
  }
  return [...result].sort(([left], [right]) => left.localeCompare(right));
};

/** The import response of a many-configuration workbook exceeds Chromium's default resource buffer; read it through CDP. */
async function importLarge(page: Page, file: string): Promise<Json> {
  await page.addInitScript({ content: CAPTURE_EXPORT_FORMS });
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: 'attached', timeout: 60_000 });
  const { response } = await watchImportResponse(page);
  await input.setInputFiles(file);
  const { status, raw } = await response;
  assert.equal(status, 200, `Browser import returned HTTP ${status}.`);
  await page.waitForURL(url => SUMMARY_ROUTE.test(url.href), { timeout: 60_000 });
  return object(array(raw)[0]);
}

const importedFacts = (envelope: Json, quantity: number) => {
  const products = array(object(array(envelope['groups'])[0])['products']).map(object);
  return {
    configurations: array(envelope['configuration']).length,
    rawQuantities: array(envelope['configuration']).map(item => object(item)['quantity']),
    hardwareSalesQuantity: products.find(item => item['code'] === SERVER)?.['quantity'],
    dependentsAllMatch: products.filter(item => item['type'] === 'hipo' || item['type'] === 'servicectohipo').every(item => item['quantity'] === quantity),
  };
};

function launchCase(): ParityCase {
  return {
    id: 'launch-sr630',
    tags: ['launch'],
    async run(h) {
      const web = await h.step('website', async () => {
        const page = await h.web.newPage();
        await page.goto('https://dcsc.lenovo.com/#/categories/STG%40Servers%40Rack%20Server%40ThinkSystem%20SR630%20V3', { waitUntil: 'domcontentloaded', timeout: 60_000 });
        const cookie = page.locator('.dcsc-cookie-close').first();
        if (await cookie.isVisible({ timeout: 1_500 }).catch(() => false)) await cookie.click();
        await page.waitForTimeout(5_000);
        const configure = page.locator('button:has-text("Customize"), a:has-text("Customize"), [role="button"]:has-text("Customize"), button:has-text("Configure"), a:has-text("Configure"), [role="button"]:has-text("Configure"), button:has-text("Build"), a:has-text("Build")').first();
        await configure.waitFor({ state: 'visible', timeout: 30_000 });
        const launched = page.waitForResponse(response => /\/api\/ctos\/7D73CTO1WW\/launch/.test(response.url()) && response.request().method() === 'POST', { timeout: 60_000 });
        await configure.click();
        const response = await launched;
        assert.equal(response.status(), 200);
        return object(await response.json());
      });
      const facts = (raw: Json) => ({ sliceCtoCode: raw['sliceCtoCode'], type: raw['type'], bom: selectedBom(raw) });
      h.compare('website-matches-captured-launch', facts(LAUNCH_FIXTURE), facts(web));
      await h.step('mcp', async () => {
        const launched = await h.mcp.call('dcsc_launch', { productCode: SERVER, mode: 'cto', solutionMode: 'General Purpose' });
        const saved = h.mcp.persistedWorkspaces().find(entry => entry['id'] === launched['workspace'])!;
        const raw = object(object(rows(saved['configurations'])[0])['raw']);
        h.compare('launch-differential', { ...facts(web), totalPrice: web['totalPrice'] }, { ...facts(raw), totalPrice: raw['totalPrice'] });
      });
    },
  };
}

function hardwareCase(quantity: number): ParityCase {
  const row = rows(QUANTITY_FIXTURE['hardwareMatrix']).find(entry => entry['requestedQuantity'] === quantity)!;
  const source = xmlPath(QUANTITY_XML.get(quantity)!);
  return {
    id: `quantity-handoff-${quantity}`,
    tags: ['import', 'export', 'quantity'],
    mode: 'in-process',
    async run(h: Harness) {
      const { mcp, step, compare, compareRequest } = h;
      const byCode = (left: { code: string }, right: { code: string }) => left.code.localeCompare(right.code);
      compare('fixture-xml-products',
        rows(row['products']).map(product => ({ code: text(product['code']).replaceAll('-', ''), quantity: product['quantity'], unitPrice: product['unitListPrice'] })).sort(byCode),
        normalizers.cfxml(readFileSync(source, 'utf8')).map(line => ({ code: line.code, quantity: line.quantity, unitPrice: line.unitPrice })).sort(byCode));

      const websiteFacts = await step('website-import', async () => {
        const page = await h.web.newPage();
        const { response } = await importInBrowser(page, source, SUMMARY_ROUTE);
        const facts = importedFacts(object(array(response)[0]), quantity);
        compare('website-import-shape', { configurations: 1, rawQuantities: [1], hardwareSalesQuantity: quantity, dependentsAllMatch: true }, facts);
        return facts;
      });
      if (quantity === 1) return;

      const mcpExport = await step('mcp', async () => {
        const imported = await mcp.call('dcsc_import', { filePath: source, solutionMode: 'General Purpose' });
        const workspace = String(imported['session']);
        const saved = mcp.persistedWorkspaces().find(entry => entry['id'] === workspace)!;
        const ids = rows(saved['configurations']).map(entry => text(entry['configurationId']));
        compare('mcp-import', { configurations: quantity, rawQuantities: Array(quantity).fill(1), uniqueIds: quantity, nonRack: quantity, physicalIdsMatch: true },
          { configurations: ids.length, rawQuantities: rows(saved['configurations']).map(entry => object(entry['raw'])['quantity']), uniqueIds: new Set(ids).size,
            nonRack: rows(saved['nonRackArea']).length, physicalIdsMatch: JSON.stringify(rows(saved['nonRackArea']).map(item => text(item['id'])).sort()) === JSON.stringify([...ids].sort()) });
        const exported = await mcp.call('dcsc_export', { kind: 'reports', session: workspace, scope: 'workspace', fileName: `parity-quantity-${quantity}`, fileTypes: ['XML'] });
        const form = mcp.requests.filter(request => request.path.endsWith('/export_zip')).at(-1);
        assert(form, 'MCP export did not post /export_zip.');
        return { ids, exported, form, workspace: saved, xml: String(exported['xml']) };
      });

      await step('website-reimport', async () => {
        const page = await h.web.newPage();
        const envelope = await importLarge(page, mcpExport.xml);
        await page.waitForTimeout(8_000);
        const exportedQuantities = quantitiesByCode({ lines: normalizers.cfxml(readFileSync(mcpExport.xml, 'utf8')) });
        const browserQuantities = quantitiesByCode({ groups: envelope['groups'] });
        compare('browser-reimport-quantities', { ...websiteFacts, quantities: Object.fromEntries(GROUPED_CODES.map(code => [code, quantity])) },
          { ...importedFacts(envelope, quantity), quantities: Object.fromEntries(GROUPED_CODES.map(code => [code, browserQuantities[code]])) });
        compare('browser-reimport-matches-export', exportedQuantities, Object.fromEntries(Object.keys(exportedQuantities).map(code => [code, browserQuantities[code]])));

        const final = await captureBrowserExport(page, h.out, `browser-final-quantity-${quantity}`);
        const configurations = array(final.data['configurations']).map(object);
        const workspaceInformation = object(final.data['workspaceInformation']);
        const dependency = object(workspaceInformation['cloneDependency']);
        const colors = object(final.data['cloneDependencyColor']);
        const owners = Object.values(dependency).flatMap(members => array(members).map(text));
        compare('browser-final-workspace',
          { configurations: quantity, physical: quantity, ids: [...mcpExport.ids].sort(), rootsMatchColors: true, membersOwnThemselves: true, ownership: [...mcpExport.ids].sort() },
          { configurations: configurations.length, physical: array(workspaceInformation['nonRackData']).length, ids: configurations.map(item => text(item['id'])).sort(),
            rootsMatchColors: JSON.stringify(Object.keys(dependency).sort()) === JSON.stringify(Object.keys(colors).sort()),
            membersOwnThemselves: Object.entries(dependency).every(([root, members]) => array(members).includes(root) && JSON.stringify(array(object(colors[root])['dependBy']).sort()) === JSON.stringify(array(members).map(text).sort())),
            ownership: [...new Set(owners)].sort() });
        compareRequest('commercial-groups', { method: 'POST', path: final.capture.path, body: final.capture.fields }, mcpExport.form, { normalize: aggregateGroups });
        compare('xml-products', xmlProducts(final.xml), xmlProducts(readFileSync(mcpExport.xml, 'utf8')));
      });
    },
  };
}

function softwareCase(): ParityCase {
  const expected = object(QUANTITY_FIXTURE['standaloneSoftwareQuantity3']);
  return {
    id: 'quantity-handoff-software',
    tags: ['import', 'quantity', 'software'],
    async run(h) {
      await h.step('website-import', async () => {
        const { response } = await importInBrowser(await h.web.newPage(), SOFTWARE_XML, SUMMARY_ROUTE);
        const envelope = object(array(response)[0]);
        const product = array(envelope['standaloneData']).map(object).find(item => item['code'] === SOFTWARE_CODE);
        const groupProduct = array(object(array(envelope['groups'])[0])['products']).map(object).find(item => item['code'] === SOFTWARE_CODE);
        h.compare('standalone-import-prices', { quantity: expected['quantity'], price: object(object(expected['importResponse'])['standaloneData'])['price'],
          groupPrice: object(object(expected['importResponse'])['groupProduct'])['price'], groupUnitPrice: object(object(expected['importResponse'])['groupProduct'])['unitPrice'] },
        { quantity: product?.['quantity'], price: product?.['price'], groupPrice: groupProduct?.['price'], groupUnitPrice: groupProduct?.['unitPrice'] });
      });
    },
  };
}

export default [launchCase(), ...[1, 4, 8].map(hardwareCase), softwareCase()];
