/** LFO-as-CTO: website hardware edit, export and re-import against the MCP's edit request, export form and re-import. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CAPTURE_EXPORT_FORMS } from '../exportUi.js';
import { normalizers, type Harness, type Json, type ParityCase } from '../harness.js';
import { settle } from '../settingsUi.js';
import {
  array, captureBrowserExport, importInBrowser, money, object, setBrowserHardwareOption,
} from '../softwareSummaryUi.js';

const PRODUCT = '7DCE100GNA';
const FEATURE = 'BFYB';
const SECTION = 'UEFI_OPERATING_MODES';
const CATEGORY = 'STG@Servers@Tower Server@ThinkSystem ST250 V3';
const SUMMARY_ROUTE = /#\/rack-summary\/rack-cto$/;
const DELTA_FIELDS = ['section', 'featureCode', 'quantity', 'isClear', 'type'];
const QUERY_FIELDS = ['entranceFlag', 'guideMode'];

const selectedQuantity = (configuration: Json, code: string): number =>
  Number(array(configuration['tabs']).flatMap(tab => array(object(tab)['subTabs']))
    .flatMap(tab => array(object(tab)['sections'])).flatMap(section => array(object(section)['results']))
    .map(object).find(result => result['code'] === code)?.['quantity'] ?? 0);
const commercialPrice = (configuration: Json): number =>
  money(configuration['price'] ?? object(array(configuration['totalPrices'])[0])['price']);
const pick = (source: Json, fields: string[]) => Object.fromEntries(fields.map(field => [field, source[field]]));
const queryOf = (query: Json | undefined) =>
  Object.fromEntries(QUERY_FIELDS.map(field => [field, String(query?.[field])]));
const deltaOf = (body: unknown) => pick(object(object(array(object(body)['configurations'])[0])['delta']), DELTA_FIELDS);
const groupsOf = (fields: unknown) => ({ groups: normalizers.wireRequest(fields as Record<string, string>).groups });

async function launchOnWebsite(h: Harness) {
  const page = await h.web.newPage();
  page.setDefaultTimeout(90_000);
  await page.addInitScript({ content: CAPTURE_EXPORT_FORMS });
  await page.goto(`https://dcsc.lenovo.com/#/categories/${encodeURIComponent(CATEGORY)}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await settle(page);
  const cookie = page.locator('.dcsc-cookie-close').first();
  if (await cookie.isVisible({ timeout: 1_000 }).catch(() => false)) await cookie.click();
  const link = page.getByRole('link').filter({ hasText: PRODUCT });
  await link.first().waitFor({ state: 'visible', timeout: 60_000 });
  assert.equal(await link.count(), 1, `Website category did not expose as-CTO product ${PRODUCT}.`);
  const pending = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes(`/lfos/${PRODUCT}/as_cto_launch`), { timeout: 120_000 });
  await link.click();
  const launch = await pending;
  assert.equal(launch.status(), 200, `Website as-CTO launch returned HTTP ${launch.status()}.`);
  await page.waitForURL(/#\/configuration\/lfo-as-cto\//, { timeout: 90_000 });
  await settle(page);
  await page.getByRole('button', { name: 'Summary' }).click();
  await page.waitForURL(/#\/rack-summary\/rack-cto/, { timeout: 90_000 });
  await settle(page);
  return { page, launch: object(await launch.json()) };
}

const reimported = async (h: Harness, xmlPath: string) => {
  const page = await h.web.newPage();
  const { response } = await importInBrowser(page, xmlPath, SUMMARY_ROUTE);
  const envelope = object(array(response)[0]);
  const configurations = array(envelope['configuration']).map(object);
  return {
    type: envelope['type'], configurations: configurations.length, missingParts: array(envelope['missingParts']).length,
    removedParts: array(envelope['removedParts']).length, selectedQuantity: selectedQuantity(configurations[0] ?? {}, FEATURE),
    price: commercialPrice(configurations[0] ?? {}), totalPrice: money(configurations[0]?.['totalPrice']),
    groups: normalizers.wireRequest({ groups: JSON.stringify(envelope['groups']) }).groups,
  };
};

export default {
  id: 'lfo-as-cto',
  tags: ['software', 'export', 'import'],
  mode: 'in-process',
  async run(h) {
    const { mcp, step, compare, compareRequest, out } = h;

    const website = await step('website', async () => {
      const { page, launch } = await launchOnWebsite(h);
      const hardware = await setBrowserHardwareOption(page, out, {
        derivePath: '/ctos/autoDerive', configuration: /#\/configuration\/(?:lfo-as-cto|cto)\//,
        summary: /#\/rack-summary\/rack-(?:cto|lfo)/, expectInitialDerive: false,
      });
      return { launch, hardware, exported: await captureBrowserExport(page, out, 'browser-as-cto-bfyb') };
    });

    const mcpRun = await step('mcp', async () => {
      const launched = await mcp.call('dcsc_launch', { productCode: PRODUCT, mode: 'lfo-as-cto', solutionMode: 'General Purpose', label: 'LFO as CTO parity' });
      const session = String(launched['session']);
      const workspaceId = String(launched['workspace']);
      const persisted = () => object(array(mcp.persistedWorkspaces().find(entry => entry['id'] === workspaceId)?.['configurations'])[0]);
      const launchedState = persisted();
      compare('launch-identity', { lfoCode: PRODUCT, sliceCtoCode: website.launch['sliceCtoCode'], mode: 'lfo-as-cto', primed: true },
        { lfoCode: PRODUCT, sliceCtoCode: object(launchedState['raw'])['sliceCtoCode'], mode: launchedState['mode'], primed: launchedState['primed'] });
      await mcp.call('dcsc_configure', { session, changes: [{ section: SECTION, code: FEATURE, quantity: 1 }] });
      const derive = mcp.requests.filter(request => request.path === '/ctos/autoDerive').at(-1);
      assert(derive, 'MCP edit did not call /ctos/autoDerive.');
      const edited = object(persisted()['raw']);
      const exported = await mcp.call('dcsc_export', { kind: 'reports', session, scope: 'configuration', fileName: 'mcp-as-cto-bfyb', fileTypes: ['XML'] });
      const form = mcp.requests.filter(request => request.path.endsWith('/export_zip')).at(-1);
      assert(form, 'MCP export did not post /export_zip.');
      return { derive, edited, form, xmlPath: String(exported['xml']) };
    });

    await step('compare', async () => {
      const { hardware, exported } = website;
      compareRequest('hardware-edit-request',
        { method: 'POST', path: '/ctos/autoDerive', query: queryOf(hardware.query), body: hardware.request },
        { ...mcpRun.derive, query: queryOf(object(mcpRun.derive.query)) }, { normalize: deltaOf });
      compare('hardware-edit-state', { selected: 1, price: hardware.price, totalPrice: hardware.totalPrice },
        { selected: selectedQuantity(mcpRun.edited, FEATURE), price: commercialPrice(mcpRun.edited), totalPrice: money(mcpRun.edited['totalPrice']) });
      compareRequest('export-form', { method: 'POST', path: exported.capture.path, body: exported.capture.fields },
        mcpRun.form, { normalize: groupsOf });
      compare('export-xml-bom', normalizers.cfxml(exported.xml), normalizers.cfxml(await readFile(mcpRun.xmlPath, 'utf8')));
      const webReimport = await reimported(h, exported.xmlPath);
      const mcpReimport = await reimported(h, mcpRun.xmlPath);
      compare('reimport', webReimport, mcpReimport);
      compare('reimport-accepted-as-cto', { type: 'cto', configurations: 1, missingParts: 0, removedParts: 0, selectedQuantity: 1 },
        pick(mcpReimport, ['type', 'configurations', 'missingParts', 'removedParts', 'selectedQuantity']));
    });
  },
} satisfies ParityCase;
