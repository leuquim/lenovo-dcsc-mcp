/**
 * Fresh-browser differential for managed storage-controller exports.
 *
 * Usage:
 *   npx tsx scripts/parity-storage-reimport.ts \
 *     --mcp-xml /path/to/mcp.xml \
 *     --out artifacts/parity-storage-reimport/run
 * Or pass --mcp-report /path/to/parity-storage/report.json to consume the
 * export produced by a successful maintained storage lifecycle gate.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page, type Response } from 'playwright';
import { selectBrowserSolutionMode } from './parity/browser.js';

type Obj = Record<string, unknown>;

const object = (value: unknown): Obj =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];
const string = (value: unknown): string => typeof value === 'string' ? value : '';

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  assert(value, `Missing --${name}.`);
  return value;
}

const browserXml = path.resolve(argument(
  'browser-xml',
  'test/fixtures/parity/xml/storage-managed-controller.xml',
));
async function resolveMcpXml(): Promise<string> {
  const hasXml = process.argv.includes('--mcp-xml');
  const hasReport = process.argv.includes('--mcp-report');
  assert(hasXml !== hasReport, 'Supply exactly one of --mcp-xml or --mcp-report.');
  if (hasXml) return path.resolve(argument('mcp-xml'));
  const reportPath = path.resolve(argument('mcp-report'));
  const report = object(JSON.parse(await readFile(reportPath, 'utf8')));
  assert.equal(report.status, 'pass', 'The storage lifecycle report must pass before reimport.');
  assert.equal(report.scope, 'live-stdio-storage-lifecycle-and-crash-restart',
    'The producer report is not a maintained storage lifecycle gate.');
  assert(typeof report.exportXml === 'string' && path.isAbsolute(report.exportXml),
    'The storage lifecycle report must identify its generated XML by absolute path.');
  return report.exportXml;
}
const mcpXml = await resolveMcpXml();
const out = path.resolve(argument('out',
  `artifacts/parity-storage-reimport/${new Date().toISOString().replace(/[:.]/g, '-')}`));
const controllerCode = argument('controller-code', '7DJ0CTO1WW');
const mode = argument('mode', 'AI & HPC – ThinkSystem Hardware');

interface ImportResult {
  name: string;
  status: number;
  route: string;
  configurationCodes: string[];
  storageDefinitions: Obj[];
  storageConnectionNetworks: Obj[];
  controllerProducts: Obj[];
  summaryCodes: string[];
  summaryHasController: boolean;
}

async function chooseMode(page: Page, diagnosticsDir: string): Promise<void> {
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await selectBrowserSolutionMode(page, mode, { diagnosticsDir });
}

function normalizeProduct(product: Obj): Obj {
  const prices = rows(product.prices).map(price => ({
    priceTypeId: price.priceTypeId,
    price: price.price,
    priceNotAvailable: price.priceNotAvailable,
  }));
  return Object.fromEntries(['code', 'type', 'quantity', 'price', 'unitPrice', 'targetCtoUnitPrice']
    .map(key => [key, product[key]]).concat([['prices', prices]]));
}

function normalizeDefinition(definition: Obj): Obj {
  return {
    maximumExpansions: definition.maximumExpansions,
    type: definition.type,
    layout: definition.layout,
    controller: object(definition.controller),
    expansion: object(definition.expansion),
    mainSwitch: object(definition.mainSwitch),
  };
}

async function importXml(page: Page, name: string, xml: string): Promise<ImportResult> {
  const dir = path.join(out, name);
  await mkdir(dir, { recursive: true });
  await chooseMode(page, dir);
  const responsePromise = page.waitForResponse((response: Response) =>
    response.url().includes('/multiple/cfxml_import') && response.request().method() === 'POST',
  { timeout: 120_000 });
  await page.locator('input[type=file]').first().setInputFiles(xml);
  const response = await responsePromise;
  const payload: unknown = await response.json();
  await writeFile(path.join(dir, 'import-response.json'), JSON.stringify(payload, null, 2));
  await page.waitForURL(url => /#\/(rack-summary|summary)\//.test(url.href), { timeout: 120_000 });
  await page.waitForTimeout(8_000);
  const root = object(Array.isArray(payload) ? payload[0] : payload);
  const configurations = rows(root.configuration);
  const networking = object(root.networkingInformation);
  const groups = rows(root.groups);
  const products = groups.flatMap(group => rows(group.products));
  const summaryCodes = (await page.locator('.productCode-col').allTextContents())
    .map(value => value.trim().split(/\s/)[0] ?? '').filter(Boolean);
  const result: ImportResult = {
    name,
    status: response.status(),
    route: page.url(),
    configurationCodes: configurations.map(configuration => string(configuration.code)).filter(Boolean),
    storageDefinitions: rows(networking.storageNetworks),
    storageConnectionNetworks: rows(networking.storageConnectionNetworks),
    controllerProducts: products.filter(product => string(product.id) !== '' &&
      (string(product.code) === controllerCode || products.some(candidate =>
        candidate.id === product.id && string(candidate.code) === controllerCode))).map(normalizeProduct),
    summaryCodes,
    summaryHasController: summaryCodes.includes(controllerCode),
  };
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

async function main(): Promise<void> {
  await Promise.all([readFile(browserXml), readFile(mcpXml)]);
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  let website: ImportResult;
  let mcp: ImportResult;
  try {
    const websiteContext = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
    try {
      website = await importXml(await websiteContext.newPage(), 'website-own', browserXml);
    } finally {
      await websiteContext.close();
    }
    const mcpContext = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
    try {
      mcp = await importXml(await mcpContext.newPage(), 'mcp', mcpXml);
    } finally {
      await mcpContext.close();
    }
  } finally {
    await browser.close();
  }

  for (const result of [website!, mcp!]) {
    assert.equal(result.status, 200, `${result.name} import failed.`);
    assert.match(result.route, /#\/rack-summary\//, `${result.name} did not reach rack summary.`);
    assert.equal(result.storageDefinitions.length, 1, `${result.name} lost its storage definition.`);
    assert.equal(string(object(result.storageDefinitions[0]?.controller).option), controllerCode,
      `${result.name} storage definition lost controller ${controllerCode}.`);
    assert(!result.configurationCodes.includes(controllerCode),
      `${result.name} unexpectedly hydrated the managed controller; update the importer contract.`);
    assert.equal(result.summaryHasController, false, `${result.name} rendered a managed controller Summary card.`);
    assert.equal(result.storageConnectionNetworks.length, 0,
      `${result.name} unexpectedly restored assignment state; update the importer contract.`);
    assert(result.controllerProducts.some(product => product.code === controllerCode && product.type === 'hardware' &&
      product.quantity === 0), `${result.name} lost the zero-quantity controller commercial row.`);
  }
  assert.deepEqual([...website!.configurationCodes].sort(), [...mcp!.configurationCodes].sort(),
    'MCP and website exports hydrate different physical configurations.');
  assert.deepEqual(website!.controllerProducts, mcp!.controllerProducts,
    'MCP managed-controller commercial rows differ from the website export.');
  assert.deepEqual(normalizeDefinition(website!.storageDefinitions[0]!), normalizeDefinition(mcp!.storageDefinitions[0]!),
    'MCP storage definition differs from the website export apart from its user-selected name.');

  const report = {
    status: 'pass',
    scope: 'fresh-browser-managed-storage-export-differential',
    inputs: { website: browserXml, mcp: mcpXml },
    controllerCode,
    website,
    mcp,
    websiteOwnImportLimitation: {
      controllerEditableConfigurationPreserved: false,
      assignmentGraphParity: 'not-tested',
      storageDefinitionPreserved: true,
      commercialRowsPreserved: true,
      note: 'The same editable-controller loss occurs when importing the website own export. Both inputs are unassigned with an empty graph, so assignment graph preservation is not tested. This runner does not claim lossless controller round-trip parity.',
    },
  };
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS storage reimport differential; report: ${path.join(out, 'report.json')}`);
}

await main();
