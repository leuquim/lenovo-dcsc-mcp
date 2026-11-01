/**
 * Headless browser/MCP differential for product-bound base services and add-ons.
 *
 * The gate captures the current browser wire contract, repeats the same basket
 * through the registered MCP tools, compares export forms and CFXML commercial
 * lines, then imports each XML into a fresh browser context.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { chromium, type Browser, type BrowserContext, type Download, type Page, type Request } from 'playwright';
import yauzl from 'yauzl';

import { ConfigSchema } from '../src/config/schema.js';
import { parseStandaloneImportResponse } from '../src/domain/importStandalone.js';
import { configureLogger } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';
import { registerImportExportTools } from '../src/mcp/importExportTools.js';
import { registerSessionTools } from '../src/mcp/sessionTools.js';
import { registerStandaloneTools } from '../src/mcp/standaloneTools.js';

type Json = Record<string, unknown>;
type ToolReply = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolReply>;
type WireCapture = { path: string; query?: Json; body?: Json; fields?: Record<string, string> };

const PRODUCT = '7D73CTO1WW';
const BASE = '5WS7B99623';
const ADD_ON = '5PS7B99638';
const EXPECTED_TOTAL = 1810;
const IMPORTED_PRODUCT_QUANTITY = 3;
const UPDATED_PRODUCT_QUANTITY = 4;
const IMPORTED_SERVICE_QUANTITY = 2;
const IMPORTED_UPDATED_TOTAL = 13_096;
const IMPORT_RESPONSE_FIXTURE = new URL(
  '../test/fixtures/service-qty-import-response.json',
  import.meta.url,
);

function parseArgs(argv = process.argv.slice(2)): { outDir: string; origin: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const result = {
    outDir: path.resolve(`artifacts/parity-services/${stamp}`),
    origin: 'https://dcsc.lenovo.com/',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [key, value] = [argv[index], argv[index + 1]];
    if (!value || !['--out', '--origin'].includes(key ?? '')) {
      throw new Error(`Invalid argument ${key ?? ''}.`);
    }
    if (key === '--out') result.outDir = path.resolve(value);
    else result.origin = value;
    index += 1;
  }
  return result;
}

function object(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Json : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function money(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  assert(Number.isFinite(number), `Expected numeric price, received ${String(value)}.`);
  return number;
}

function toolValue(reply: ToolReply, name: string): Json {
  assert.notEqual(reply.isError, true, `${name} failed: ${reply.content[0]?.text ?? ''}`);
  return object(JSON.parse(reply.content[0]?.text ?? '{}'));
}

function selectedCodes(value: Json): string[] {
  return array(value['selections'])
    .map(item => String(object(item)['code'] ?? ''))
    .filter(Boolean)
    .sort();
}

function summaryLines(value: unknown): Array<{ code: string; quantity: number; unitPrice: number }> {
  const product = object(array(value)[0]);
  return array(product['results']).map(item => {
    const line = object(item);
    return {
      code: String(line['code'] ?? ''),
      quantity: Number(line['quantity'] ?? 0),
      unitPrice: money(line['unitPrice']),
    };
  }).sort((left, right) => left.code.localeCompare(right.code));
}

function summaryTotal(value: unknown): number {
  return money(object(array(value)[0])['totalPrice']);
}

function decodeForm(postData: string | null): Record<string, string> {
  assert(postData, 'Expected an URL-encoded export form body.');
  return Object.fromEntries(new URLSearchParams(postData));
}

function normalizedExportForm(fields: Record<string, string>): Json {
  return {
    data: JSON.parse(fields['data'] ?? 'null') as unknown,
    serviceAndorRequest: JSON.parse(fields['serviceAndorRequest'] ?? 'null') as unknown,
  };
}

function xmlText(value: string, tag: string): string {
  const match = value.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
  return (match?.[1] ?? '').trim();
}

function xmlBlock(value: string, tag: string): string {
  return value.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? '';
}

function serviceXmlLines(xml: string): Array<{ code: string; quantity: number; unitPrice: number; currency: string }> {
  const cfData = xmlBlock(xml, 'CFData');
  return [...cfData.matchAll(/<ProductLineItem>([\s\S]*?)<\/ProductLineItem>/g)]
    .map(match => {
      const line = match[1] ?? '';
      const price = xmlBlock(line, 'UnitListPrice');
      return {
        code: xmlText(line, 'ProprietaryProductIdentifier'),
        quantity: Number(xmlText(line, 'Quantity')),
        unitPrice: money(xmlText(price, 'MonetaryAmount')),
        currency: xmlText(price, 'GlobalCurrencyCode'),
      };
    })
    .sort((left, right) => left.code.localeCompare(right.code));
}

async function extractXml(zipPath: string, outputPath: string): Promise<string> {
  const body = await new Promise<Buffer>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error('Could not open export ZIP.'));
      zip.once('error', reject);
      zip.once('end', () => reject(new Error(`${zipPath} contains no XML member.`)));
      zip.on('entry', entry => {
        if (!entry.fileName.toLowerCase().endsWith('.xml')) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error('Could not read XML member.'));
          const chunks: Buffer[] = [];
          stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
          stream.once('error', reject);
          stream.once('end', () => {
            zip.close();
            resolve(Buffer.concat(chunks));
          });
        });
      });
      zip.readEntry();
    });
  });
  await writeFile(outputPath, body);
  return body.toString('utf8');
}

async function settle(page: Page): Promise<void> {
  await page.locator('.ant-spin-spinning:visible').first()
    .waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(700);
}

async function newPage(browser: Browser, acceptDownloads = false): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    serviceWorkers: 'block',
    acceptDownloads,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  return { context, page };
}

async function selectBrowserService(page: Page, code: string): Promise<{ request: Json; response: Json }> {
  const pending = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes('/api/services/autoDerive'),
  { timeout: 120_000 });
  await page.getByText(code, { exact: true }).first().click();
  const response = await pending;
  assert.equal(response.status(), 200, `Browser service selection ${code} returned HTTP ${response.status()}.`);
  await settle(page);
  return {
    request: object(response.request().postDataJSON()),
    response: object(await response.json()),
  };
}

type BrowserResult = {
  base: { request: Json; response: Json };
  addOn: { request: Json; response: Json };
  removed: { request: Json; response: Json };
  readded: { request: Json; response: Json };
  summaryRequest: unknown;
  summaryResponse: unknown;
  exportFields: Record<string, string>;
  zipPath: string;
  xmlPath: string;
  xml: string;
  quantityControl: {
    count: number;
    initialValue: string;
    incrementedValue: string;
    restoredValue: string;
    servicePostsDuringClicks: number;
  };
};

async function browserFlow(browser: Browser, origin: string, outDir: string): Promise<BrowserResult> {
  const { context, page } = await newPage(browser, true);
  try {
    await page.goto(`${origin.replace(/\/$/, '')}/#/services`, {
      waitUntil: 'domcontentloaded', timeout: 90_000,
    });
    await settle(page);
    await page.waitForTimeout(2_500);
    const cookie = page.locator('.dcsc-cookie-close').first();
    if (await cookie.isVisible({ timeout: 1_000 }).catch(() => false)) await cookie.click();
    await page.getByText('Select Services', { exact: true }).click();
    await settle(page);
    await page.locator('#selectMode').fill('7D73');
    await page.waitForTimeout(800);
    const launchGraph = page.waitForResponse(response =>
      response.request().method() === 'POST' && response.url().includes('/api/services/autoDerive'),
    { timeout: 120_000 });
    const launchCatalog = page.waitForResponse(response =>
      response.request().method() === 'GET' && response.url().includes(`/api/service_pacs/${PRODUCT}`),
    { timeout: 120_000 });
    await page.locator('.ant-select-dropdown-menu-item').filter({ hasText: new RegExp(PRODUCT) }).first().click();
    const [graphResponse, catalogResponse] = await Promise.all([launchGraph, launchCatalog]);
    assert.equal(graphResponse.status(), 200);
    assert.equal(catalogResponse.status(), 200);
    await settle(page);

    const base = await selectBrowserService(page, BASE);
    const addOn = await selectBrowserService(page, ADD_ON);
    const removed = await selectBrowserService(page, ADD_ON);
    assert.deepEqual(removed.request['delta'], { section: 'Add ons' });
    const readded = await selectBrowserService(page, ADD_ON);

    const summaryPending = page.waitForResponse(response =>
      response.request().method() === 'POST' && response.url().includes('/api/services/summaries'),
    { timeout: 120_000 });
    await page.getByRole('button', { name: 'Summary' }).click();
    const summaryResponse = await summaryPending;
    assert.equal(summaryResponse.status(), 200);
    await page.waitForURL(/#\/summary\/service$/, { timeout: 90_000 });
    await settle(page);
    const summaryRequest = summaryResponse.request().postDataJSON() as unknown;
    const summary = await summaryResponse.json() as unknown;
    assert.deepEqual(summaryLines(summary).map(line => line.code), [ADD_ON, BASE].sort());
    assert.equal(summaryTotal(summary), EXPECTED_TOTAL);
    await page.getByText(BASE, { exact: true }).waitFor({ state: 'visible' });
    await page.getByText(ADD_ON, { exact: true }).waitFor({ state: 'visible' });

    let exportRequest: { postData: string | null } | undefined;
    page.on('request', request => {
      if (request.url().includes('/api/service_pacs/export')) exportRequest = { postData: request.postData() };
    });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      page.getByText('Save', { exact: true }).click(),
    ]);
    const zipPath = path.join(outDir, 'browser-services.zip');
    await download.saveAs(zipPath);
    assert(exportRequest, 'Browser Save did not post /service_pacs/export.');
    const exportFields = decodeForm(exportRequest.postData);
    const xmlPath = path.join(outDir, 'browser-services.xml');
    const xml = await extractXml(zipPath, xmlPath);

    const quantity = page.locator('.workspace-tab__quantity');
    const quantityInput = quantity.locator('.quantity-input');
    const quantityControlCount = await quantity.count();
    assert.equal(quantityControlCount, 1, 'Native service summary should expose one product quantity control.');
    const initialValue = await quantityInput.inputValue();
    let servicePostsDuringClicks = 0;
    const countServicePosts = (request: Request): void => {
      if (request.method() === 'POST' && /\/api\/(?:services|service_pacs)\//.test(request.url())) {
        servicePostsDuringClicks += 1;
      }
    };
    page.on('request', countServicePosts);
    await quantity.locator('.control-add').click();
    await page.waitForFunction(() =>
      (document.querySelector('.workspace-tab__quantity .quantity-input') as HTMLInputElement | null)?.value === '2');
    const incrementedValue = await quantityInput.inputValue();
    await quantity.locator('.control-minus').click();
    await page.waitForFunction(() =>
      (document.querySelector('.workspace-tab__quantity .quantity-input') as HTMLInputElement | null)?.value === '1');
    const restoredValue = await quantityInput.inputValue();
    await page.waitForTimeout(750);
    page.off('request', countServicePosts);
    assert.equal(servicePostsDuringClicks, 0, 'Native product quantity clicks unexpectedly posted a service mutation.');
    return { base, addOn, removed, readded, summaryRequest, summaryResponse: summary,
      exportFields, zipPath, xmlPath, xml,
      quantityControl: {
        count: quantityControlCount,
        initialValue,
        incrementedValue,
        restoredValue,
        servicePostsDuringClicks,
      } };
  } finally {
    await context.close();
  }
}

type ImportResult = {
  url: string;
  status: number;
  type: string;
  codes: string[];
  productQuantity: number;
  serviceQuantities: Array<{ code: string; quantity: number }>;
  totalPrice: number;
  bodyHasCodes: boolean;
};

async function browserImport(
  browser: Browser,
  origin: string,
  xmlPath: string,
): Promise<ImportResult> {
  const { context, page } = await newPage(browser);
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await settle(page);
    const pending = page.waitForResponse(response =>
      response.request().method() === 'POST' && response.url().includes('/multiple/cfxml_import'),
    { timeout: 120_000 });
    await page.locator('input[type=file]').first().setInputFiles(xmlPath);
    const response = await pending;
    assert.equal(response.status(), 200, `Browser import returned HTTP ${response.status()}.`);
    const raw = await response.json() as unknown;
    const envelope = object(Array.isArray(raw) ? raw[0] : raw);
    const summaries = array(envelope['summary']);
    assert.equal(summaries.length, 1, 'Browser import did not return one serviced product summary.');
    const product = object(summaries[0]);
    const lines = array(product['results']).map(object);
    assert(lines.length > 0, 'Browser import returned no authoritative service summary lines.');
    await page.waitForURL(/#\/summary\/service$/, { timeout: 120_000 });
    await settle(page);
    const body = await page.locator('body').innerText();
    const serviceQuantities = lines.map(line => ({
      code: String(line['code'] ?? ''),
      quantity: Number(line['quantity']),
    })).sort((left, right) => left.code.localeCompare(right.code));
    assert(serviceQuantities.every(line => line.code && Number.isInteger(line.quantity) && line.quantity > 0));
    const codes = serviceQuantities.map(line => line.code);
    const productQuantity = Number(product['quantity']);
    assert(Number.isInteger(productQuantity) && productQuantity > 0);
    const totalPrice = summaryTotal(summaries);
    return {
      url: page.url(), status: response.status(), type: String(envelope['type'] ?? ''),
      codes,
      productQuantity,
      serviceQuantities,
      totalPrice,
      bodyHasCodes: codes.every(code => body.includes(code)),
    };
  } finally {
    await context.close();
  }
}

async function browserImportedQuantityFlow(
  browser: Browser,
  origin: string,
  outDir: string,
): Promise<{
  imported: ImportResult;
  quantityControl: {
    initialValue: string;
    incrementedValue: string;
    initialTotal: number;
    incrementedTotal: number;
    servicePostsDuringClick: number;
  };
  exportFields: Record<string, string>;
  exportStatus: number;
  exportResponse: unknown;
  nativeExportLimitation: boolean;
  zipPath?: string;
  xmlPath?: string;
  xml?: string;
}> {
  const { context, page } = await newPage(browser, true);
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await settle(page);
    const pending = page.waitForResponse(response =>
      response.request().method() === 'POST' && response.url().includes('/multiple/cfxml_import'),
    { timeout: 120_000 });
    await page.locator('input[type=file]').first().setInputFiles(
      path.resolve('test/fixtures/parity/xml/service-p3-s2.xml'),
    );
    const importResponse = await pending;
    assert.equal(importResponse.status(), 200);
    const raw = await importResponse.json() as unknown;
    const envelope = object(Array.isArray(raw) ? raw[0] : raw);
    const parsed = parseStandaloneImportResponse(raw);
    assert(parsed?.kind === 'service', 'Native import did not return typed product-service state.');
    await page.waitForURL(/#\/summary\/service$/, { timeout: 120_000 });
    await settle(page);
    const body = await page.locator('body').innerText();
    const imported: ImportResult = {
      url: page.url(),
      status: importResponse.status(),
      type: String(envelope['type'] ?? ''),
      codes: parsed.state.selections.map(selection => selection.code).sort(),
      productQuantity: parsed.state.product.quantity,
      serviceQuantities: parsed.state.selections.map(selection => ({
        code: selection.code,
        quantity: selection.quantity,
      })),
      totalPrice: summaryTotal(parsed.state.summaryRaw),
      bodyHasCodes: parsed.state.selections.every(selection => body.includes(selection.code)),
    };
    assert.equal(imported.productQuantity, IMPORTED_PRODUCT_QUANTITY);
    assert.deepEqual(imported.serviceQuantities, [{ code: BASE, quantity: IMPORTED_SERVICE_QUANTITY }]);
    assert.equal(imported.totalPrice, 9_822);

    const quantity = page.locator('.workspace-tab__quantity');
    assert.equal(await quantity.count(), 1);
    const input = quantity.locator('.quantity-input');
    const initialValue = await input.inputValue();
    assert.equal(initialValue, String(IMPORTED_PRODUCT_QUANTITY));
    let servicePostsDuringClick = 0;
    const countServicePosts = (request: Request): void => {
      if (request.method() === 'POST' && /\/api\/(?:services|service_pacs)\//.test(request.url())) {
        servicePostsDuringClick += 1;
      }
    };
    page.on('request', countServicePosts);
    await quantity.locator('.control-add').click();
    await page.waitForFunction((expected) =>
      (document.querySelector('.workspace-tab__quantity .quantity-input') as HTMLInputElement | null)?.value === expected,
    String(UPDATED_PRODUCT_QUANTITY));
    const incrementedValue = await input.inputValue();
    await page.waitForTimeout(750);
    page.off('request', countServicePosts);
    assert.equal(servicePostsDuringClick, 0);
    const incrementedBody = await page.locator('body').innerText();
    assert.match(incrementedBody, /\$13,096\.00/);
    assert.match(incrementedBody, /5WS7B99623[\s\S]*\$1,637\.00[\s\S]*2[\s\S]*\$3,274\.00/);

    let exportRequest: { postData: string | null } | undefined;
    let download: Download | undefined;
    page.on('request', request => {
      if (request.url().includes('/api/service_pacs/export')) exportRequest = { postData: request.postData() };
    });
    page.once('download', value => { download = value; });
    const exportResponse = page.waitForResponse(response =>
      response.request().method() === 'POST' && response.url().includes('/api/service_pacs/export'),
    { timeout: 120_000 });
    await page.getByText('Save', { exact: true }).click();
    const exportResult = await exportResponse;
    await page.waitForTimeout(500);
    assert(exportRequest, 'Native imported service Save did not post /service_pacs/export.');
    const exportFields = decodeForm(exportRequest.postData);
    const form = normalizedExportForm(exportFields);
    const exportResponseBody = await exportResult.json().catch(async () =>
      exportResult.text().catch(() => ''));
    const nativeExportLimitation = exportResult.status() !== 200;
    let zipPath: string | undefined;
    let xmlPath: string | undefined;
    let xml: string | undefined;
    if (nativeExportLimitation) {
      assert.equal(exportResult.status(), 500);
      assert.equal(download, undefined);
      assert.deepEqual(form['data'], [{
        code: PRODUCT,
        quantity: UPDATED_PRODUCT_QUANTITY,
        services: [],
      }]);
      const serviceAndorRequest = object(form['serviceAndorRequest']);
      const selected = array(object(array(serviceAndorRequest['sections'])[0])['results']);
      assert.equal(object(selected[0])['quantity'], IMPORTED_SERVICE_QUANTITY);
    } else {
      assert(download, 'Native imported service export returned HTTP 200 without a download.');
      assert.deepEqual(form['data'], [{
        code: PRODUCT,
        quantity: UPDATED_PRODUCT_QUANTITY,
        services: [{ serviceCode: BASE, quantity: IMPORTED_SERVICE_QUANTITY }],
      }]);
      zipPath = path.join(outDir, 'browser-imported-service-quantity.zip');
      await download.saveAs(zipPath);
      xmlPath = path.join(outDir, 'browser-imported-service-quantity.xml');
      xml = await extractXml(zipPath, xmlPath);
      assert.deepEqual(serviceXmlLines(xml), [{
        code: BASE,
        quantity: UPDATED_PRODUCT_QUANTITY * IMPORTED_SERVICE_QUANTITY,
        unitPrice: 1637,
        currency: 'USD',
      }]);
    }
    return {
      imported,
      quantityControl: {
        initialValue,
        incrementedValue,
        initialTotal: imported.totalPrice,
        incrementedTotal: IMPORTED_UPDATED_TOTAL,
        servicePostsDuringClick,
      },
      exportFields,
      exportStatus: exportResult.status(),
      exportResponse: exportResponseBody,
      nativeExportLimitation,
      ...(zipPath ? { zipPath } : {}),
      ...(xmlPath ? { xmlPath } : {}),
      ...(xml ? { xml } : {}),
    };
  } finally {
    await context.close();
  }
}

async function mcpFlow(outDir: string): Promise<{
  service: DcscService;
  result: Json;
  captures: WireCapture[];
  zipPath: string;
  xmlPath: string;
  xml: string;
  parityDerives: unknown[];
  paritySummary: unknown;
  rejectedQuantity: Json;
  importedQuantity: {
    resized: Json;
    exactQuantity: Json;
    summaryRequest: unknown;
    export: Json;
    zipPath: string;
    xmlPath: string;
    xml: string;
  };
}> {
  const config = ConfigSchema.parse({
    logLevel: 'error',
    files: { persistSessions: false, artifactDir: path.join(outDir, 'mcp-artifacts') },
    pacing: { perToolRequestBudget: 50 },
  });
  const service = new DcscService(config);
  const handlers = new Map<string, ToolHandler>();
  const collector = {
    registerTool(name: string, _config: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
      return { remove() {}, update() {} };
    },
  } as unknown as McpServer;
  registerStandaloneTools(collector, service);
  registerSessionTools(collector, service);
  registerImportExportTools(collector, service);
  const invoke = async (name: string, args: Record<string, unknown>): Promise<ToolReply> => {
    const handler = handlers.get(name);
    assert(handler, `${name} was not registered.`);
    return handler(args);
  };
  const call = async (name: string, args: Record<string, unknown>): Promise<Json> => {
    return toolValue(await invoke(name, args), name);
  };
  const captures: WireCapture[] = [];
  const originalSend = service.http.send.bind(service.http);
  service.http.send = (async request => {
    if (request.path === '/services/autoDerive' && request.body?.kind === 'json') {
      captures.push({ path: request.path, query: structuredClone(request.query ?? {}),
        body: structuredClone(request.body.value) as Json });
    }
    if (request.path === '/services/summaries' && request.body?.kind === 'json') {
      captures.push({ path: request.path, body: structuredClone(request.body.value) as Json });
    }
    if (request.path === '/service_pacs/export' && request.body?.kind === 'form') {
      captures.push({ path: request.path, query: structuredClone(request.query ?? {}),
        fields: structuredClone(request.body.fields) });
    }
    if (request.responseKind === 'json') return originalSend(request);
    return originalSend(request);
  }) as typeof service.http.send;

  try {
    const launched = await call('dcsc_launch', {
      mode: 'services',
      productCode: PRODUCT,
      productQuantity: 1,
      subCategory: 'Point of Sale',
      replace: false,
      refresh: false,
    });
    const workspace = String(launched['session']);
    assert(workspace.startsWith('ws_'));
    const base = await call('dcsc_basket_set', { basket: 'services', action: 'select', session: workspace, code: BASE, quantity: 1 });
    assert.deepEqual(selectedCodes(base), [BASE]);
    const addOn = await call('dcsc_basket_set', { basket: 'services', action: 'select', session: workspace, code: ADD_ON, quantity: 1 });
    assert.deepEqual(selectedCodes(addOn), [ADD_ON, BASE].sort());
    assert.equal(summaryTotal(addOn['summary']), EXPECTED_TOTAL);
    const removed = await call('dcsc_basket_set', { basket: 'services', action: 'remove', session: workspace, code: ADD_ON });
    assert.deepEqual(selectedCodes(removed), [BASE]);
    const readded = await call('dcsc_basket_set', { basket: 'services', action: 'select', session: workspace, code: ADD_ON, quantity: 1 });
    assert.deepEqual(selectedCodes(readded), [ADD_ON, BASE].sort());
    assert.equal(summaryTotal(readded['summary']), EXPECTED_TOTAL);
    const exported = await call('dcsc_export', { kind: 'reports', session: workspace, fileName: 'mcp-services' });
    const zipPath = String(exported['zipPath']);
    assert(zipPath.endsWith('.zip'));
    const xmlPath = path.join(outDir, 'mcp-services.xml');
    const xml = await extractXml(zipPath, xmlPath);
    const parityDerives = captures.filter(capture => capture.path === '/services/autoDerive')
      .slice(-4).map(capture => capture.body);
    const paritySummary = captures.filter(capture => capture.path === '/services/summaries').at(-1)?.body;

    const beforeRejected = service.sessions.getWorkspace(workspace);
    assert(beforeRejected);
    const beforeRejectedRevision = beforeRejected.revision;
    const beforeRejectedSelections = structuredClone(beforeRejected.serverState.standaloneServiceState);
    const rejectedReply = await invoke('dcsc_basket_set', {
      basket: 'services', action: 'setQuantity',
      session: workspace,
      code: BASE,
      quantity: 2,
      expectedRevision: beforeRejectedRevision,
    });
    assert.equal(rejectedReply.isError, true, 'DCSC-normalized service quantity should fail closed.');
    const rejectedQuantity = object(JSON.parse(rejectedReply.content[0]?.text ?? '{}'));
    assert.match(String(rejectedQuantity['error'] ?? ''), /requestedQuantity=2, acceptedQuantity=1/);
    assert.match(String(rejectedQuantity['error'] ?? ''), /No workspace change was saved/);
    const afterRejected = service.sessions.getWorkspace(workspace);
    assert(afterRejected);
    assert.equal(afterRejected.revision, beforeRejectedRevision);
    assert.deepEqual(afterRejected.serverState.standaloneServiceState, beforeRejectedSelections);

    const imported = parseStandaloneImportResponse(JSON.parse(
      readFileSync(IMPORT_RESPONSE_FIXTURE, 'utf8'),
    ) as unknown);
    assert(imported?.kind === 'service', 'Expected captured product-service import fixture.');
    assert.equal(imported.state.product.quantity, IMPORTED_PRODUCT_QUANTITY);
    assert.equal(imported.state.selections[0]?.quantity, IMPORTED_SERVICE_QUANTITY);
    const sourceWorkspace = service.sessions.getWorkspace(workspace);
    assert(sourceWorkspace);
    const created = await service.sessions.createManyAtomic([], {
      workspaceContext: { locale: sourceWorkspace.locale, solution: sourceWorkspace.solution },
      workspaceState: { serverState: { standaloneServiceState: imported.state } },
    });
    const importedWorkspace = created.workspace;
    const resizeCaptureStart = captures.length;
    const resized = await call('dcsc_basket_set', {
      basket: 'services', action: 'setProductQuantity',
      session: importedWorkspace.id,
      quantity: UPDATED_PRODUCT_QUANTITY,
      expectedRevision: importedWorkspace.revision,
    });
    assert.equal(object(resized['product'])['quantity'], UPDATED_PRODUCT_QUANTITY);
    assert.equal(object(array(resized['selections'])[0])['quantity'], IMPORTED_SERVICE_QUANTITY);
    assert.equal(summaryTotal(resized['summary']), IMPORTED_UPDATED_TOTAL);
    const resizeCaptures = captures.slice(resizeCaptureStart);
    assert.equal(resizeCaptures.filter(capture => capture.path === '/services/autoDerive').length, 0);
    const importedSummaryRequest = resizeCaptures.find(
      capture => capture.path === '/services/summaries',
    )?.body;
    assert.deepEqual(importedSummaryRequest, [{
      code: PRODUCT,
      quantity: UPDATED_PRODUCT_QUANTITY,
      services: [{ serviceCode: BASE, quantity: IMPORTED_SERVICE_QUANTITY }],
    }]);

    const exactCaptureStart = captures.length;
    const exactQuantity = await call('dcsc_basket_set', {
      basket: 'services', action: 'setQuantity',
      session: importedWorkspace.id,
      code: BASE,
      quantity: IMPORTED_SERVICE_QUANTITY,
      expectedRevision: Number(resized['revision']),
    });
    assert.equal(object(array(exactQuantity['selections'])[0])['quantity'], IMPORTED_SERVICE_QUANTITY);
    assert.equal(captures.slice(exactCaptureStart)
      .filter(capture => capture.path === '/services/autoDerive').length, 0);
    const importedExport = await call('dcsc_export', { kind: 'reports',
      session: importedWorkspace.id,
      fileName: 'mcp-imported-service-quantity',
    });
    const importedZipPath = String(importedExport['zipPath']);
    const importedXmlPath = path.join(outDir, 'mcp-imported-service-quantity.xml');
    const importedXml = await extractXml(importedZipPath, importedXmlPath);
    assert.deepEqual(serviceXmlLines(importedXml), [{
      code: BASE,
      quantity: UPDATED_PRODUCT_QUANTITY * IMPORTED_SERVICE_QUANTITY,
      unitPrice: 1637,
      currency: 'USD',
    }]);
    assert.match(importedXml, new RegExp(
      `<ProprietaryProductIdentifier>${PRODUCT}</ProprietaryProductIdentifier><Quantity>${UPDATED_PRODUCT_QUANTITY}</Quantity>`,
    ));
    assert.match(importedXml, new RegExp(
      `<ProprietaryProductIdentifier>${BASE}</ProprietaryProductIdentifier><Quantity>${IMPORTED_SERVICE_QUANTITY}</Quantity>`,
    ));
    return { service, result: { launched, base, addOn, removed, readded, exported },
      captures, zipPath, xmlPath, xml, parityDerives, paritySummary, rejectedQuantity,
      importedQuantity: {
        resized,
        exactQuantity,
        summaryRequest: importedSummaryRequest,
        export: importedExport,
        zipPath: importedZipPath,
        xmlPath: importedXmlPath,
        xml: importedXml,
      } };
  } catch (error) {
    await service.close();
    throw error;
  }
}

async function stdioImportedQuantityFlow(outDir: string): Promise<{
  calls: Json[];
  imported: Json;
  resized: Json;
  exported: Json;
  restored: Json;
  restoredExport: Json;
  xmlPath: string;
  restoredXmlPath: string;
}> {
  const stdioDir = path.join(outDir, 'stdio-imported-quantity');
  await mkdir(stdioDir, { recursive: true });
  const configFile = path.join(stdioDir, 'config.json');
  const sessionFile = path.join(stdioDir, 'sessions.json');
  await writeFile(configFile, JSON.stringify({
    logLevel: 'error',
    files: {
      persistSessions: true,
      sessionFile,
      artifactDir: path.join(stdioDir, 'exports'),
    },
    pacing: { perToolRequestBudget: 50 },
  }));
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] =>
      entry[1] !== undefined && !entry[0].startsWith('DCSC_')));
  const calls: Json[] = [];
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  const start = async (): Promise<void> => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/server.ts'],
      stderr: 'pipe',
      env: { ...inherited, DCSC_CONFIG: configFile },
    });
    transport.stderr?.on('data', () => undefined);
    client = new Client({ name: 'parity-services-quantity', version: '1.0.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    for (const name of ['dcsc_import', 'dcsc_basket_browse',
      'dcsc_basket_set', 'dcsc_export']) {
      assert(tools.tools.some(tool => tool.name === name), `${name} is not registered over stdio.`);
    }
  };
  const call = async (name: string, args: Json): Promise<Json> => {
    assert(client, 'Stdio MCP client is not connected.');
    const response = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: 300_000 },
    );
    const text = (response.content as Array<{ type: string; text?: string }>)
      .find(item => item.type === 'text')?.text ?? '{}';
    const result = object(JSON.parse(text));
    calls.push({ name, arguments: args, isError: response.isError === true, result });
    assert.notEqual(response.isError, true, `${name} failed over stdio: ${text}`);
    assert(Buffer.byteLength(text) <= 8_000, `${name} exceeded the MCP response budget.`);
    return result;
  };
  const stop = async (): Promise<void> => {
    await client?.close().catch(() => undefined);
    client = undefined;
    transport = undefined;
  };
  const crashRestart = async (): Promise<void> => {
    assert(transport?.pid, 'Stdio MCP transport has no child pid.');
    process.kill(transport.pid, 'SIGKILL');
    await stop();
    await start();
  };

  await start();
  try {
    const imported = await call('dcsc_import', {
      filePath: path.resolve('test/fixtures/parity/xml/service-p3-s2.xml'),
      solutionMode: 'General Purpose',
    });
    const workspace = String(imported['session']);
    assert(workspace.startsWith('ws_'), 'Service quantity import returned no workspace.');
    const before = await call('dcsc_basket_browse', { basket: 'services', session: workspace });
    assert.equal(object(before['product'])['quantity'], IMPORTED_PRODUCT_QUANTITY);
    assert.equal(object(array(before['selections'])[0])['quantity'], IMPORTED_SERVICE_QUANTITY);
    const resized = await call('dcsc_basket_set', {
      basket: 'services', action: 'setProductQuantity',
      session: workspace,
      quantity: UPDATED_PRODUCT_QUANTITY,
      expectedRevision: Number(before['revision']),
    });
    assert.equal(object(resized['product'])['quantity'], UPDATED_PRODUCT_QUANTITY);
    assert.equal(object(array(resized['selections'])[0])['quantity'], IMPORTED_SERVICE_QUANTITY);
    assert.equal(summaryTotal(resized['summary']), IMPORTED_UPDATED_TOTAL);
    const exported = await call('dcsc_export', { kind: 'reports',
      session: workspace,
      fileName: 'stdio-imported-service-quantity',
    });
    const xmlPath = String(exported['xml']);
    const xml = readFileSync(xmlPath, 'utf8');
    assert.deepEqual(serviceXmlLines(xml), [{
      code: BASE,
      quantity: UPDATED_PRODUCT_QUANTITY * IMPORTED_SERVICE_QUANTITY,
      unitPrice: 1637,
      currency: 'USD',
    }]);

    await crashRestart();
    const restored = await call('dcsc_basket_browse', { basket: 'services', session: workspace });
    assert.equal(object(restored['product'])['quantity'], UPDATED_PRODUCT_QUANTITY);
    assert.equal(object(array(restored['selections'])[0])['quantity'], IMPORTED_SERVICE_QUANTITY);
    assert.equal(summaryTotal(restored['summary']), IMPORTED_UPDATED_TOTAL);
    const restoredExport = await call('dcsc_export', { kind: 'reports',
      session: workspace,
      fileName: 'stdio-restored-service-quantity',
    });
    const restoredXmlPath = String(restoredExport['xml']);
    assert.deepEqual(serviceXmlLines(readFileSync(restoredXmlPath, 'utf8')), serviceXmlLines(xml));
    return { calls, imported, resized, exported, restored, restoredExport, xmlPath, restoredXmlPath };
  } finally {
    await stop();
  }
}

async function main(): Promise<void> {
  const options = parseArgs();
  await mkdir(options.outDir, { recursive: true });
  configureLogger('error');
  const startedAt = new Date().toISOString();
  let browser: Browser | undefined;
  let service: DcscService | undefined;
  let failure: unknown;
  try {
    browser = await chromium.launch({ headless: true });
    const browserResult = await browserFlow(browser, options.origin, options.outDir);
    const browserImportedQuantity = await browserImportedQuantityFlow(
      browser,
      options.origin,
      options.outDir,
    );
    const mcp = await mcpFlow(options.outDir);
    service = mcp.service;
    const stdioImportedQuantity = await stdioImportedQuantityFlow(options.outDir);

    const browserRequests = [browserResult.base.request, browserResult.addOn.request,
      browserResult.removed.request, browserResult.readded.request];
    const mcpDerives = mcp.parityDerives;
    assert.deepEqual(mcpDerives, browserRequests, 'MCP selection/removal request sequence diverged from the browser.');
    const mcpSummary = mcp.paritySummary;
    assert.deepEqual(mcpSummary, browserResult.summaryRequest, 'MCP summary request diverged from the browser.');
    const mcpExport = mcp.captures.find(capture => capture.path === '/service_pacs/export');
    assert(mcpExport?.fields, 'MCP export form was not captured.');
    assert.deepEqual(normalizedExportForm(mcpExport.fields), normalizedExportForm(browserResult.exportFields));

    const browserXmlLines = serviceXmlLines(browserResult.xml);
    const mcpXmlLines = serviceXmlLines(mcp.xml);
    assert.deepEqual(browserXmlLines, [
      { code: ADD_ON, quantity: 1, unitPrice: 173, currency: 'USD' },
      { code: BASE, quantity: 1, unitPrice: 1637, currency: 'USD' },
    ].sort((left, right) => left.code.localeCompare(right.code)));
    assert.deepEqual(mcpXmlLines, browserXmlLines);
    assert.match(browserResult.xml, /<OutputType>Multiple Services<\/OutputType>/);
    assert.match(mcp.xml, /<OutputType>Multiple Services<\/OutputType>/);

    const browserImportResult = await browserImport(browser, options.origin, browserResult.xmlPath);
    const mcpImportResult = await browserImport(browser, options.origin, mcp.xmlPath);
    for (const imported of [browserImportResult, mcpImportResult]) {
      assert.match(imported.url, /#\/summary\/service$/);
      assert.deepEqual(imported.codes, [ADD_ON, BASE].sort());
      assert.equal(imported.productQuantity, 1);
      assert.deepEqual(imported.serviceQuantities, [
        { code: ADD_ON, quantity: 1 },
        { code: BASE, quantity: 1 },
      ].sort((left, right) => left.code.localeCompare(right.code)));
      assert.equal(imported.totalPrice, EXPECTED_TOTAL);
      assert.equal(imported.bodyHasCodes, true);
    }
    const importedQuantityReimport = await browserImport(
      browser, options.origin, mcp.importedQuantity.xmlPath,
    );
    assert.deepEqual(importedQuantityReimport.codes, [BASE]);
    assert.equal(importedQuantityReimport.productQuantity, UPDATED_PRODUCT_QUANTITY);
    assert.deepEqual(importedQuantityReimport.serviceQuantities, [
      { code: BASE, quantity: IMPORTED_SERVICE_QUANTITY },
    ]);
    assert.equal(importedQuantityReimport.totalPrice, IMPORTED_UPDATED_TOTAL);
    assert.equal(importedQuantityReimport.bodyHasCodes, true);
    const browserQuantityReimport = browserImportedQuantity.xmlPath
      ? await browserImport(browser, options.origin, browserImportedQuantity.xmlPath)
      : undefined;
    if (browserQuantityReimport) {
      assert.equal(browserQuantityReimport.productQuantity, UPDATED_PRODUCT_QUANTITY);
      assert.deepEqual(browserQuantityReimport.serviceQuantities, [
        { code: BASE, quantity: IMPORTED_SERVICE_QUANTITY },
      ]);
      assert.equal(browserQuantityReimport.totalPrice, IMPORTED_UPDATED_TOTAL);
    }

    const browserForm = normalizedExportForm(browserResult.exportFields);
    const mcpForm = normalizedExportForm(mcpExport.fields);
    await Promise.all([
      writeFile(path.join(options.outDir, 'browser-wire.json'), `${JSON.stringify({
        requests: browserRequests,
        summaryRequest: browserResult.summaryRequest,
        summaryResponse: browserResult.summaryResponse,
        export: browserForm,
        quantityControl: browserResult.quantityControl,
        importedQuantity: {
          imported: browserImportedQuantity.imported,
          quantityControl: browserImportedQuantity.quantityControl,
          export: normalizedExportForm(browserImportedQuantity.exportFields),
          exportStatus: browserImportedQuantity.exportStatus,
        exportResponse: browserImportedQuantity.exportResponse,
          nativeExportLimitation: browserImportedQuantity.nativeExportLimitation,
        },
      }, null, 2)}\n`),
      writeFile(path.join(options.outDir, 'mcp-wire.json'), `${JSON.stringify({
        captures: mcp.captures,
        result: mcp.result,
        export: mcpForm,
        rejectedQuantity: mcp.rejectedQuantity,
        importedQuantity: {
          resized: mcp.importedQuantity.resized,
          exactQuantity: mcp.importedQuantity.exactQuantity,
          summaryRequest: mcp.importedQuantity.summaryRequest,
          export: mcp.importedQuantity.export,
        },
        stdioImportedQuantity,
      }, null, 2)}\n`),
      writeFile(path.join(options.outDir, 'report.json'), `${JSON.stringify({
        status: 'passed', startedAt, finishedAt: new Date().toISOString(),
        product: PRODUCT, services: [BASE, ADD_ON], currency: 'USD', totalPrice: EXPECTED_TOTAL,
        selectionSequence: ['base selected', 'add-on selected', 'add-on removed', 'add-on re-added'],
        browser: {
          exportZip: browserResult.zipPath,
          exportXml: browserResult.xmlPath,
          xmlSha256: createHash('sha256').update(browserResult.xml).digest('hex'),
          commercialLines: browserXmlLines,
          reimport: browserImportResult,
          quantityControl: browserResult.quantityControl,
          importedQuantity: {
            imported: browserImportedQuantity.imported,
            quantityControl: browserImportedQuantity.quantityControl,
            exportStatus: browserImportedQuantity.exportStatus,
            exportData: normalizedExportForm(browserImportedQuantity.exportFields)['data'],
            exportResponse: browserImportedQuantity.exportResponse,
            nativeExportLimitation: browserImportedQuantity.nativeExportLimitation,
            nativeExportLimitationScope: 'Save after import and product-quantity resize',
            ...(browserImportedQuantity.zipPath
              ? { exportZip: browserImportedQuantity.zipPath }
              : {}),
            ...(browserImportedQuantity.xmlPath
              ? { exportXml: browserImportedQuantity.xmlPath }
              : {}),
            ...(browserImportedQuantity.xml
              ? {
                  xmlSha256: createHash('sha256').update(browserImportedQuantity.xml).digest('hex'),
                  commercialLines: serviceXmlLines(browserImportedQuantity.xml),
                }
              : {}),
            reimport: browserQuantityReimport,
          },
        },
        mcp: {
          exportZip: mcp.zipPath,
          exportXml: mcp.xmlPath,
          xmlSha256: createHash('sha256').update(mcp.xml).digest('hex'),
          commercialLines: mcpXmlLines,
          reimport: mcpImportResult,
          rejectedQuantity: mcp.rejectedQuantity,
          importedQuantity: {
            sourceProductQuantity: IMPORTED_PRODUCT_QUANTITY,
            updatedProductQuantity: UPDATED_PRODUCT_QUANTITY,
            preservedServiceQuantity: IMPORTED_SERVICE_QUANTITY,
            totalPrice: IMPORTED_UPDATED_TOTAL,
            summaryRequest: mcp.importedQuantity.summaryRequest,
            exportZip: mcp.importedQuantity.zipPath,
            exportXml: mcp.importedQuantity.xmlPath,
            xmlSha256: createHash('sha256').update(mcp.importedQuantity.xml).digest('hex'),
            commercialLines: serviceXmlLines(mcp.importedQuantity.xml),
            browserReimport: importedQuantityReimport,
          },
          stdioImportedQuantity: {
            calls: stdioImportedQuantity.calls.length,
            sourceProductQuantity: IMPORTED_PRODUCT_QUANTITY,
            updatedProductQuantity: UPDATED_PRODUCT_QUANTITY,
            preservedServiceQuantity: IMPORTED_SERVICE_QUANTITY,
            exportXml: stdioImportedQuantity.xmlPath,
            restoredExportXml: stdioImportedQuantity.restoredXmlPath,
          },
        },
        assertions: {
          exactDeriveSequence: true,
          exactSummaryRequest: true,
          exactExportSemantics: true,
          commercialXmlParity: true,
          freshBrowserReimportParity: true,
          nativeProductQuantityIsLocalOnly: true,
          nativeImportedServiceQuantityPreservedAcrossProductResize: true,
          nativeImportedResizeExportOutcomeVerified: true,
          normalizedServiceQuantityRollsBack: true,
          importedServiceQuantityPreservedAcrossProductResize: true,
          importedQuantityExportReimports: true,
          importedQuantitySurvivesStdioRestart: true,
        },
      }, null, 2)}\n`),
    ]);
    process.stdout.write(`${JSON.stringify({ status: 'passed', outDir: options.outDir,
      totalPrice: EXPECTED_TOTAL, services: [BASE, ADD_ON] }, null, 2)}\n`);
  } catch (error) {
    failure = error;
    await writeFile(path.join(options.outDir, 'report.json'), `${JSON.stringify({
      status: 'failed', startedAt, finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    }, null, 2)}\n`);
    throw error;
  } finally {
    await Promise.allSettled([service?.close(), browser?.close()]);
    if (failure) process.exitCode = 1;
  }
}

await main();
