/**
 * Fresh-browser import comparison for physical-storage placement exports.
 *
 * Maintained MCP gate:
 *   npx tsx scripts/parity-storage-placement-reimport.ts \
 *     --mcp-report artifacts/.../storage-placement-mcp-live-run/report.json \
 *     --out artifacts/.../storage-placement-reimport
 *
 * The legacy three-way browser/MCP comparison remains available with
 * --website-first-xml, --website-second-xml, and --mcp-xml.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page, type Response } from 'playwright';
import { selectBrowserSolutionMode } from './parity/browser.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Obj : {};
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];
const string = (value: unknown): string => typeof value === 'string' ? value : '';

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ? path.resolve(value) : undefined;
}

const mcpReport = optionalArgument('mcp-report');
const websiteFirstXml = optionalArgument('website-first-xml');
const websiteSecondXml = optionalArgument('website-second-xml');
const mcpXml = optionalArgument('mcp-xml');
const requestedOut = optionalArgument('out');
assert(requestedOut, 'Missing --out.');
const out = requestedOut;
assert(mcpReport || (websiteFirstXml && websiteSecondXml && mcpXml),
  'Supply --mcp-report, or all of --website-first-xml, --website-second-xml, and --mcp-xml.');
assert(!(mcpReport && (websiteFirstXml || websiteSecondXml || mcpXml)),
  '--mcp-report cannot be combined with explicit XML inputs.');
const mode = 'AI & HPC – ThinkSystem Hardware';
const managedCodes = new Set(['7DP4CTO1WW', '7DHNCTO1WW']);

async function chooseMode(page: Page, diagnosticsDir: string): Promise<void> {
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await selectBrowserSolutionMode(page, mode, { diagnosticsDir });
}

function normalizedProduct(product: Obj): Obj {
  return Object.fromEntries(['code', 'type', 'quantity', 'price', 'unitPrice', 'targetCtoUnitPrice']
    .map(key => [key, product[key]]));
}

async function importXml(page: Page, name: string, xml: string): Promise<Obj> {
  const dir = path.join(out, name);
  await mkdir(dir, { recursive: true });
  await chooseMode(page, dir);
  const responsePromise = page.waitForResponse((response: Response) =>
    response.url().includes('/multiple/cfxml_import') && response.request().method() === 'POST',
  { timeout: 120_000 });
  await page.locator('input[type=file]').first().setInputFiles(xml);
  const response = await responsePromise;
  const body = await response.text();
  await writeFile(path.join(dir, 'import-response.txt'), body);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
    await writeFile(path.join(dir, 'import-response.json'), JSON.stringify(payload, null, 2));
  } catch {
    const failure = { name, input: xml, status: response.status(), route: page.url(), responseBody: body };
    await writeFile(path.join(dir, 'result.json'), JSON.stringify(failure, null, 2));
    await page.screenshot({ path: path.join(dir, 'summary.png'), fullPage: true });
    return failure;
  }
  await page.waitForURL(url => /#\/(rack-summary|summary)\//.test(url.href), { timeout: 120_000 }).catch(() => undefined);
  await page.waitForTimeout(8_000);
  const root = object(Array.isArray(payload) ? payload[0] : payload);
  const networking = object(root.networkingInformation);
  const workspace = object(root.workspace);
  const rackChildren = rows(workspace.rackArea).flatMap(rack => rows(rack.children));
  const physicalItems = [...rackChildren, ...rows(workspace.nonRackArea)];
  const products = rows(root.groups).flatMap(group => rows(group.products));
  const colors = object(root.cloneDependencyColor);
  const summaryCodes = (await page.locator('.productCode-col').allTextContents())
    .map(value => value.trim().split(/\s/)[0] ?? '').filter(Boolean);
  const goToWorkspace = page.getByRole('button', { name: /Go to Workspace/i }).first();
  const result: Obj = {
    name,
    input: xml,
    status: response.status(),
    route: page.url(),
    configurations: rows(root.configuration).map(configuration => ({
      id: configuration.id,
      code: configuration.code,
    })),
    configurationCodes: rows(root.configuration).map(configuration => string(configuration.code)).filter(Boolean),
    definitions: rows(networking.storageNetworks).map(definition => ({
      name: definition.name,
      type: definition.type,
      layout: definition.layout,
      maximumExpansions: definition.maximumExpansions,
      controller: object(definition.controller),
      mainSwitch: object(definition.mainSwitch),
    })),
    managedHierarchy: physicalItems.filter(item => managedCodes.has(string(item.code)) ||
      item.type === 'storage' || (item.type === 'switch' && Number(item.quantity) > 1)).map(item => ({
      id: item.id, configurationId: item.configurationId, type: item.type, quantity: item.quantity,
      size: item.size, originalIds: item.originalIds,
    })),
    managedProducts: products.filter(product => managedCodes.has(string(product.code)))
      .map(normalizedProduct),
    colorDependencies: Object.fromEntries(Object.entries(colors).filter(([, value]) => {
      const dependBy = object(value).dependBy;
      return Array.isArray(dependBy) && dependBy.length > 1;
    }).map(([id, value]) => [id, object(value).dependBy])),
    summaryCodes,
    goToWorkspaceVisible: await goToWorkspace.isVisible().catch(() => false),
    goToWorkspaceEnabled: await goToWorkspace.isEnabled().catch(() => false),
  };
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  await page.screenshot({ path: path.join(dir, 'summary.png'), fullPage: true });
  return result;
}

interface ExpectedCase {
  physicalIds: string[];
  hardware: Obj[];
}

async function inputs(): Promise<{
  cases: Array<readonly [string, string]>;
  source: Obj;
  expected?: [ExpectedCase, ExpectedCase];
}> {
  if (!mcpReport) {
    assert(websiteFirstXml && websiteSecondXml && mcpXml);
    return {
      cases: [
        ['website-first', websiteFirstXml],
        ['website-second', websiteSecondXml],
        ['mcp-second', mcpXml],
      ],
      source: { websiteFirstXml, websiteSecondXml, mcpXml },
    };
  }
  const report = object(JSON.parse(await readFile(mcpReport, 'utf8')));
  assert.equal(report.status, 'pass', 'The storage placement producer report must pass.');
  assert(object(report.first).placements && object(report.second).placements,
    'The report is not a maintained storage placement producer.');
  const firstXml = string(object(report.export).xml);
  const detachedXml = string(object(object(report.sanReplacement).export).xml);
  assert(firstXml && path.isAbsolute(firstXml), 'Producer report export.xml must be an absolute XML path.');
  assert(detachedXml && path.isAbsolute(detachedXml),
    'Producer report sanReplacement.export.xml must be an absolute XML path.');
  const placementIds = [...rows(object(report.first).placements), ...rows(object(report.second).placements)]
    .map(item => string(item.physicalId)).filter(Boolean).sort();
  assert.equal(new Set(placementIds).size, 4,
    'Producer report must identify four distinct controller/SAN physical aliases.');
  const firstHardware = rows(report.commercial)
    .filter(item => item.type === 'hardware' && managedCodes.has(string(item.code)));
  const detachedHardware = [
    ...rows(object(report.groupUnplace).commercial)
      .filter(item => item.type === 'hardware' && item.code === '7DP4CTO1WW'),
    ...rows(object(report.sanReplacement).commercial)
      .filter(item => item.type === 'hardware' && item.code === '7DHNCTO1WW'),
  ];
  assert.equal(firstHardware.length, 2, 'Producer first export must describe both managed hardware rows.');
  assert.equal(detachedHardware.length, 2, 'Producer detached export must describe both managed hardware rows.');
  return {
    cases: [['mcp-first', firstXml], ['mcp-detached', detachedXml]],
    source: { mcpReport, firstXml, detachedXml },
    expected: [
      { physicalIds: placementIds, hardware: firstHardware },
      { physicalIds: placementIds, hardware: detachedHardware },
    ],
  };
}

function assertMcpPlacementSemantics(results: Obj[], expected: [ExpectedCase, ExpectedCase]): void {
  assert.equal(results.length, 2);
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 200, `${string(result.name)} import did not return HTTP 200.`);
    assert.match(string(result.route), /#\/rack-summary\/rack-cto$/,
      `${string(result.name)} did not hydrate the rack summary.`);
    assert.equal(result.goToWorkspaceVisible, true,
      `${string(result.name)} must expose the workspace action.`);
    assert.equal(result.goToWorkspaceEnabled, true,
      `${string(result.name)} must leave the imported workspace usable.`);
    const codes = Array.isArray(result.configurationCodes)
      ? result.configurationCodes.map(String)
      : [];
    assert.equal(codes.filter(code => code === '7DP4CTO1WW').length, 2,
      `${string(result.name)} must hydrate two controller physical configurations.`);
    assert.equal(codes.filter(code => code === '7DHNCTO1WW').length, 2,
      `${string(result.name)} must hydrate two SAN-switch physical configurations.`);
    const identities = rows(result.configurations)
      .filter(item => managedCodes.has(string(item.code)))
      .map(item => string(item.id)).sort();
    assert.deepEqual(identities, expected[index]!.physicalIds,
      `${string(result.name)} changed the producer's physical controller/SAN identities.`);
    const products = rows(result.managedProducts);
    for (const code of managedCodes) {
      const product = products.find(item => item.code === code && item.type === 'hardware');
      assert(product, `${string(result.name)} omitted ${code} hardware from commercial groups.`);
      assert.equal(product.quantity, 2, `${string(result.name)} ${code} quantity must equal physical count 2.`);
      assert.notEqual(product.quantity, 3, `${string(result.name)} must not count the managed template as hardware.`);
      const producer = expected[index]!.hardware.find(item => item.code === code && item.type === 'hardware');
      assert(producer, `Producer report omitted expected ${code} hardware.`);
      assert.deepEqual({ quantity: product.quantity, price: product.price, unitPrice: product.unitPrice },
        { quantity: producer.quantity, price: producer.price, unitPrice: producer.unitPrice },
        `${string(result.name)} ${code} commercial values differ from the producer export.`);
    }
    const dependencies = Object.values(object(result.colorDependencies));
    assert.equal(dependencies.length, 2,
      `${string(result.name)} must preserve controller and SAN physical dependency groups.`);
    assert(dependencies.every(value => Array.isArray(value) && value.length === 2),
      `${string(result.name)} dependency groups must each contain the two physical aliases.`);
  }
  const firstDefinition = rows(results[0]!.definitions)
    .find(item => item.name === 'Physical Placement Gate');
  const detachedDefinition = rows(results[1]!.definitions)
    .find(item => item.name === 'Physical Placement Gate');
  assert.equal(object(firstDefinition?.mainSwitch).option, '7DHNCTO1WW',
    'First-placement import must retain the active DB710S definition.');
  assert.equal(object(detachedDefinition?.mainSwitch).option, '',
    'Detached import must retain the physical DB710S aliases without leaving it active in the definition.');
}

async function main(): Promise<void> {
  const resolved = await inputs();
  await Promise.all([...resolved.cases.map(([, xml]) => readFile(xml)), mkdir(out, { recursive: true })]);
  const browser = await chromium.launch({ headless: true });
  const results: Obj[] = [];
  try {
    for (const [name, xml] of resolved.cases) {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
      try {
        results.push(await importXml(await context.newPage(), name, xml));
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (mcpReport) {
    assert(resolved.expected);
    assertMcpPlacementSemantics(results, resolved.expected);
  } else assert.equal(results.length, 3);
  const report = {
    status: mcpReport ? 'pass' : (results.every(result => result.status === 200)
      ? 'observed-with-all-imports-http-200'
      : 'observed-with-import-failures'),
    scope: 'fresh-browser-physical-storage-placement-import-comparison',
    inputs: resolved.source,
    results,
    caveat: mcpReport
      ? undefined
      : 'Website second-placement source export contains stale position/size for its second aliases; this is an external website export-state defect, not an MCP oracle for those fields.',
  };
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`${mcpReport ? 'PASS' : 'OBSERVED'} storage placement reimports; report: ${path.join(out, 'report.json')}`);
}

await main();
