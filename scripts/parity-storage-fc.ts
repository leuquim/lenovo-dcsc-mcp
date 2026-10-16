/**
 * Bounded browser oracle for anonymous FC storage auto-connect.
 *
 * The input must be a settled website export which already contains a named
 * storage definition, an assigned server and selected FC controller features.
 * This runner changes only that definition from its SAN switch to Direct
 * Attached, then triggers the website's P2P auto-connect control.
 *
 * Exit 0: the website returned at least one connection for the named storage
 * network. Exit 2: the complete native request returned HTTP 200 but no storage
 * rows. Exit 1: setup, import, UI or endpoint failure.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page, type Request, type Response } from 'playwright';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Obj : {};
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ? (name === 'name' ? value : path.resolve(value)) : undefined;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const xml = optionalArgument('xml') ??
  path.join(repoRoot, 'test/fixtures/parity/xml/storage-fc-zero-graph.xml');
const requestedOut = optionalArgument('out');
if (!requestedOut) throw new Error('Missing --out.');
const out = requestedOut;
const storageName = optionalArgument('name') ?? 'Parity Postplacement Edit';

async function clickVisibleText(page: Page, pattern: RegExp): Promise<void> {
  const candidates = page.getByText(pattern, { exact: true });
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      return;
    }
  }
  throw new Error(`No visible control matched ${pattern}.`);
}

async function waitIdle(page: Page): Promise<void> {
  await page.locator('.Loader__background:visible').waitFor({ state: 'hidden', timeout: 120_000 })
    .catch(() => undefined);
}

async function openStorageDefinition(page: Page): Promise<void> {
  await clickVisibleText(page, /^Preference$/i);
  await page.waitForTimeout(1_000);
  const tabs = page.getByText('Storage', { exact: true });
  for (let index = (await tabs.count()) - 1; index >= 0; index -= 1) {
    if (await tabs.nth(index).isVisible().catch(() => false)) {
      await tabs.nth(index).click();
      break;
    }
  }
  await page.waitForTimeout(500);
  await clickVisibleText(page, new RegExp(`^${escapeRegex(storageName)}$`));
  await page.waitForTimeout(800);
}

function connectionSummary(connection: Obj): Obj {
  const distance = object(connection.cableDistance);
  return {
    network: connection.network,
    topology: connection.topology,
    sourceCode: connection.sourcePart ?? object(distance.from).code,
    destinationCode: connection.destinationPart ?? object(distance.to).code,
    cableFeatureCode: connection.cablePart ?? object(connection.cableFeature).featureCode,
    category: connection.category,
    subType: connection.subType,
  };
}

function selectedFeatureQuantity(configuration: Obj, featureCode: string): number | undefined {
  const quantities: number[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const row = value as Obj;
    const code = string(row.featureCode || row.code);
    if (code === featureCode) {
      const quantity = Number(row.selectedQuantity ?? row.quantity);
      if (Number.isFinite(quantity)) quantities.push(quantity);
    }
    Object.values(row).forEach(visit);
  };
  visit(configuration);
  return quantities.length > 0 ? Math.max(...quantities) : undefined;
}

function assertSelectedFeature(configuration: Obj | undefined, code: string, quantity: number, scope: string): void {
  assert(configuration, `${scope} configuration is absent.`);
  assert.equal(selectedFeatureQuantity(configuration, code), quantity,
    `${scope} must contain selected ${code} quantity ${quantity}.`);
}

async function captureJson(response: Response, name: string): Promise<unknown> {
  const body = await response.text();
  await writeFile(path.join(out, `${name}.txt`), body);
  try {
    const parsed = JSON.parse(body) as unknown;
    await writeFile(path.join(out, `${name}.json`), JSON.stringify(parsed, null, 2));
    return parsed;
  } catch {
    return body;
  }
}

async function captureRequest(request: Request, name: string): Promise<Obj> {
  const raw = request.postData() ?? '';
  let parsed: unknown = raw;
  try { parsed = JSON.parse(raw); } catch { /* preserve raw */ }
  await writeFile(path.join(out, `${name}.json`),
    typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2));
  return object(parsed);
}

