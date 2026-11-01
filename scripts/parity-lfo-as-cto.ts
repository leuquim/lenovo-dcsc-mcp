/** Headless browser/MCP differential for the supported LFO-as-CTO route. */
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import { ConfigSchema } from '../src/config/schema.js';
import { writeExportBundle } from '../src/files/artifactStore.js';
import { configureLogger } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';
import {
  array,
  captureBrowserExport,
  money,
  normalizedGroups,
  normalizedXml,
  object,
  setBrowserHardwareOption,
  sha256,
  type ExportCapture,
  type Json,
} from './parity/softwareSummaryUi.js';

const PRODUCT = '7DCE100GNA';
const FEATURE = 'BFYB';
const CATEGORY = 'STG@Servers@Tower Server@ThinkSystem ST250 V3';

function args(argv = process.argv.slice(2)): { outDir: string; origin: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const result = { outDir: path.resolve(`artifacts/parity-lfo-as-cto/${stamp}`), origin: 'https://dcsc.lenovo.com/' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]; const value = argv[index + 1];
    if (!value || !['--out', '--origin'].includes(key ?? '')) throw new Error(`Invalid argument ${key ?? ''}.`);
    if (key === '--out') result.outDir = path.resolve(value); else result.origin = value;
    index += 1;
  }
  return result;
}

function selectedQuantity(configuration: Json, code: string): number {
  for (const tab of array(configuration['tabs'])) for (const subTab of array(object(tab)['subTabs']))
    for (const section of array(object(subTab)['sections'])) for (const result of array(object(section)['results'])) {
      const item = object(result); if (item['code'] === code) return Number(item['quantity'] ?? 0);
    }
  return 0;
}

function commercialPrice(configuration: Json): number {
  return money(configuration['price'] ?? object(array(configuration['totalPrices'])[0])['price']);
}

async function newAuditPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
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
  page.setDefaultTimeout(90_000);
  return { context, page };
}

async function settle(page: Page): Promise<void> {
  await page.locator('.ant-spin-spinning:visible').first()
    .waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
}

