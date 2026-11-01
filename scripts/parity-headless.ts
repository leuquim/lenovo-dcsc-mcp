/**
 * Maintained anonymous DCSC browser parity runner.
 *
 * Examples:
 *   npx tsx scripts/parity-headless.ts --suite=offline
 *   npx tsx scripts/parity-headless.ts --suite=baseline
 *   npx tsx scripts/parity-headless.ts --suite=handoff
 *   npx tsx scripts/parity-headless.ts --suite=discovery
 *
 * Every browser context is new, in-memory, and headless. The discovery suite
 * only performs actions exposed by the SPA and records their exact wire data;
 * it never synthesizes or replays an API request.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { chromium, type Browser, type Page, type Response } from 'playwright';
import { ConfigSchema } from '../src/config/schema.js';
import { parseCfxml } from '../src/domain/import.js';
import { writeExportBundle } from '../src/files/artifactStore.js';
import { DcscService } from '../src/mcp/service.js';
import { buildGroups } from '../src/domain/reduce.js';
import { captureBrowserExport, normalizedGroups } from './parity/softwareSummaryUi.js';

type JsonObject = Record<string, unknown>;
type Suite = 'offline' | 'baseline' | 'handoff' | 'discovery' | 'all';

interface Options {
  suite: Suite;
  outDir: string;
  origin: string;
  importXml: string;
  rackCode?: string;
  switchCode?: string;
  networkFamily?: string;
  storageCode?: string;
  solutionMode?: string;
  freshCatalog: boolean;
  handoffQuantity?: number;
  storageLifecycleOnly: boolean;
  automaticSwitchFlow: boolean;
}

interface Check {
  name: string;
  status: 'pass' | 'fail' | 'blocked';
  detail?: unknown;
}

interface WireEntry {
  sequence: number;
  phase: string;
  method: string;
  url: string;
  status: number;
  requestBodyFile?: string;
  responseBodyFile?: string;
  requestSha256?: string;
  responseSha256?: string;
  connectionCount?: number;
}

interface ProductLine {
  code: string;
  type: string;
  quantity: number;
  unitListPrice: number;
  features: Array<{ code: string; quantity: number }>;
}

interface XmlSummary {
  products: ProductLine[];
  groups: Array<{ quantity: number; unitListPrice: number }>;
}

const ROOT = process.cwd();
const QUANTITY_FIXTURE = path.join(ROOT, 'test/fixtures/parity/browser-quantity-matrix.json');
const IMPORT_CONTRACT_FIXTURE = path.join(
  ROOT,
  'test/fixtures/parity/browser-quantity-import-contract.json',
);
const LAUNCH_FIXTURE = path.join(ROOT, 'test/fixtures/parity/sr630-launch.json');
const QUANTITY_XML = new Map<number, string>([
  [1, 'test/fixtures/parity/xml/sr630-v3-qty1.xml'],
  [4, 'test/fixtures/parity/xml/sr630-v3-qty4.xml'],
  [8, 'test/fixtures/parity/xml/sr630-v3-qty8.xml'],
]);
const SOFTWARE_XML = path.join(
  ROOT,
  'test/fixtures/parity/xml/standalone-software-qty3.xml',
);

function parseArgs(argv: string[]): Options {
  const values = Object.fromEntries(
    argv.filter((arg) => arg.startsWith('--')).map((arg) => {
      const [key, ...rest] = arg.slice(2).split('=');
      return [key, rest.join('=')];
    }),
  );
  const suite = (values['suite'] || 'offline') as Suite;
  if (!['offline', 'baseline', 'handoff', 'discovery', 'all'].includes(suite)) {
    throw new Error(`Unknown suite ${suite}. Use offline, baseline, handoff, discovery, or all.`);
  }
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const result: Options = {
    suite,
    outDir: path.resolve(values['out'] || `artifacts/parity-headless/${stamp}`),
    origin: values['origin'] || 'https://dcsc.lenovo.com/',
    importXml: path.resolve(values['import'] || QUANTITY_XML.get(1)!),
    freshCatalog: Object.hasOwn(values, 'fresh-catalog'),
    storageLifecycleOnly: Object.hasOwn(values, 'storage-lifecycle-only'),
    automaticSwitchFlow: Object.hasOwn(values, 'automatic-switch-flow'),
  };
  if (values['switch-code']) result.switchCode = values['switch-code'];
  if (values['rack-code']) result.rackCode = values['rack-code'];
  if (values['network-family']) result.networkFamily = values['network-family'];
  if (values['storage-code']) result.storageCode = values['storage-code'];
  if (values['solution-mode']) result.solutionMode = values['solution-mode'];
  if (values['quantity']) result.handoffQuantity = Number(values['quantity']);
  return result;
}

function object(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function array(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function number(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a finite number, received ${String(value)}.`);
  return parsed;
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseJsonBody(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    const params = new URLSearchParams(value);
    if ([...params.keys()].length === 0) return value;
    return Object.fromEntries([...params].map(([key, item]) => {
      try {
        return [key, JSON.parse(item) as unknown];
      } catch {
        return [key, item];
      }
    }));
  }
}

function normalizeXml(xml: string): XmlSummary {
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: true }).parse(xml) as unknown;
  const cfData = object(object(object(parsed)['CFXML'])['CFData']);
  const products = array(cfData['ProductLineItem']).map((raw): ProductLine => {
    const line = object(raw);
    const identification = object(object(line['ProductIdentification'])['PartnerProductIdentification']);
    const price = object(object(object(line['UnitListPrice'])['FinancialAmount']));
    const features = array(line['ProductSubLineItem']).map((featureRaw) => {
      const feature = object(featureRaw);
      const featureId = object(object(feature['ProductIdentification'])['PartnerProductIdentification']);
      return {
        code: text(featureId['ProprietaryProductIdentifier']),
        quantity: number(feature['Quantity']),
      };
    });
    return {
      code: text(identification['ProprietaryProductIdentifier']),
      type: text(identification['ProductTypeCode']),
      quantity: number(line['Quantity']),
      unitListPrice: number(price['MonetaryAmount']),
      features,
    };
  });
  const groups = array(cfData['ConfigurationGroupLineItem']).map((raw) => {
    const group = object(raw);
    const price = object(object(object(group['unitListPrice'])['financialAmount']));
    return { quantity: number(group['quantity']), unitListPrice: number(price['monetaryAmount']) };
  });
  return { products, groups };
}

async function offlineChecks(checks: Check[], outDir: string): Promise<void> {
  const fixture = JSON.parse(await readFile(QUANTITY_FIXTURE, 'utf8')) as JsonObject;
  const matrix = array(fixture['hardwareMatrix']).map(object);
  const normalized: Record<string, XmlSummary> = {};
  for (const row of matrix) {
    const quantity = number(row['requestedQuantity']);
    const xmlPath = QUANTITY_XML.get(quantity);
    assert(xmlPath, `No XML capture is registered for quantity ${quantity}.`);
    const actual = normalizeXml(await readFile(path.resolve(xmlPath), 'utf8'));
    normalized[`hardwareQuantity${quantity}`] = actual;
    const expectedProducts = array(row['products']).map(object);
    assert.equal(actual.products.length, expectedProducts.length, `quantity ${quantity} product count`);
    for (const expected of expectedProducts) {
      const product = actual.products.find((item) => item.code === text(expected['code']));
      assert(product, `quantity ${quantity}: missing ${text(expected['code'])}`);
      assert.equal(product.type, expected['type']);
      assert.equal(product.quantity, expected['quantity']);
      assert.equal(product.unitListPrice, expected['unitListPrice']);
      for (const key of ['feature', 'termFeature']) {
        const expectedFeature = object(expected[key]);
        if (Object.keys(expectedFeature).length === 0) continue;
        const selectedFeature: { code: string; quantity: number } | undefined = product.features.find(
          (item) => item.code === text(expectedFeature['code']),
        );
        assert.deepEqual(selectedFeature, {
          code: expectedFeature['code'],
          quantity: expectedFeature['quantity'],
        });
      }
    }
    const expectedGroup = object(row['xmlGroup']);
    assert.deepEqual(actual.groups[0], {
      quantity: expectedGroup['quantity'],
      unitListPrice: expectedGroup['unitListPrice'],
    });
    checks.push({ name: `browser XML quantity ${quantity} semantic oracle`, status: 'pass' });
  }

  const software = normalizeXml(await readFile(SOFTWARE_XML, 'utf8'));
  normalized['standaloneSoftwareQuantity3'] = software;
  const expectedSoftware = object(fixture['standaloneSoftwareQuantity3']);
  const softwareLine = software.products.find((item) => item.code === expectedSoftware['code']);
  assert(softwareLine, `Standalone product ${text(expectedSoftware['code'])} is absent.`);
  assert.equal(softwareLine.quantity, expectedSoftware['quantity']);
  assert.equal(softwareLine.unitListPrice, expectedSoftware['unitPrice']);
  assert.deepEqual(software.groups[0], {
    quantity: object(expectedSoftware['xml'])['configurationGroup']
      ? object(object(expectedSoftware['xml'])['configurationGroup'])['quantity']
      : undefined,
    unitListPrice: object(object(expectedSoftware['xml'])['configurationGroup'])['unitListPrice'],
  });
  assert.equal(money(softwareLine.quantity * softwareLine.unitListPrice), expectedSoftware['extendedPrice']);
  checks.push({ name: 'browser standalone quantity 3 unit/extended price oracle', status: 'pass' });

  const importContract = JSON.parse(await readFile(IMPORT_CONTRACT_FIXTURE, 'utf8')) as JsonObject;
  for (const caseRaw of array(importContract['cases'])) {
    const contract = object(caseRaw);
    const requestedQuantity = number(contract['requestedQuantity']);
    const configurations = array(contract['configuration']).map(object);
    const groupProducts = array(object(contract['group'])['products']).map(object);
    const workspaceItems = array(object(contract['workspace'])['nonRackArea']).map(object);
    assert.equal(configurations.length, 1);
    assert.equal(configurations[0]?.['quantity'], 1);
    assert(groupProducts.length > 0);
    assert(groupProducts.every((product) => product['quantity'] === requestedQuantity));
    assert.equal(workspaceItems.length, 1);
    assert.equal(workspaceItems[0]?.['quantity'], requestedQuantity);
    assert.equal(array(workspaceItems[0]?.['originalIds']).length, requestedQuantity);
    const settled = object(contract['settledCustomizeRequest']);
    if (Object.keys(settled).length > 0) {
      assert.equal(settled['configurationCount'], requestedQuantity);
      assert.equal(settled['nonRackCount'], requestedQuantity);
      assert.deepEqual(settled['configurationIds'], settled['nonRackIds']);
    }
  }
  checks.push({ name: 'browser quantity import compression/clone contract', status: 'pass' });
  await writeFile(path.join(outDir, 'normalized-browser-xml.json'), JSON.stringify(normalized, null, 2));
}

class WireCapture {
  readonly entries: WireEntry[] = [];
  readonly pending: Promise<void>[] = [];
  readonly requestBodies = new Map<number, unknown>();
  readonly responseBodies = new Map<number, unknown>();
  phase = 'boot';
  #sequence = 0;

  constructor(private readonly outDir: string) {}

  attach(page: Page): void {
    page.on('response', (response) => {
      if (!new URL(response.url()).pathname.startsWith('/api/')) return;
      this.pending.push(this.record(response));
    });
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.pending);
    await writeFile(path.join(this.outDir, 'wire-index.json'), JSON.stringify(this.entries, null, 2));
  }

  async record(response: Response): Promise<void> {
    const request = response.request();
    const method = request.method();
    if (method === 'GET') {
      const pathname = new URL(response.url()).pathname;
      if (!/pdu|storage|network|topolog|connector|cable|switch/i.test(pathname)) {
        return;
      }
    }
    const sequence = ++this.#sequence;
    const prefix = String(sequence).padStart(3, '0');
    const entry: WireEntry = {
      sequence,
      phase: this.phase,
      method,
      url: response.url(),
      status: response.status(),
    };
    const requestBody = request.postData();
    if (requestBody) {
      const parsed = parseJsonBody(requestBody);
      this.requestBodies.set(sequence, parsed);
      const serialized = JSON.stringify(parsed, null, 2);
      entry.requestBodyFile = `wire/${prefix}-request.json`;
      entry.requestSha256 = sha256(serialized);
      await writeFile(path.join(this.outDir, entry.requestBodyFile), serialized);
    }
    try {
      const responseBody = await response.text();
      if (responseBody) {
        let serialized = responseBody;
        try {
          const parsed = JSON.parse(responseBody) as unknown;
          this.responseBodies.set(sequence, parsed);
          serialized = JSON.stringify(parsed, null, 2);
          if (/auto.?connect/i.test(new URL(response.url()).pathname)) {
            const envelope = object(parsed);
            const nested = object(envelope['result']);
            const connections = envelope['connections'] ?? envelope['autoConnectResults'] ?? nested['connections'];
            entry.connectionCount = Array.isArray(connections) ? connections.length : 0;
          }
        } catch {
          // Preserve non-JSON responses byte-for-byte as text.
        }
        entry.responseBodyFile = `wire/${prefix}-response.txt`;
        entry.responseSha256 = sha256(serialized);
        await writeFile(path.join(this.outDir, entry.responseBodyFile), serialized);
      }
    } catch {
      // Redirects and downloads can make response bodies unavailable.
    }
    this.entries.push(entry);
  }
}

async function closeCookieBanner(page: Page): Promise<void> {
  const close = page.locator('.dcsc-cookie-close').first();
  if (await close.isVisible({ timeout: 1_500 }).catch(() => false)) await close.click();
}

async function newPage(browser: Browser, capture: WireCapture): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable', {
    maxTotalBufferSize: 100 * 1024 * 1024,
    maxResourceBufferSize: 50 * 1024 * 1024,
    maxPostDataSize: 25 * 1024 * 1024,
  });
  capture.attach(page);
  return page;
}

function selectedBom(raw: unknown): Array<{ code: string; quantity: number }> {
  const configuration = object(raw);
  const rows: Array<{ code: string; quantity: number }> = [];
  for (const tabRaw of array(configuration['tabs'])) {
    for (const subTabRaw of array(object(tabRaw)['subTabs'])) {
      for (const sectionRaw of array(object(subTabRaw)['sections'])) {
        for (const resultRaw of array(object(sectionRaw)['results'])) {
          const result = object(resultRaw);
          if (typeof result['code'] === 'string') {
            rows.push({ code: result['code'], quantity: Number(result['quantity'] ?? 1) });
          }
        }
      }
    }
  }
  return rows.sort((left, right) => left.code.localeCompare(right.code));
}

async function baseline(browser: Browser, capture: WireCapture, options: Options, checks: Check[]): Promise<void> {
  const page = await newPage(browser, capture);
  try {
    capture.phase = 'baseline-category';
    await page.goto(
      new URL('#/categories/STG%40Servers%40Rack%20Server%40ThinkSystem%20SR630%20V3', options.origin).href,
      { waitUntil: 'domcontentloaded', timeout: 60_000 },
    );
    await closeCookieBanner(page);
    await page.waitForTimeout(5_000);
    await writeFile(
      path.join(options.outDir, 'baseline-category-text.txt'),
      (await page.locator('body').innerText()).slice(0, 30_000),
    );
    const configure = page.locator(
      'button:has-text("Customize"), a:has-text("Customize"), [role="button"]:has-text("Customize"), button:has-text("Configure"), a:has-text("Configure"), [role="button"]:has-text("Configure"), button:has-text("Build"), a:has-text("Build")',
    ).first();
    await configure.waitFor({ state: 'visible', timeout: 30_000 });
    capture.phase = 'baseline-launch';
    const launchResponse = page.waitForResponse(
      (response) => /\/api\/ctos\/7D73CTO1WW\/launch/.test(response.url()) && response.request().method() === 'POST',
      { timeout: 60_000 },
    );
    await configure.click();
    const response = await launchResponse;
    assert.equal(response.status(), 200);
    const actual = await response.json() as unknown;
    const expected = JSON.parse(await readFile(LAUNCH_FIXTURE, 'utf8')) as unknown;
    assert.equal(object(actual)['sliceCtoCode'], object(expected)['sliceCtoCode']);
    assert.equal(object(actual)['type'], object(expected)['type']);
    assert.deepEqual(selectedBom(actual), selectedBom(expected));

    const service = new DcscService(ConfigSchema.parse({
      files: { persistSessions: false },
      logLevel: 'error',
      pacing: { perToolRequestBudget: 80 },
    }));
    try {
      const ctx = service.newCtx();
      const solution = await service.resolveSolution(ctx, 'General Purpose');
      const mcp = await service.launch({ productCode: '7D73CTO1WW', mode: 'cto', solution, ctx });
      assert.equal(mcp.raw.sliceCtoCode, object(actual)['sliceCtoCode']);
      assert.equal(mcp.raw.type, object(actual)['type']);
      assert.equal(mcp.raw.totalPrice, object(actual)['totalPrice']);
      assert.deepEqual(selectedBom(mcp.raw), selectedBom(actual));
    } finally {
      await service.close();
    }
    checks.push({
      name: 'fresh browser/MCP SR630 V3 launch differential',
      status: 'pass',
      detail: { selectedLines: selectedBom(actual).length, totalPrice: object(actual)['totalPrice'] },
    });
  } finally {
    await page.context().close();
  }
}

async function uploadXml(
  page: Page,
  capture: WireCapture,
  xmlPath: string,
  origin: string,
  captureLargeResponse = false,
  solutionMode?: string,
): Promise<unknown> {
  capture.phase = `import-${path.basename(xmlPath)}`;
  await page.goto(new URL('/', origin).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await closeCookieBanner(page);
  if (solutionMode) await selectSolutionMode(page, solutionMode);
  const file = page.locator('input[type="file"]').first();
  await file.waitFor({ state: 'attached', timeout: 30_000 });
  const imported = page.waitForResponse(
    (response) => response.url().includes('/multiple/cfxml_import') && response.request().method() === 'POST',
    { timeout: 60_000 },
  );
  let payload: unknown;
  // Observe the original browser request through a larger inspector buffer.
  // Eight configuration trees exceed Chromium's default per-resource limit.
  // Do not replay the multipart upload through a separate HTTP client.
  const cdp = captureLargeResponse ? await page.context().newCDPSession(page) : undefined;
  let largeBody: Promise<unknown> | undefined;
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  if (cdp) {
    await cdp.send('Network.enable', { maxTotalBufferSize: 256 * 1024 * 1024,
      maxResourceBufferSize: 128 * 1024 * 1024 });
    largeBody = new Promise((resolve, reject) => {
      let requestId: string | undefined;
      bodyTimer = setTimeout(() => reject(new Error('Timed out capturing the complete browser import response.')), 120_000);
      cdp.on('Network.responseReceived', event => {
        if (new URL(event.response.url).pathname.endsWith('/multiple/cfxml_import')) requestId = event.requestId;
      });
      cdp.on('Network.loadingFinished', event => {
        if (event.requestId !== requestId) return;
        void cdp.send('Network.getResponseBody', { requestId }).then(result => {
          const content = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
          resolve(JSON.parse(content) as unknown);
        }).catch(reject);
      });
      cdp.on('Network.loadingFailed', event => {
        if (event.requestId === requestId) reject(new Error(`Browser import failed: ${event.errorText}`));
      });
    });
    void largeBody.catch(() => undefined);
  }
  try {
    await file.setInputFiles(xmlPath);
    const response = await imported;
    assert.equal(response.status(), 200);
    payload = largeBody ? await largeBody : await response.json() as unknown;
    assert(payload !== undefined, 'The complete browser import response is required for commercial parity.');
  } finally {
    if (bodyTimer) clearTimeout(bodyTimer);
    if (cdp) await cdp.detach();
  }
  await page.waitForURL((url) => /#\/(rack-summary|summary)\//.test(url.href), { timeout: 60_000 });
  return payload;
}

async function selectSolutionMode(page: Page, solutionMode: string): Promise<void> {
  const modeMenu = page.locator('.mode_picker_glow').first();
  await modeMenu.waitFor({ state: 'visible', timeout: 30_000 });
  await modeMenu.click();
  const popover = page.locator('.ant-popover:visible').filter({ has: page.locator('.header-settings') });
  await popover.locator('[role="combobox"]').click();
  await page.locator('.ant-select-dropdown:visible').getByText(solutionMode, { exact: true }).click();
  await popover.locator('#apply').click();
  await page.waitForTimeout(5_000);
}

function groupQuantities(envelope: JsonObject): Record<string, number> {
  const quantities: Record<string, number> = {};
  for (const groupRaw of array(envelope['groups'])) {
    for (const productRaw of array(object(groupRaw)['products'])) {
      const product = object(productRaw);
      const code = text(product['code']).replaceAll('-', '');
      if (code === '') continue;
      quantities[code] = (quantities[code] ?? 0) + Number(product['quantity'] ?? 0);
    }
  }
  return quantities;
}

function importedPhysicalIds(envelope: JsonObject): string[] {
  const configurationIds = array(envelope['configuration'])
    .map((item) => text(object(item)['id']))
    .filter(Boolean);
  const workspace = object(envelope['workspace']);
  const workspaceIds = array(workspace['nonRackArea']).flatMap((item) => {
    const physical = object(item);
    const originals = array(physical['originalIds']).map(text).filter(Boolean);
    return originals.length > 0 ? originals : [text(physical['id'])].filter(Boolean);
  });
  return [...new Set([...configurationIds, ...workspaceIds])];
}

async function mcpBrowserRoundtrip(
  browser: Browser,
  capture: WireCapture,
  options: Options,
  xmlPath: string,
  expectedQuantity: number,
): Promise<unknown> {
  const temporary = await mkdtemp(path.join(tmpdir(), `dcsc-parity-q${expectedQuantity}-`));
  const config = ConfigSchema.parse({
    files: { persistSessions: false, artifactDir: path.join(temporary, 'artifacts') },
    logLevel: 'error',
    pacing: { perToolRequestBudget: 120 },
  });
  const service = new DcscService(config);
  try {
    const imported = await service.importConfig({
      content: await readFile(xmlPath, 'utf8'),
      ctx: service.newCtx(),
      solutionMode: 'General Purpose',
    });
    assert.equal(imported.sessions.length, expectedQuantity, 'MCP imported physical configuration count');
    assert(imported.sessions.every((session) => session.raw.quantity === 1));
    const sessionIds = imported.sessions.map((session) => session.configurationId);
    assert.equal(new Set(sessionIds).size, expectedQuantity, 'MCP imported unique configuration IDs');
    const workspace = service.sessions.getWorkspace(imported.workspaceId);
    assert(workspace, `MCP omitted imported workspace ${imported.workspaceId}.`);
    assert.equal(workspace.configurations.size, expectedQuantity);
    assert.equal(workspace.nonRackArea.length, expectedQuantity);
    assert.deepEqual(
      new Set(workspace.nonRackArea.map((item) => item.id)),
      new Set(sessionIds),
      'MCP configuration and physical IDs diverged',
    );
    await writeFile(path.join(options.outDir, `mcp-imported-commercial-quantity-${expectedQuantity}.json`),
      JSON.stringify({
        cloneDependency: workspace.serverState.cloneDependency,
        cloneDependencyColor: workspace.serverState.cloneDependencyColor,
        configurations: [...workspace.configurations.values()].map(session => ({
          configurationId: session.configurationId,
          groups: buildGroups(session.raw, session.configurationId, session.mode),
        })),
      }, null, 2));

    const exported = await service.exportZip(workspace.id, {
      fileName: `parity-quantity-${expectedQuantity}`,
      fileTypes: ['XML'],
      scope: 'workspace',
      ctx: service.newCtx(),
    });
    assert.equal(exported.configurationsExported, expectedQuantity);
    const bundle = await writeExportBundle(
      exported.stream,
      `parity-quantity-${expectedQuantity}`,
      config,
    );
    assert(bundle.xml, 'MCP XML export was absent from the returned bundle.');
    await writeFile(path.join(options.outDir, `mcp-export-quantity-${expectedQuantity}.xml`),
      await readFile(bundle.xml));
    const parsed = parseCfxml(await readFile(bundle.xml, 'utf8'));
    const exportedQuantities = Object.fromEntries(
      [...new Set(parsed.configurations.map((line) => line.productCode))].map((code) => [
        code.replaceAll('-', ''),
        parsed.configurations
          .filter((line) => line.productCode === code)
          .reduce((total, line) => total + line.quantity, 0),
      ]),
    );
    for (const code of ['7D73CTO1WW', '7S0XCTO6WW', '7S0XCTO5WW', '7Q01CTO2WW', '7Q01CTS4WW', '7Q01CTSAWW']) {
      assert.equal(exportedQuantities[code], expectedQuantity, `MCP export ${code} quantity`);
    }

    const page = await newPage(browser, capture);
    try {
      await page.addInitScript({ content: `
        globalThis.__dcscAuditForms = [];
        HTMLFormElement.prototype.submit = function () {
          const fields = {};
          this.querySelectorAll('input').forEach(input => { fields[input.name] = input.value; });
          globalThis.__dcscAuditForms.push({ path: this.action, fields });
        };
      ` });
      await Promise.allSettled(capture.pending);
      const startSequence = Math.max(0, ...capture.entries.map((entry) => entry.sequence));
      const browserImported = await uploadXml(page, capture, bundle.xml, options.origin, true);
      await writeFile(path.join(options.outDir, `browser-reimport-quantity-${expectedQuantity}.json`),
        JSON.stringify(browserImported));
      await page.waitForTimeout(8_000);
      await Promise.allSettled(capture.pending);
      const envelope = object(array(browserImported)[0]);
      const responsePhysicalIds = importedPhysicalIds(envelope);
      const customize = [...capture.entries]
        .reverse()
        .find((entry) =>
          entry.sequence > startSequence &&
          new URL(entry.url).pathname.endsWith('/api/ctos/racks/customize') &&
          entry.method === 'POST',
        );
      const settledRequest = customize ? object(capture.requestBodies.get(customize.sequence)) : {};
      const settledIds = array(settledRequest['configurations'])
        .map((item) => text(object(item)['id']))
        .filter(Boolean);
      const browserPhysicalIds = responsePhysicalIds.length > 0 ? responsePhysicalIds : settledIds;
      assert.equal(new Set(browserPhysicalIds).size, expectedQuantity, 'browser re-import physical ID count');
      const browserQuantities = groupQuantities(envelope);
      assert(Object.keys(browserQuantities).length > 0, 'Browser import omitted commercial groups.');
      for (const [code, quantity] of Object.entries(exportedQuantities)) {
        assert.equal(browserQuantities[code], quantity, `browser re-import ${code} quantity`);
      }
      const browserExport = await captureBrowserExport(page, options.outDir, `browser-final-quantity-${expectedQuantity}`);
      const finalConfigurations = array(browserExport.data['configurations']).map(object);
      const finalWorkspace = object(browserExport.data['workspaceInformation']);
      const finalPhysical = array(finalWorkspace['nonRackData']).map(object);
      const finalDependency = object(finalWorkspace['cloneDependency']);
      const finalColors = object(browserExport.data['cloneDependencyColor']);
      assert.equal(finalConfigurations.length, expectedQuantity, 'Browser final configuration count');
      assert.equal(finalPhysical.length, expectedQuantity, 'Browser final physical count');
      assert.deepEqual(new Set(finalConfigurations.map(item => item['id'])), new Set(sessionIds),
        'Browser final configuration identities');
      assert.deepEqual(new Set(finalPhysical.map(item => item['id'])), new Set(sessionIds),
        'Browser final physical identities');
      assert.deepEqual(Object.keys(finalDependency).sort(), Object.keys(finalColors).sort(),
        'Browser final dependency/color roots');
      const finalOwners = new Set<string>();
      for (const [root, members] of Object.entries(finalDependency)) {
        assert(Array.isArray(members), `Browser final clone root ${root} must have members`);
        assert(members.includes(root), `Browser final clone root ${root} must own itself`);
        assert.deepEqual([...array(object(finalColors[root])['dependBy'])].sort(), [...members].sort(),
          `Browser final clone root ${root} color membership`);
        for (const member of members) {
          assert.equal(typeof member, 'string', 'Browser final clone member identity');
          assert(!finalOwners.has(member as string), `Browser final clone member ${member} has overlapping owners`);
          finalOwners.add(member as string);
        }
      }
      assert.deepEqual(finalOwners, new Set(sessionIds), 'Browser final clone ownership covers every configuration');
      const mcpCommercial = normalizedGroups(buildGroups(workspace));
      const browserCommercial = normalizedGroups(browserExport.groups);
      const aggregate = (products: typeof mcpCommercial) => {
        const result = new Map<string, { quantity: number; extendedPrice: number; wirePrice: number }>();
        for (const product of products) {
          assert(product.unitPrice !== null && product.price !== null, 'Commercial price unavailable.');
          const key = JSON.stringify([product.type, product.code, product.unitPrice]);
          const current = result.get(key) ?? { quantity: 0, extendedPrice: 0, wirePrice: 0 };
          current.quantity += product.quantity;
          current.extendedPrice = money(current.extendedPrice + product.unitPrice * product.quantity);
          // Browser HIPO/service `price` is per configuration even when its
          // row consolidates many clones; hardware `price` is extended.
          current.wirePrice = money(current.wirePrice + product.price *
            (product.type === 'hardware' ? 1 : product.quantity));
          result.set(key, current);
        }
        return [...result].sort(([left], [right]) => left.localeCompare(right));
      };
      assert.deepEqual(aggregate(mcpCommercial), aggregate(browserCommercial), 'Browser and MCP commercial groups');
      await writeFile(path.join(options.outDir, `commercial-groups-quantity-${expectedQuantity}.json`),
        JSON.stringify({ mcp: mcpCommercial, browser: browserCommercial, aggregate: aggregate(mcpCommercial) }, null, 2));
      // Lenovo XML intentionally reallocates product prices relative to its
      // commercial groups. Compare XML with XML, never with import group prices.
      const xmlProducts = (xml: string) => {
        const result = new Map<string, number>();
        for (const product of normalizeXml(xml).products) {
          const key = JSON.stringify([product.type, product.code, product.unitListPrice,
            [...product.features].sort((a, b) => a.code.localeCompare(b.code))]);
          result.set(key, (result.get(key) ?? 0) + product.quantity);
        }
        return [...result].sort(([left], [right]) => left.localeCompare(right));
      };
      assert.deepEqual(xmlProducts(await readFile(bundle.xml, 'utf8')), xmlProducts(browserExport.xml),
        'Browser and MCP XML products, selected features, unit prices and quantities');
      const browserPrices: Record<string, { quantity: number; unitPrice: number; extendedPrice: number }> = {};
      for (const code of Object.keys(exportedQuantities)) {
        const browserLines = browserCommercial.filter(line => line.code === code);
        const expectedUnitPrices = [...new Set(browserLines.map(line => line.unitPrice))];
        assert.equal(expectedUnitPrices.length, 1, `fixture ${code} must have a single unit price`);
        const actualExtended = money(browserLines.reduce((sum, line) => sum + (line.unitPrice ?? 0) * line.quantity, 0));
        browserPrices[code] = { quantity: browserQuantities[code]!, unitPrice: expectedUnitPrices[0]!,
          extendedPrice: actualExtended };
      }
      return {
        expectedQuantity,
        mcpConfigurationIds: sessionIds,
        mcpNonRackIds: workspace.nonRackArea.map((item) => item.id),
        exportedQuantities,
        browserPhysicalIds,
        browserGroupQuantities: browserQuantities,
        browserCommercialLines: browserPrices,
        currency: workspace.locale.currency,
        totalPrice: money(Object.values(browserPrices).reduce((sum, line) => sum + line.extendedPrice, 0)),
        browserSettledCustomizeConfigurations: settledIds.length,
        browserSemanticEvidence: 'Browser and MCP export groups match commercial quantities/prices; their XML products and selected features independently match.',
        browserUrl: page.url(),
      };
    } finally {
      await page.context().close();
    }
  } finally {
    await service.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

async function handoff(
  browser: Browser,
  capture: WireCapture,
  options: Options,
  checks: Check[],
): Promise<void> {
  let inputs = [...QUANTITY_XML.entries()].map(([quantity, file]) => ({
    name: `hardware quantity ${quantity}`,
    file: path.resolve(file),
    expectedQuantity: quantity,
  })).concat([{ name: 'standalone software quantity 3', file: SOFTWARE_XML, expectedQuantity: 3 }]);
  if (options.handoffQuantity !== undefined) {
    inputs = inputs.filter((input) => input.expectedQuantity === options.handoffQuantity);
  }
  for (const input of inputs) {
    const page = await newPage(browser, capture);
    try {
      const imported = await uploadXml(page, capture, input.file, options.origin);
      await page.waitForTimeout(8_000);
      const envelope = object(array(imported)[0]);
      if (input.name.startsWith('hardware')) {
        const configurations = array(envelope['configuration']).map(object);
        assert.equal(configurations.length, 1, `${input.name}: imported configuration count`);
        assert.deepEqual(
          configurations.map((configuration) => configuration['quantity']),
          [1],
          `${input.name}: raw configuration remains one unit`,
        );
        const groupProducts = array(object(array(envelope['groups'])[0])['products']).map(object);
        const hardware = groupProducts.find((item) => item['code'] === '7D73CTO1WW');
        assert(hardware, `${input.name}: imported group omitted 7D73CTO1WW.`);
        assert.equal(hardware['quantity'], input.expectedQuantity, `${input.name}: sales quantity`);
        for (const dependent of groupProducts.filter((item) => item['type'] === 'hipo' || item['type'] === 'servicectohipo')) {
          assert.equal(dependent['quantity'], input.expectedQuantity, `${input.name}: ${String(dependent['code'])} quantity`);
        }
      } else {
        const products = array(envelope['standaloneData']).map(object);
        const product = products.find((item) => item['code'] === '7S1S002WWW');
        assert(product, 'Standalone import response omitted 7S1S002WWW.');
        assert.equal(product['quantity'], input.expectedQuantity);
        assert.equal(product['price'], 234.5);
        const groupProduct = array(object(array(envelope['groups'])[0])['products']).map(object)
          .find((item) => item['code'] === '7S1S002WWW');
        assert(groupProduct, 'Standalone import response omitted its group product.');
        assert.equal(groupProduct['price'], 703.5);
        assert.equal(groupProduct['unitPrice'], 234.5);
      }
      checks.push({
        name: `browser CFXML handoff: ${input.name}`,
        status: 'pass',
        detail: { url: page.url(), responseKeys: Object.keys(envelope).sort() },
      });
      if (input.name.startsWith('hardware') && input.expectedQuantity > 1) {
        const roundtrip = await mcpBrowserRoundtrip(
          browser,
          capture,
          options,
          input.file,
          input.expectedQuantity,
        );
        await writeFile(
          path.join(options.outDir, `mcp-browser-roundtrip-quantity-${input.expectedQuantity}.json`),
          JSON.stringify(roundtrip, null, 2),
        );
        checks.push({
          name: `browser XML → MCP → browser quantity ${input.expectedQuantity}`,
          status: 'pass',
          detail: roundtrip,
        });
      }
    } finally {
      await page.context().close();
    }
  }
}

async function clickExactVisible(
  page: Page,
  names: RegExp[],
  clickCount = 1,
): Promise<string | undefined> {
  for (const name of names) {
    const candidates = page.getByText(name, { exact: true });
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        await candidate.click({ clickCount });
        return (await candidate.innerText()).trim();
      }
    }
  }
  return undefined;
}

async function activateVisibleCode(page: Page, code: string): Promise<boolean> {
  const candidates = page.getByText(new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    await candidate.dblclick();
    return true;
  }
  return false;
}

async function discovery(browser: Browser, capture: WireCapture, options: Options, checks: Check[]): Promise<void> {
  const page = await newPage(browser, capture);
  try {
    if (options.freshCatalog) {
      capture.phase = 'fresh-hpc-mode';
      await page.goto(new URL('/', options.origin).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await closeCookieBanner(page);
      await selectSolutionMode(page, options.solutionMode ?? 'AI & HPC – ThinkSystem Hardware');
      capture.phase = 'fresh-hpc-server-launch';
      await page.goto(
        new URL('#/categories/STG%40Servers%40Rack%20Server%40ThinkSystem%20SR630%20V3', options.origin).href,
        { waitUntil: 'domcontentloaded', timeout: 60_000 },
      );
      await page.waitForTimeout(5_000);
      const configure = page.locator(
        'button:has-text("Customize"), a:has-text("Customize"), [role="button"]:has-text("Customize")',
      ).first();
      await configure.waitFor({ state: 'visible', timeout: 30_000 });
      await configure.click();
      await page.waitForURL(/#\/configuration\/cto\//, { timeout: 60_000 });
      await page.waitForTimeout(8_000);
      capture.phase = 'fresh-hpc-server-topology';
      const managementRow = page.getByText('Management', { exact: true }).first().locator('xpath=../../..');
      const topologyQuantity = managementRow.locator('input.ant-input-number-input');
      await topologyQuantity.fill('1');
      await topologyQuantity.press('Tab');
      await page.waitForTimeout(5_000);
      await writeFile(
        path.join(options.outDir, 'fresh-hpc-server-topology.txt'),
        (await page.locator('body').innerText()).slice(0, 40_000),
      );
      capture.phase = 'fresh-hpc-server-summary';
      await page.getByText('Summary', { exact: true }).first().click();
      await page.waitForURL(/#\/rack-summary\//, { timeout: 60_000 });
      await page.waitForTimeout(10_000);
    } else {
      await uploadXml(page, capture, options.importXml, options.origin, false, options.solutionMode);
    }
    capture.phase = 'workspace-entry';
    const workspace = page.getByText('Go to Workspace', { exact: true }).first();
    if (!await workspace.isVisible({ timeout: 10_000 }).catch(() => false)) {
      checks.push({ name: 'workspace networking discovery', status: 'blocked', detail: 'Go to Workspace is absent.' });
      return;
    }
    await workspace.click();
    await page.waitForTimeout(5_000);

    const body = await page.locator('body').innerText();
    const controls = await page.locator('button, [role="button"], a, li.ant-menu-item').evaluateAll((elements) =>
      elements.map((element) => ({
        tag: element.tagName,
        text: (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 200),
        ariaLabel: element.getAttribute('aria-label'),
        title: element.getAttribute('title'),
      })).filter((item) => /network|switch|storage|connect|cable/i.test(`${item.text} ${item.ariaLabel} ${item.title}`)),
    );
    await writeFile(path.join(options.outDir, 'workspace-network-controls.json'), JSON.stringify(controls, null, 2));

    let rackActivated = false;
    if (options.rackCode) {
      capture.phase = 'rack-category';
      const rackCategory = await clickExactVisible(page, [/^Rack$/i]);
      if (rackCategory) await page.waitForTimeout(3_000);
      capture.phase = `rack-${options.rackCode}`;
      rackActivated = await activateVisibleCode(page, options.rackCode);
      if (rackActivated) await page.waitForTimeout(10_000);
      checks.push({
        name: `workspace rack addition: ${options.rackCode}`,
        status: rackActivated ? 'pass' : 'blocked',
      });
      if (rackActivated) {
        capture.phase = 'move-server-to-rack';
        const serverPanel = page.getByText(/\(1\)\s*\[\s*7D73CTO1WW\s*\].*Server/i).first();
        if (await serverPanel.isVisible().catch(() => false)) {
          await serverPanel.click();
          await page.waitForTimeout(500);
          const moveTo = page.getByText('Move to', { exact: true }).first();
          if (await moveTo.isVisible().catch(() => false)) {
            await moveTo.click();
            await page.waitForTimeout(500);
            const rackDestination = page.getByText('A1 - Rack', { exact: true }).last();
            if (await rackDestination.isVisible().catch(() => false)) {
              await rackDestination.click();
              await page.waitForTimeout(10_000);
            }
          }
        }
        if (options.freshCatalog) {
          const autoArrange = page.locator('.auto-arrange__switch button:visible').first();
          if (await autoArrange.isVisible().catch(() => false)) {
            capture.phase = 'fresh-hpc-auto-arrange';
            await autoArrange.click();
            await page.waitForTimeout(10_000);
          }
        }
      }
    }

    capture.phase = 'network-category';
    const category = await clickExactVisible(
      page,
      [/^Network$/i, /^Networking$/i, /^Switch$/i, /^Switches$/i],
    );
    if (category) await page.waitForTimeout(5_000);
    const networkFamily = await clickExactVisible(page, [/^Fabric Switches$/i]);
    if (networkFamily) await page.waitForTimeout(5_000);
    const requestedNetworkFamily = options.networkFamily ??
      (options.switchCode === '7D5FCTOFWW' ? 'NVIDIA Networking - Ethernet' : undefined);
    const networkLeaf = requestedNetworkFamily
      ? await clickExactVisible(page, [new RegExp(`^${requestedNetworkFamily.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')])
      : undefined;
    if (networkLeaf) await page.waitForTimeout(5_000);
    const afterCategory = await page.locator('body').innerText();
    await writeFile(path.join(options.outDir, 'workspace-network-text.txt'), afterCategory.slice(0, 30_000));

    let switchActivated = false;
    if (options.switchCode) {
      capture.phase = `switch-${options.switchCode}`;
      switchActivated = await activateVisibleCode(page, options.switchCode);
      if (switchActivated) await page.waitForTimeout(8_000);
      checks.push({
        name: `workspace switch addition: ${options.switchCode}`,
        status: switchActivated ? 'pass' : 'blocked',
        detail: switchActivated
          ? 'The SPA launched and customized the selected switch; wire-index.json is authoritative.'
          : `The selected network family did not expose ${options.switchCode}.`,
      });
    }

    const afterSwitchText = await page.locator('body').innerText();
    await writeFile(
      path.join(options.outDir, 'workspace-after-switch-text.txt'),
      afterSwitchText.slice(0, 40_000),
    );
    capture.phase = 'floor-and-cabling';
    const cablingText = await page.locator('body').innerText();
    await writeFile(
      path.join(options.outDir, 'floor-and-cabling-text.txt'),
      cablingText.slice(0, 40_000),
    );
    const cablingControls = await page.locator(
      'button, [role="button"], a, li.ant-menu-item, input, select, [role="combobox"], [role="tab"]',
    ).evaluateAll((elements) => elements.map((element) => ({
      tag: element.tagName,
      type: element.getAttribute('type'),
      text: (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 240),
      ariaLabel: element.getAttribute('aria-label'),
      title: element.getAttribute('title'),
      placeholder: element.getAttribute('placeholder'),
      value: 'value' in element ? String((element as HTMLInputElement).value) : null,
    })).filter((item) => /network|switch|storage|connect|cable|preference|topolog|floor/i.test(
      `${item.text} ${item.ariaLabel} ${item.title} ${item.placeholder}`,
    )));
    await writeFile(
      path.join(options.outDir, 'floor-and-cabling-controls.json'),
      JSON.stringify(cablingControls, null, 2),
    );
    const allCablingControls = await page.locator(
      'button, [role="button"], a, li, input, select, [role="combobox"], [role="tab"], [title], [aria-label]',
    ).evaluateAll((elements) => elements.map((element, index) => ({
      index,
      tag: element.tagName,
      className: element.getAttribute('class'),
      type: element.getAttribute('type'),
      text: (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 240),
      ariaLabel: element.getAttribute('aria-label'),
      title: element.getAttribute('title'),
      placeholder: element.getAttribute('placeholder'),
      value: 'value' in element ? String((element as HTMLInputElement).value) : null,
    })));
    await writeFile(
      path.join(options.outDir, 'floor-and-cabling-all-controls.json'),
      JSON.stringify(allCablingControls, null, 2),
    );
    await page.screenshot({
      path: path.join(options.outDir, 'floor-and-cabling.png'),
      fullPage: true,
    });
    const cablingPanel = page.getByText('Floor and Cabling', { exact: true }).first();
    if (await cablingPanel.isVisible().catch(() => false)) {
      const ancestry = await cablingPanel.evaluate((element) => {
        const items: string[] = [];
        let current: HTMLElement | null = element as HTMLElement;
        for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
          items.push(current.outerHTML.slice(0, 12_000));
        }
        return items;
      });
      await writeFile(
        path.join(options.outDir, 'floor-and-cabling-panel-ancestry.json'),
        JSON.stringify(ancestry, null, 2),
      );
    }
    const cablingSettingsIcon = cablingPanel.locator('xpath=../..').locator('.anticon-setting').first();
    if (
      !options.freshCatalog &&
      await cablingSettingsIcon.isVisible().catch(() => false) &&
      !(await page.getByText('Preference', { exact: true }).count())
    ) {
      capture.phase = 'floor-and-cabling-settings';
      await cablingSettingsIcon.click();
      await page.waitForTimeout(3_000);
      await writeFile(
        path.join(options.outDir, 'floor-and-cabling-settings-text.txt'),
        (await page.locator('body').innerText()).slice(0, 50_000),
      );
      await page.screenshot({
        path: path.join(options.outDir, 'floor-and-cabling-settings.png'),
        fullPage: true,
      });
    }
    capture.phase = 'preference-rack-select';
    if (rackActivated) {
      const rackLabels = page.getByText('A1', { exact: true });
      const rackLabelCandidates: string[] = [];
      for (let index = 0; index < await rackLabels.count(); index += 1) {
        const label = rackLabels.nth(index);
        if (!await label.isVisible().catch(() => false)) continue;
        rackLabelCandidates.push(await label.evaluate((element) => element.outerHTML.slice(0, 8_000)));
      }
      await writeFile(
        path.join(options.outDir, 'preference-rack-labels.json'),
        JSON.stringify(rackLabelCandidates, null, 2),
      );
      const rackLabel = rackLabels.last();
      if (await rackLabel.isVisible().catch(() => false)) {
        await rackLabel.click();
        await page.waitForTimeout(500);
      }
    }
    capture.phase = 'preference-open';
    const preferenceClicked = await clickExactVisible(page, [/^Preference$/i]);
    const preferenceVisible = Boolean(preferenceClicked);
    if (preferenceVisible) {
      await page.waitForTimeout(2_000);
      await writeFile(
        path.join(options.outDir, 'preference-open-text.txt'),
        (await page.locator('body').innerText()).slice(0, 50_000),
      );
      const preferenceControls = await page.locator(
        '.ant-popover button, .ant-popover input, .ant-popover [role="button"], .ant-popover [role="combobox"], .ant-popover .ant-select, .ant-popover label, .ant-popover [title]',
      ).evaluateAll((elements) => elements.map((element, index) => ({
        index,
        tag: element.tagName,
        className: element.getAttribute('class'),
        text: (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 300),
        title: element.getAttribute('title'),
        ariaLabel: element.getAttribute('aria-label'),
        value: 'value' in element ? String((element as HTMLInputElement).value) : null,
      })));
      await writeFile(
        path.join(options.outDir, 'preference-controls.json'),
        JSON.stringify(preferenceControls, null, 2),
      );
      await page.screenshot({
        path: path.join(options.outDir, 'preference-open.png'),
        fullPage: true,
      });
      const managementPreference = await clickExactVisible(page, [/^Management$/i]);
      if (managementPreference) {
        await page.waitForTimeout(1_000);
        await writeFile(
          path.join(options.outDir, 'preference-management-text.txt'),
          (await page.locator('body').innerText()).slice(0, 50_000),
        );
        const managementControls = await page.locator(
          '.ant-card:visible button, .ant-card:visible input, .ant-card:visible [role="button"], .ant-card:visible [role="combobox"], .ant-card:visible .ant-select, .ant-card:visible label, .ant-card:visible [title]',
        ).evaluateAll((elements) => elements.map((element, index) => ({
          index,
          tag: element.tagName,
          className: element.getAttribute('class'),
          text: (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 300),
          title: element.getAttribute('title'),
          ariaLabel: element.getAttribute('aria-label'),
          value: 'value' in element ? String((element as HTMLInputElement).value) : null,
        })));
        await writeFile(
          path.join(options.outDir, 'preference-management-controls.json'),
          JSON.stringify(managementControls, null, 2),
        );
        await page.screenshot({
          path: path.join(options.outDir, 'preference-management.png'),
          fullPage: true,
        });
        const managementPanel = page.locator('.ant-collapse-item-active:visible').filter({ hasText: /^Management/ }).first();
        const managementSelects = managementPanel.locator('.ant-select:visible');
        const managementSelectOptions: Array<{ index: number; selected: string; options: string[] }> = [];
        for (let index = 0; index < await managementSelects.count(); index += 1) {
          const select = managementSelects.nth(index);
          const selected = (await select.innerText()).trim().replace(/\s+/g, ' ');
          await select.click();
          await page.waitForTimeout(300);
          const dropdownOptions = await page.locator(
            '.ant-select-dropdown:visible .ant-select-dropdown-menu-item, .ant-select-dropdown:visible [role="option"]',
          ).allTextContents();
          managementSelectOptions.push({
            index,
            selected,
            options: dropdownOptions.map((option) => option.trim().replace(/\s+/g, ' ')).filter(Boolean),
          });
          await page.keyboard.press('Escape');
        }
        await writeFile(
          path.join(options.outDir, 'preference-management-options.json'),
          JSON.stringify(managementSelectOptions, null, 2),
        );
        if (options.switchCode === '7D5FCTOFWW' && await managementSelects.count() >= 4) {
          capture.phase = 'preference-management-cable';
          await managementSelects.nth(1).click();
          const cableType = page.getByText('Cat5E', { exact: true }).last();
          if (await cableType.isVisible().catch(() => false)) await cableType.click();
          await page.waitForTimeout(500);
          capture.phase = 'preference-management-main-switch';
          await managementSelects.nth(3).click();
          const mainSwitch = page.getByText(/\[7D5FCTOFWW, BPC7\]/).last();
          if (await mainSwitch.isVisible().catch(() => false)) await mainSwitch.click();
          await page.waitForTimeout(2_000);
          await writeFile(
            path.join(options.outDir, 'preference-management-selected-text.txt'),
            (await page.locator('body').innerText()).slice(0, 50_000),
          );
          await page.screenshot({
            path: path.join(options.outDir, 'preference-management-selected.png'),
            fullPage: true,
          });
        }
      }
      capture.phase = 'preference-storage';
      const storagePreference = page.getByText('Storage', { exact: true }).last();
      if (!options.automaticSwitchFlow && await storagePreference.isVisible().catch(() => false)) {
        await storagePreference.click();
        await page.waitForTimeout(1_000);
        await writeFile(path.join(options.outDir, 'preference-storage-text.txt'),
          (await page.locator('body').innerText()).slice(0, 50_000));
        await page.screenshot({ path: path.join(options.outDir, 'preference-storage.png'), fullPage: true });
        const addStorage = page.getByText(/^Add Storage$/i).last();
        if (await addStorage.isVisible().catch(() => false)) {
          capture.phase = 'preference-storage-add';
          await addStorage.click();
          await page.waitForTimeout(1_000);
          await writeFile(path.join(options.outDir, 'preference-storage-after-add-text.txt'),
            (await page.locator('body').innerText()).slice(0, 50_000));
          const storageControls = await page.locator(
            '.ant-card:visible button, .ant-card:visible input, .ant-card:visible [role="button"], .ant-card:visible [role="combobox"], .ant-card:visible .ant-select, .ant-card:visible label, .ant-card:visible [title]',
          ).evaluateAll((elements) => elements.map((element, index) => ({
            index,
            tag: element.tagName,
            className: element.getAttribute('class'),
            text: (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 300),
            title: element.getAttribute('title'),
            ariaLabel: element.getAttribute('aria-label'),
            placeholder: element.getAttribute('placeholder'),
            value: 'value' in element ? String((element as HTMLInputElement).value) : null,
          })));
          await writeFile(path.join(options.outDir, 'preference-storage-after-add-controls.json'),
            JSON.stringify(storageControls, null, 2));
          await page.screenshot({ path: path.join(options.outDir, 'preference-storage-after-add.png'), fullPage: true });
          const nameDialog = page.locator('[role="dialog"]:visible').filter({
            hasText: 'Please enter a unique name for the new storage',
          }).last();
          if (await nameDialog.isVisible().catch(() => false)) {
            const storageName = nameDialog.locator('input:visible').first();
            if (await storageName.isVisible().catch(() => false)) await storageName.fill('Parity Storage');
            await nameDialog.getByText('OK', { exact: true }).click();
            await page.waitForTimeout(1_000);
            await writeFile(path.join(options.outDir, 'preference-storage-created-text.txt'),
              (await page.locator('body').innerText()).slice(0, 50_000));
            const createdControls = await page.locator(
              '.ant-card:visible button, .ant-card:visible input, .ant-card:visible [role="button"], .ant-card:visible [role="combobox"], .ant-card:visible .ant-select, .ant-card:visible label, .ant-card:visible [title]',
            ).evaluateAll((elements) => elements.map((element, index) => ({
              index,
              tag: element.tagName,
              className: element.getAttribute('class'),
              text: (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 300),
              title: element.getAttribute('title'),
              ariaLabel: element.getAttribute('aria-label'),
              placeholder: element.getAttribute('placeholder'),
              value: 'value' in element ? String((element as HTMLInputElement).value) : null,
            })));
            await writeFile(path.join(options.outDir, 'preference-storage-created-controls.json'),
              JSON.stringify(createdControls, null, 2));
            await page.screenshot({ path: path.join(options.outDir, 'preference-storage-created.png'), fullPage: true });
            const createdStorage = page.getByText('Parity Storage', { exact: true }).last();
            if (await createdStorage.isVisible().catch(() => false)) {
              capture.phase = 'preference-storage-edit';
              await createdStorage.click();
              await page.waitForTimeout(1_000);
              await writeFile(path.join(options.outDir, 'preference-storage-edit-text.txt'),
                (await page.locator('body').innerText()).slice(0, 50_000));
              const editDialog = page.locator('[role="dialog"]:visible').last();
              const editControls = await editDialog.locator(
                'button, input, [role="button"], [role="combobox"], .ant-select, label, [title]',
              ).evaluateAll((elements) => elements.map((element, index) => ({
                index,
                tag: element.tagName,
                className: element.getAttribute('class'),
                text: (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 300),
                title: element.getAttribute('title'),
                ariaLabel: element.getAttribute('aria-label'),
                placeholder: element.getAttribute('placeholder'),
                value: 'value' in element ? String((element as HTMLInputElement).value) : null,
              })));
              await writeFile(path.join(options.outDir, 'preference-storage-edit-controls.json'),
                JSON.stringify(editControls, null, 2));
              const editSelects = editDialog.locator('.ant-select:visible');
              const editOptions: Array<{ index: number; selected: string; options: string[] }> = [];
              for (let index = 0; index < await editSelects.count(); index += 1) {
                const select = editSelects.nth(index);
                const selected = (await select.innerText()).trim().replace(/\s+/g, ' ');
                await select.click();
                await page.waitForTimeout(300);
                const options = await page.locator(
                  '.ant-select-dropdown:visible .ant-select-dropdown-menu-item, .ant-select-dropdown:visible [role="option"]',
                ).allTextContents();
                editOptions.push({ index, selected,
                  options: options.map((option) => option.trim().replace(/\s+/g, ' ')).filter(Boolean) });
                await page.keyboard.press('Escape');
              }
              await writeFile(path.join(options.outDir, 'preference-storage-edit-options.json'),
                JSON.stringify(editOptions, null, 2));
              await page.screenshot({ path: path.join(options.outDir, 'preference-storage-edit.png'), fullPage: true });
              const editItems = page.locator('a:visible, button:visible').filter({ hasText: /^Edit Item$/ });
              const editItemCount = await editItems.count();
              for (let index = 0; !options.storageLifecycleOnly && index < editItemCount; index += 1) {
                const editItem = editItems.nth(index);
                if (!await editItem.isVisible().catch(() => false)) continue;
                capture.phase = `preference-storage-edit-item-${index}`;
                await editItem.click();
                await page.waitForTimeout(750);
                await writeFile(path.join(options.outDir, `preference-storage-edit-item-${index}-text.txt`),
                  (await page.locator('body').innerText()).slice(0, 50_000));
                await page.screenshot({
                  path: path.join(options.outDir, `preference-storage-edit-item-${index}.png`), fullPage: true,
                });
                const pickerDialog = page.locator('[role="dialog"]:visible').last();
                if (await pickerDialog.isVisible().catch(() => false)) {
                  const cancel = pickerDialog.getByText(/^(?:Cancel|Close)$/i).last();
                  if (await cancel.isVisible().catch(() => false)) await cancel.click();
                  else await page.keyboard.press('Escape');
                  await page.waitForTimeout(300);
                }
              }
              const changeName = page.locator('button:visible').filter({ hasText: /^Change storage name$/ }).first();
              if (await changeName.isVisible().catch(() => false)) {
                capture.phase = 'preference-storage-rename';
                await changeName.click();
                await page.waitForTimeout(300);
                const renameDialog = page.locator('[role="dialog"]:visible').last();
                const nameInput = renameDialog.locator('input:visible').first();
                if (await nameInput.isVisible().catch(() => false)) await nameInput.fill('Parity Storage Renamed');
                const confirm = renameDialog.getByText(/^(?:Save|Update|OK)$/i).last();
                if (await confirm.isVisible().catch(() => false)) await confirm.click();
                await page.waitForTimeout(750);
                await writeFile(path.join(options.outDir, 'preference-storage-renamed-text.txt'),
                  (await page.locator('body').innerText()).slice(0, 50_000));
                const renamedStorage = page.getByText('Parity Storage Renamed', { exact: true }).last();
                if (await renamedStorage.isVisible().catch(() => false)) {
                  await renamedStorage.click();
                  await page.waitForTimeout(300);
                }
              }
              const removeStorage = page.locator('button:visible').filter({ hasText: /^Remove storage network$/ }).first();
              if (await removeStorage.isVisible().catch(() => false)) {
                capture.phase = 'preference-storage-remove';
                await removeStorage.click();
                await page.waitForTimeout(300);
                const removeDialog = page.locator('[role="dialog"]:visible').last();
                await writeFile(path.join(options.outDir, 'preference-storage-remove-dialog.txt'),
                  (await removeDialog.innerText()).slice(0, 10_000));
                const confirm = removeDialog.getByText(/^(?:Remove|Delete|OK|Yes)$/i).last();
                if (await confirm.isVisible().catch(() => false)) await confirm.click();
                await page.waitForTimeout(750);
                await writeFile(path.join(options.outDir, 'preference-storage-removed-text.txt'),
                  (await page.locator('body').innerText()).slice(0, 50_000));
              }
            }
          }
        }
      }
      if (options.storageLifecycleOnly) {
        checks.push({ name: 'storage definition lifecycle discovery', status: 'pass', detail: {
          created: await page.getByText('Parity Storage', { exact: true }).count() > 0,
          renamed: await page.getByText('Parity Storage Renamed', { exact: true }).count() > 0,
        } });
        return;
      }
      capture.phase = 'preference-power';
      const powerTab = page.getByText('Power', { exact: true }).last();
      if (await powerTab.isVisible().catch(() => false)) {
        await powerTab.click();
        await page.waitForTimeout(1_000);
        await writeFile(
          path.join(options.outDir, 'preference-power-text.txt'),
          (await page.locator('body').innerText()).slice(0, 50_000),
        );
        const powerControls = await page.locator(
          '.ant-card:visible button, .ant-card:visible input, .ant-card:visible [role="button"], .ant-card:visible [role="combobox"], .ant-card:visible .ant-select, .ant-card:visible label, .ant-card:visible [title]',
        ).evaluateAll((elements) => elements.map((element, index) => ({
          index,
          tag: element.tagName,
          className: element.getAttribute('class'),
          text: (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 300),
          title: element.getAttribute('title'),
          ariaLabel: element.getAttribute('aria-label'),
          value: 'value' in element ? String((element as HTMLInputElement).value) : null,
        })));
        await writeFile(
          path.join(options.outDir, 'preference-power-controls.json'),
          JSON.stringify(powerControls, null, 2),
        );
        await page.screenshot({
          path: path.join(options.outDir, 'preference-power.png'),
          fullPage: true,
        });
      }
      await clickExactVisible(page, [/^Preference$/i]);
      await page.waitForTimeout(500);
    }

    capture.phase = 'auto-connect-settings';
    const autoConnectLabel = page.locator('.auto-connect__label:visible').first();
    const autoConnectContainer = autoConnectLabel.locator('xpath=..');
    const autoConnectSettings = autoConnectContainer.locator('.anticon-setting').first();
    if (await autoConnectSettings.isVisible().catch(() => false)) {
      await autoConnectSettings.click();
      await page.waitForTimeout(500);
      const automatedPdu = page.getByText('Automated Rack PDU', { exact: true }).last();
      if (await automatedPdu.isVisible().catch(() => false)) {
        await writeFile(
          path.join(options.outDir, 'auto-connect-settings-automated-pdu.html'),
          await automatedPdu.evaluate((element) => element.closest('button')?.outerHTML ?? element.outerHTML),
        );
        const automatedPduCheckbox = automatedPdu.locator('xpath=ancestor::label[1]').locator('input[type="checkbox"]');
        if (await automatedPduCheckbox.isChecked()) {
          capture.phase = 'auto-connect-disable-automated-pdu';
          await automatedPdu.click();
          await page.waitForTimeout(8_000);
        }
      }
      await page.screenshot({
        path: path.join(options.outDir, 'auto-connect-settings.png'),
        fullPage: true,
      });
      await autoConnectSettings.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }

    type Placement = { code: string; configurationId?: string; rackId?: string; position?: number; nonRack: boolean };
    const placementFromResponse = async (phase: string, code: string): Promise<Placement> => {
      await Promise.allSettled(capture.pending);
      const entry = capture.entries.filter((item) => item.phase === phase &&
        /\/ctos\/racks\/customize$/.test(new URL(item.url).pathname) && item.status === 200)
        .sort((left, right) => right.sequence - left.sequence)[0];
      const body = object(entry ? capture.responseBodies.get(entry.sequence) : undefined);
      for (const rackRaw of array(body['rackArea'])) {
        const rack = object(rackRaw);
        for (const itemRaw of array(rack['rackItems'])) {
          const item = object(itemRaw);
          if (text(item['code']) === code) {
            const configurationId = text(item['id']);
            const rackId = text(rack['id']);
            const position = Number(item['position']);
            return { code, nonRack: false,
              ...(configurationId ? { configurationId } : {}),
              ...(rackId ? { rackId } : {}),
              ...(Number.isFinite(position) ? { position } : {}) };
          }
        }
      }
      const nonRack = array(body['nonRackArea']).map(object).find((item) => text(item['code']) === code);
      const configurationId = nonRack ? text(nonRack['id']) : '';
      return { code, ...(configurationId ? { configurationId } : {}), nonRack: Boolean(nonRack) };
    };
    let serverPlacement: Placement = { code: '7D73CTOHWW', nonRack: true };
    let switchPlacement: Placement = { code: options.switchCode ?? '', nonRack: true };
    if (options.freshCatalog) {
      capture.phase = 'summary-for-placement';
      const summary = page.getByText('Summary', { exact: true }).first();
      if (await summary.isVisible().catch(() => false)) {
        await summary.click();
        await page.waitForURL(/#\/rack-summary\//, { timeout: 60_000 });
        await page.waitForTimeout(8_000);
        await writeFile(path.join(options.outDir, 'summary-before-placement.txt'),
          (await page.locator('body').innerText()).slice(0, 50_000));
        await page.screenshot({ path: path.join(options.outDir, 'summary-before-placement.png'), fullPage: true });
        async function moveSummaryItemToA1(code: string, phase: string): Promise<Placement> {
          const codeText = page.locator('.productCode-col').filter({ hasText: new RegExp(
            code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i',
          ) }).first();
          if (!await codeText.isVisible().catch(() => false)) return { code, nonRack: true };
          const product = codeText.locator('xpath=ancestor::div[contains(@class,"panel-header")][1]');
          if (!await product.isVisible().catch(() => false)) return { code, nonRack: true };
          await writeFile(
            path.join(options.outDir, `summary-${code}-product.html`),
            await product.evaluate((element) => element.outerHTML.slice(0, 30_000)),
          );
          const moveTo = product.getByText('Move to', { exact: true }).first();
          if (!await moveTo.isVisible().catch(() => false)) return { code, nonRack: true };
          await moveTo.click();
          await page.waitForTimeout(500);
          const rackDestination = page.getByText('A1 - Rack', { exact: true }).last();
          if (!await rackDestination.isVisible().catch(() => false)) return { code, nonRack: true };
          capture.phase = phase;
          await rackDestination.click();
          await page.waitForTimeout(10_000);
          return placementFromResponse(phase, code);
        }
        capture.phase = 'summary-move-server-after-pdu-disabled';
        serverPlacement = await moveSummaryItemToA1('7D73CTOHWW', capture.phase);
        capture.phase = 'summary-move-switch-after-pdu-disabled';
        if (options.switchCode) switchPlacement = await moveSummaryItemToA1(options.switchCode, capture.phase);
        capture.phase = 'workspace-after-summary-placement';
        const backToWorkspace = page.getByText('Go to Workspace', { exact: true }).first();
        if (await backToWorkspace.isVisible().catch(() => false)) {
          await backToWorkspace.click();
          await page.waitForTimeout(10_000);
        }
      }
    }
    await writeFile(
      path.join(options.outDir, 'workspace-placement-result.json'),
      JSON.stringify({ server: serverPlacement, switch: switchPlacement,
        bothPlaced: !serverPlacement.nonRack && !switchPlacement.nonRack,
        text: (await page.locator('body').innerText()).slice(0, 40_000) }, null, 2),
    );

    if (options.automaticSwitchFlow && !serverPlacement.nonRack && !switchPlacement.nonRack) {
      capture.phase = 'automatic-switch-orchestration';
      const orchestrationStart = capture.entries.length;
      const autoConnectContainer = page.locator('.auto-connect__label:visible').first().locator('xpath=..');
      const autoConnectToggle = autoConnectContainer.locator('.ant-switch').first();
      if (await autoConnectToggle.isVisible().catch(() => false)) {
        const toggleClass = await autoConnectToggle.getAttribute('class') ?? '';
        const toggleOn = await autoConnectToggle.getAttribute('aria-checked') === 'true' ||
          toggleClass.includes('ant-switch-checked');
        if (toggleOn) {
          await autoConnectToggle.click();
          await page.waitForTimeout(3_000);
        }
        await autoConnectToggle.click();
        const startedAt = Date.now();
        let lastEntryCount = capture.entries.length;
        let lastChangeAt = Date.now();
        const progress: Array<{
          elapsedSeconds: number;
          loaderVisible: boolean;
          entries: Array<{ sequence: number; method: string; pathname: string; status: number; connectionCount?: number }>;
          bodySignal?: string;
        }> = [];
        while (Date.now() - startedAt < 8 * 60_000) {
          await page.waitForTimeout(5_000);
          await Promise.allSettled(capture.pending);
          if (capture.entries.length !== lastEntryCount) {
            lastEntryCount = capture.entries.length;
            lastChangeAt = Date.now();
          }
          const entries = capture.entries.slice(orchestrationStart).map((entry) => ({
            sequence: entry.sequence,
            method: entry.method,
            pathname: new URL(entry.url).pathname,
            status: entry.status,
            ...(entry.connectionCount === undefined ? {} : { connectionCount: entry.connectionCount }),
          }));
          const bodyText = await page.locator('body').innerText();
          const bodySignal = bodyText.match(/(?:unable|failed|error|cannot)[^\n]{0,180}/i)?.[0];
          const loaderVisible = await page.locator('.Loader__background:visible').count() > 0;
          progress.push({
            elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
            loaderVisible,
            entries,
            ...(bodySignal ? { bodySignal } : {}),
          });
          await writeFile(path.join(options.outDir, 'automatic-switch-progress.json'),
            JSON.stringify(progress, null, 2));
          const autoConnectEntries = entries.filter((entry) => /auto_connect/.test(entry.pathname));
          if (autoConnectEntries.some((entry) => (entry.connectionCount ?? 0) > 0)) break;
          const hasOrchestration = entries.some((entry) =>
            /switch_calculation|\/ctos\/[^/]+\/launch|\/ctos\/racks\/customize|autoDerive/.test(entry.pathname));
          const stableMilliseconds = Date.now() - lastChangeAt;
          if (!loaderVisible && autoConnectEntries.length > 0 && stableMilliseconds >= 30_000) break;
          if (!loaderVisible && hasOrchestration && stableMilliseconds >= 90_000) break;
          if (bodySignal && !loaderVisible && stableMilliseconds >= 30_000) break;
        }
        await writeFile(path.join(options.outDir, 'automatic-switch-terminal-text.txt'),
          (await page.locator('body').innerText()).slice(0, 50_000));
        await page.screenshot({
          path: path.join(options.outDir, 'automatic-switch-terminal.png'), fullPage: true,
        });
      }
    }

    capture.phase = 'auto-connect-p2p';
    const currentAutoConnectContainer = page.locator('.auto-connect__label:visible').first().locator('xpath=..');
    const currentAutoConnectSettings = currentAutoConnectContainer.locator('.anticon-setting').first();
    if (!serverPlacement.nonRack && !switchPlacement.nonRack &&
      await currentAutoConnectSettings.isVisible().catch(() => false)) {
      await currentAutoConnectSettings.click();
      await page.waitForTimeout(500);
      const p2p = page.getByText('P2P Cabling', { exact: true }).last();
      if (await p2p.isVisible().catch(() => false)) {
        const p2pLabel = p2p.locator('xpath=ancestor::label[1]');
        const p2pCheckbox = p2pLabel.locator('input[type="checkbox"]');
        await writeFile(path.join(options.outDir, 'auto-connect-settings-p2p.html'),
          await p2pLabel.evaluate((element) => element.outerHTML));
        if (await p2pCheckbox.isChecked()) {
          capture.phase = 'auto-connect-p2p-disable';
          await p2p.click();
          await page.waitForTimeout(5_000);
        }
        capture.phase = 'auto-connect-p2p-enable';
        const autoConnectResponse = page.waitForResponse((response) =>
          /\/api\/auto_connect(?:\?|$)/.test(response.url()) && response.request().method() === 'POST',
        { timeout: 60_000 });
        await p2p.click();
        await autoConnectResponse;
        await page.waitForTimeout(15_000);
      }
      await currentAutoConnectSettings.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
    await page.screenshot({
      path: path.join(options.outDir, 'workspace-after-auto-connect.png'),
      fullPage: true,
    });

    capture.phase = 'browser-export';
    const exportClicked = await clickExactVisible(page, [/^Export$/i]);
    if (exportClicked) {
      const exportOpened = await page.waitForFunction(() => document.body.innerText.includes('Export Preference'),
        undefined, { timeout: 5_000 }).then(() => true).catch(() => false);
      if (exportOpened) {
        await writeFile(path.join(options.outDir, 'browser-export-dialog-text.txt'),
          (await page.locator('body').innerText()).slice(0, 30_000));
        await page.screenshot({ path: path.join(options.outDir, 'browser-export-dialog.png'), fullPage: true });
        const fileName = page.locator('input[type="text"]:visible').last();
        if (await fileName.isVisible().catch(() => false)) await fileName.fill('parity-ai-hpc-rack');
        await page.waitForTimeout(500);
        const exportRequestPromise = page.waitForRequest((request) =>
          /\/api\/ctos\/export_zip(?:\?|$)/.test(request.url()) && request.method() === 'POST',
        { timeout: 120_000 });
        const downloadPromise = page.waitForEvent('download', { timeout: 120_000 }).catch(() => undefined);
        await page.getByText('Save', { exact: true }).last().click();
        const exportRequest = await exportRequestPromise;
        const fields = object(parseJsonBody(exportRequest.postData()));
        if (Object.keys(fields).length > 0) {
          const data = typeof fields['data'] === 'string'
            ? JSON.parse(fields['data']) as JsonObject
            : object(fields['data']);
          const groups = typeof fields['groups'] === 'string'
            ? JSON.parse(fields['groups']) as unknown
            : fields['groups'];
          const exportEvidence = {
            action: exportRequest.url(),
            method: exportRequest.method(),
            fieldNames: Object.keys(fields),
            customizingFlags: object(data['customizingFlags']),
            networkingInformation: object(data['networkingInformation']),
            exportFileTypes: data['exportFileTypes'],
            groupCount: array(groups).length,
          };
          await writeFile(path.join(options.outDir, 'browser-export-form-summary.json'),
            JSON.stringify(exportEvidence, null, 2));
          await writeFile(path.join(options.outDir, 'browser-export-data.json'), JSON.stringify(data, null, 2));
        }
        const download = await downloadPromise;
        if (download) await download.saveAs(path.join(options.outDir, 'parity-ai-hpc-rack.zip'));
      }
    }

    const openDialog = page.locator('[role="dialog"]:visible');
    if (await openDialog.count()) {
      const close = openDialog.last().locator('.ant-modal-close:visible').first();
      if (await close.isVisible().catch(() => false)) await close.click();
    }
    capture.phase = 'storage-category';
    const storage = options.storageCode
      ? await clickExactVisible(page, [/^Storage$/i, /^Add Storage$/i])
      : undefined;
    if (storage) await page.waitForTimeout(5_000);
    const afterStorage = await page.locator('body').innerText();
    await writeFile(path.join(options.outDir, 'workspace-storage-text.txt'), afterStorage.slice(0, 30_000));

    let storageActivated = false;
    if (options.storageCode) {
      capture.phase = `storage-${options.storageCode}`;
      storageActivated = await activateVisibleCode(page, options.storageCode);
      if (storageActivated) await page.waitForTimeout(8_000);
    }

    await Promise.allSettled(capture.pending);
    const populated = capture.entries.some((entry) => {
      const pathname = new URL(entry.url).pathname;
      return /auto.?connect/i.test(pathname) && entry.status === 200 && (entry.connectionCount ?? 0) > 0;
    });
    checks.push({
      name: 'workspace networking discovery',
      status: populated ? 'pass' : 'blocked',
      detail: populated
        ? { message: 'The SPA produced a successful nonzero auto-connect response; inspect wire-index.json.',
            serverPlacement, switchPlacement }
        : {
            reason: 'No successful nonzero auto-connect was produced by unambiguous visible category actions.',
            categoryClicked: category,
            networkFamilyClicked: networkFamily,
            networkLeafClicked: networkLeaf,
            switchCode: options.switchCode,
            switchActivated,
            rackCode: options.rackCode,
            rackActivated,
            requestedSolutionMode: options.solutionMode,
            visibleSolutionMode: afterSwitchText.includes('General Purpose')
              ? 'General Purpose'
              : options.solutionMode,
            preferenceVisible,
            autoConnectControlVisible: /Auto Connect/i.test(cablingText),
            serverPlacement,
            switchPlacement,
            storageClicked: storage,
            storageCode: options.storageCode,
            storageActivated,
            visibleKeywords: [...new Set(body.match(/.{0,25}(?:network|switch|storage|connect|cable).{0,60}/gi) ?? [])].slice(0, 20),
            nextStep: serverPlacement.nonRack || switchPlacement.nonRack
              ? 'Place both the server and selected switch in the same rack by their product cards, then trigger Auto Connect.'
              : 'Both products are placed. Complete the supported UI switch association so switchMap identifies the Management switch, then rerun Auto Connect.',
          },
    });
  } catch (error) {
    await Promise.allSettled([
      page.content().then(html => writeFile(path.join(options.outDir, 'discovery-error.html'), html)),
      page.locator('body').innerText().then(body => writeFile(path.join(options.outDir, 'discovery-error.txt'), body)),
      writeFile(path.join(options.outDir, 'discovery-error-context.json'),
        JSON.stringify({ phase: capture.phase, url: page.url() }, null, 2)),
    ]);
    throw error;
  } finally {
    await page.context().close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(path.join(options.outDir, 'wire'), { recursive: true });
  const checks: Check[] = [];
  await offlineChecks(checks, options.outDir);

  let browser: Browser | undefined;
  const capture = new WireCapture(options.outDir);
  try {
    if (options.suite !== 'offline') browser = await chromium.launch({ headless: true });
    if (browser && (options.suite === 'baseline' || options.suite === 'all')) {
      await baseline(browser, capture, options, checks);
    }
    if (browser && (options.suite === 'handoff' || options.suite === 'all')) {
      await handoff(browser, capture, options, checks);
    }
    if (browser && (options.suite === 'discovery' || options.suite === 'all')) {
      await discovery(browser, capture, options, checks);
    }
  } catch (error) {
    checks.push({
      name: 'runner',
      status: 'fail',
      detail: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
    });
  } finally {
    if (browser) await browser.close();
    await capture.flush();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    execution: {
      suite: options.suite,
      headless: true,
      persistentProfile: false,
      isolatedContextPerScenario: true,
      origin: options.origin,
      importXml: options.importXml,
    },
    checks,
    passed: checks.filter((check) => check.status === 'pass').length,
    blocked: checks.filter((check) => check.status === 'blocked').length,
    failed: checks.filter((check) => check.status === 'fail').length,
    wireEntries: capture.entries.length,
  };
  await writeFile(path.join(options.outDir, 'report.json'), JSON.stringify(report, null, 2));
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.failed > 0 ? 1 : report.blocked > 0 ? 2 : 0;
}

await main();
