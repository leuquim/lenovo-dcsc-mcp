/** Dense D3 chassis with an SD535 node: website launch, nested placement and export against the MCP's launch, nested placement and export. */
import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright';

import { openBrowserImportHome } from '../browser.js';
import { CAPTURE_EXPORT_FORMS } from '../exportUi.js';
import type { Json, ParityCase } from '../harness.js';
import { exportFromWorkspace, RACK_CODE, reimportEnvelope, rows } from '../rackUi.js';
import { object } from '../softwareSummaryUi.js';

const WEBSITE_MODE = 'AI & HPC – ThinkSystem Hardware';
const MCP_MODE = 'HPC and AI - Systems';
const CHASSIS = '7DD0CTOLWW';
const NODE = '7DD1CTOLWW';
const ROUTES: Record<string, string> = {
  [CHASSIS]: 'STG%40Servers%40Multi-Node%40ThinkSystem%20D3%20Chassis',
  [NODE]: 'STG%40Servers%40Multi-Node%40ThinkSystem%20SD535%20V3',
};
const RANDOM_IDS = new Set(['id', 'originalId', 'vlhId']);

const withoutRandomIds = (value: unknown): unknown => Array.isArray(value) ? value.map(withoutRandomIds)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !RANDOM_IDS.has(key)).map(([key, inner]) => [key, withoutRandomIds(inner)]))
    : value;
const text = (value: unknown) => value === undefined || value === null ? '' : String(value);
const physical = (item: Json): Json => ({
  code: item['code'] ?? item['sliceCtoCode'], type: item['type'], position: item['position'], size: item['size'],
  occupiedBay: item['occupiedBay'], capacity: item['capacity'], chassisModel: item['chassisModel'], asVLH: item['asVLH'] === true,
  nodes: rows(item['nodes']).map(physical), children: rows(item['children']).map(physical),
});
/** Configurations, rack and loose contents of an export form's data, an import envelope or a customize response, without random ids. */
function layout(value: unknown): unknown {
  const root = object(value);
  const information = object(root['workspaceInformation']);
  const workspace = object(root['workspace']);
  const pick = (...candidates: Json[][]) => candidates.find(rowsFound => rowsFound.length > 0) ?? [];
  const configurations = pick(rows(root['configurations']), rows(root['configuration']), rows(information['configurations']));
  return withoutRandomIds({
    configurations: configurations.map(item => ({ code: item['code'] ?? item['sliceCtoCode'], type: item['type'],
      quantity: Number(item['quantity']), totalPrice: Number(item['totalPrice']), asVLH: item['asVLH'] === true })),
    racks: pick(rows(root['rackArea']), rows(information['rackData']), rows(workspace['rackArea'])).map(physical),
    nonRack: pick(rows(root['nonRackArea']), rows(information['nonRackData']), rows(workspace['nonRackArea'])).map(physical),
  });
}
const countNodes = (items: Json[]): number => items.reduce((total, item) =>
  total + (item['type'] === 'node' ? 1 : 0) + countNodes([...rows(item['nodes']), ...rows(item['children'])]), 0);
const exportedLayout = (fields: unknown) => layout(JSON.parse(text(object(fields)['data']) || '{}'));