async function launchBrowserAsCto(
  browser: Browser,
  origin: string,
): Promise<{ context: BrowserContext; page: Page; launch: Json }> {
  const { context, page } = await newAuditPage(browser);
  await page.goto(`${origin.replace(/\/$/, '')}/#/categories/${encodeURIComponent(CATEGORY)}`, {
    waitUntil: 'domcontentloaded', timeout: 90_000,
  });
  await settle(page);
  const cookie = page.locator('.dcsc-cookie-close').first();
  if (await cookie.isVisible({ timeout: 1_000 }).catch(() => false)) await cookie.click();
  const link = page.getByRole('link').filter({ hasText: PRODUCT });
  await link.first().waitFor({ state: 'visible', timeout: 60_000 });
  assert.equal(await link.count(), 1, `Website category did not expose as-CTO product ${PRODUCT}.`);
  const pending = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes(`/lfos/${PRODUCT}/as_cto_launch`),
  { timeout: 120_000 });
  await link.click();
  const response = await pending;
  assert.equal(response.status(), 200, `Website as-CTO launch returned HTTP ${response.status()}.`);
  await page.waitForURL(/#\/configuration\/lfo-as-cto\//, { timeout: 90_000 });
  await settle(page);
  await page.getByRole('button', { name: 'Summary' }).click();
  await page.waitForURL(/#\/rack-summary\/rack-cto/, { timeout: 90_000 });
  await settle(page);
  return { context, page, launch: object(await response.json()) };
}

type ImportSemantic = {
  currentUrl: string;
  type: string;
  configurationCount: number;
  selectedQuantity: number;
  price: number;
  totalPrice: number;
  missingParts: number;
  removedParts: number;
  groups: ReturnType<typeof normalizedGroups>;
  visibleButtons: string[];
  visibleDialogs: string[];
};

async function submitBrowserImport(
  browser: Browser,
  origin: string,
  xmlPath: string,
  outDir: string,
  name: string,
): Promise<ImportSemantic> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    const file = page.locator('input[type=file]').first();
    await file.waitFor({ state: 'attached', timeout: 60_000 });
    const pending = page.waitForResponse(response =>
      response.request().method() === 'POST' && response.url().includes('/multiple/cfxml_import'),
    { timeout: 120_000 });
    await file.setInputFiles(xmlPath);
    const response = await pending;
    assert.equal(response.status(), 200, `${name}: browser import returned HTTP ${response.status()}.`);
    const payload = await response.json() as unknown;
    const envelope = object(Array.isArray(payload) ? payload[0] : payload);
    const configurations = array(envelope['configuration']).map(object);
    assert.equal(envelope['type'], 'cto', `${name}: browser import did not classify as CTO.`);
    assert.equal(configurations.length, 1, `${name}: browser import did not return one configuration.`);
    assert.deepEqual(array(envelope['missingParts']), [], `${name}: browser import reported missing parts.`);
    assert.deepEqual(array(envelope['removedParts']), [], `${name}: browser import reported removed parts.`);
    await page.waitForTimeout(3_000);
    const configuration = configurations[0]!;
    const visibleButtons = (await page.getByRole('button').allInnerTexts())
      .map(value => value.trim()).filter(Boolean);
    const visibleDialogs = await page.locator('[role="dialog"]:visible, .ant-modal:visible').allInnerTexts();
    const semantic: ImportSemantic = {
      currentUrl: page.url(),
      type: String(envelope['type']),
      configurationCount: configurations.length,
      selectedQuantity: selectedQuantity(configuration, FEATURE),
      price: commercialPrice(configuration),
      totalPrice: money(configuration['totalPrice']),
      missingParts: array(envelope['missingParts']).length,
      removedParts: array(envelope['removedParts']).length,
      groups: normalizedGroups(envelope['groups']),
      visibleButtons,
      visibleDialogs,
    };
    await writeFile(path.join(outDir, `${name}-import.json`), `${JSON.stringify(semantic, null, 2)}\n`);
    return semantic;
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const options = args(); await mkdir(options.outDir, { recursive: true });
  const startedAt = new Date().toISOString(); let browser: Browser | undefined; let service: DcscService | undefined;
  let failure: unknown; let report: Json = {};
  try {
    configureLogger('error'); browser = await chromium.launch({ headless: true });
    const config = ConfigSchema.parse({ logLevel: 'error', files: { persistSessions: false, artifactDir: path.join(options.outDir, 'mcp-artifacts') }, pacing: { perToolRequestBudget: 50 } });
    service = new DcscService(config);
    const solution = await service.resolveSolution(service.newCtx(), 'General Purpose');
    const session = await service.launch({ productCode: PRODUCT, mode: 'lfo-as-cto', solution, ctx: service.newCtx(), label: 'LFO as CTO parity' });
    assert.equal(session.mode, 'lfo-as-cto'); assert.equal(session.configurable, true); assert.equal(session.primed, true);
    assert.equal(selectedQuantity(session.raw as Json, 'BFYE'), 1);

    const browserOracle = await launchBrowserAsCto(browser, options.origin);
    assert.equal(browserOracle.launch['lfoCode'], PRODUCT);
    assert.equal(browserOracle.launch['sliceCtoCode'], session.raw.sliceCtoCode);
    const browserHardware = await setBrowserHardwareOption(browserOracle.page, options.outDir, {
      derivePath: '/ctos/autoDerive',
      configuration: /#\/configuration\/(?:lfo-as-cto|cto)\//,
      summary: /#\/rack-summary\/rack-(?:cto|lfo)/,
      expectInitialDerive: false,
    });
    const oracle = await captureBrowserExport(browserOracle.page, options.outDir, 'browser-as-cto-bfyb');
    const oracleGroups = normalizedGroups(oracle.groups); const oracleBom = normalizedXml(oracle.xml);
    await browserOracle.context.close();

    let mcpDerive: { query: Json; body: Json; response?: Json } | undefined;
    const forms: ExportCapture[] = []; const originalSend = service.http.send.bind(service.http);
    service.http.send = (async request => {
      if (request.path === '/ctos/autoDerive' && request.body?.kind === 'json') mcpDerive = { query: structuredClone(request.query ?? {}), body: structuredClone(request.body.value) as Json };
      if (request.path.endsWith('/export_zip') && request.body?.kind === 'form') forms.push({ path: request.path, fields: structuredClone(request.body.fields) });
      if (request.responseKind === 'json') { const response = await originalSend(request as typeof request & { responseKind: 'json' }); if (request.path === '/ctos/autoDerive' && mcpDerive) mcpDerive.response = structuredClone(response.raw) as Json; return response; }
      return originalSend(request);
    }) as typeof service.http.send;

    const ref = session.index.byCode.get(FEATURE)?.[0]; assert(ref, `Launch index omitted ${FEATURE}.`);
    const configured = await service.configure(session, [{ section: ref.section, code: FEATURE, quantity: 1 }], service.newCtx({ locale: session.locale, solution: session.solution }));
    assert.equal(configured.mode, 'lfo-as-cto'); assert.equal(selectedQuantity(configured.raw as Json, FEATURE), 1); assert(mcpDerive?.response);
    assert.equal(mcpDerive.query['entranceFlag'], browserHardware.query['entranceFlag']);
    assert.equal(mcpDerive.query['guideMode'], browserHardware.query['guideMode']);
    assert.equal(typeof mcpDerive.query['configurationId'], 'string');
    assert.equal(typeof browserHardware.query['configurationId'], 'string');
    const mcpDelta = object(object(array(mcpDerive.body['configurations'])[0])['delta']);
    const browserDelta = object(object(array(browserHardware.request['configurations'])[0])['delta']);
    for (const field of ['section', 'featureCode', 'quantity', 'isClear', 'type']) assert.deepEqual(mcpDelta[field], browserDelta[field]);
    const authoritative = object(array(mcpDerive.response['configurations'])[0]);
    assert.equal(selectedQuantity(authoritative, FEATURE), 1);
    assert.equal(commercialPrice(authoritative), browserHardware.price); assert.equal(money(authoritative['totalPrice']), browserHardware.totalPrice);
    await writeFile(path.join(options.outDir, 'mcp-as-cto-request.json'), `${JSON.stringify({ query: mcpDerive.query, body: mcpDerive.body }, null, 2)}\n`);
    await writeFile(path.join(options.outDir, 'mcp-as-cto-response.json'), `${JSON.stringify(mcpDerive.response, null, 2)}\n`);

    const exported = await service.exportZip(configured.id, { fileTypes: ['XML'], fileName: 'mcp-as-cto-bfyb', ctx: service.newCtx(), scope: 'configuration' });
    const bundle = await writeExportBundle(exported.stream, 'mcp-as-cto-bfyb', config); assert(bundle.xml);
    const mcpXmlPath = path.join(options.outDir, 'mcp-as-cto-bfyb.xml'); const mcpZip = path.join(options.outDir, 'mcp-as-cto-bfyb.zip');
    await copyFile(bundle.xml, mcpXmlPath); await copyFile(bundle.zipPath, mcpZip);
    const form = forms.at(-1); assert(form); assert(form.path.endsWith('/ctos/export_zip'));
    await writeFile(path.join(options.outDir, 'mcp-as-cto-form.json'), `${JSON.stringify(form, null, 2)}\n`);
    const mcpGroups = normalizedGroups(JSON.parse(form.fields['groups'] ?? '[]'));
    const mcpXml = await readFile(mcpXmlPath, 'utf8'); const mcpBom = normalizedXml(mcpXml);
    assert.deepEqual(mcpGroups, oracleGroups); assert.deepEqual(mcpBom, oracleBom);

    const browserReimport = await submitBrowserImport(
      browser, options.origin, oracle.xmlPath, options.outDir, 'browser-as-cto-bfyb',
    );
    const mcpReimport = await submitBrowserImport(
      browser, options.origin, mcpXmlPath, options.outDir, 'mcp-as-cto-bfyb',
    );
    assert.equal(browserReimport.selectedQuantity, 1);
    assert.equal(mcpReimport.selectedQuantity, 1);
    assert.match(browserReimport.currentUrl, /#\/rack-summary\/rack-cto$/);
    assert.match(mcpReimport.currentUrl, /#\/rack-summary\/rack-cto$/);
    assert.equal(mcpReimport.price, browserReimport.price);
    assert.equal(mcpReimport.totalPrice, browserReimport.totalPrice);
    assert.deepEqual(mcpReimport.groups, browserReimport.groups);
    assert.deepEqual(mcpReimport.groups, mcpGroups);
    report = { schemaVersion: 1, status: 'pass', headless: true, startedAt, completedAt: new Date().toISOString(), product: PRODUCT, launchMode: 'lfo-as-cto', selected: { section: ref.section, code: FEATURE, quantity: 1 }, pricing: { base: browserHardware.price, total: browserHardware.totalPrice, importedTotal: mcpReimport.totalPrice }, request: { endpointFamily: 'ctos', querySemanticsMatchBrowser: true, deltaMatchesBrowser: true, envelopeExactMatch: JSON.stringify(mcpDerive.body) === JSON.stringify(browserHardware.request) }, export: { endpoint: form.path, groupsSha256: sha256(JSON.stringify(mcpGroups)), xmlBomSha256: sha256(JSON.stringify(mcpBom)), archiveSha256: sha256(await readFile(mcpZip)) }, browserImport: { websiteExportRoute: browserReimport.currentUrl, mcpExportRoute: mcpReimport.currentUrl, note: 'DCSC accepts both archives as CTO and restores the rack CTO summary route.' }, assertions: { configurablePrimedAsCtoLaunch: true, browserAndMcpSelectedStateMatch: true, browserAndMcpPriceMatch: true, groupsMatch: true, xmlBomMatches: true, websiteAndMcpBrowserImportsAccepted: true } };
    console.log('PASS LFO-as-CTO hardware edit/export/reimport');
  } catch (error) { failure = error; report = { schemaVersion: 1, status: 'fail', headless: true, startedAt, completedAt: new Date().toISOString(), error: error instanceof Error ? error.stack ?? error.message : String(error) }; console.error(error); }
  finally { await Promise.allSettled([service?.close() ?? Promise.resolve(), browser?.close() ?? Promise.resolve()]); const serialized = `${JSON.stringify(report, null, 2)}\n`; await writeFile(path.join(options.outDir, 'report.json'), serialized); await writeFile(path.join(options.outDir, 'report.sha256'), `${sha256(serialized)}  report.json\n`); console.log(`Report: ${path.join(options.outDir, 'report.json')}`); }
  if (failure) process.exitCode = 1;
}
void main();
