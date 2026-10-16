/**
 * Fresh headless browser/MCP export differential for a priced embedded CAL.
 *
 * Captures Lenovo's own hidden export form and archive after selecting three
 * 50-user CAL packs, then compares MCP configuration/workspace groups and XML
 * commercial lines against that browser-authored handoff.
 *
 * Run: npx tsx scripts/parity-software-export.ts [--out artifacts/parity-software-export/<run>]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { chromium, type Browser, type Locator, type Page, type Response } from 'playwright';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

import { ConfigSchema } from '../src/config/schema.js';
import { configureLogger } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';

type Json = Record<string, unknown>;
type ExportCapture = { path: string; fields: Record<string, string> };
type Product = {
  code: string;
  type: string;
  quantity: number;
  price: number | null;
  unitPrice: number | null;
};
type XmlLine = {
  code: string;
  type: string;
  quantity: number;
  unitPrice: number;
  children: Array<{ code: string; quantity: number; unitPrice: number }>;
};

const PRODUCT = '7D73CTO1WW';
const SOFTWARE_DERIVE = /\/api\/ctos\/autoDerive(?:\?|$)/;

function parseArgs(argv = process.argv.slice(2)): { outDir: string; origin: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let outDir = path.resolve(`artifacts/parity-software-export/${stamp}`);
  let origin = 'https://dcsc.lenovo.com/';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--out' && argument !== '--origin') throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value.`);
    if (argument === '--out') outDir = path.resolve(value);
    else origin = value;
    index += 1;
  }
  return { outDir, origin };
}

function object(value: unknown): Json {
  return typeof value === 'object' && value !== null ? value as Json : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function quantitiesForCode(value: unknown, code: string): number[] {
  if (Array.isArray(value)) return value.flatMap(item => quantitiesForCode(item, code));
  if (typeof value !== 'object' || value === null) return [];
  const item = value as Json;
  const own = item['code'] === code && Number.isFinite(Number(item['quantity']))
    ? [Number(item['quantity'])]
    : [];
  return own.concat(Object.values(item).flatMap(child => quantitiesForCode(child, code)));
}

function money(value: unknown): number {
  const amount = Number(value);
  assert(Number.isFinite(amount), `Expected a finite monetary value, received ${String(value)}.`);
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function visible(locator: Locator, description: string): Promise<Locator> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (let index = 0; index < await locator.count(); index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Could not find a visible ${description}.`);
}

async function waitUntilSettled(page: Page): Promise<void> {
  await page.locator('.ant-spin-spinning:visible').first()
    .waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
}

function isSoftwareDerive(response: Response): boolean {
  return response.request().method() === 'POST' && SOFTWARE_DERIVE.test(response.url()) &&
    new URL(response.url()).searchParams.get('isCustomizeOSSoftware') === 'true';
}

async function softwareAction(page: Page, interact: () => Promise<void>): Promise<Json> {
  const pending = page.waitForResponse(isSoftwareDerive, { timeout: 90_000 });
  await interact();
  const response = await pending;
  assert.equal(response.status(), 200, `Software derive returned HTTP ${response.status()}.`);
  await waitUntilSettled(page);
  return object(await response.json());
}

async function chooseAntOption(page: Page, select: Locator, text: string): Promise<void> {
  await select.click();
  const dropdown = await visible(page.locator('.ant-select-dropdown:visible'), `${text} dropdown`);
  await (await visible(
    dropdown.locator('.ant-select-dropdown-menu-item').filter({ hasText: text }),
    `${text} option`,
  )).click();
}

async function configureBrowser(page: Page, origin: string): Promise<{ totalPrice: number; patch: Json }> {
  await page.goto(
    new URL(`#/configuration/cto/${PRODUCT}?hardwareType=server`, origin).href,
    { waitUntil: 'domcontentloaded', timeout: 90_000 },
  );
  const cookie = page.locator('.dcsc-cookie-close').first();
  if (await cookie.isVisible({ timeout: 2_000 }).catch(() => false)) await cookie.click();
  await visible(page.getByText('Configuration Price', { exact: true }), 'Configuration Price');
  await (await visible(page.getByText('OS & Software', { exact: true }), 'OS & Software tab')).click();
  await (await visible(page.getByText('Microsoft', { exact: true }), 'Microsoft tab')).click();
  await (await visible(
    page.getByText('Windows Server 2025 CAL', { exact: true }),
    'Windows Server 2025 CAL section',
  )).click();
  const boxes = page.locator('label.ant-checkbox-wrapper:not(.screen):visible');
  assert((await boxes.count()) >= 2, 'CAL section did not expose its actual checkbox controls.');
  await softwareAction(page, () => boxes.nth(0).click());
  const heading = await visible(
    page.getByText('Windows Server 2025 User CALs', { exact: true }),
    'Windows Server 2025 User CAL group',
  );
  const panel = heading.locator('xpath=ancestor::*[.//*[normalize-space(text())="Reset"]][1]');
  assert.equal(await panel.count(), 1, 'Could not isolate the User CAL panel.');
  await softwareAction(page, () => chooseAntOption(
    page,
    panel.locator('.ant-select:visible').first(),
    'Windows Server 2025 CAL (50 User)',
  ));
  const patch = await softwareAction(page, () => chooseAntOption(
    page,
    panel.locator('.ant-select:visible').last(),
    '3',
  ));
  const totalPrice = await readDisplayedTotal(page);
  return { totalPrice, patch };
}

async function readDisplayedTotal(page: Page): Promise<number> {
  const lines = (await page.locator('body').innerText()).split('\n').map(line => line.trim()).filter(Boolean);
  const label = lines.findIndex(line => /^(?:configuration|total) price:?$/i.test(line));
  assert(label >= 0, 'Could not find the displayed Configuration Price label.');
  for (const line of lines.slice(label + 1, label + 6)) {
    const match = line.match(/[$€£]\s*([0-9][0-9,.]*)/);
    if (match) return money(match[1]?.replace(/,/g, ''));
  }
  throw new Error('Could not read the displayed Configuration Price.');
}

async function captureBrowserExport(page: Page, outDir: string): Promise<{
  capture: ExportCapture;
  archive: string;
  xml: string;
  data: Json;
  groups: unknown;
}> {
  await (await visible(page.getByRole('button', { name: 'Summary' }), 'Summary button'))
    .evaluate(element => (element as HTMLElement).click());
  await page.waitForURL(/rack-summary/, { waitUntil: 'commit', timeout: 60_000 });
  await waitUntilSettled(page);
  await page.waitForTimeout(1_500);
  await (await visible(page.getByRole('button', { name: 'Export' }), 'Export button'))
    .evaluate(element => (element as HTMLElement).click());
  await visible(page.locator('button.ant-btn-primary').filter({ hasText: /^Save$/ }), 'export Save button');
  const xmlChoice = await visible(page.getByText('XML', { exact: true }), 'XML export choice');
  const xmlContainer = xmlChoice.locator(
    'xpath=ancestor::*[self::label or contains(@class,"checkbox") or .//input[@type="checkbox"]][1]',
  );
  const xmlBox = xmlContainer.locator('input[type=checkbox]');
  if (await xmlBox.count()) {
    if (!(await xmlBox.isChecked())) await xmlChoice.click();
  } else {
    await xmlChoice.click();
  }
  const filename = page.locator('input.ant-input[type=text]').last();
  if (await filename.count()) await filename.fill('browser-priced-cal-qty3');
  await page.locator('button.ant-btn-primary').filter({ hasText: /^Save$/ }).last().click();
  await page.waitForTimeout(500);
  const captures = await page.evaluate(() =>
    (globalThis as unknown as { __dcscAuditForms?: ExportCapture[] }).__dcscAuditForms ?? []);
  const capture = captures[0];
  assert(capture, 'Browser did not submit its hidden export form.');
  assert(capture.path.includes('/ctos/export_zip'), `Unexpected browser export endpoint ${capture.path}.`);
  const data = object(JSON.parse(capture.fields['data'] ?? '{}'));
  const groups = JSON.parse(capture.fields['groups'] ?? '[]') as unknown;
  await writeFile(path.join(outDir, 'browser-export-form.json'), `${JSON.stringify(capture, null, 2)}\n`);
  const response = await page.context().request.post(capture.path, {
    form: capture.fields,
    timeout: 120_000,
  });
  assert(response.ok(), `Browser-authored export returned HTTP ${response.status()}.`);
  const bytes = await response.body();
  assert.equal(bytes.subarray(0, 2).toString(), 'PK', 'Browser export was not a ZIP archive.');
  const archive = path.join(outDir, 'browser-priced-cal-qty3.zip');
  await writeFile(archive, bytes);
  const xmlText = await firstXml(archive);
  await writeFile(path.join(outDir, 'browser-priced-cal-qty3.xml'), xmlText);
  return { capture, archive, xml: xmlText, data, groups };
}

function normalizedGroups(value: unknown): Product[] {
  const products = array(value).flatMap(group => array(object(group)['products']));
  return products.map(item => {
    const product = object(item);
    return {
      code: String(product['code'] ?? ''),
      type: String(product['type'] ?? ''),
      quantity: Number(product['quantity'] ?? 0),
      price: product['price'] === null ? null : money(product['price']),
      unitPrice: product['unitPrice'] === null ? null : money(product['unitPrice']),
    };
  }).sort(compareProduct);
}

function compareProduct(left: Product, right: Product): number {
  return left.type.localeCompare(right.type) || left.code.localeCompare(right.code) ||
    left.quantity - right.quantity || Number(left.unitPrice ?? -1) - Number(right.unitPrice ?? -1);
}

async function exportMcp(
  service: DcscService,
  handle: string,
  name: string,
  outDir: string,
  captures: Array<{ path: string; fields: Record<string, string> }>,
): Promise<{ archive: string; xml: string; groups: unknown; data: Json }> {
  const before = captures.length;
  const response = await service.exportZip(handle, {
    fileTypes: ['XML'], fileName: name, scope: handle.startsWith('ws_') ? 'workspace' : 'configuration',
    ctx: service.newCtx(),
  });
  const archive = path.join(outDir, `${name}.zip`);
  await pipeline(response.stream, createWriteStream(archive));
  const capture = captures[before];
  assert(capture, `${name}: MCP export request was not captured.`);
  const bytes = await readFile(archive);
  assert.equal(bytes.subarray(0, 2).toString(), 'PK', `${name}: export was not a ZIP archive.`);
  await writeFile(path.join(outDir, `${name}-export-form.json`), `${JSON.stringify(capture, null, 2)}\n`);
  const xml = await firstXml(archive);
  await writeFile(path.join(outDir, `${name}.xml`), xml);
  return {
    archive,
    xml,
    groups: JSON.parse(capture.fields['groups'] ?? '[]') as unknown,
    data: object(JSON.parse(capture.fields['data'] ?? '{}')),
  };
}

function xmlCommercialLines(xml: string): XmlLine[] {
  return [...xml.matchAll(/<ProductLineItem>([\s\S]*?)<\/ProductLineItem>/g)].map(match => {
    const body = match[1] ?? '';
    const header = body.split('<ProductSubLineItem>')[0] ?? '';
    return {
      code: xmlCode(header),
      type: xmlText(header, 'ProductTypeCode'),
      quantity: Number(xmlText(header, 'Quantity')),
      unitPrice: money(xmlText(xmlBlock(header, 'UnitListPrice'), 'MonetaryAmount')),
      children: [...body.matchAll(/<ProductSubLineItem>([\s\S]*?)<\/ProductSubLineItem>/g)]
        .map(child => ({
          code: xmlCode(child[1] ?? ''),
          quantity: Number(xmlText(child[1] ?? '', 'Quantity')),
          unitPrice: money(xmlText(xmlBlock(child[1] ?? '', 'UnitListPrice'), 'MonetaryAmount')),
        }))
        .sort((left, right) => left.code.localeCompare(right.code) || left.quantity - right.quantity),
    };
  }).sort((left, right) => left.type.localeCompare(right.type) || left.code.localeCompare(right.code));
}

function xmlCode(value: string): string {
  return xmlText(value, 'ProprietaryProductIdentifier').replace('-', '');
}

function xmlText(value: string, tag: string): string {
  const match = value.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
  return (match?.[1] ?? '').trim();
}

function xmlBlock(value: string, tag: string): string {
  return value.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? '';
}

async function firstXml(archive: string): Promise<string> {
  const open = promisify<string, yauzl.Options, ZipFile>(yauzl.open);
  const zip = await open(archive, { lazyEntries: true });
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
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
    await context.addInitScript({ content: `
      globalThis.__dcscAuditForms = [];
      HTMLFormElement.prototype.submit = function () {
        const fields = {};
        this.querySelectorAll('input').forEach(input => { fields[input.name] = input.value; });
        globalThis.__dcscAuditForms.push({ path: this.action, fields });
      };
    ` });
    const page = await context.newPage();
    const browserState = await configureBrowser(page, options.origin);
    await writeFile(
      path.join(options.outDir, 'browser-quantity3-software-patch.json'),
      `${JSON.stringify(browserState.patch, null, 2)}\n`,
    );

    service = new DcscService(ConfigSchema.parse({
      logLevel: 'error', files: { persistSessions: false, artifactDir: path.join(options.outDir, 'mcp-artifacts') },
      pacing: { perToolRequestBudget: 100 },
    }));
    const ctx = service.newCtx();
    const solution = await service.resolveSolution(ctx, 'General Purpose');
    const session = await service.launch({ productCode: PRODUCT, mode: 'cto', solution, ctx });
    for (const change of [
      { name: 'T1K2', code: 'T1K3', quantity: 1 },
      { name: 'T1K2/T1K3/CAL_50_2025', code: 'SDDZ', quantity: 1 },
      { name: 'T1K2', code: 'SDDZ', quantity: 3 },
    ]) {
      const ref = session.index.sections.find(section => section.name === change.name);
      assert(ref, `MCP did not discover ${change.name}.`);
      await service.configure(session, [{ section: ref.id, code: change.code, quantity: change.quantity }], service.newCtx(), session.revision);
    }
    assert.equal(money(session.raw.totalPrice), browserState.totalPrice, 'Browser and MCP totals differ before export.');

    const browserExport = await captureBrowserExport(page, options.outDir);
    const mcpCaptures: Array<{ path: string; fields: Record<string, string> }> = [];
    const originalSend = service.http.send.bind(service.http);
    service.http.send = (async request => {
      if (request.path.endsWith('/export_zip') && request.body?.kind === 'form') {
        mcpCaptures.push({ path: request.path, fields: structuredClone(request.body.fields) });
      }
      return request.responseKind === 'json'
        ? originalSend(request)
        : originalSend(request);
    }) as typeof service.http.send;
    const configurationExport = await exportMcp(
      service, session.id, 'mcp-priced-cal-qty3-configuration', options.outDir, mcpCaptures,
    );
    const workspaceExport = await exportMcp(
      service, session.workspaceId, 'mcp-priced-cal-qty3-workspace', options.outDir, mcpCaptures,
    );

    const browserGroups = normalizedGroups(browserExport.groups);
    const configurationGroups = normalizedGroups(configurationExport.groups);
    const workspaceGroups = normalizedGroups(workspaceExport.groups);
    assert.deepEqual(configurationGroups, browserGroups, 'MCP configuration export groups differ from browser groups.');
    assert.deepEqual(workspaceGroups, browserGroups, 'MCP workspace export groups differ from browser groups.');
    const families = new Set(browserGroups.map(product => product.type));
    for (const family of ['hardware', 'hipo', 'servicectohipo']) {
      assert(families.has(family), `Browser export dropped unrelated ${family} products.`);
    }

    const browserXml = xmlCommercialLines(browserExport.xml);
    const configurationXml = xmlCommercialLines(configurationExport.xml);
    const workspaceXml = xmlCommercialLines(workspaceExport.xml);
    assert.deepEqual(configurationXml, browserXml, 'MCP configuration XML commercial lines differ from browser XML.');
    assert.deepEqual(workspaceXml, browserXml, 'MCP workspace XML commercial lines differ from browser XML.');
    const calLine = browserXml.find(line => line.code === '7S1SCTOAWW');
    assert(calLine, 'Browser XML omitted the selected CAL commercial product.');
    assert(calLine.children.some(child => child.code === 'SDDZ' && child.quantity === 3), 'Browser XML omitted SDDZ quantity 3.');
    assert(
      quantitiesForCode(browserState.patch, 'SDH2').includes(3),
      'Browser derive response omitted its quantity-3 SDH2 companion.',
    );
    const companionLine = browserXml.find(line =>
      line.children.some(child => child.code === 'SDH2' && child.quantity === 3));
    assert(companionLine, 'Browser XML omitted its quantity-3 SDH2 companion.');

    report = {
      schemaVersion: 1, status: 'pass', headless: true, freshContext: true,
      startedAt, completedAt: new Date().toISOString(), product: PRODUCT,
      total: { browser: browserState.totalPrice, mcp: money(session.raw.totalPrice), currency: session.locale.currency },
      groups: { browser: browserGroups, configuration: configurationGroups, workspace: workspaceGroups },
      xmlCommercialLines: browserXml,
      archives: {
        browser: { path: browserExport.archive, sha256: sha256(await readFile(browserExport.archive)) },
        configuration: { path: configurationExport.archive, sha256: sha256(await readFile(configurationExport.archive)) },
        workspace: { path: workspaceExport.archive, sha256: sha256(await readFile(workspaceExport.archive)) },
      },
      browserFileTypes: browserExport.data['exportFileTypes'],
      assertions: {
        configurationGroupsMatchBrowser: true, workspaceGroupsMatchBrowser: true,
        configurationXmlMatchesBrowser: true, workspaceXmlMatchesBrowser: true,
        pricedCalQuantity: 3,
        derivedCompanionQuantity: 3,
        companionXmlParent: companionLine.code,
        unrelatedFamiliesPreserved: [...families].sort(),
      },
    };
    console.log('PASS priced CAL quantity-3 browser/MCP export handoff');
  } catch (error) {
    failure = error;
    report = {
      schemaVersion: 1, status: 'fail', headless: true, freshContext: true,
      startedAt, completedAt: new Date().toISOString(), product: PRODUCT,
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

void main();