async function launchOnWebsite(page: Page, code: string): Promise<void> {
  await page.goto(`https://dcsc.lenovo.com/#/categories/${ROUTES[code]}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForTimeout(5_000);
  const pending = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes(`/api/ctos/${code}/launch`), { timeout: 120_000 });
  const button = page.locator(`a[href*="${code}"] button`).first();
  await button.waitFor({ state: 'visible', timeout: 30_000 });
  await button.click();
  assert.equal((await pending).status(), 200, `${code} launch status`);
  await page.waitForURL(/#\/configuration\/cto\//, { timeout: 60_000 });
  await page.waitForTimeout(8_000);
  await page.getByText('Summary', { exact: true }).first().click();
  await page.waitForURL(/#\/rack-summary\//, { timeout: 60_000 });
  await page.waitForTimeout(8_000);
}

async function dragChassisToRack(page: Page, source: Locator): Promise<void> {
  const box = await source.boundingBox();
  assert(box, 'Nested chassis drag source must have visible bounds.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2, { steps: 5 });
  await page.waitForTimeout(500);
  const targets = page.locator('.rack-empty-unit:visible');
  for (let index = await targets.count() - 1; index >= 0; index -= 1) {
    const target = targets.nth(index);
    const targetBox = await target.boundingBox();
    if (!targetBox) continue;
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 4 });
    await page.waitForTimeout(200);
    if (!((await target.locator('.rack-empty-placement').getAttribute('style')) ?? '').includes('background-color')) continue;
    await page.waitForTimeout(500);
    await page.mouse.up();
    return;
  }
  await page.mouse.up();
  throw new Error('No rack U accepted the compatible nested chassis drag.');
}

async function placeFromNonRack(page: Page, code: string): Promise<void> {
  const candidates = page.locator('.ant-collapse-item').filter({ hasText: new RegExp(code) });
  let container: Locator | undefined;
  for (let index = await candidates.count() - 1; index >= 0 && !container; index -= 1) {
    if (await candidates.nth(index).isVisible().catch(() => false)) container = candidates.nth(index);
  }
  assert(container, `Could not find a visible non-rack group for ${code}.`);
  if ((await container.locator('.ant-collapse-header').first().getAttribute('aria-expanded')) !== 'true') await container.locator('.ant-collapse-header').first().click();
  await page.waitForTimeout(750);
  const cloneGroup = container.locator('.ant-collapse-item').last();
  if (await cloneGroup.count() > 0 && (await cloneGroup.locator('.ant-collapse-header').first().getAttribute('aria-expanded')) !== 'true') {
    await cloneGroup.locator('.ant-collapse-header').first().click();
    await page.waitForTimeout(750);
  }
  const customized = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/api/ctos/racks/customize'), { timeout: 180_000 });
  if (code === CHASSIS) {
    const source = container.locator('.rack-chassis, .rack-horizontal-chassis, .rack-server').last();
    await source.waitFor({ state: 'visible', timeout: 15_000 });
    await dragChassisToRack(page, source);
  } else {
    await page.locator('.rack-chassis:visible, .rack-horizontal-chassis:visible').last().click();
    const addNode = page.getByText('Add Node', { exact: true }).last();
    await addNode.waitFor({ state: 'visible', timeout: 15_000 });
    await addNode.click();
    await page.locator('.ant-cascader-menus:visible').waitFor({ state: 'visible', timeout: 15_000 });
    for (const option of [
      page.getByText('Already Configured Nodes', { exact: true }).last(),
      page.getByText(new RegExp(`\\[\\s*${code}\\s*\\][\\s\\S]*Node[\\s\\S]*Non Rack Area`, 'i')).last(),
    ]) {
      await option.waitFor({ state: 'visible', timeout: 15_000 });
      await option.hover();
      await page.waitForTimeout(500);
    }
    await page.getByText('As Copy', { exact: true }).last().click();
  }
  assert.equal((await customized).status(), 200, `${code} move customize`);
  await page.waitForTimeout(12_000);
}

async function disableAutomatedRackPdu(page: Page): Promise<void> {
  const settings = page.locator('.auto-connect__label:visible').first().locator('xpath=..').locator('.anticon-setting').first();
  await settings.waitFor({ state: 'visible', timeout: 15_000 });
  await settings.click();
  const automatedPdu = page.getByText('Automated Rack PDU', { exact: true }).last();
  await automatedPdu.waitFor({ state: 'visible', timeout: 10_000 });
  if (await automatedPdu.locator('xpath=ancestor::label[1]').locator('input[type="checkbox"]').isChecked()) {
    await automatedPdu.click();
    await page.waitForTimeout(8_000);
  }
  await settings.click().catch(() => undefined);
  await page.waitForTimeout(500);
}

export default {
  id: 'nested-vlh',
  tags: ['rack', 'nested', 'export'],
  mode: 'in-process',
  async run(h) {
    const { mcp, step, compare, compareRequest } = h;

    const website = await step('website', async () => {
      const page = await h.web.newPage();
      page.setDefaultTimeout(90_000);
      await page.addInitScript({ content: CAPTURE_EXPORT_FORMS });
      await openBrowserImportHome(page, WEBSITE_MODE, { diagnosticsDir: h.out });
      await launchOnWebsite(page, CHASSIS);
      await launchOnWebsite(page, NODE);
      await page.getByText('Go to Workspace', { exact: true }).first().click();
      await page.waitForURL(/#\/rack-configuration/, { timeout: 60_000 });
      await page.waitForTimeout(8_000);
      await page.getByText('Rack', { exact: true }).first().click();
      const derived = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/api/ctos/autoDerive'), { timeout: 180_000 });
      await page.getByText(new RegExp(RACK_CODE)).first().dblclick();
      assert.equal((await derived).status(), 200, 'rack derive status');
      await page.waitForTimeout(8_000);
      await disableAutomatedRackPdu(page);
      await placeFromNonRack(page, CHASSIS);
      await placeFromNonRack(page, NODE);
      const nested = {
        chassisCount: await page.locator('.rack-chassis:visible, .rack-horizontal-chassis:visible').count(),
      };
      const exported = await exportFromWorkspace(page, h.out, 'browser-nested-vlh');
      const reimport = layout(await reimportEnvelope(h, exported.xmlPath));
      const nodeCount = countNodes(rows(object(reimport)['racks']));
      return { nested: { ...nested, nodeCount }, exported, reimport };
    });

    await step('mcp', async () => {
      const chassis = await mcp.call('dcsc_launch', { productCode: CHASSIS, mode: 'cto', solutionMode: MCP_MODE });
      const workspace = String(chassis['workspace']);
      const node = await mcp.call('dcsc_launch', { productCode: NODE, mode: 'cto', solutionMode: MCP_MODE, session: workspace });
      const added = await mcp.call('dcsc_rack_add', { session: workspace, rackCode: RACK_CODE });
      const rackId = String(rows(added['racks'])[0]?.['rackId']);
      await mcp.call('dcsc_rack_edit', { session: workspace, action: 'place', rackId, configuration: chassis['session'] });
      const saved = () => mcp.persistedWorkspaces().find(entry => entry['id'] === workspace)!;
      const chassisId = String(rows(saved()['configurations']).find(entry => entry['id'] === chassis['session'])?.['configurationId']);
      const placed = await mcp.call('dcsc_rack_edit', { session: workspace, action: 'place', rackId, chassisId, configuration: node['session'] });
      compare('nested-placement', { chassis: website.nested.chassisCount, nodes: website.nested.nodeCount },
        { chassis: rows(rows(saved()['rackArea'])[0]?.['rackItems']).filter(item => item['id'] === chassisId).length,
          nodes: rows(rows(rows(saved()['rackArea'])[0]?.['rackItems']).find(item => item['id'] === chassisId)?.['nodes']).length });
      assert(placed['nestedPlacement'], 'MCP placement did not return nestedPlacement.');

      const exported = await mcp.call('dcsc_export', { kind: 'reports', session: workspace, scope: 'workspace', fileName: 'nested-vlh-mcp', fileTypes: ['XML', 'QUOTE'] });
      const form = mcp.requests.filter(request => request.path.endsWith('/export_zip')).at(-1);
      assert(form, 'MCP export did not post /export_zip.');
      compareRequest('export-layout', { method: 'POST', path: website.exported.form.path, body: website.exported.form.fields }, form, { normalize: exportedLayout });
      compare('browser-reimport-layout', website.reimport, layout(await reimportEnvelope(h, String(exported['xml']))));
    });
  },
} satisfies ParityCase;
