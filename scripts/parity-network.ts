/**
 * Maintained live parity gate for AI/HPC automatic switch provisioning.
 *
 * Builds the same design as the browser r25 oracle through DcscService, checks
 * the captured port graph and current native prices, exports it, and imports that export
 * through a fresh headless browser session.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium, type Page } from 'playwright';

import { ConfigSchema } from '../src/config/schema.js';
import { listTopologyConnectors } from '../src/domain/networkPreferences.js';
import { readConnectionGraph, readSwitchMap } from '../src/domain/cabling.js';
import { writeExportBundle } from '../src/files/artifactStore.js';
import { DcscService } from '../src/mcp/service.js';

type JsonObject = Record<string, unknown>;

const ROOT = process.cwd();
const ORACLE_PATH = path.join(ROOT, 'test/fixtures/parity/browser-auto-switch-cabling.json');
const SERVER_CODE = '7D73CTOHWW';
const RACK_CODE = '7D6DCTO1WW';
const SWITCH_CODE = '7D5FCTOFWW';
const SOLUTION_MODE = 'HPC and AI - Systems';

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function finite(value: unknown): number {
  assert.equal(typeof value, 'number', `Expected a numeric price; got ${String(value)}.`);
  assert(Number.isFinite(value), `Expected a finite price; got ${String(value)}.`);
  return value as number;
}

function configurationCode(configuration: JsonObject): string {
  return text(configuration['sliceCtoCode'] ?? configuration['code']).toUpperCase();
}

async function closeCookie(page: Page): Promise<void> {
  const close = page.locator('.dcsc-cookie-close').first();
  if (await close.isVisible({ timeout: 2_000 }).catch(() => false)) await close.click();
}

async function importXml(page: Page, xmlPath: string): Promise<JsonObject> {
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await closeCookie(page);
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: 'attached', timeout: 30_000 });
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes('/multiple/cfxml_import') && response.request().method() === 'POST',
  { timeout: 120_000 });
  await input.setInputFiles(xmlPath);
  const response = await responsePromise;
  assert.equal(response.status(), 200, 'Fresh-browser CFXML import status');
  const body = await response.json() as unknown;
  await page.waitForURL(/#\/(?:rack-summary|summary)\//, { timeout: 120_000 });
  return object(Array.isArray(body) ? body[0] : body);
}

function importedConfigurations(payload: JsonObject): JsonObject[] {
  const values = array(payload['configuration']).length > 0
    ? array(payload['configuration'])
    : array(payload['configurations']);
  return values.map(object);
}

function importedConnections(payload: JsonObject): JsonObject[] {
  const networking = object(payload['networkingInformation']);
  for (const value of [payload['autoConnectResults'], networking['autoConnectResults'],
    networking['connections'], object(payload['workspace'])['connections']]) {
    if (Array.isArray(value)) return value.map(object);
  }
  return [];
}

function importedRackItems(payload: JsonObject): JsonObject[] {
  const workspace = object(payload['workspace']);
  return array(workspace['rackArea']).flatMap((rackValue) => {
    const rack = object(rackValue);
    return array(rack['rackItems'] ?? rack['items'] ?? rack['children']).map(object);
  });
}

function priceMap(configurations: JsonObject[]): Record<string, number[]> {
  const prices = new Map<string, number[]>();
  for (const configuration of configurations) {
    const code = configurationCode(configuration);
    const current = prices.get(code) ?? [];
    current.push(finite(configuration['totalPrice']));
    prices.set(code, current);
  }
  return Object.fromEntries([...prices].map(([code, values]) => [code, values.sort((a, b) => a - b)]));
}

function selectedLines(configuration: JsonObject): JsonObject[] {
  return array(configuration['unSelectableCharacters']).flatMap((sectionValue) => {
    const section = object(sectionValue);
    return array(section['results']).map((resultValue) => {
      const result = object(resultValue);
      return {
        section: text(section['name']),
        code: text(result['code']),
        quantity: result['quantity'],
        derived: result['derived'],
        unitPrice: result['unitPrice'],
        totalPrice: result['totalPrice'],
        price: result['price'],
      };
    });
  });
}

async function main(): Promise<void> {
  const outArg = process.argv.find((value) => value.startsWith('--out='));
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const outDir = path.resolve(outArg?.slice('--out='.length) ?? `artifacts/parity-network/${stamp}`);
  await mkdir(outDir, { recursive: true });
  const oracle = object(JSON.parse(await readFile(ORACLE_PATH, 'utf8')) as unknown);
  const oracleConnection = object(oracle['connection']);
  assert.deepEqual(oracle['orchestration'], [
    { endpoint: '/api/switch_calculation', status: 200 },
    { endpoint: '/api/ctos/7D5FCTOFWW/launch', status: 200 },
    { endpoint: '/api/ctos/racks/customize', status: 200 },
    { endpoint: '/api/ctos/autoDerive', status: 200 },
    { endpoint: '/api/auto_connect', status: 200, connections: 1 },
  ]);
  assert.equal(oracleConnection['cablePart'], 'AVFT');
  assert.equal(oracleConnection['cableOption'], '00WE111');

  const config = ConfigSchema.parse({
    files: { persistSessions: false, artifactDir: path.join(outDir, 'artifacts') },
    logLevel: 'error',
    pacing: { perToolRequestBudget: 80 },
  });
  const service = new DcscService(config);
  let stage = 'resolve-solution';
  try {
    const ctx = service.newCtx();
    const solution = await service.resolveSolution(ctx, SOLUTION_MODE);

    stage = 'launch-server';
    const server = await service.launch({ productCode: SERVER_CODE, mode: 'cto', solution, ctx });
    let workspace = service.sessions.getWorkspace(server.workspaceId)!;

    stage = 'select-server-management-topology';
    const fabric = await service.fabricOptions(ctx, solution);
    const management = fabric.networkTypes.find((value) => value.name === 'Management');
    const mainDevice = fabric.networkDevices.find((value) =>
      value.option === SWITCH_CODE && value.feature === 'BPC7' && value.topologies.includes('1GbE_Copper'));
    const cat5e = fabric.cables.find((value) =>
      text(value.category).toUpperCase() === 'CAT5E' && value.topologies.includes('1GbE_Copper') &&
      value.compatibility.includes(SWITCH_CODE));
    assert(management, 'Current AI/HPC fabric has no Management network type.');
    assert(mainDevice, 'Current AI/HPC fabric has no compatible SN2201/BPC7 Management switch.');
    assert(cat5e, 'Current AI/HPC fabric has no SN2201-compatible Cat5E cable choice.');
    const connectors = listTopologyConnectors(server.raw, fabric, '1GbE_Copper');
    const managementPort = connectors.find((value) => {
      const raw = object(value.raw);
      return text(raw['portNumber']) === '1' && /RJ45 mgmt/i.test(text(raw['port'] ?? raw['portDescription']));
    });
    assert(managementPort, 'The SR630 V3 has no captured-compatible RJ45 management connector.');
    await service.applyTopology({ sessionHandle: server.id, topology: '1GbE_Copper',
      networkName: 'Management', connectorIds: [managementPort.id], autoConnect: false,
      expectedRevision: server.revision, ctx });

    stage = 'add-rack';
    workspace = service.sessions.getWorkspace(server.workspaceId)!;
    await service.addRack(workspace.id, RACK_CODE, ctx, workspace.revision);
    workspace = service.sessions.getWorkspace(server.workspaceId)!;
    const rack = workspace.rackArea[0];
    assert(rack, 'DCSC returned no rack after addRack.');

    stage = 'launch-manual-switch';
    const manualSwitch = await service.launch({ productCode: SWITCH_CODE, mode: 'cto', solution, ctx,
      workspaceId: workspace.id, expectedRevision: workspace.revision, label: 'Manual SN2201' });

    stage = 'place-server';
    workspace = service.sessions.getWorkspace(server.workspaceId)!;
    await service.placeInRack(workspace.id, { rackId: text(rack['id']), sessionId: server.id,
      position: 1, expectedRevision: workspace.revision, ctx });
    stage = 'place-manual-switch';
    workspace = service.sessions.getWorkspace(server.workspaceId)!;
    await service.placeInRack(workspace.id, { rackId: text(rack['id']), sessionId: manualSwitch.id,
      position: 5, expectedRevision: workspace.revision, ctx });

    stage = 'set-management-preference';
    workspace = service.sessions.getWorkspace(server.workspaceId)!;
    await service.setNetworkPreferences(workspace.id, { selections: [{
      networkTypeId: management.id,
      topology: '1GbE_Copper',
      mainDeviceId: mainDevice.id,
      cableId: cat5e.id,
      cableColor: '',
    }], autoConnect: false, expectedRevision: workspace.revision, ctx });

    stage = 'automatic-switch-orchestration';
    workspace = service.sessions.getWorkspace(server.workspaceId)!;
    const connected = await service.runAutoConnect(workspace.id, ctx, workspace.revision,
      { autoAddPDU: false, autoAddSwitch: true, p2pCabling: true });
    workspace = service.sessions.getWorkspace(server.workspaceId)!;

    assert.equal(workspace.configurations.size, 4, 'Expected server, rack, manual switch, and generated switch.');
    const switches = [...workspace.configurations.values()].filter((value) => value.product.code === SWITCH_CODE);
    assert.equal(switches.length, 2, 'Automatic orchestration must preserve the manual switch and add a separate switch.');
    const switchMap = readSwitchMap(workspace.serverState);
    assert.equal(switchMap.length, 1, 'Expected exactly one generated Management switch mapping.');
    const generatedId = text(object(switchMap[0])['id']);
    assert(generatedId && generatedId !== manualSwitch.configurationId,
      'Generated switch identity must differ from the manually added SN2201.');
    const generated = switches.find((value) => value.configurationId === generatedId);
    assert(generated, 'Generated switch configuration is missing.');

    const rawConnections = readConnectionGraph(workspace.serverState).map(object);
    assert.equal(connected.connections.length, 1, 'Projected auto-connect graph must contain one link.');
    assert.equal(rawConnections.length, 1, 'Raw auto-connect graph must contain one link.');
    const connection = rawConnections[0]!;
    assert.equal(connection['network'], oracleConnection['network']);
    assert.equal(connection['topology'], oracleConnection['topology']);
    assert.equal(connection['sourceId'], server.configurationId);
    assert.equal(connection['destinationId'], generatedId);
    for (const key of ['sourcePart', 'sourcePortNumber', 'sourcePortName', 'destinationPart',
      'destinationPortNumber', 'destinationPortName', 'cablePart', 'cableOption', 'cableType',
      'cablePrice', 'type', 'subType', 'category'] as const) {
      assert.equal(connection[key], oracleConnection[key], `Auto-connect ${key} differs from browser r25.`);
    }
    assert.equal(workspace.cables.length, 1);
    assert.equal(workspace.cables[0]?.cableCode, oracleConnection['cablePart']);

    const historicalPrices = object(object(oracle['prices'])['finalAfterPlacementAndAutoConnect']) as Record<string, number[]>;
    const livePrices = priceMap([...workspace.configurations.values()].map((value) => object(value.raw)));
    await writeFile(path.join(outDir, 'mcp-post-connect-summary.json'), JSON.stringify({
      prices: livePrices, historicalPrices,
      configurations: [...workspace.configurations.values()].map((value) => ({
        id: value.configurationId,
        code: value.product.code,
        totalPrice: value.raw.totalPrice,
        lines: selectedLines(object(value.raw)),
      })),
      connection,
      projectedConnections: connected.connections,
    }, null, 2));
    // Catalog prices change independently of the captured structural oracle.
    // Compare current prices against the fresh native browser import below.

    stage = 'export';
    const exported = await service.exportZip(workspace.id, { ctx, fileName: 'mcp-network-parity',
      fileTypes: ['XML', 'QUOTE', 'FLOOR', 'RACK_REPORT', 'RACK_DIAGRAM', 'QUOTE_GROUP', 'SUMMARY'] });
    const bundle = await writeExportBundle(exported.stream, 'mcp-network-parity', config);
    assert(bundle.xml, 'DCSC export ZIP contains no XML member.');

    stage = 'fresh-browser-import';
    const browser = await chromium.launch({ headless: true });
    let browserImport: JsonObject;
    try {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      const page = await context.newPage();
      browserImport = await importXml(page, bundle.xml);
      await writeFile(path.join(outDir, 'browser-import-response.json'), JSON.stringify([browserImport]));
      await context.close();
    } finally {
      await browser.close();
    }
    const restoredConfigurations = importedConfigurations(browserImport);
    const restoredPrices = priceMap(restoredConfigurations);
    assert.deepEqual(restoredPrices, livePrices, 'Fresh browser import changed current configuration prices.');
    for (const restored of restoredConfigurations) {
      const current = [...workspace.configurations.values()].find(value => value.configurationId === restored['id']);
      assert(current, 'Fresh browser import introduced an unknown configuration.');
      assert.equal(finite(restored['totalPrice']), finite(current.raw.totalPrice), 'Fresh browser import changed an individual configuration price.');
      const selections = (configuration: JsonObject) => selectedLines(configuration)
        .map(line => ({ section: line['section'], code: line['code'], quantity: line['quantity'] }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      assert.deepEqual(selections(restored), selections(object(current.raw)), 'Fresh browser import changed selected parts or quantities.');
    }
    assert.equal(new Set(restoredConfigurations.map((value) => text(value['id']))).size, 4,
      'Fresh browser import changed configuration identities.');
    assert.deepEqual(new Set(restoredConfigurations.map((value) => text(value['id']))),
      new Set([...workspace.configurations.values()].map((value) => value.configurationId)),
      'Fresh browser import did not preserve exact configuration IDs.');
    const restoredItems = importedRackItems(browserImport);
    assert.equal(restoredItems.some((value) => text(value['id']) === generatedId), true,
      'Fresh browser import omitted generated switch placement.');
    const restoredConnections = importedConnections(browserImport);
    assert.equal(restoredConnections.length, 1, 'Fresh browser import omitted the port graph.');
    assert.equal(restoredConnections[0]?.['cablePart'], oracleConnection['cablePart']);
    assert.equal(restoredConnections[0]?.['sourceId'], server.configurationId);
    assert.equal(restoredConnections[0]?.['destinationId'], generatedId);

    const result = {
      capturedAt: new Date().toISOString(),
      status: 'pass',
      browserOracle: path.relative(ROOT, ORACLE_PATH),
      solutionMode: solution.solutionMode,
      workspace: workspace.id,
      revision: workspace.revision,
      configurations: [...workspace.configurations.values()].map((value) => ({
        id: value.configurationId, code: value.product.code, type: value.product.type,
        totalPrice: value.raw.totalPrice,
      })),
      manualSwitchId: manualSwitch.configurationId,
      generatedSwitchId: generatedId,
      switchMap,
      connection,
      cables: workspace.cables,
      export: { zipPath: path.relative(ROOT, bundle.zipPath), xmlPath: path.relative(ROOT, bundle.xml),
        bytes: bundle.bytes, sha256: bundle.sha256 },
      browserImport: {
        configurationIds: restoredConfigurations.map((value) => text(value['id'])),
        prices: restoredPrices,
        rackItems: restoredItems.map((value) => ({ id: value['id'], code: value['code'],
          position: value['position'] })),
        connections: restoredConnections,
      },
    };
    await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await writeFile(path.join(outDir, 'failure.json'), JSON.stringify({
      capturedAt: new Date().toISOString(), status: 'fail', stage,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    throw new Error(`Network parity failed at ${stage}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error });
  } finally {
    await service.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
