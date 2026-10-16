/**
 * Maintained browser parity gate for a two-rack General Purpose workspace.
 *
 * The runner drives only controls exposed by the current DCSC SPA. After the
 * SPA has emitted an export request, it repeats that exact form request through
 * the browser context so the ZIP body can be inspected in headless Chromium.
 *
 * Usage:
 *   npx tsx scripts/parity-rack-lifecycle.ts
 *   npx tsx scripts/parity-rack-lifecycle.ts --out=artifacts/parity-rack/my-run
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Response } from 'playwright';
import yauzl from 'yauzl';
import { ConfigSchema } from '../src/config/schema.js';
import { writeExportBundle } from '../src/files/artifactStore.js';
import { DcscService } from '../src/mcp/service.js';
import {
  inspectExportWorkbook,
  workbookEvidence,
  type WorkbookInspection,
  type WorkbookSheet,
} from './lib/xlsx-inspection.js';

type JsonObject = Record<string, unknown>;

interface WireCall {
  phase: string;
  endpoint: string;
  status: number;
  autoArrange?: boolean;
  request: LayoutSummary;
  response: LayoutSummary;
}

interface LayoutSummary {
  rackCount?: number;
  nonRackCount?: number;
  racks?: Array<{ code: string; items: Array<{ code: string; position: number; size: number }> }>;
  configurationCount?: number;
}

interface Placement {
  rack: string | null;
  position: number | null;
}

const ROOT = process.cwd();
const SOURCE_XML = path.join(ROOT, 'test/fixtures/parity/xml/one-rack-sr630-v3.xml');
const CONTRACT = path.join(ROOT, 'test/fixtures/parity/browser-two-rack-lifecycle.json');
const RACK_CODE = '7D6DCTO1WW';
const SERVER_CODE = '7D73CTO1WW';
const WORKBOOK_SHEETS = ['Quote', 'Floor Report', 'Rack Report', 'Rack Diagram', 'Power Report',
  'ConfigGroupView', 'Summary', 'Message History'];

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function number(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function parseBody(value: string | null): unknown {
  if (!value) return {};
  try { return JSON.parse(value) as unknown; } catch { return {}; }
}

function layoutSummary(value: unknown): LayoutSummary {
  const root = object(value);
  const workspace = object(root['workspaceInformation']);
  const rackArea = array(root['rackArea']).length > 0
    ? array(root['rackArea'])
    : array(workspace['rackData']);
  const nonRackArea = Object.hasOwn(root, 'nonRackArea')
    ? array(root['nonRackArea'])
    : array(workspace['nonRackData']);
  const configurations = array(root['configurations']).length > 0
    ? array(root['configurations'])
    : array(workspace['configurations']);
  return {
    ...(rackArea.length > 0 ? {
      rackCount: rackArea.length,
      racks: rackArea.map((entry) => {
        const rack = object(entry);
        return {
          code: text(rack['code']),
          items: array(rack['rackItems']).map((itemRaw) => {
            const item = object(itemRaw);
            return {
              code: text(item['code']),
              position: number(item['position']),
              size: number(item['size']),
            };
          }),
        };
      }),
    } : {}),
    ...(Object.hasOwn(root, 'nonRackArea') || Object.hasOwn(workspace, 'nonRackData')
      ? { nonRackCount: nonRackArea.length }
      : {}),
    ...(configurations.length > 0 ? { configurationCount: configurations.length } : {}),
  };
}

function endpoint(url: string): string {
  return new URL(url).pathname;
}

async function closeCookie(page: Page): Promise<void> {
  const close = page.locator('.dcsc-cookie-close').first();
  if (await close.isVisible({ timeout: 2_000 }).catch(() => false)) await close.click();
}

async function importXml(page: Page, xmlPath: string): Promise<JsonObject> {
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await closeCookie(page);
  const file = page.locator('input[type="file"]').first();
  await file.waitFor({ state: 'attached', timeout: 30_000 });
  const imported = page.waitForResponse((response) =>
    response.url().includes('/multiple/cfxml_import') && response.request().method() === 'POST',
  { timeout: 120_000 });
  await file.setInputFiles(xmlPath);
  const response = await imported;
  assert.equal(response.status(), 200, 'CFXML import status');
  const body = await response.json() as unknown;
  await page.waitForURL(/#\/(?:rack-summary|summary)\//, { timeout: 120_000 });
  return object(Array.isArray(body) ? body[0] : body);
}

async function enterWorkspace(page: Page): Promise<void> {
  await page.getByText('Go to Workspace', { exact: true }).first().click();
  await page.waitForURL(/#\/rack-configuration/, { timeout: 60_000 });
  await page.waitForTimeout(7_000);
}

async function addRack(page: Page): Promise<void> {
  await page.getByText('Rack', { exact: true }).first().click();
  await page.waitForTimeout(1_000);
  const product = page.getByText(new RegExp(RACK_CODE)).first();
  const derived = page.waitForResponse((response) =>
    response.url().includes('/api/ctos/autoDerive') && response.request().method() === 'POST',
  { timeout: 120_000 });
  await product.dblclick();
  await derived;
  await page.waitForTimeout(5_000);
}

async function placement(page: Page): Promise<Placement> {
  const racks = page.locator('.rack');
  for (let index = 0; index < await racks.count(); index += 1) {
    const rack = racks.nth(index);
    const server = rack.locator('.rack-server');
    if (await server.count() === 0) continue;
    const label = (await rack.locator('.rack__description').innerText()).trim();
    const style = await server.first().getAttribute('style') ?? '';
    const bottom = Number(/bottom:\s*([0-9.]+)px/.exec(style)?.[1] ?? 0);
    return { rack: label, position: Math.round(bottom / 15) + 1 };
  }
  return { rack: null, position: null };
}

async function openNonRackMenu(page: Page): Promise<void> {
  await closeCookie(page);
  const group = page.locator('.ant-collapse-item').filter({ hasText: new RegExp(SERVER_CODE) }).last();
  const moveTo = page.locator('.ant-menu-submenu-title:visible').filter({ hasText: /^Move To$/ });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const expanded = await group.locator('.ant-collapse-header').first().getAttribute('aria-expanded');
    if (expanded !== 'true') await group.locator('.ant-collapse-header').first().click({ force: true });
    if (await moveTo.count() === 0) {
      await group.locator('.anticon-setting').click({ force: true });
      await page.waitForTimeout(350);
    }
    if (await moveTo.count() > 0) {
      await moveTo.last().click({ force: true });
      return;
    }
    await page.keyboard.press('Escape');
  }
  throw new Error('The native non-rack Move To menu did not become visible after three attempts.');
}

async function moveNonRack(page: Page, rack: 'A1' | 'A2'): Promise<void> {
  await openNonRackMenu(page);
  const derived = page.waitForResponse((response) =>
    response.url().includes('/api/ctos/autoDerive') && response.request().method() === 'POST',
  { timeout: 120_000 });
  await page.getByText(`${rack} - Rack`, { exact: true }).last().click();
  await derived;
  await page.waitForTimeout(5_000);
}

async function openPlacedMenu(page: Page): Promise<void> {
  await closeCookie(page);
  const moveTo = page.locator('.ant-menu-submenu-title:visible').filter({ hasText: /^Move To$/ });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await moveTo.count() === 0) {
      await page.locator('.rack-server').first().click({ force: true });
      await page.waitForTimeout(350);
    }
    if (await moveTo.count() > 0) {
      await moveTo.last().click({ force: true });
      return;
    }
    await page.keyboard.press('Escape');
  }
  throw new Error('The native placed-item Move To menu did not become visible after three attempts.');
}

async function movePlaced(page: Page, destination: 'A1' | 'A2' | 'Non Rack Items'): Promise<void> {
  await openPlacedMenu(page);
  const derive = page.waitForResponse((response) =>
    response.url().includes('/api/ctos/autoDerive') && response.request().method() === 'POST',
  { timeout: 120_000 });
  await page.getByText(destination === 'Non Rack Items' ? destination : `${destination} - Rack`, {
    exact: true,
  }).last().click();
  await derive;
  await page.waitForTimeout(5_000);
}

async function setAutoArrange(page: Page, enabled: boolean): Promise<void> {
  const toggle = page.locator('.auto-arrange .ant-switch');
  const currentlyEnabled = (await toggle.innerText()).trim() === 'On';
  if (currentlyEnabled !== enabled) {
    const response = page.waitForResponse((item) =>
      item.url().includes('/api/ctos/racks/customize') &&
      item.url().includes(`autoArrange=${String(enabled)}`),
    { timeout: 120_000 });
    await toggle.click();
    await response;
    await page.waitForTimeout(5_000);
  }
}

function installCapture(page: Page, phase: () => string, calls: WireCall[]): void {
  page.on('response', async (response: Response) => {
    if (response.request().method() !== 'POST') return;
    if (!/\/api\/ctos\/(?:racks\/customize|autoDerive|[^/]+\/launch|racks\/[^/]+\/launch)/.test(response.url())) return;
    let responseBody: unknown = {};
    // Launch and derive payloads contain complete catalogs/configurations and
    // can exceed hundreds of MB. Their status and request shape are enough for
    // this physical gate; only customize responses carry the accepted layout.
    if (response.url().includes('/api/ctos/racks/customize')) {
      try {
        responseBody = await response.json() as unknown;
      } catch {
        responseBody = {};
      }
    }
    const requestBody = parseBody(response.request().postData());
    const parsed = new URL(response.url());
    const autoArrange = parsed.searchParams.get('autoArrange');
    calls.push({
      phase: phase(),
      endpoint: endpoint(response.url()),
      status: response.status(),
      ...(autoArrange === null ? {} : { autoArrange: autoArrange === 'true' }),
      request: layoutSummary(requestBody),
      response: layoutSummary(responseBody),
    });
  });
}

async function exportZip(page: Page, outDir: string): Promise<{ zipPath: string; sha256: string }> {
  await page.getByText('Export', { exact: true }).first().click();
  await page.getByText('Export Preference', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('input.ant-input:visible').last().fill('rack-two-lifecycle');
  const requestPromise = page.waitForRequest((request) =>
    request.url().includes('/api/ctos/export_zip') && request.method() === 'POST',
  { timeout: 120_000 });
  await page.getByText('Save', { exact: true }).last().click();
  const request = await requestPromise;
  const contentType = request.headers()['content-type'] ?? 'application/x-www-form-urlencoded';
  const response = await page.request.fetch(request.url(), {
    method: 'POST',
    data: request.postData() ?? '',
    headers: { 'content-type': contentType },
    timeout: 120_000,
  });
  assert.equal(response.status(), 200, 'browser export replay status');
  const body = await response.body();
  const zipPath = path.join(outDir, 'browser-two-rack.zip');
  await writeFile(zipPath, body);
  return { zipPath, sha256: createHash('sha256').update(body).digest('hex') };
}

async function extractXml(zipPath: string, outDir: string): Promise<string> {
  const result = await new Promise<{ name: string; body: Buffer }>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error('Could not open export ZIP.'));
      zip.readEntry();
      zip.on('entry', (entry) => {
        if (!entry.fileName.toLowerCase().endsWith('.xml')) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error('Could not read XML member.'));
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => resolve({ name: path.basename(entry.fileName), body: Buffer.concat(chunks) }));
        });
      });
      zip.on('end', () => reject(new Error('Export ZIP contains no XML member.')));
      zip.on('error', reject);
    });
  });
  const xmlPath = path.join(outDir, result.name);
  await writeFile(xmlPath, result.body);
  return xmlPath;
}

function semanticImport(payload: JsonObject): JsonObject {
  const configurations = array(payload['configuration']).map(object);
  const floor = object(payload['floorInformation']);
  const occupied = array(floor['floorGrid']).map(object).filter((tile) => array(tile['items']).length > 0);
  return {
    configurationCount: configurations.length,
    configurations: configurations.map((configuration) => ({
      id: text(configuration['id']),
      code: text(configuration['sliceCtoCode']),
      type: text(configuration['type']),
      quantity: number(configuration['quantity']),
      totalPrice: number(configuration['totalPrice']),
    })),
    rackCount: array(object(payload['workspace'])['rackArea']).length,
    nonRackCount: array(object(payload['workspace'])['nonRackArea']).length,
    occupied: occupied.map((tile) => ({
      coordinate: text(tile['coordinate']),
      items: array(tile['items']).map((itemRaw) => {
        const item = object(itemRaw);
        return {
          id: text(item['id']), code: text(item['code']),
          position: number(item['position']), size: number(item['size']),
        };
      }),
    })),
  };
}

function semanticKey(value: JsonObject): string {
  return [text(value['code']), text(value['type']), number(value['quantity']), number(value['totalPrice'])].join('|');
}

function rowsWith(sheet: WorkbookSheet, column: string, value: string) {
  return sheet.rows.filter(row => row.cells[column] === value);
}

function positive(value: string | undefined): boolean {
  return Number((value ?? '').replaceAll(',', '')) > 0;
}

function commercialLines(workbook: WorkbookInspection): Array<Record<string, string>> {
  return workbook.sheets['Quote']!.rows.filter(row =>
    [RACK_CODE, SERVER_CODE].includes(row.cells['A'] ?? '') && /^(Rack|Server)\s*:/.test(row.cells['C'] ?? ''))
    .map(row => ({ code: row.cells['A']!, quantity: row.cells['E']!, price: row.cells['F']! }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function diagnosticLines(workbook: WorkbookInspection): Array<Record<string, string>> {
  return workbook.sheets['Message History']!.rows
    .filter(row => ['Warning', 'Normal', 'Error'].includes(row.cells['A'] ?? ''))
    .map(row => ({ severity: row.cells['A']!, message: row.cells['B'] ?? '', information: row.cells['C'] ?? '' }));
}

function assertLifecycleWorkbook(workbook: WorkbookInspection, source: string): Record<string, unknown> {
  assert.deepEqual(workbook.sheetNames, WORKBOOK_SHEETS, `${source} workbook sheets`);
  for (const sheetName of ['Quote', 'Floor Report', 'Rack Report', 'Power Report', 'ConfigGroupView', 'Summary']) {
    const media = workbook.sheets[sheetName]!.media;
    assert(media.length > 0, `${source} ${sheetName} has no drawing relationship.`);
    assert(media.every(item => item.bytes > 0 && item.width !== null && item.width > 0 && item.height !== null && item.height > 0),
      `${source} ${sheetName} contains an empty or invalid PNG.`);
  }
  const quote = workbook.sheets['Quote']!;
  const racks = rowsWith(quote, 'A', RACK_CODE).filter(row => /^Rack\s*:/.test(row.cells['C'] ?? ''));
  const servers = rowsWith(quote, 'A', SERVER_CODE).filter(row => /^Server\s*:/.test(row.cells['C'] ?? ''));
  assert.equal(racks.length, 2, `${source} Quote rack count`);
  assert.equal(servers.length, 1, `${source} Quote server count`);
  assert(racks.every(row => row.cells['E'] === '1.0' && positive(row.cells['F'])), `${source} Quote rack qty/price`);
  assert(servers.every(row => row.cells['E'] === '1.0' && positive(row.cells['F'])), `${source} Quote server qty/price`);
  assert(rowsWith(quote, 'A', '6400').some(row => row.cells['E'] === '2.0'), `${source} Quote server cords`);

  const floor = workbook.sheets['Floor Report']!;
  assert.deepEqual(rowsWith(floor, 'A', RACK_CODE).map(row => row.cells['D']).sort(), ['A1', 'A2'],
    `${source} Floor rack identities`);
  const diagram = workbook.sheets['Rack Diagram']!;
  const diagramValues = diagram.rows.flatMap(row => row.values);
  assert(diagramValues.includes('A1') && diagramValues.includes('A2'), `${source} Rack Diagram locations`);
  assert.equal(diagramValues.filter(value => value === RACK_CODE).length, 2, `${source} Rack Diagram rack count`);
  assert(diagram.rows.some(row => row.cells['BF'] === '1' && row.cells['CZ'] === SERVER_CODE),
    `${source} Rack Diagram server A2/U1 placement`);

  const power = workbook.sheets['Power Report']!;
  assert(power.rows.some(row => row.cells['E'] === SERVER_CODE), `${source} Power Report server identity`);
  const inputPower = power.rows.find(row => row.cells['D'] === 'Input Power (W)');
  assert(inputPower && positive(inputPower.cells['E']) && positive(inputPower.cells['F']) && positive(inputPower.cells['G']),
    `${source} Power Report numeric idle/load/nominal values`);
  for (const sheetName of ['ConfigGroupView', 'Summary']) {
    const sheet = workbook.sheets[sheetName]!;
    assert.equal(rowsWith(sheet, sheetName === 'ConfigGroupView' ? 'B' : 'A', RACK_CODE).length, 2,
      `${source} ${sheetName} rack count`);
    assert.equal(rowsWith(sheet, sheetName === 'ConfigGroupView' ? 'B' : 'A', SERVER_CODE).length, 1,
      `${source} ${sheetName} server count`);
  }
  const history = workbook.sheets['Message History']!;
  assert(history.rows.some(row => row.cells['A'] === 'Severity'), `${source} Message History headers`);
  assert(history.rows.some(row => ['Warning', 'Normal', 'Error'].includes(row.cells['A'] ?? '') && (row.cells['B'] ?? '').length > 0),
    `${source} Message History current diagnostic rows`);
  assert(history.rows.some(row => row.cells['B'] === 'History'), `${source} Message History marker`);
  return { ...workbookEvidence(workbook), commercialLines: commercialLines(workbook),
    messageHistory: { mode: 'General Purpose current diagnostics; imported workspace has no new native audit events',
      diagnosticRows: diagnosticLines(workbook).length, historyMarker: true } };
}

async function verifyMcpLifecycle(
  browserPage: Page,
  browserXmlPath: string,
  outDir: string,
  browserWorkbook: WorkbookInspection,
): Promise<JsonObject> {
  const config = ConfigSchema.parse({
    files: { persistSessions: false, artifactDir: path.join(outDir, 'mcp-artifacts') },
    logLevel: 'error',
    pacing: { perToolRequestBudget: 80 },
  });
  const service = new DcscService(config);
  try {
    const ctx = service.newCtx();
    const imported = await service.importConfig({
      content: await readFile(browserXmlPath, 'utf8'),
      ctx,
      solutionMode: 'General Purpose',
      fileName: path.basename(browserXmlPath),
    });
    let workspace = service.sessions.getWorkspace(imported.workspaceId);
    assert(workspace, 'MCP import did not publish a workspace.');
    const racks = [...workspace.rackArea];
    assert.equal(racks.length, 2, 'MCP import rack count');
    const server = [...workspace.configurations.values()].find((item) => item.product.code === SERVER_CODE);
    assert(server, 'MCP import omitted the server configuration.');

    const currentPlacement = (): Placement => {
      workspace = service.sessions.getWorkspace(imported.workspaceId)!;
      for (let index = 0; index < workspace.rackArea.length; index += 1) {
        const rack = workspace.rackArea[index]!;
        const item = array(rack['rackItems']).map(object)
          .find((entry) => text(entry['id']) === server.configurationId);
        if (item) return { rack: `A${index + 1}`, position: number(item['position']) };
      }
      return { rack: null, position: null };
    };

    assert.deepEqual(currentPlacement(), { rack: 'A2', position: 1 });
    await service.placeInRack(workspace.id, {
      rackId: text(racks[0]!['id']), sessionId: server.id, position: 1,
      expectedRevision: workspace.revision, ctx,
    });
    assert.deepEqual(currentPlacement(), { rack: 'A1', position: 1 });
    workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    await service.placeInRack(workspace.id, {
      rackId: text(racks[1]!['id']), sessionId: server.id, position: 1,
      expectedRevision: workspace.revision, ctx,
    });
    assert.deepEqual(currentPlacement(), { rack: 'A2', position: 1 });
    workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    await service.editLayout(workspace.id, {
      action: 'unplace', configurationId: server.id, expectedRevision: workspace.revision, ctx,
    });
    assert.deepEqual(currentPlacement(), { rack: null, position: null });
    workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    const beforeArrangeIds = workspace.nonRackArea.map((item) => text(item['id']));
    await service.editLayout(workspace.id, {
      action: 'arrange', expectedRevision: workspace.revision, ctx,
    });
    workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    assert.deepEqual(workspace.nonRackArea.map((item) => text(item['id'])), beforeArrangeIds,
      'Arrange must leave non-rack items unplaced, matching the SPA.');
    assert.deepEqual(currentPlacement(), { rack: null, position: null });
    await service.placeInRack(workspace.id, {
      rackId: text(racks[1]!['id']), sessionId: server.id,
      expectedRevision: workspace.revision, ctx,
    });
    assert.deepEqual(currentPlacement(), { rack: 'A2', position: 1 });

    workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    const placedRevision = workspace.revision;
    assert.equal(await service.sessions.undoWorkspace(workspace.id, placedRevision), true);
    assert.deepEqual(currentPlacement(), { rack: null, position: null });
    workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    assert.equal(await service.sessions.redoWorkspace(workspace.id, workspace.revision), true);
    assert.deepEqual(currentPlacement(), { rack: 'A2', position: 1 });

    workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    const expectedIds = new Set([...workspace.configurations.values()].map((item) => item.configurationId));
    const expectedConfigurations = [...workspace.configurations.values()].map((item) => ({
      code: item.product.code,
      type: item.product.type,
      quantity: number(item.raw.quantity),
      totalPrice: number(item.raw.totalPrice),
    })).sort((left, right) => semanticKey(left).localeCompare(semanticKey(right)));
    const exported = await service.exportZip(workspace.id, {
      ctx,
      fileName: 'mcp-two-rack-lifecycle',
      fileTypes: ['XML', 'QUOTE', 'FLOOR', 'RACK_REPORT', 'RACK_DIAGRAM', 'POWER_REPORT',
        'QUOTE_GROUP', 'SUMMARY', 'MESSAGE_HISTORY'],
    });
    const bundle = await writeExportBundle(exported.stream, 'mcp-two-rack-lifecycle', config);
    assert(bundle.xml, 'MCP export ZIP contains no XML member.');
    const mcpWorkbook = await inspectExportWorkbook(bundle.zipPath);
    const workbook = assertLifecycleWorkbook(mcpWorkbook, 'MCP');
    assert.deepEqual(commercialLines(mcpWorkbook), commercialLines(browserWorkbook),
      'MCP Quote product quantities/prices differ from the corresponding native export.');
    assert.deepEqual(diagnosticLines(mcpWorkbook), diagnosticLines(browserWorkbook),
      'MCP current Message History diagnostics differ from the corresponding native export.');

    const browserImported = await importXml(browserPage, bundle.xml);
    const semantic = semanticImport(browserImported);
    const actualConfigurations = array(semantic['configurations']).map(object);
    assert.deepEqual(new Set(actualConfigurations.map((item) => text(item['id']))), expectedIds,
      'Browser reimport changed MCP configuration identities.');
    assert.deepEqual(actualConfigurations.map((item) => ({
      code: text(item['code']), type: text(item['type']), quantity: number(item['quantity']),
      totalPrice: number(item['totalPrice']),
    })).sort((left, right) => semanticKey(left).localeCompare(semanticKey(right))), expectedConfigurations);
    assert.deepEqual(array(semantic['occupied']).map(object).map((tile) => ({
      coordinate: tile['coordinate'],
      items: array(tile['items']).map((item) => ({
        code: object(item)['code'], position: object(item)['position'], size: object(item)['size'],
      })),
    })), [{ coordinate: 'A2', items: [{ code: SERVER_CODE, position: 1, size: 1 }] }]);

    return {
      extension: 'MCP durable history; the imported-workspace SPA exposed no Undo/Redo history.',
      workspaceRevision: workspace.revision,
      operations: ['move A2 to A1', 'move A1 to A2', 'unplace',
        'arrange preserves non-rack', 'auto-place A2', 'undo', 'redo'],
      messageHistoryMode: 'GP current diagnostics; no synthesized MCP action events expected for this imported workflow',
      export: {
        zipPath: path.relative(ROOT, bundle.zipPath),
        xmlPath: path.relative(ROOT, bundle.xml),
        bytes: bundle.bytes,
        sha256: bundle.sha256,
        workbook,
      },
      browserReimport: semantic,
    };
  } finally {
    await service.close();
  }
}

async function main(): Promise<void> {
  const arg = process.argv.find((value) => value.startsWith('--out='));
  const mcpFromArg = process.argv.find((value) => value.startsWith('--mcp-from='));
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const outDir = path.resolve(arg?.slice('--out='.length) ?? `artifacts/parity-rack/${stamp}`);
  await mkdir(outDir, { recursive: true });
  const contract = JSON.parse(await readFile(CONTRACT, 'utf8')) as JsonObject;
  assert.equal(object(contract['source'])['rackCode'], RACK_CODE);

  const browser = await chromium.launch({ headless: true });
  const calls: WireCall[] = [];
  let phase = 'import';
  try {
    if (mcpFromArg) {
      const mcpFrom = path.resolve(mcpFromArg.slice('--mcp-from='.length));
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      const page = await context.newPage();
      const browserWorkbook = await inspectExportWorkbook(path.join(path.dirname(mcpFrom), 'browser-two-rack.zip'));
      assertLifecycleWorkbook(browserWorkbook, 'native');
      const mcp = await verifyMcpLifecycle(page, mcpFrom, outDir, browserWorkbook);
      await context.close();
      const result = {
        capturedAt: new Date().toISOString(), status: 'pass', mode: 'mcp-only',
        browserOracleXml: path.relative(ROOT, mcpFrom), mcp,
      };
      await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    installCapture(page, () => phase, calls);
    await importXml(page, SOURCE_XML);
    await enterWorkspace(page);

    phase = 'add-rack-a2';
    await addRack(page);
    assert.equal(await page.locator('.rack').count(), 2);
    assert.deepEqual(await placement(page), { rack: 'A1', position: 1 });

    phase = 'move-a1-a2';
    await movePlaced(page, 'A2');
    assert.deepEqual(await placement(page), { rack: 'A2', position: 1 });
    phase = 'move-a2-a1';
    await movePlaced(page, 'A1');
    assert.deepEqual(await placement(page), { rack: 'A1', position: 1 });
    phase = 'unplace';
    await movePlaced(page, 'Non Rack Items');
    assert.deepEqual(await placement(page), { rack: null, position: null });
    phase = 'auto-arrange';
    await setAutoArrange(page, true);
    phase = 'place-auto-a2';
    await moveNonRack(page, 'A2');
    assert.deepEqual(await placement(page), { rack: 'A2', position: 1 });

    const history = await page.getByText(/^(Undo|Redo)$/).evaluateAll((elements) =>
      Object.fromEntries(elements.map((element) => [
        (element.textContent ?? '').trim().toLowerCase(),
        element.closest('button')?.hasAttribute('disabled') ?? false,
      ])),
    );
    assert.deepEqual(history, { undo: true, redo: true });

    phase = 'export';
    const exported = await exportZip(page, outDir);
    const xmlPath = await extractXml(exported.zipPath, outDir);
    const browserWorkbook = await inspectExportWorkbook(exported.zipPath);
    const browserWorkbookEvidence = assertLifecycleWorkbook(browserWorkbook, 'native');
    await context.close();

    phase = 'reimport';
    const reimportContext: BrowserContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const reimportPage = await reimportContext.newPage();
    const imported = await importXml(reimportPage, xmlPath);
    const semantic = semanticImport(imported);
    assert.equal(semantic['configurationCount'], 3);
    assert.equal(semantic['rackCount'], 2);
    assert.equal(semantic['nonRackCount'], 0);
    const occupied = array(semantic['occupied']).map(object);
    assert.equal(occupied.length, 1);
    assert.equal(occupied[0]!['coordinate'], 'A2');
    assert.deepEqual(array(occupied[0]!['items']).map((item) => ({
      code: object(item)['code'], position: object(item)['position'], size: object(item)['size'],
    })), [{ code: SERVER_CODE, position: 1, size: 1 }]);
    const configurations = array(semantic['configurations']).map(object);
    assert.equal(new Set(configurations.map((item) => item['id'])).size, 3);
    assert.equal(configurations.reduce((sum, item) => sum + number(item['totalPrice']), 0) > 0, true);
    await reimportContext.close();

    phase = 'mcp-lifecycle';
    const mcpReimportContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const mcpReimportPage = await mcpReimportContext.newPage();
    const mcp = await verifyMcpLifecycle(mcpReimportPage, xmlPath, outDir, browserWorkbook);
    await mcpReimportContext.close();

    const result = {
      capturedAt: new Date().toISOString(),
      status: 'pass',
      sourceXml: path.relative(ROOT, SOURCE_XML),
      contract: path.relative(ROOT, CONTRACT),
      phases: ['add-rack-a2', 'move-a1-a2',
        'move-a2-a1', 'unplace', 'auto-arrange', 'place-auto-a2', 'export', 'reimport'],
      browserHistory: { undoDisabled: history['undo'], redoDisabled: history['redo'] },
      export: { ...exported, zipPath: path.relative(ROOT, exported.zipPath), xmlPath: path.relative(ROOT, xmlPath),
        workbook: browserWorkbookEvidence },
      reimport: semantic,
      mcp,
      wire: calls,
    };
    await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
