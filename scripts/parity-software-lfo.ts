/**
 * Fresh headless round-trip for a mixed LFO workspace containing current
 * preconfigured hardware and standalone software.
 *
 * The script launches a current LFO through MCP only to produce a hardware seed.
 * Lenovo's website then composes standalone software through Product Catalog
 * > Software and authors the quantity-3 source used by the remainder of the run.
 *
 * Run: npx tsx scripts/parity-software-lfo.ts [--out artifacts/parity-software-lfo/<run>]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

import { ConfigSchema } from '../src/config/schema.js';
import {
  launchStandaloneSoftware,
  setStandaloneSoftwareQuantity,
  type StandaloneSoftwareState,
} from '../src/domain/standalone.js';
import { reconcileImportedSoftwareCatalog } from '../src/domain/importStandalone.js';
import { configureLogger } from '../src/http/trace.js';
import { writeExportBundle } from '../src/files/artifactStore.js';
import { DcscService } from '../src/mcp/service.js';
import { exportStandaloneSoftwareArtifact } from '../src/app/standalone.js';

export type Json = Record<string, unknown>;
export type ExportCapture = { path: string; fields: Record<string, string> };
export type CommercialProduct = {
  code: string;
  type: string;
  quantity: number;
  price: number | null;
  unitPrice: number | null;
};
export type XmlProduct = {
  code: string;
  type: string;
  quantity: number;
  unitPrice: number;
  children: Array<{ code: string; type: string; quantity: number; unitPrice: number }>;
};

const LFO_PRODUCT = '7DCE100GNA';
const SOFTWARE_CODE = '7S1S002WWW';
const HARDWARE_CODE = 'BFYB';
const HARDWARE_DESCRIPTION = 'Operating mode selection for: "Maximum Performance Mode"';

function parseArgs(argv = process.argv.slice(2)): { outDir: string; origin: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const result = {
    outDir: path.resolve(`artifacts/parity-software-lfo/${stamp}`),
    origin: 'https://dcsc.lenovo.com/',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--out', '--origin'].includes(key ?? '')) throw new Error(`Unknown argument: ${key}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${key} requires a value.`);
    if (key === '--out') result.outDir = path.resolve(value);
    else result.origin = value;
    index += 1;
  }
  return result;
}

export function object(value: unknown): Json {
  return typeof value === 'object' && value !== null ? value as Json : {};
}

export function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

export function money(value: unknown): number {
  const amount = Number(value);
  assert(Number.isFinite(amount), `Expected a finite monetary value, received ${String(value)}.`);
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function visible(locator: Locator, description: string): Promise<Locator> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    for (let index = 0; index < await locator.count(); index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Could not find a visible ${description}.`);
}

async function settle(page: Page): Promise<void> {
  await page.locator('.ant-spin-spinning:visible').first()
    .waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
}

async function newAuditContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    serviceWorkers: 'block',
  });
  await context.addInitScript({ content: `
    globalThis.__dcscAuditForms = [];
    HTMLFormElement.prototype.submit = function () {
      const fields = {};
      this.querySelectorAll('input').forEach(input => { fields[input.name] = input.value; });
      globalThis.__dcscAuditForms.push({ path: this.action, fields });
    };
  ` });
  return context;
}

export async function importInBrowser(
  browser: Browser,
  origin: string,
  xmlPath: string,
  summaryRoute: RegExp = /#\/rack-summary\/rack-lfo/,
): Promise<{ context: BrowserContext; page: Page; response: unknown; total: number }> {
  const context = await newAuditContext(browser);
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const file = page.locator('input[type=file]').first();
  await file.waitFor({ state: 'attached', timeout: 60_000 });
  const pending = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes('/multiple/cfxml_import'),
  { timeout: 120_000 });
  await file.setInputFiles(xmlPath);
  const response = await pending;
  assert.equal(response.status(), 200, `Browser import returned HTTP ${response.status()}.`);
  const imported = await response.json() as unknown;
  try {
    await page.waitForURL(summaryRoute, { timeout: 90_000 });
  } catch (error) {
    const envelope = Array.isArray(imported) ? imported[0] : imported;
    const record = object(envelope);
    const summary = {
      currentUrl: page.url(),
      responseKeys: Object.keys(record).sort(),
      type: record['type'],
      mode: record['mode'],
      configurationCount: array(record['configuration']).length,
      missingParts: array(record['missingParts']),
      removedParts: array(record['removedParts']),
    };
    throw new Error(`Browser import did not navigate to ${summaryRoute}: ${JSON.stringify(summary)}`, {
      cause: error,
    });
  }
  await settle(page);
  const cookie = page.locator('.dcsc-cookie-close').first();
  if (await cookie.isVisible({ timeout: 1_000 }).catch(() => false)) await cookie.click();
  return { context, page, response: imported, total: await readGrandTotal(page) };
}

async function readGrandTotal(page: Page): Promise<number> {
  const lines = (await page.locator('body').innerText()).split('\n').map(line => line.trim()).filter(Boolean);
  const label = lines.findIndex(line => /^grand total:?$/i.test(line));
  assert(label >= 0, 'Browser summary omitted Grand Total.');
  for (const line of lines.slice(label + 1, label + 5)) {
    const match = line.match(/[$€£]\s*([0-9][0-9,.]*)/);
    if (match) return money(match[1]?.replace(/,/g, ''));
  }
  throw new Error('Could not read browser Grand Total.');
}

async function setBrowserSoftwareQuantity(page: Page, quantity: number): Promise<void> {
  const customizes = page.getByText('Customize', { exact: true });
  await visible(customizes, 'summary Customize action');
  let customize: Locator | undefined;
  for (let index = 0; index < await customizes.count(); index += 1) {
    const candidate = customizes.nth(index);
    if (await candidate.isVisible()) customize = candidate;
  }
  assert(customize, 'Summary did not expose a visible standalone Customize action.');
  await customize.click();
  await page.waitForURL(/#\/software(?:\?|$)/, { timeout: 90_000 });
  await settle(page);
  await selectSoftwareQuantityOnCatalog(page, quantity);
}

async function composeBrowserSoftware(page: Page, quantity: number): Promise<void> {
  await (await visible(page.getByText('Show Product Catalog', { exact: true }), 'Show Product Catalog action')).click();
  await (await visible(page.getByText('Software', { exact: true }), 'Software catalog category')).click();
  await page.waitForURL(/#\/software(?:\?|$)/, { timeout: 90_000 });
  await settle(page);
  await selectSoftwareQuantityOnCatalog(page, quantity);
}

export async function setBrowserHardwareOption(
  page: Page,
  outDir: string,
  routes: {
    derivePath?: '/lfos/autoDerive' | '/ctos/autoDerive';
    configuration?: RegExp;
    summary?: RegExp;
    expectInitialDerive?: boolean;
  } = {},
): Promise<{ query: Json; request: Json; response: Json; totalPrice: number; price: number }> {
  const derivePath = routes.derivePath ?? '/lfos/autoDerive';
  const configurationRoute = routes.configuration ?? /#\/configuration\/lfo\//;
  const summaryRoute = routes.summary ?? /#\/rack-summary\/rack-lfo/;
  const customizes = page.getByText('Customize', { exact: true });
  await visible(customizes, 'summary Customize action');
  let hardware: Locator | undefined;
  for (let index = 0; index < await customizes.count(); index += 1) {
    const candidate = customizes.nth(index);
    if (await candidate.isVisible()) {
      hardware = candidate;
      break;
    }
  }
  assert(hardware, 'Summary did not expose a visible LFO hardware Customize action.');
  const initial = routes.expectInitialDerive === false ? undefined : page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes(derivePath),
  { timeout: 120_000 });
  await hardware.click();
  await page.waitForURL(configurationRoute, { timeout: 90_000 });
  if (initial) {
    const initialResponse = await initial;
    assert.equal(initialResponse.status(), 200,
      `Browser LFO customization launch returned HTTP ${initialResponse.status()}.`);
  }
  await settle(page);

  const description = await visible(page.getByText(HARDWARE_DESCRIPTION, { exact: true }), HARDWARE_DESCRIPTION);
  const input = description.locator('xpath=ancestor::*[.//input[@type="radio"]][1]//input[@type="radio"]');
  assert.equal(await input.count(), 1, `Could not isolate the ${HARDWARE_CODE} radio input.`);
  const pending = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes(derivePath),
  { timeout: 120_000 });
  await input.click();
  const derive = await pending;
  assert.equal(derive.status(), 200, `Browser LFO hardware edit returned HTTP ${derive.status()}.`);
  const request = derive.request().postDataJSON() as Json;
  const response = object(await derive.json());
  const url = new URL(derive.url());
  const query: Json = {
    configurationId: url.searchParams.get('configurationId'),
    entranceFlag: url.searchParams.get('entranceFlag'),
    ...(url.searchParams.has('guideMode')
      ? { guideMode: url.searchParams.get('guideMode') === 'true' }
      : {}),
    ...(url.searchParams.has('isLfo')
      ? { isLfo: url.searchParams.get('isLfo') === 'true' }
      : {}),
    ...(url.searchParams.has('scope') ? { scope: url.searchParams.get('scope') } : {}),
  };
  await writeFile(path.join(outDir, 'browser-lfo-hardware-request.json'), `${JSON.stringify(request, null, 2)}\n`);
  await writeFile(path.join(outDir, 'browser-lfo-hardware-response.json'), `${JSON.stringify(response, null, 2)}\n`);
  await writeFile(path.join(outDir, 'browser-lfo-hardware-query.json'), `${JSON.stringify(query, null, 2)}\n`);
  await settle(page);
  const configuration = object(array(response['configurations'])[0]);
  assert.equal(selectedQuantity(configuration, HARDWARE_CODE), 1,
    `Browser response did not select ${HARDWARE_CODE}.`);
  await (await visible(page.getByRole('button', { name: 'Summary' }), 'hardware Summary button')).click();
  await page.waitForURL(summaryRoute, { timeout: 90_000 });
  await settle(page);
  return {
    query,
    request,
    response,
    totalPrice: money(configuration['totalPrice']),
    price: money(configuration['price'] ?? object(array(configuration['totalPrices'])[0])['price']),
  };
}

function selectedQuantity(configuration: Json, code: string): number {
  for (const tab of array(configuration['tabs'])) {
    for (const subTab of array(object(tab)['subTabs'])) {
      for (const section of array(object(subTab)['sections'])) {
        for (const result of array(object(section)['results'])) {
          const item = object(result);
          if (text(item['code']) === code) return Number(item['quantity'] ?? 0);
        }
      }
    }
  }
  return 0;
}

async function selectSoftwareQuantityOnCatalog(page: Page, quantity: number): Promise<void> {
  const row = page.locator('.software-feature').filter({
    has: page.locator('.software-feature__code').filter({ hasText: new RegExp(`^${SOFTWARE_CODE}$`) }),
  });
  assert.equal(await row.count(), 1, `Could not isolate ${SOFTWARE_CODE} software row.`);
  const select = await visible(row.getByRole('combobox'), `${SOFTWARE_CODE} quantity selector`);
  await select.click();
  const option = await visible(
    page.locator('.ant-select-dropdown:visible .ant-select-dropdown-menu-item').filter({ hasText: new RegExp(`^${quantity}$`) }),
    `software quantity ${quantity}`,
  );
  await option.click();
  await settle(page);
  await (await visible(page.getByRole('button', { name: 'Summary' }), 'software Summary button')).click();
  await page.waitForURL(/#\/rack-summary\/rack-lfo/, { timeout: 90_000 });
  await settle(page);
}

export async function captureBrowserExport(
  page: Page,
  outDir: string,
  name: string,
): Promise<{ capture: ExportCapture; archive: string; xmlPath: string; xml: string; groups: unknown; data: Json }> {
  await (await visible(page.getByRole('button', { name: 'Export' }), 'Export button'))
    .evaluate(element => (element as HTMLElement).click());
  await visible(page.locator('button.ant-btn-primary').filter({ hasText: /^Save$/ }), 'export Save button');
  const xmlChoice = await visible(page.getByText('XML', { exact: true }), 'XML export choice');
  const container = xmlChoice.locator(
    'xpath=ancestor::*[self::label or contains(@class,"checkbox") or .//input[@type="checkbox"]][1]',
  );
  const box = container.locator('input[type=checkbox]');
  if (await box.count()) {
    if (!(await box.isChecked())) await xmlChoice.click();
  } else await xmlChoice.click();
  const filename = page.locator('input.ant-input[type=text]').last();
  if (await filename.count()) await filename.fill(name);
  const before = await auditForms(page);
  await page.locator('button.ant-btn-primary').filter({ hasText: /^Save$/ }).last().click();
  await page.waitForTimeout(800);
  const captures = await auditForms(page);
  const capture = captures.slice(before.length).find(candidate => candidate.path.includes('/export_zip'));
  assert(capture, `${name}: browser did not submit its export form.`);
  await writeFile(path.join(outDir, `${name}-form.json`), `${JSON.stringify(capture, null, 2)}\n`);
  const response = await page.context().request.post(capture.path, { form: capture.fields, timeout: 120_000 });
  assert(response.ok(), `${name}: browser export returned HTTP ${response.status()}.`);
  const bytes = await response.body();
  assert.equal(bytes.subarray(0, 2).toString(), 'PK', `${name}: browser export was not a ZIP.`);
  const archive = path.join(outDir, `${name}.zip`);
  await writeFile(archive, bytes);
  const xml = await firstXml(archive);
  const xmlPath = path.join(outDir, `${name}.xml`);
  await writeFile(xmlPath, xml);
  return {
    capture,
    archive,
    xmlPath,
    xml,
    groups: JSON.parse(capture.fields['groups'] ?? '[]') as unknown,
    data: object(JSON.parse(capture.fields['data'] ?? '{}')),
  };
}

async function auditForms(page: Page): Promise<ExportCapture[]> {
  return page.evaluate(() =>
    (globalThis as unknown as { __dcscAuditForms?: ExportCapture[] }).__dcscAuditForms ?? []);
}

export function normalizedGroups(value: unknown): CommercialProduct[] {
  return array(value).flatMap(group => array(object(group)['products'])).map(raw => {
    const product = object(raw);
    return {
      code: text(product['code']).replaceAll('-', ''),
      type: text(product['type']).toLowerCase(),
      quantity: Number(product['quantity'] ?? 0),
      price: product['price'] === null || product['price'] === undefined ? null : money(product['price']),
      unitPrice: product['unitPrice'] === null || product['unitPrice'] === undefined
        ? null : money(product['unitPrice']),
    };
  }).sort(compareCommercialProduct);
}

function compareCommercialProduct(left: CommercialProduct, right: CommercialProduct): number {
  return left.type.localeCompare(right.type) || left.code.localeCompare(right.code) ||
    left.quantity - right.quantity || Number(left.unitPrice ?? -1) - Number(right.unitPrice ?? -1);
}

export function normalizedXml(xml: string): XmlProduct[] {
  const parsed = object(new XMLParser({ ignoreAttributes: false, parseTagValue: true }).parse(xml));
  const cfData = object(object(object(parsed['CFXML'])['CFData']));
  return array(cfData['ProductLineItem']).map(raw => {
    const line = object(raw);
    const identity = object(object(line['ProductIdentification'])['PartnerProductIdentification']);
    const price = object(object(line['UnitListPrice'])['FinancialAmount']);
    return {
      code: text(identity['ProprietaryProductIdentifier']).replaceAll('-', ''),
      type: text(identity['ProductTypeCode']),
      quantity: Number(line['Quantity'] ?? 0),
      unitPrice: money(price['MonetaryAmount'] ?? 0),
      children: array(line['ProductSubLineItem']).map(childRaw => {
        const child = object(childRaw);
        const childIdentity = object(object(child['ProductIdentification'])['PartnerProductIdentification']);
        const childPrice = object(object(child['UnitListPrice'])['FinancialAmount']);
        return {
          code: text(childIdentity['ProprietaryProductIdentifier']).replaceAll('-', ''),
          type: text(childIdentity['ProductTypeCode']),
          quantity: Number(child['Quantity'] ?? 0),
          unitPrice: money(childPrice['MonetaryAmount'] ?? 0),
        };
      }).sort(compareXmlChild),
    };
  }).sort(compareXmlProduct);
}

function compareXmlChild(
  left: XmlProduct['children'][number],
  right: XmlProduct['children'][number],
): number {
  return left.type.localeCompare(right.type) || left.code.localeCompare(right.code) ||
    left.quantity - right.quantity || left.unitPrice - right.unitPrice;
}

function compareXmlProduct(left: XmlProduct, right: XmlProduct): number {
  return left.type.localeCompare(right.type) || left.code.localeCompare(right.code) ||
    left.quantity - right.quantity || left.unitPrice - right.unitPrice;
}

function softwareLine(groups: CommercialProduct[], quantity: number): CommercialProduct {
  const matches = groups.filter(product =>
    product.code === SOFTWARE_CODE && product.type === 'standalone' && product.quantity === quantity);
  assert.equal(matches.length, 1, `Expected one standalone ${SOFTWARE_CODE} quantity ${quantity} line.`);
  return matches[0] as CommercialProduct;
}

async function firstXml(archive: string): Promise<string> {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true }, (error, value) => {
      if (error || !value) reject(error ?? new Error(`Could not open ${archive}.`));
      else resolve(value);
    });
  });
  return new Promise((resolve, reject) => {
    zip.once('error', reject);
    zip.on('entry', (entry: Entry) => {
      if (!entry.fileName.toLowerCase().endsWith('.xml')) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          reject(error ?? new Error(`Could not read ${entry.fileName}.`));
          return;
        }
        const chunks: Buffer[] = [];
        stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
        stream.once('error', reject);
        stream.once('end', () => {
          zip.close();
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      });
    });
    zip.once('end', () => reject(new Error(`${archive} contains no XML file.`)));
    zip.readEntry();
  });
}

async function main(): Promise<void> {
  const options = parseArgs();
  await mkdir(options.outDir, { recursive: true });
  const startedAt = new Date().toISOString();
  let browser: Browser | undefined;
  let service: DcscService | undefined;
  let failure: unknown;
  let report: Json = {};
  try {
    configureLogger('error');
    browser = await chromium.launch({ headless: true });
    const config = ConfigSchema.parse({
      logLevel: 'error',
      files: { persistSessions: false, artifactDir: path.join(options.outDir, 'mcp-artifacts') },
      pacing: { perToolRequestBudget: 100 },
    });
    service = new DcscService(config);

    // Produce a current hardware-only LFO seed, then compose standalone software
    // through Lenovo's visible Product Catalog > Software website route.
    const seedCtx = service.newCtx();
    const seedSolution = await service.resolveSolution(seedCtx, 'General Purpose');
    const seedSession = await service.launch({
      productCode: LFO_PRODUCT,
      mode: 'lfo',
      solution: seedSolution,
      ctx: service.newCtx(),
      label: 'mixed LFO parity seed',
    });
    assert.equal(seedSession.mode, 'lfo');
    const seedExport = await service.exportZip(seedSession.id, {
      fileTypes: ['XML'],
      fileName: 'lfo-hardware-seed',
      ctx: service.newCtx(),
      scope: 'configuration',
    });
    const seedBundle = await writeExportBundle(seedExport.stream, 'lfo-hardware-seed', config);
    assert(seedBundle.xml, 'Current LFO hardware export did not contain XML.');
    const seedXml = path.join(options.outDir, 'lfo-hardware-seed.xml');
    const seedZip = path.join(options.outDir, 'lfo-hardware-seed.zip');
    await copyFile(seedBundle.xml, seedXml);
    await copyFile(seedBundle.zipPath, seedZip);

    const seeded = await importInBrowser(browser, options.origin, seedXml);
    const hardwareOnlyTotal = seeded.total;
    await composeBrowserSoftware(seeded.page, 3);
    const sourceTotal = await readGrandTotal(seeded.page);
    const source = await captureBrowserExport(seeded.page, options.outDir, 'browser-mixed-qty3-source');
    const sourceGroups = normalizedGroups(source.groups);
    const sourceSoftware = softwareLine(sourceGroups, 3);
    assert.equal(sourceSoftware.unitPrice, 234.5);
    assert.equal(sourceSoftware.price, 703.5);
    await seeded.context.close();

    // Import the browser handoff into MCP, refresh its catalog without repricing,
    // edit the selected quantity and export the complete mixed workspace.
    const imported = await service.importConfig({
      content: source.xml,
      fileName: 'browser-mixed-qty3-source.xml',
      ctx: service.newCtx(),
    });
    const workspace = service.sessions.getWorkspace(imported.workspaceId);
    assert(workspace, 'MCP import did not publish its workspace.');
    assert.equal(workspace.configurations.size, 1, 'Mixed LFO source did not restore its hardware configuration.');
    assert.equal([...workspace.configurations.values()][0]?.mode, 'lfo');
    const importedState = workspace.serverState['standaloneSoftwareState'] as StandaloneSoftwareState;
    assert.equal(importedState.selections.length, 1);
    assert.equal(importedState.selections[0]?.quantity, 3);
    assert.equal(importedState.selections[0]?.unitPrice, 234.5);
    assert.equal(importedState.selections[0]?.totalPrice, 703.5);

    const mcpForms: ExportCapture[] = [];
    let mcpHardwareRequest: { query: Json; body: Json } | undefined;
    let mcpHardwareResponse: Json | undefined;
    const originalSend = service.http.send.bind(service.http);
    service.http.send = (async request => {
      if (request.path === '/lfos/autoDerive' && request.body?.kind === 'json') {
        mcpHardwareRequest = {
          query: structuredClone(request.query ?? {}),
          body: structuredClone(request.body.value) as Json,
        };
      }
      if (request.path.endsWith('/export_zip') && request.body?.kind === 'form') {
        mcpForms.push({ path: request.path, fields: structuredClone(request.body.fields) });
      }
      if (request.responseKind === 'json') {
        const result = await originalSend(request as typeof request & { responseKind: 'json' });
        if (request.path === '/lfos/autoDerive') mcpHardwareResponse = structuredClone(result.raw) as Json;
        return result;
      }
      return originalSend(request);
    }) as typeof service.http.send;

    const hardwareSession = [...workspace.configurations.values()][0]!;
    const hardwareRef = hardwareSession.index.byCode.get(HARDWARE_CODE)?.[0];
    assert(hardwareRef, `Imported LFO index omitted ${HARDWARE_CODE}.`);
    const configured = await service.configure(hardwareSession, [{
      section: hardwareRef.section,
      code: HARDWARE_CODE,
      quantity: 1,
    }], service.newCtx({ locale: workspace.locale, solution: workspace.solution }));
    assert.equal(selectedQuantity(configured.raw as Json, HARDWARE_CODE), 1,
      `MCP response did not select ${HARDWARE_CODE}.`);
    assert(mcpHardwareRequest && mcpHardwareResponse, 'MCP LFO hardware request was not captured.');
    await writeFile(path.join(options.outDir, 'mcp-lfo-hardware-request.json'),
      `${JSON.stringify(mcpHardwareRequest, null, 2)}\n`);
    await writeFile(path.join(options.outDir, 'mcp-lfo-hardware-response.json'),
      `${JSON.stringify(mcpHardwareResponse, null, 2)}\n`);

    const refreshCtx = service.newCtx({ locale: workspace.locale, solution: workspace.solution });
    const refreshedCatalog = await launchStandaloneSoftware(service.http, refreshCtx);
    await service.sessions.transact(workspace.id, {
      expectedRevision: workspace.revision,
      keepEmptyWorkspace: true,
    }, draft => {
      const current = draft.serverState['standaloneSoftwareState'] as StandaloneSoftwareState;
      draft.serverState['standaloneSoftwareState'] = reconcileImportedSoftwareCatalog(current, refreshedCatalog);
    });
    const refreshed = workspace.serverState['standaloneSoftwareState'] as StandaloneSoftwareState;
    assert.equal(refreshed.selections[0]?.quantity, 3);
    assert.equal(refreshed.selections[0]?.unitPrice, 234.5);
    assert.equal(refreshed.selections[0]?.totalPrice, 703.5);
    await service.sessions.transact(workspace.id, {
      expectedRevision: workspace.revision,
      keepEmptyWorkspace: true,
    }, draft => {
      const current = draft.serverState['standaloneSoftwareState'] as StandaloneSoftwareState;
      draft.serverState['standaloneSoftwareState'] = setStandaloneSoftwareQuantity(current, SOFTWARE_CODE, 4);
    });
    const edited = workspace.serverState['standaloneSoftwareState'] as StandaloneSoftwareState;
    assert.equal(edited.selections[0]?.unitPrice, 234.5);
    assert.equal(edited.selections[0]?.totalPrice, 938);

    const artifact = await exportStandaloneSoftwareArtifact(
      service,
      workspace,
      'mcp-mixed-qty4',
      { fileTypes: ['XML'] },
    );
    const mcpForm = mcpForms.at(-1);
    assert(mcpForm, 'MCP mixed export form was not captured.');
    assert(mcpForm.path.endsWith('/lfos/export_zip'), `MCP used unexpected endpoint ${mcpForm.path}.`);
    await writeFile(path.join(options.outDir, 'mcp-mixed-qty4-form.json'), `${JSON.stringify(mcpForm, null, 2)}\n`);
    const mcpZip = path.join(options.outDir, 'mcp-mixed-qty4.zip');
    const mcpXmlPath = path.join(options.outDir, 'mcp-mixed-qty4.xml');
    await copyFile(artifact.zipPath, mcpZip);
    assert(artifact.xml, 'MCP mixed archive did not contain XML.');
    await copyFile(artifact.xml, mcpXmlPath);
    const mcpXml = await readFile(mcpXmlPath, 'utf8');
    const mcpGroups = normalizedGroups(JSON.parse(mcpForm.fields['groups'] ?? '[]'));

    // Create the same edit through a second fresh browser and capture Lenovo's
    // exact current quantity-4 mixed export as the oracle.
    const browserEdited = await importInBrowser(browser, options.origin, source.xmlPath);
    const browserHardware = await setBrowserHardwareOption(browserEdited.page, options.outDir);
    assert.deepEqual(mcpHardwareRequest.query, browserHardware.query,
      'MCP LFO hardware query differs from the website request.');
    const browserRequestConfiguration = object(array(browserHardware.request['configurations'])[0]);
    const mcpRequestConfiguration = object(array(mcpHardwareRequest.body['configurations'])[0]);
    const browserDelta = object(browserRequestConfiguration['delta']);
    const mcpDelta = object(mcpRequestConfiguration['delta']);
    for (const field of ['section', 'featureCode', 'quantity', 'isClear', 'type']) {
      assert.deepEqual(mcpDelta[field], browserDelta[field],
        `MCP LFO hardware delta differs from the website for ${field}.`);
    }
    const mcpConfiguration = object(array(mcpHardwareResponse['configurations'])[0]);
    assert.equal(money(mcpConfiguration['price']), browserHardware.price);
    assert.equal(money(mcpConfiguration['totalPrice']), browserHardware.totalPrice);
    await setBrowserSoftwareQuantity(browserEdited.page, 4);
    const browserQuantity4Total = await readGrandTotal(browserEdited.page);
    const oracle = await captureBrowserExport(browserEdited.page, options.outDir, 'browser-mixed-qty4-oracle');
    const oracleGroups = normalizedGroups(oracle.groups);
    const oracleSoftware = softwareLine(oracleGroups, 4);
    assert.equal(oracleSoftware.unitPrice, 234.5);
    assert.equal(oracleSoftware.price, 938);
    assert.deepEqual(mcpGroups, oracleGroups, 'MCP mixed groups differ from the edited browser export.');
    const mcpBom = normalizedXml(mcpXml);
    const browserBom = normalizedXml(oracle.xml);
    assert.deepEqual(mcpBom, browserBom, 'MCP mixed XML BOM differs from the edited browser XML.');
    await browserEdited.context.close();

    const families = new Set(mcpGroups.map(product => product.type));
    for (const family of ['hardware', 'standalone']) {
      assert(families.has(family), `Mixed export omitted ${family} products.`);
    }
    assert(mcpGroups.some(product => product.code === LFO_PRODUCT && product.type === 'hardware'),
      `Mixed export omitted LFO hardware ${LFO_PRODUCT}.`);

    // Prove the MCP archive is accepted by a third fresh browser and that its
    // import response restores the standalone commercial line.
    const reimported = await importInBrowser(browser, options.origin, mcpXmlPath);
    const envelope = object(array(reimported.response)[0]);
    const standalone = array(envelope['standaloneData']).map(object)
      .find(item => text(item['code']).replaceAll('-', '') === SOFTWARE_CODE);
    assert(standalone, 'Browser reimport response omitted standalone software.');
    assert.equal(Number(standalone['quantity']), 4);
    const reimportGroups = normalizedGroups(envelope['groups']);
    const reimportSoftware = softwareLine(reimportGroups, 4);
    assert.equal(reimportSoftware.unitPrice, 234.5);
    assert.equal(reimportSoftware.price, 938);
    assert.deepEqual(reimportGroups, mcpGroups, 'Fresh browser reimport changed the mixed commercial groups.');
    assert.equal(reimported.total, browserQuantity4Total, 'Fresh browser reimport total differs from browser oracle.');
    await writeFile(path.join(options.outDir, 'browser-reimport-normalized.json'), `${JSON.stringify({
      url: reimported.page.url(),
      grandTotal: reimported.total,
      configurationCount: array(envelope['configuration']).length,
      groups: reimportGroups,
      standaloneData: standalone,
    }, null, 2)}\n`);
    await reimported.context.close();

    report = {
      schemaVersion: 1,
      status: 'pass',
      headless: true,
      freshBrowserContexts: 3,
      startedAt,
      completedAt: new Date().toISOString(),
      seed: {
        product: LFO_PRODUCT,
        mode: seedSession.mode,
        hardwareOnlyGrandTotal: hardwareOnlyTotal,
        archive: { path: seedZip, sha256: sha256(await readFile(seedZip)) },
      },
      source: {
        browserGrandTotal: sourceTotal,
        standalone: sourceSoftware,
        groupsSha256: sha256(JSON.stringify(sourceGroups)),
        xmlBomSha256: sha256(JSON.stringify(normalizedXml(source.xml))),
      },
      edited: {
        browserGrandTotal: browserQuantity4Total,
        reimportGrandTotal: reimported.total,
        standalone: oracleSoftware,
        groupsSha256: sha256(JSON.stringify(oracleGroups)),
        xmlBomSha256: sha256(JSON.stringify(browserBom)),
        configurations: workspace.configurations.size,
        families: [...families].sort(),
        hardware: {
          code: HARDWARE_CODE,
          browserPrice: browserHardware.price,
          browserTotalPrice: browserHardware.totalPrice,
          requestSha256: sha256(JSON.stringify(browserHardware.request)),
          requestEnvelopeExactMatch:
            JSON.stringify(mcpHardwareRequest.body) === JSON.stringify(browserHardware.request),
          browserAutoVariant: object(browserHardware.request['customizingFlags'])['autoVariant'],
          mcpAutoVariant: object(mcpHardwareRequest.body['customizingFlags'])['autoVariant'],
          browserImportInformationCount: array(browserHardware.request['importInformation']).length,
          mcpImportInformationCount: array(mcpHardwareRequest.body['importInformation']).length,
        },
      },
      archives: {
        browserSource: { path: source.archive, sha256: sha256(await readFile(source.archive)) },
        browserOracle: { path: oracle.archive, sha256: sha256(await readFile(oracle.archive)) },
        mcp: { path: mcpZip, sha256: sha256(await readFile(mcpZip)) },
      },
      assertions: {
        importedBrowserAuthoredSource: true,
        lfoHardwareQueryMatchesBrowser: true,
        lfoHardwareDeltaMatchesBrowser: true,
        lfoHardwareStateAndPriceMatchBrowser: true,
        refreshPreservedImportedPrice: true,
        editPreservedUnitPrice: true,
        completeGroupsMatchBrowser: true,
        completeXmlBomMatchesBrowser: true,
        freshBrowserReimportAccepted: true,
        freshBrowserReimportCommercialGroupsMatch: true,
      },
    };
    console.log('PASS mixed LFO hardware + standalone software round-trip');
  } catch (error) {
    failure = error;
    report = {
      schemaVersion: 1,
      status: 'fail',
      headless: true,
      startedAt,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
    console.error(error);
  } finally {
    await Promise.allSettled([service?.close() ?? Promise.resolve(), browser?.close() ?? Promise.resolve()]);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(path.join(options.outDir, 'report.json'), serialized);
    await writeFile(path.join(options.outDir, 'report.sha256'), `${sha256(serialized)}  report.json\n`);
    console.log(`Report: ${path.join(options.outDir, 'report.json')}`);
  }
  if (failure) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
