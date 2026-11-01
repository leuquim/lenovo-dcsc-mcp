/** Copy and Clone Multiple on a racked server: website customize and export requests against dcsc_rack_edit, linked edit and root delete. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Page, Request } from 'playwright';

import { normalizers, type Harness, type Json, type ParityCase } from '../harness.js';
import { exportFromWorkspace, ONE_RACK_XML, openWorkspace, reimportEnvelope, rows, SERVER_CODE } from '../rackUi.js';
import { array, object } from '../softwareSummaryUi.js';

type Action = 'copy' | 'clone';
interface Variant { id: string; action: Action; clones: number; edit?: 'source' | 'member'; deleteRoot?: boolean }

const CUSTOMIZE_PATH = '/ctos/racks/customize';
const LINKED_FEATURE = { section: 'PROCESSOR', code: 'BYW3', quantity: 2 };
const text = (value: unknown) => value === null || value === undefined ? '' : String(value);
const num = (value: unknown) => Number(value) || 0;
const byJson = (left: unknown, right: unknown) => JSON.stringify(left).localeCompare(JSON.stringify(right));

const serverIdentities = (body: unknown) => {
  const servers = rows(object(body)['configurations']).filter(item => (item['sliceCtoCode'] ?? item['code']) === SERVER_CODE);
  return { servers: servers.length, independent: new Set(servers.map(item => item['id'])).size,
    racks: rows(object(body)['rackArea']).map(rack => rows(rack['rackItems']).map(item => ({ code: item['code'], position: item['position'], size: item['size'] }))) };
};
const exportShape = (fields: unknown) => {
  const data = object(JSON.parse(text(object(fields)['data']) || '{}'));
  const dependency = object(object(data['workspaceInformation'])['cloneDependency']);
  return {
    cloneDependencySizes: Object.values(dependency).map(members => array(members).length).sort(),
    configurations: rows(data['configurations']).map(item => ({ code: item['sliceCtoCode'] ?? item['code'], quantity: num(item['quantity']), totalPrice: num(item['totalPrice']) })).sort(byJson),
    groups: normalizers.wireRequest({ groups: text(object(fields)['groups']) || '[]' }).groups,
  };
};
const processorResults = (configuration: Json) => rows(array(configuration['tabs']).flatMap(tab => array(object(tab)['subTabs'])).flatMap(tab => array(object(tab)['sections']))
  .map(object).find(section => section['name'] === LINKED_FEATURE.section)?.['results']).map(result => ({ code: result['code'], quantity: result['quantity'] }));

async function websiteRun(h: Harness, variant: Variant, page: Page) {
  const customizes: Request[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes(`/api${CUSTOMIZE_PATH}`)) customizes.push(request); });
  const servers = page.locator('.rack-server');
  const before = await servers.count();
  await servers.first().click();
  const modal = page.locator('.ant-modal:visible').last();
  if (variant.action === 'copy') {
    await page.getByText('Copy', { exact: true }).last().click();
    await modal.getByText('Number of copies', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  } else {
    await page.getByText('Clone Multiple', { exact: true }).last().click();
    await modal.getByText('Number of clones', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  }
  const count = modal.locator('input.ant-input-number-input').first();
  await count.fill(variant.action === 'copy' ? '1' : String(variant.clones));
  await count.press('Tab');
  await modal.locator('button.ant-btn-primary:visible').last().click();
  await page.waitForFunction(expected => document.querySelectorAll('.rack-server').length > Number(expected), before, { timeout: 180_000 });
  await page.waitForTimeout(12_000);
  const actionRequest = customizes.at(-1);
  assert(actionRequest, `${variant.action} emitted no customize request.`);
  const request = { method: 'POST', path: new URL(actionRequest.url()).pathname, body: actionRequest.postDataJSON() as unknown };

  if (variant.deleteRoot) {
    const total = await servers.count();
    await servers.first().click();
    await page.getByText('Delete', { exact: true }).last().waitFor({ state: 'visible', timeout: 10_000 });
    const pending = page.waitForResponse(response => response.url().includes(`/api${CUSTOMIZE_PATH}`) && response.request().method() === 'POST', { timeout: 120_000 });
    await page.getByText('Delete', { exact: true }).last().click();
    const confirm = page.locator('.ant-modal:visible').last();
    if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) await confirm.locator('button.ant-btn-primary:visible').last().click();
    assert.equal((await pending).status(), 200, 'Linked deletion customize status');
    await page.waitForFunction(expected => document.querySelectorAll('.rack-server').length < Number(expected), total, { timeout: 120_000 });
    await page.waitForTimeout(8_000);
  }
  if (variant.edit) {
    const workspaceUrl = page.url();
    await (variant.edit === 'source' ? servers.first() : servers.last()).click();
    await page.getByText('Customize', { exact: true }).last().click();
    await page.waitForURL(/#\/configuration\/cto\//, { timeout: 60_000 });
    await page.waitForTimeout(7_000);
    await page.getByText('Processors', { exact: true }).first().click();
    await page.waitForTimeout(1_000);
    await page.getByText('Processors', { exact: true }).last().click();
    await page.waitForTimeout(3_000);
    await page.locator('[class~="BYW3"] .ant-select-selection').first().click();
    const derived = page.waitForResponse(response => response.url().includes('/api/ctos/autoDerive') && response.request().method() === 'POST', { timeout: 120_000 });
    await page.locator('.ant-select-dropdown:visible .ant-select-dropdown-menu-item').filter({ hasText: /^2$/ }).click();
    assert.equal((await derived).status(), 200, 'Linked source edit derive status');
    await page.waitForTimeout(5_000);
    const toWorkspace = page.getByText('Go to Workspace', { exact: true }).first();
    if (await toWorkspace.isVisible().catch(() => false)) await toWorkspace.click();
    else {
      await page.goBack({ waitUntil: 'domcontentloaded' });
      if (!/#\/rack-configuration/.test(page.url())) await page.goto(workspaceUrl);
    }
    await page.waitForURL(/#\/rack-configuration/, { timeout: 60_000 });
    await page.waitForTimeout(5_000);
  }
  const exported = await exportFromWorkspace(page, h.out, `browser-${variant.id}`);
  return { request, exportRequest: { method: 'POST', path: exported.form.path, body: exported.form.fields } };
}

function variantCase(variant: Variant): ParityCase {
  return {
    id: variant.id,
    tags: ['rack', 'export'],
    mode: 'in-process',
    async run(h) {
      const { mcp, step, compare, compareRequest } = h;
      const website = await step('website', async () => websiteRun(h, variant, await openWorkspace(h, ONE_RACK_XML)));

      await step('mcp', async () => {
        const imported = await mcp.call('dcsc_import', { content: await readFile(ONE_RACK_XML, 'utf8'), solutionMode: 'General Purpose' });
        const workspace = String(imported['session']);
        const saved = () => mcp.persistedWorkspaces().find(entry => entry['id'] === workspace)!;
        const servers = () => rows(saved()['configurations']).filter(entry => object(entry['product'])['code'] === SERVER_CODE);
        const source = servers()[0]!;
        const sourceSession = String(source['id']);
        const customizeCalls = () => mcp.requests.filter(request => request.path === CUSTOMIZE_PATH).length;

        const beforeAction = customizeCalls();
        let created: string[];
        if (variant.action === 'copy') {
          await mcp.call('dcsc_rack_edit', { session: workspace, action: 'copy', configuration: sourceSession });
          created = [];
        } else {
          const cloned = await mcp.call('dcsc_rack_edit', { session: workspace, action: 'clone', configuration: sourceSession,
            count: variant.clones, placement: 'same-rack', labelPrefix: 'Node' });
          created = rows(cloned['created']).map(entry => String(entry['session']));
        }
        const actionRequest = mcp.requests.filter(request => request.path === CUSTOMIZE_PATH).slice(beforeAction).at(-1);
        assert(actionRequest, `MCP ${variant.action} emitted no customize request.`);
        compareRequest('action-request', website.request, actionRequest, { normalize: serverIdentities });

        if (variant.edit) {
          await mcp.call('dcsc_configure', { session: variant.edit === 'source' ? sourceSession : created[0], changes: [LINKED_FEATURE] });
        }
        if (variant.deleteRoot) await mcp.call('dcsc_rack_edit', { session: workspace, action: 'remove', configuration: sourceSession });

        const exported = await mcp.call('dcsc_export', { kind: 'reports', session: workspace, scope: 'workspace', fileName: `mcp-${variant.id}`, fileTypes: ['XML', 'QUOTE'] });
        const exportRequest = mcp.requests.filter(request => request.path.endsWith('/export_zip')).at(-1);
        assert(exportRequest, 'MCP export did not post /export_zip.');
        compareRequest('export-request', website.exportRequest, exportRequest, { normalize: exportShape });

        const survivors = servers();
        const placed = rows(saved()['rackArea']).flatMap(rack => rows(rack['rackItems']))
          .filter(item => survivors.some(entry => entry['configurationId'] === item['id'])).sort((left, right) => num(left['position']) - num(right['position']));
        const handoff = await reimportEnvelope(h, String(exported['xml']));
        const reimported = rows(handoff['configuration']).filter(entry => (entry['sliceCtoCode'] ?? entry['code']) === SERVER_CODE);
        const reimportedPlaced = rows(object(handoff['floorInformation'])['floorGrid']).flatMap(cell => rows(cell['items']))
          .filter(item => reimported.some(entry => entry['id'] === item['id'])).sort((left, right) => num(left['position']) - num(right['position']));
        compare('browser-reimport-of-mcp-export', {
          ids: survivors.map(entry => text(entry['configurationId'])).sort(),
          quantities: survivors.map(() => 1),
          positions: placed.map(item => num(item['position'])),
          ...(variant.edit ? { processors: survivors.map(() => [{ code: LINKED_FEATURE.code, quantity: LINKED_FEATURE.quantity }]) } : {}),
        }, {
          ids: reimported.map(entry => text(entry['id'])).sort(),
          quantities: reimported.map(entry => num(entry['quantity'])),
          positions: reimportedPlaced.map(item => num(item['position'])),
          ...(variant.edit ? { processors: reimported.map(processorResults) } : {}),
        });
      });
    },
  };
}

export default ([
  { id: 'rack-copy', action: 'copy', clones: 1 },
  { id: 'rack-clone', action: 'clone', clones: 1 },
  { id: 'rack-clone-edit-source', action: 'clone', clones: 1, edit: 'source' },
  { id: 'rack-clone-edit-member', action: 'clone', clones: 1, edit: 'member' },
  { id: 'rack-clone-delete-root', action: 'clone', clones: 2, deleteRoot: true },
] satisfies Variant[]).map(variantCase) satisfies ParityCase[];
