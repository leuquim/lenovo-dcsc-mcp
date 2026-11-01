/** FC storage Direct Attached Auto-Connect: the website's UI flow against the MCP's update + Auto-Connect on the same export. */
import assert from 'node:assert/strict';
import path from 'node:path';

import type { Page } from 'playwright';

import { HPC_MODE, object, persistedWorkspace, rows, text, websiteImport, type Obj } from '../fabric.js';
import type { ParityCase } from '../harness.js';

const SEED = path.resolve('test/fixtures/parity/xml/storage-fc-zero-graph.xml');
const STORAGE_NAME = 'Parity Postplacement Edit';
const SERVER_CODE = '7D73CTOHWW';
const CONTROLLER_OPTION = '7Y70CTOHWW';
const SAN_SWITCH_OPTION = '7D8PCTO1WW';
const FC_TOPOLOGY = /\b(?:8|16|32|64)Gb(?:E)?_Fibre\b|Fibre Channel|\bFC\b/i;
const SELECTED_FEATURES: Array<[string, string, number]> = [['server', 'ATZV', 1], ['controller', 'B4DA', 1], ['controller', 'B4B7', 2], ['controller', 'B4B2', 8]];

function selectedFeatureQuantity(value: unknown, featureCode: string): number | undefined {
  const quantities: number[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node === null || typeof node !== 'object') return;
    const row = node as Obj;
    if (text(row['featureCode'] || row['code']) === featureCode) {
      const quantity = Number(row['selectedQuantity'] ?? row['quantity']);
      if (Number.isFinite(quantity)) quantities.push(quantity);
    }
    Object.values(row).forEach(visit);
  };
  visit(value);
  return quantities.length > 0 ? Math.max(...quantities) : undefined;
}

const selectedFeatures = (configurations: Obj[]) => {
  const owner = { server: configurations.find(item => item['selectedStorageNetwork'] === STORAGE_NAME && item['code'] === SERVER_CODE),
    controller: configurations.find(item => item['code'] === CONTROLLER_OPTION) };
  return Object.fromEntries(SELECTED_FEATURES.map(([who, code]) => [`${who}:${code}`, selectedFeatureQuantity(owner[who as 'server' | 'controller'], code)]));
};