async function main(): Promise<void> {
  await Promise.all([readFile(xml), mkdir(out, { recursive: true })]);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  let phase = 'boot';
  const lifecycle: string[] = [];
  browser.on('disconnected', () => lifecycle.push(`browser-disconnected:${phase}`));
  page.on('crash', () => lifecycle.push(`page-crash:${phase}`));
  page.on('pageerror', error => lifecycle.push(`page-error:${phase}:${String(error)}`));
  try {
    phase = 'import';
    await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const cookie = page.locator('.dcsc-cookie-close').first();
    if (await cookie.isVisible({ timeout: 1_500 }).catch(() => false)) await cookie.click();
    const importResponse = page.waitForResponse(response =>
      response.url().includes('/multiple/cfxml_import') && response.request().method() === 'POST',
    { timeout: 120_000 });
    await page.locator('input[type=file]').first().setInputFiles(xml);
    const imported = await importResponse;
    const importedPayload = await captureJson(imported, 'import-response');
    assert.equal(imported.status(), 200, 'Website import did not return HTTP 200.');
    await page.waitForURL(url => /#\/(rack-summary|summary)\//.test(url.href), { timeout: 120_000 });
    await waitIdle(page);
    await page.waitForTimeout(8_000);
    const importedRoute = page.url();

    const importRoot = object(Array.isArray(importedPayload) ? importedPayload[0] : importedPayload);
    const importNetworking = object(importRoot.networkingInformation);
    const importedDefinitions = rows(importNetworking.storageNetworks);
    const importedDefinition = importedDefinitions.find(definition => definition.name === storageName);
    assert(importedDefinition, `Import omitted storage definition ${storageName}.`);
    assert.equal(string(object(importedDefinition.controller).option), '7Y70CTOHWW',
      'Import changed the DE2000H controller selection.');
    assert.equal(string(object(importedDefinition.mainSwitch).option), '7D8PCTO1WW',
      'Import changed the DB610S SAN switch selection.');
    assert.equal(string(object(importedDefinition.mainSwitch).featureCode), 'BLAC',
      'Import changed the DB610S base feature selection.');
    const importedConfigs = rows(importRoot.configuration);
    const importedAssigned = importedConfigs.filter(config => config.selectedStorageNetwork === storageName);
    assert(importedAssigned.length > 0, 'Import did not retain a server storage-network assignment.');
    const importedServer = importedAssigned.find(config => config.code === '7D73CTOHWW');
    const importedController = importedConfigs.find(config => config.code === '7Y70CTOHWW');
    assertSelectedFeature(importedServer, 'ATZV', 1, 'Imported assigned server');
    assertSelectedFeature(importedController, 'B4DA', 1, 'Imported controller');
    assertSelectedFeature(importedController, 'B4B7', 2, 'Imported controller');
    assertSelectedFeature(importedController, 'B4B2', 8, 'Imported controller');

    phase = 'workspace';
    await page.getByRole('button', { name: /Go to Workspace/i }).first().click();
    await page.waitForURL(/#\/rack-configuration/, { timeout: 120_000 });
    await waitIdle(page);
    await page.waitForTimeout(6_000);

    phase = 'direct-attached';
    await openStorageDefinition(page);
    const sanSelect = page.locator('.ant-select:visible')
      .filter({ has: page.locator('.ant-select-selection-selected-value[title*="7D8PCTO1WW"]') }).first();
    await sanSelect.waitFor({ state: 'visible', timeout: 15_000 });
    const previousSwitch = await sanSelect.locator('.ant-select-selection-selected-value').getAttribute('title');
    await sanSelect.click();
    const direct = page.locator('.ant-select-dropdown:visible .ant-select-dropdown-menu-item')
      .filter({ hasText: 'Direct Attached Connection' }).first();
    await direct.waitFor({ state: 'visible', timeout: 10_000 });
    await direct.click();
    await page.waitForTimeout(1_000);
    await clickVisibleText(page, /^Close$/);
    await page.waitForTimeout(2_000);

    phase = 'auto-connect';
    const autoContainer = page.locator('.auto-connect__label:visible').first().locator('xpath=..');
    const settings = autoContainer.locator('.anticon-setting').first();
    await settings.click();
    await page.waitForTimeout(500);
    const p2p = page.getByText('P2P Cabling', { exact: true }).last();
    await p2p.waitFor({ state: 'visible', timeout: 10_000 });
    const p2pBox = p2p.locator('xpath=ancestor::label[1]').locator('input[type=checkbox]');
    if (await p2pBox.isChecked()) {
      await p2p.click();
      await page.waitForFunction(() => {
        const label = [...document.querySelectorAll('label')]
          .find(candidate => candidate.textContent?.includes('P2P Cabling'));
        return label?.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked === false;
      }, { timeout: 10_000 });
      await page.waitForTimeout(1_000);
    }
    const autoResponsePromise = page.waitForResponse(response =>
      /\/api\/auto_connect(?:\?|$)/.test(response.url()) && response.request().method() === 'POST',
    { timeout: 60_000 });
    await p2p.click();
    const autoResponse = await autoResponsePromise;
    const autoRequest = await captureRequest(autoResponse.request(), 'auto-connect-request');
    const autoPayload = object(await captureJson(autoResponse, 'auto-connect-response'));
    await waitIdle(page);
    await page.waitForTimeout(5_000);

    const requestDefinitions = rows(autoRequest.storageConnectionNetworks);
    const requestDefinition = requestDefinitions.find(definition => definition.name === storageName);
    assert(requestDefinition, 'Auto-connect request omitted the named storage definition.');
    assert.equal(string(object(requestDefinition.mainSwitch).option), '',
      'Direct Attached request retained a SAN switch option.');
    const requestAssigned = rows(autoRequest.configurations)
      .filter(config => config.selectedStorageNetwork === storageName);
    assert(requestAssigned.length > 0, 'Auto-connect request omitted the server assignment.');
    const requestedServer = requestAssigned.find(config => config.code === '7D73CTOHWW');
    const requestedController = rows(autoRequest.configurations)
      .find(config => config.code === '7Y70CTOHWW');
    assertSelectedFeature(requestedServer, 'ATZV', 1, 'Auto-connect assigned server');
    assertSelectedFeature(requestedController, 'B4DA', 1, 'Auto-connect controller');
    assertSelectedFeature(requestedController, 'B4B7', 2, 'Auto-connect controller');
    assertSelectedFeature(requestedController, 'B4B2', 8, 'Auto-connect controller');
    assert.equal(autoResponse.status(), 200, 'Auto-connect did not return HTTP 200.');

    const directConnections = rows(autoPayload.connections);
    const nestedConnections = rows(autoPayload.autoConnectResults)
      .flatMap(result => rows(result.connections));
    const connections = [...directConnections, ...nestedConnections];
    const controllerCode = string(object(requestDefinition.controller).option);
    const storageConnections = connections.filter(connection =>
      connection.network === storageName || /storage|fibre|fiber|fc/i.test(string(connection.network)) ||
      /storage/i.test(string(connection.subType)) ||
      (/\b(?:8|16|32|64)Gb(?:E)?_Fibre\b|Fibre Channel|\bFC\b/i.test(string(connection.topology)) &&
        controllerCode !== '' && [connection.sourcePart, connection.destinationPart].includes(controllerCode)));
    const report = {
      status: storageConnections.length > 0 ? 'pass' : 'blocked',
      scope: 'anonymous-native-direct-attached-storage-auto-connect',
      input: xml,
      storageName,
      import: {
        status: imported.status(),
        route: importedRoute,
        definitionCount: importedDefinitions.length,
        assignedConfigurationIds: importedAssigned.map(config => config.id),
        selections: { ATZV: 1, B4DA: 1, B4B7: 2, B4B2: 8 },
      },
      edit: { previousSwitch, selectedConnection: 'Direct Attached Connection' },
      request: {
        definition: requestDefinition,
        assignedConfigurationIds: requestAssigned.map(config => config.id),
        selections: { ATZV: 1, B4DA: 1, B4B7: 2, B4B2: 8 },
        settings: autoRequest.autoConnectSettings,
      },
      response: {
        status: autoResponse.status(),
        connectionCount: connections.length,
        storageConnectionCount: storageConnections.length,
        connections: connections.map(connectionSummary),
        responseKeys: Object.keys(autoPayload).sort(),
        hasErrors: rows(autoPayload.errors).length > 0,
        errors: rows(autoPayload.errors),
      },
      conclusion: storageConnections.length > 0
        ? 'The native Direct Attached workflow generated storage connections.'
        : 'The complete native Direct Attached request returned HTTP 200 without a storage connection.',
    };
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    await page.screenshot({ path: path.join(out, 'workspace.png'), fullPage: true });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (storageConnections.length === 0) process.exitCode = 2;
  } finally {
    await writeFile(path.join(out, 'lifecycle.log'), `${lifecycle.join('\n')}\n`);
    await context.close();
    await browser.close();
  }
}

main().catch(async error => {
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'error.txt'), String(error?.stack ?? error));
  console.error(error);
  process.exitCode = 1;
});