function storageConnections(connections: Obj[], controllerOption: string) {
  return connections.filter(connection => connection['network'] === STORAGE_NAME || /storage|fibre|fiber|fc/i.test(text(connection['network']))
    || /storage/i.test(text(connection['subType'])) || (FC_TOPOLOGY.test(text(connection['topology'])) && controllerOption !== ''
      && [connection['sourcePart'], connection['destinationPart']].includes(controllerOption)))
    .map(connection => ({ network: connection['network'], topology: connection['topology'], sourceCode: connection['sourcePart'],
      destinationCode: connection['destinationPart'], cableFeatureCode: connection['cablePart'], category: connection['category'], subType: connection['subType'] }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function clickVisibleText(page: Page, pattern: RegExp): Promise<void> {
  const candidates = page.getByText(pattern, { exact: true });
  for (let index = 0; index < await candidates.count(); index += 1) {
    if (await candidates.nth(index).isVisible().catch(() => false)) { await candidates.nth(index).click(); return; }
  }
  throw new Error(`No visible control matched ${pattern}.`);
}
const waitIdle = (page: Page) => page.locator('.Loader__background:visible').waitFor({ state: 'hidden', timeout: 120_000 }).catch(() => undefined);

/** The website flow: import, Preference > Storage > Direct Attached, then toggle P2P cabling to fire Auto-Connect. */
async function websiteDirectAttached(page: Page): Promise<{ request: Obj; response: Obj }> {
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const cookie = page.locator('.dcsc-cookie-close').first();
  if (await cookie.isVisible({ timeout: 1_500 }).catch(() => false)) await cookie.click();
  const importResponse = page.waitForResponse(response => response.url().includes('/multiple/cfxml_import') && response.request().method() === 'POST', { timeout: 120_000 });
  await page.locator('input[type=file]').first().setInputFiles(SEED);
  assert.equal((await importResponse).status(), 200, 'Website import did not return HTTP 200.');
  await page.waitForURL(url => /#\/(rack-summary|summary)\//.test(url.href), { timeout: 120_000 });
  await waitIdle(page);
  await page.waitForTimeout(8_000);
  await page.getByRole('button', { name: /Go to Workspace/i }).first().click();
  await page.waitForURL(/#\/rack-configuration/, { timeout: 120_000 });
  await waitIdle(page);
  await page.waitForTimeout(6_000);
  await clickVisibleText(page, /^Preference$/i);
  await page.waitForTimeout(1_000);
  const tabs = page.getByText('Storage', { exact: true });
  for (let index = (await tabs.count()) - 1; index >= 0; index -= 1) {
    if (await tabs.nth(index).isVisible().catch(() => false)) { await tabs.nth(index).click(); break; }
  }
  await page.waitForTimeout(500);
  await clickVisibleText(page, new RegExp(`^${STORAGE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  await page.waitForTimeout(800);
  const sanSelect = page.locator('.ant-select:visible').filter({ has: page.locator(`.ant-select-selection-selected-value[title*="${SAN_SWITCH_OPTION}"]`) }).first();
  await sanSelect.waitFor({ state: 'visible', timeout: 15_000 });
  await sanSelect.click();
  const direct = page.locator('.ant-select-dropdown:visible .ant-select-dropdown-menu-item').filter({ hasText: 'Direct Attached Connection' }).first();
  await direct.waitFor({ state: 'visible', timeout: 10_000 });
  await direct.click();
  await page.waitForTimeout(1_000);
  await clickVisibleText(page, /^Close$/);
  await page.waitForTimeout(2_000);
  await page.locator('.auto-connect__label:visible').first().locator('xpath=..').locator('.anticon-setting').first().click();
  await page.waitForTimeout(500);
  const p2p = page.getByText('P2P Cabling', { exact: true }).last();
  await p2p.waitFor({ state: 'visible', timeout: 10_000 });
  const checkbox = p2p.locator('xpath=ancestor::label[1]').locator('input[type=checkbox]');
  if (await checkbox.isChecked()) {
    await p2p.click();
    await page.waitForFunction(() => [...document.querySelectorAll('label')].find(label => label.textContent?.includes('P2P Cabling'))
      ?.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked === false, undefined, { timeout: 10_000 });
    await page.waitForTimeout(1_000);
  }
  const autoResponse = page.waitForResponse(response => /\/api\/auto_connect(?:\?|$)/.test(response.url()) && response.request().method() === 'POST', { timeout: 60_000 });
  await p2p.click();
  const response = await autoResponse;
  assert.equal(response.status(), 200, 'Auto-connect did not return HTTP 200.');
  const request = object(JSON.parse(response.request().postData() ?? '{}'));
  const body = object(await response.json());
  await waitIdle(page);
  return { request, response: body };
}

export default {
  id: 'storage-fc',
  tags: ['storage', 'cabling', 'import'],
  async run(h) {
    const { mcp, step, compare } = h;

    const website = await step('website-direct-attached', async () => {
      const page = await h.web.newPage();
      try {
        const { request, response } = await websiteDirectAttached(page);
        const definition = rows(request['storageConnectionNetworks']).find(item => item['name'] === STORAGE_NAME);
        assert(definition, 'Auto-connect request omitted the named storage definition.');
        assert.equal(text(object(definition['mainSwitch'])['option']), '', 'Direct Attached request retained a SAN switch option.');
        const configurations = rows(request['configurations']);
        assert(configurations.some(item => item['selectedStorageNetwork'] === STORAGE_NAME), 'Auto-connect request omitted the server assignment.');
        const connections = [...rows(response['connections']), ...rows(response['autoConnectResults']).flatMap(item => rows(item['connections']))];
        return { definition, selected: selectedFeatures(configurations), connections: storageConnections(connections, text(object(definition['controller'])['option'])) };
      } finally { await page.context().close(); }
    });

    await step('mcp-direct-attached', async () => {
      const imported = await websiteImport(h, SEED, 'seed');
      assert.equal(imported.status, 200);
      const importedDefinition = rows(object(imported.payload['networkingInformation'])['storageNetworks']).find(item => item['name'] === STORAGE_NAME);
      assert.equal(text(object(importedDefinition?.['controller'])['option']), CONTROLLER_OPTION, 'Import changed the controller selection.');
      assert.equal(text(object(importedDefinition?.['mainSwitch'])['option']), SAN_SWITCH_OPTION, 'Import changed the SAN switch selection.');
      const mcpImport = await mcp.call('dcsc_import', { filePath: SEED, solutionMode: HPC_MODE });
      const workspace = String(mcpImport['session']);
      await mcp.call('dcsc_storage_set', { session: workspace, expectedRevision: persistedWorkspace(h, workspace)['revision'],
        change: { action: 'update', name: STORAGE_NAME, changes: { switchId: 'direct-attached' }, autoConnect: false } });
      await mcp.call('dcsc_auto_connect', { session: workspace, settings: { p2pCabling: true } });
      const saved = persistedWorkspace(h, workspace);
      const state = object(saved['serverState']);
      const definition = rows(state['storageConnectionNetworks']).find(item => item['name'] === STORAGE_NAME)!;
      compare('direct-attached-definition', { mainSwitch: text(object(website.definition['mainSwitch'])['option']), controller: text(object(website.definition['controller'])['option']) },
        { mainSwitch: text(object(definition['mainSwitch'])['option']), controller: text(object(definition['controller'])['option']) });
      compare('assigned-and-controller-features', website.selected, selectedFeatures(rows(saved['configurations']).map(item => object(item['raw']))));
      compare('direct-attached-storage-connections', website.connections, storageConnections(rows(state['connections']), text(object(definition['controller'])['option'])));
    });
  },
} satisfies ParityCase;
