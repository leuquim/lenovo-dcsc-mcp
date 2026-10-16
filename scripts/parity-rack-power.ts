/**
 * Maintained browser + MCP parity gate for manual rack PDU and line-cord edits.
 *
 * The browser half uses the visible rack Customize > Power controls. The MCP
 * half repeats the final selections on two independently referenced racks,
 * exercises history and restart, then reimports its export in a fresh browser.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium, type Browser, type Page } from 'playwright';
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

interface PowerLine {
  section: string;
  code: string;
  quantity: number;
  description: string;
  unitPrice?: number;
}

interface DeriveStep {
  code: string;
  quantity: number;
  status: number;
  guideMode: string | null;
  totalPrice: number;
  selected: PowerLine[];
}

interface FillerLine {
  code: string;
  quantity: number;
}

const ROOT = process.cwd();
const SOURCE_XML = path.join(ROOT, 'test/fixtures/parity/xml/one-rack-sr630-v3.xml');
const RACK_CODE = '7D6DCTO1WW';
const FIRST_PDU = 'CE6L';
const FIRST_CORD = '6275';
const FINAL_PDU = 'C0D8';
const FINAL_CORD = '6500';
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
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function configurations(payload: JsonObject): JsonObject[] {
  const raw = array(payload['configurations']).length > 0
    ? array(payload['configurations'])
    : array(payload['configuration']);
  return raw.map(object);
}

function powerLines(configuration: JsonObject): PowerLine[] {
  const output: PowerLine[] = [];
  for (const tabRaw of array(configuration['tabs'])) {
    for (const subTabRaw of array(object(tabRaw)['subTabs'])) {
      for (const sectionRaw of array(object(subTabRaw)['sections'])) {
        const section = object(sectionRaw);
        for (const resultRaw of array(section['results'])) {
          const result = object(resultRaw);
          const characterName = text(result['characterName']).toUpperCase();
          if (!['PDU', 'LINECORD', 'RACK_POWERCABLE'].includes(characterName)) continue;
          const quantity = number(result['quantity']);
          if (quantity <= 0) continue;
          const feature = array(section['features']).map(object)
            .find((candidate) => text(candidate['code']) === text(result['code']));
          output.push({
            section: characterName,
            code: text(result['code']),
            quantity,
            description: text(result['description']),
            ...(typeof feature?.['unitPrice'] === 'number'
              ? { unitPrice: feature['unitPrice'] as number }
              : {}),
          });
        }
      }
    }
  }
  return output.sort((left, right) => `${left.section}:${left.code}`.localeCompare(`${right.section}:${right.code}`));
}

const FILLER_CODES = new Set(['4275', '4273', '4271', 'B34A', 'B349', 'B348']);

function fillerLines(configuration: JsonObject): FillerLine[] {
  const characters = array(configuration['unSelectableCharacters']).map(object);
  const sections = characters.length > 0
    ? characters
    : array(configuration['tabs']).flatMap((tab) => array(object(tab)['subTabs']))
      .flatMap((subTab) => array(object(subTab)['sections'])).map(object);
  return sections.flatMap((section) => array(section['results']).map(object)
    .filter((result) => FILLER_CODES.has(text(result['code'])))
    .map((result) => ({ code: text(result['code']), quantity: number(result['quantity']) })))
    .sort((left, right) => left.code.localeCompare(right.code));
}

function rackConfiguration(payload: JsonObject, id?: string): JsonObject {
  const racks = configurations(payload).filter((candidate) =>
    text(candidate['sliceCtoCode'] ?? candidate['code']) === RACK_CODE);
  const result = id ? racks.find((candidate) => text(candidate['id']) === id) : racks[0];
  assert(result, `Response omitted rack configuration${id ? ` ${id}` : ''}.`);
  return result;
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
  const pending = page.waitForResponse((response) =>
    response.url().includes('/multiple/cfxml_import') && response.request().method() === 'POST',
  { timeout: 120_000 });
  await input.setInputFiles(xmlPath);
  const response = await pending;
  assert.equal(response.status(), 200, 'CFXML import status');
  const body = await response.json() as unknown;
  await page.waitForURL(/#\/(?:rack-summary|summary)\//, { timeout: 120_000 });
  return object(Array.isArray(body) ? body[0] : body);
}

async function enterRackPower(page: Page): Promise<void> {
  await page.getByText('Go to Workspace', { exact: true }).first().click();
  await page.waitForURL(/#\/rack-configuration/, { timeout: 60_000 });
  await page.waitForTimeout(5_000);
  await page.locator('.rack .rack__actions button').first().click();
  await page.getByText('Customize', { exact: true }).last().click();
  await page.waitForURL(/#\/configuration\/cto\//, { timeout: 60_000 });
  await page.waitForTimeout(7_000);
  await page.getByText('Power', { exact: true }).first().click();
  await page.waitForTimeout(3_000);
}

async function selectQuantity(page: Page, code: string, quantity: number): Promise<DeriveStep> {
  const selector = page.locator(`[class~="${code}"] .ant-select-selection`).first();
  await selector.click();
  const choices = page.locator('.ant-select-dropdown:visible .ant-select-dropdown-menu-item');
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes('/api/ctos/autoDerive') && response.request().method() === 'POST',
  { timeout: 120_000 });
  await choices.filter({ hasText: new RegExp(`^${quantity}$`) }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, `${code} derive status`);
  const payload = object(await response.json() as unknown);
  const rack = rackConfiguration(payload);
  await page.waitForTimeout(2_000);
  assert.equal((await page.locator(`[class~="${code}"] .ant-select-selection`).first().innerText()).trim(), String(quantity));
  return {
    code,
    quantity,
    status: response.status(),
    guideMode: new URL(response.url()).searchParams.get('guideMode'),
    totalPrice: number(rack['totalPrice']),
    selected: powerLines(rack),
  };
}

async function exportZip(page: Page, outDir: string, name: string): Promise<{ zipPath: string; sha256: string }> {
  await page.getByText('Export', { exact: true }).first().click();
  await page.getByText('Export Preference', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('input.ant-input:visible').last().fill(name);
  const requestPromise = page.waitForRequest((request) =>
    request.url().includes('/api/ctos/export_zip') && request.method() === 'POST',
  { timeout: 120_000 });
  await page.getByText('Save', { exact: true }).last().click();
  const request = await requestPromise;
  await writeFile(path.join(outDir, `${name}-export-request.multipart.txt`), request.postData() ?? '');
  const response = await page.request.fetch(request.url(), {
    method: 'POST', data: request.postData() ?? '',
    headers: { 'content-type': request.headers()['content-type'] ?? 'application/x-www-form-urlencoded' },
    timeout: 120_000,
  });
  assert.equal(response.status(), 200, 'browser export replay status');
  const body = await response.body();
  const zipPath = path.join(outDir, `${name}.zip`);
  await writeFile(zipPath, body);
  return { zipPath, sha256: createHash('sha256').update(body).digest('hex') };
}

async function extractXml(zipPath: string, outDir: string, outputName: string): Promise<string> {
  const body = await new Promise<Buffer>((resolve, reject) => {
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
          stream.on('end', () => resolve(Buffer.concat(chunks)));
        });
      });
      zip.on('end', () => reject(new Error('Export ZIP contains no XML member.')));
      zip.on('error', reject);
    });
  });
  const result = path.join(outDir, outputName);
  await writeFile(result, body);
  return result;
}

function assertExactPower(configuration: JsonObject, expected: Array<{ section: string; code: string; quantity: number }>): void {
  assert.deepEqual(powerLines(configuration).map(({ section, code, quantity }) => ({ section, code, quantity })),
    [...expected].sort((left, right) => `${left.section}:${left.code}`.localeCompare(`${right.section}:${right.code}`)));
}

function rowsWith(sheet: WorkbookSheet, column: string, value: string) {
  return sheet.rows.filter(row => row.cells[column] === value);
}

function selectedWorkbookLines(workbook: WorkbookInspection, codes: string[]): Array<Record<string, string>> {
  return workbook.sheets['Quote']!.rows.filter(row => codes.includes(row.cells['A'] ?? ''))
    .map(row => ({ code: row.cells['A']!, quantity: row.cells['E'] ?? '', price: row.cells['F'] ?? '' }))
    .sort((left, right) => left.code.localeCompare(right.code));
}

function assertPowerWorkbook(
  workbook: WorkbookInspection,
  source: string,
  expected: { rackCount: number; selections: Array<{ code: string; quantity: number }> },
): Record<string, unknown> {
  assert.deepEqual(workbook.sheetNames, WORKBOOK_SHEETS, `${source} workbook sheets`);
  for (const sheetName of ['Quote', 'Floor Report', 'Rack Report', 'Power Report', 'ConfigGroupView', 'Summary']) {
    const media = workbook.sheets[sheetName]!.media;
    assert(media.length > 0, `${source} ${sheetName} has no drawing relationship.`);
    assert(media.every(item => item.bytes > 0 && item.width !== null && item.width > 0 && item.height !== null && item.height > 0),
      `${source} ${sheetName} contains an empty or invalid PNG.`);
  }
  const quote = workbook.sheets['Quote']!;
  const racks = rowsWith(quote, 'A', RACK_CODE).filter(row => /^Rack\s*:/.test(row.cells['C'] ?? ''));
  assert.equal(racks.length, expected.rackCount, `${source} Quote rack count`);
  assert(racks.every(row => row.cells['E'] === '1.0' && Number(row.cells['F']) > 0), `${source} Quote rack qty/price`);
  for (const selection of expected.selections) {
    assert(rowsWith(quote, 'A', selection.code).some(row => Number(row.cells['E']) === selection.quantity),
      `${source} Quote ${selection.code} quantity`);
  }
  const floor = workbook.sheets['Floor Report']!;
  assert.deepEqual(rowsWith(floor, 'A', RACK_CODE).map(row => row.cells['D']).sort(),
    Array.from({ length: expected.rackCount }, (_, index) => `A${index + 1}`), `${source} Floor rack identities`);
  const diagramValues = workbook.sheets['Rack Diagram']!.rows.flatMap(row => row.values);
  for (let index = 1; index <= expected.rackCount; index += 1) {
    assert(diagramValues.includes(`A${index}`), `${source} Rack Diagram missing A${index}`);
  }
  assert.equal(diagramValues.filter(value => value === RACK_CODE).length, expected.rackCount,
    `${source} Rack Diagram rack count`);
  const power = workbook.sheets['Power Report']!;
  const inputPower = power.rows.filter(row => row.cells['D'] === 'Input Power (W)');
  assert(inputPower.length > 0 && inputPower.every(row =>
    ['E', 'F', 'G'].every(column => Number((row.cells[column] ?? '').replaceAll(',', '')) > 0)),
  `${source} Power Report numeric idle/load/nominal values`);
  for (const sheetName of ['ConfigGroupView', 'Summary']) {
    const column = sheetName === 'ConfigGroupView' ? 'B' : 'A';
    assert.equal(rowsWith(workbook.sheets[sheetName]!, column, RACK_CODE).length, expected.rackCount,
      `${source} ${sheetName} rack count`);
  }
  const history = workbook.sheets['Message History']!;
  assert(history.rows.some(row => row.cells['A'] === 'Severity'), `${source} Message History headers`);
  assert(history.rows.some(row => ['Warning', 'Normal', 'Error'].includes(row.cells['A'] ?? '') && (row.cells['B'] ?? '').length > 0),
    `${source} Message History current diagnostic rows`);
  return { ...workbookEvidence(workbook),
    selections: selectedWorkbookLines(workbook, expected.selections.map(item => item.code)) };
}

async function browserGate(browser: Browser, outDir: string): Promise<{
  xmlPath: string; workbook: WorkbookInspection; summary: JsonObject;
}> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  try {
    const imported = await importXml(page, SOURCE_XML);
    const initialRack = rackConfiguration(imported);
    const rackId = text(initialRack['id']);
    const baselinePrice = number(initialRack['totalPrice']);
    await enterRackPower(page);

    const steps: DeriveStep[] = [];
    for (const [code, quantity] of [
      [FIRST_PDU, 1], [FIRST_CORD, 1], [FIRST_PDU, 0],
      [FINAL_PDU, 1], [FIRST_CORD, 0], [FINAL_CORD, 1],
    ] as const) steps.push(await selectQuantity(page, code, quantity));

    const final = steps.at(-1)!;
    assert.deepEqual(final.selected.map(({ section, code, quantity }) => ({ section, code, quantity })), [
      { section: 'LINECORD', code: FINAL_CORD, quantity: 1 },
      { section: 'PDU', code: FINAL_PDU, quantity: 1 },
    ]);
    assert.equal(steps.every((step) => step.guideMode === 'true'), true);
    const selectedOptionDelta = final.selected.reduce((sum, line) => sum + (line.unitPrice ?? 0) * line.quantity, 0);
    // The authoritative rack total may also include installation lines pulled
    // by autoDerive. Record both numbers instead of treating option prices as
    // a locally calculable rack quote.
    assert(final.totalPrice >= baselinePrice + selectedOptionDelta);

    await page.getByText('Back to Workspace', { exact: true }).click();
    await page.waitForURL(/#\/rack-configuration/, { timeout: 60_000 });
    await page.waitForTimeout(5_000);
    const exported = await exportZip(page, outDir, 'browser-rack-power');
    const xmlPath = await extractXml(exported.zipPath, outDir, 'browser-rack-power.xml');
    const workbook = await inspectExportWorkbook(exported.zipPath);
    const workbookResult = assertPowerWorkbook(workbook, 'native', { rackCount: 1,
      selections: [{ code: FINAL_PDU, quantity: 1 }, { code: FINAL_CORD, quantity: 1 }] });

    const reimportContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const reimportPage = await reimportContext.newPage();
    const reimported = await importXml(reimportPage, xmlPath);
    const restored = rackConfiguration(reimported, rackId);
    assert.equal(number(restored['totalPrice']), final.totalPrice);
    assertExactPower(restored, [
      { section: 'PDU', code: FINAL_PDU, quantity: 1 },
      { section: 'LINECORD', code: FINAL_CORD, quantity: 1 },
    ]);
    await reimportContext.close();

    return {
      xmlPath,
      workbook,
      summary: {
        source: path.relative(ROOT, SOURCE_XML), rackId, baselinePrice,
        steps, selectedOptionDelta,
        finalPrice: final.totalPrice,
        export: { zipPath: path.relative(ROOT, exported.zipPath), xmlPath: path.relative(ROOT, xmlPath),
          sha256: exported.sha256, workbook: workbookResult },
        reimport: { rackId: text(restored['id']), totalPrice: number(restored['totalPrice']), selected: powerLines(restored) },
      },
    };
  } finally {
    await context.close();
  }
}

/** Browser oracle for a second-code attempt and accepted non-unit power quantities. */
async function browserMultiPowerGate(browser: Browser, outDir: string): Promise<JsonObject> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  try {
    const imported = await importXml(page, SOURCE_XML);
    const initialRack = rackConfiguration(imported);
    const rackId = text(initialRack['id']);
    const baselinePrice = number(initialRack['totalPrice']);
    await enterRackPower(page);
    const requested = [
      { section: 'PDU', code: FIRST_PDU, quantity: 2 },
      { section: 'PDU', code: FINAL_PDU, quantity: 3 },
      { section: 'LINECORD', code: FIRST_CORD, quantity: 4 },
      { section: 'LINECORD', code: FINAL_CORD, quantity: 2 },
    ];
    // Despite the sections serializing `multipleSelectable:false`, the live
    // browser retains both accepted codes and their independent quantities.
    const expected = [...requested].sort((left, right) =>
      `${left.section}:${left.code}`.localeCompare(`${right.section}:${right.code}`));
    const steps: DeriveStep[] = [];
    for (const item of requested) steps.push(await selectQuantity(page, item.code, item.quantity));
    const final = steps.at(-1)!;
    assert.deepEqual(final.selected.map(({ section, code, quantity }) => ({ section, code, quantity })), expected);

    await page.getByText('Back to Workspace', { exact: true }).click();
    await page.waitForURL(/#\/rack-configuration/, { timeout: 60_000 });
    await page.waitForTimeout(5_000);
    const exported = await exportZip(page, outDir, 'browser-rack-power-multi');
    const xmlPath = await extractXml(exported.zipPath, outDir, 'browser-rack-power-multi.xml');
    const reimportContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const reimportPage = await reimportContext.newPage();
    const reimported = await importXml(reimportPage, xmlPath);
    const restored = rackConfiguration(reimported, rackId);
    assert.equal(number(restored['totalPrice']), final.totalPrice);
    assertExactPower(restored, expected);
    await reimportContext.close();
    return {
      source: path.relative(ROOT, SOURCE_XML), rackId, baselinePrice, requested, steps,
      finalPrice: final.totalPrice,
      export: { zipPath: path.relative(ROOT, exported.zipPath), xmlPath: path.relative(ROOT, xmlPath),
        sha256: exported.sha256 },
      reimport: { rackId: text(restored['id']), totalPrice: number(restored['totalPrice']),
        selected: powerLines(restored) },
    };
  } finally {
    await context.close();
  }
}

async function mcpGate(
  browser: Browser,
  outDir: string,
  expectedRackOnePrice: number,
  browserWorkbook?: WorkbookInspection,
): Promise<JsonObject> {
  const stateFile = path.join(outDir, 'mcp-state.json');
  const config = ConfigSchema.parse({
    files: { persistSessions: true, sessionFile: stateFile, artifactDir: path.join(outDir, 'mcp-artifacts') },
    logLevel: 'error', pacing: { perToolRequestBudget: 80 },
  });
  let service = new DcscService(config);
  let workspaceId = '';
  let rackIds: string[] = [];
  try {
    const ctx = service.newCtx();
    const imported = await service.importConfig({
      content: await readFile(SOURCE_XML, 'utf8'), ctx,
      solutionMode: 'General Purpose', fileName: path.basename(SOURCE_XML),
    });
    workspaceId = imported.workspaceId;
    let workspace = service.sessions.getWorkspace(workspaceId)!;
    rackIds = workspace.rackArea.map((rack) => text(rack['id']));
    assert.equal(rackIds.length, 1);

    const configure = async (rackId: string, options: { pduCode?: string; cordCode?: string; quantity?: number }) => {
      workspace = service.sessions.getWorkspace(workspaceId)!;
      return service.configurePdu(workspace.id, rackId, {
        ...options, expectedRevision: workspace.revision, ctx,
      });
    };
    // Repeat the browser's replacement sequence exactly. DCSC's derive graph
    // is path-dependent because selecting a PDU can pull installation lines.
    await configure(rackIds[0]!, { pduCode: FIRST_PDU, quantity: 1 });
    await configure(rackIds[0]!, { cordCode: FIRST_CORD, quantity: 1 });
    await configure(rackIds[0]!, { pduCode: FIRST_PDU, quantity: 0 });
    await configure(rackIds[0]!, { pduCode: FINAL_PDU, quantity: 1 });
    await configure(rackIds[0]!, { cordCode: FIRST_CORD, quantity: 0 });
    const rackOne = await configure(rackIds[0]!, { cordCode: FINAL_CORD, quantity: 1 });
    assert.equal(rackOne.totalPrice, expectedRackOnePrice);

    // Add the second rack only after the matched single-rack edit. Workspace
    // derive can legitimately reprice existing configurations, so comparing a
    // two-rack workspace to the browser's one-rack flow would conflate inputs.
    workspace = service.sessions.getWorkspace(workspaceId)!;
    await service.addRack(workspace.id, RACK_CODE, ctx, workspace.revision);
    workspace = service.sessions.getWorkspace(workspaceId)!;
    rackIds = workspace.rackArea.map((rack) => text(rack['id']));
    assert.equal(rackIds.length, 2);
    assert.deepEqual(powerLines([...workspace.configurations.values()]
      .find((configuration) => configuration.configurationId === rackIds[0])!.raw)
      .map(({ section, code, quantity }) => ({ section, code, quantity })), [
      { section: 'LINECORD', code: FINAL_CORD, quantity: 1 },
      { section: 'PDU', code: FINAL_PDU, quantity: 1 },
    ]);
    await configure(rackIds[1]!, { pduCode: FIRST_PDU, quantity: 1 });
    const rackTwo = await configure(rackIds[1]!, { cordCode: FIRST_CORD, quantity: 1 });
    assert.equal(rackTwo.powerReadiness?.complete, true);

    workspace = service.sessions.getWorkspace(workspaceId)!;
    assert.deepEqual(workspace.powerSelections, [
      { rackId: rackIds[0], pduCode: FINAL_PDU, cordCode: FINAL_CORD },
      { rackId: rackIds[1], pduCode: FIRST_PDU, cordCode: FIRST_CORD },
    ]);
    const redoStateRevision = workspace.revision;
    assert.equal(await service.sessions.undoWorkspace(workspace.id, redoStateRevision), true);
    workspace = service.sessions.getWorkspace(workspaceId)!;
    assert.deepEqual(workspace.powerSelections, [
      { rackId: rackIds[0], pduCode: FINAL_PDU, cordCode: FINAL_CORD },
      { rackId: rackIds[1], pduCode: FIRST_PDU },
    ]);
    assert.equal(await service.sessions.redoWorkspace(workspace.id, workspace.revision), true);

    workspace = service.sessions.getWorkspace(workspaceId)!;
    const exported = await service.exportZip(workspace.id, {
      ctx, fileName: 'mcp-two-rack-power',
      fileTypes: ['XML', 'QUOTE', 'FLOOR', 'RACK_REPORT', 'RACK_DIAGRAM', 'POWER_REPORT',
        'QUOTE_GROUP', 'SUMMARY', 'MESSAGE_HISTORY'],
    });
    const bundle = await writeExportBundle(exported.stream, 'mcp-two-rack-power', config);
    assert(bundle.xml);
    const mcpWorkbook = await inspectExportWorkbook(bundle.zipPath);
    const workbook = assertPowerWorkbook(mcpWorkbook, 'MCP', { rackCount: 2, selections: [
      { code: FINAL_PDU, quantity: 1 }, { code: FINAL_CORD, quantity: 1 },
      { code: FIRST_PDU, quantity: 1 }, { code: FIRST_CORD, quantity: 1 },
    ] });
    if (browserWorkbook) {
      assert.deepEqual(selectedWorkbookLines(mcpWorkbook, [FINAL_PDU, FINAL_CORD]),
        selectedWorkbookLines(browserWorkbook, [FINAL_PDU, FINAL_CORD]),
        'MCP rack-one PDU/cord workbook lines differ from the corresponding native export.');
    }
    await service.close();

    service = new DcscService(config);
    workspace = service.sessions.getWorkspace(workspaceId)!;
    assert.deepEqual(workspace.powerSelections, [
      { rackId: rackIds[0], pduCode: FINAL_PDU, cordCode: FINAL_CORD },
      { rackId: rackIds[1], pduCode: FIRST_PDU, cordCode: FIRST_CORD },
    ]);
    const configurationByRack = new Map([...workspace.configurations.values()]
      .map((configuration) => [configuration.configurationId, configuration]));
    const selectionKeys = (rackId: string) => powerLines(configurationByRack.get(rackId)!.raw)
      .map(({ section, code, quantity }) => ({ section, code, quantity }));
    assert.deepEqual(selectionKeys(rackIds[0]!), [
      { section: 'LINECORD', code: FINAL_CORD, quantity: 1 },
      { section: 'PDU', code: FINAL_PDU, quantity: 1 },
    ]);
    assert.deepEqual(selectionKeys(rackIds[1]!), [
      { section: 'LINECORD', code: FIRST_CORD, quantity: 1 },
      { section: 'PDU', code: FIRST_PDU, quantity: 1 },
    ]);

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const reimported = await importXml(page, bundle.xml);
    await writeFile(path.join(outDir, 'mcp-browser-reimport-response.json'), JSON.stringify([reimported]));
    const importedRacks: JsonObject[] = [];
    for (const [rackId, expected] of [
      [rackIds[0]!, [{ section: 'PDU', code: FINAL_PDU, quantity: 1 }, { section: 'LINECORD', code: FINAL_CORD, quantity: 1 }]],
      [rackIds[1]!, [{ section: 'PDU', code: FIRST_PDU, quantity: 1 }, { section: 'LINECORD', code: FIRST_CORD, quantity: 1 }]],
    ] as const) {
      const restored = rackConfiguration(reimported, rackId);
      const source = configurationByRack.get(rackId)!.raw;
      assertExactPower(restored, [...expected]);
      assert.equal(number(restored['totalPrice']), number(source.totalPrice),
        `Fresh browser import changed rack ${rackId} price.`);
      assert.deepEqual(fillerLines(restored), fillerLines(object(source)),
        `Fresh browser import changed rack ${rackId} filler selections.`);
      importedRacks.push({
        rackId,
        totalPrice: restored['totalPrice'],
        selected: powerLines(restored),
        filler: fillerLines(restored),
      });
    }
    const sourceNetworking = object(workspace.serverState['networkingInformation']);
    const restoredNetworking = object(reimported['networkingInformation']);
    assert.deepEqual(array(restoredNetworking['powerSelection']), array(sourceNetworking['powerSelection']),
      'Fresh browser import changed networkingInformation.powerSelection.');
    await context.close();

    return {
      workspaceId, rackIds, revision: workspace.revision,
      powerSelections: workspace.powerSelections,
      selected: rackIds.map((rackId) => ({ rackId, lines: powerLines(configurationByRack.get(rackId)!.raw) })),
      history: { undoRemovedSecondRackCordOnly: true, redoRestored: true },
      restart: { durable: true, rackReferencesPreserved: true },
      export: { zipPath: path.relative(ROOT, bundle.zipPath), xmlPath: path.relative(ROOT, bundle.xml),
        bytes: bundle.bytes, sha256: bundle.sha256, workbook },
      browserReimport: {
        status: 'pass',
        exactRackReferences: true,
        exactPowerLines: true,
        exactRackPrices: true,
        exactFillerLines: true,
        racks: importedRacks,
        powerSelection: array(restoredNetworking['powerSelection']),
      },
    };
  } finally {
    await service.close();
  }
}

async function mcpMultiPowerGate(browser: Browser, outDir: string, expectedPrice: number): Promise<JsonObject> {
  const stateFile = path.join(outDir, 'mcp-state.json');
  const config = ConfigSchema.parse({ files: { persistSessions: true, sessionFile: stateFile,
    artifactDir: path.join(outDir, 'mcp-artifacts') }, logLevel: 'error',
  pacing: { perToolRequestBudget: 80 } });
  let service = new DcscService(config);
  try {
    const ctx = service.newCtx();
    const imported = await service.importConfig({ content: await readFile(SOURCE_XML, 'utf8'), ctx,
      solutionMode: 'General Purpose', fileName: path.basename(SOURCE_XML) });
    let workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    const rackId = text(workspace.rackArea[0]?.['id']);
    const requested = [
      { pduCode: FIRST_PDU, quantity: 2 }, { pduCode: FINAL_PDU, quantity: 3 },
      { cordCode: FIRST_CORD, quantity: 4 }, { cordCode: FINAL_CORD, quantity: 2 },
    ];
    let last: Awaited<ReturnType<DcscService['configurePdu']>> | undefined;
    for (const selection of requested) {
      workspace = service.sessions.getWorkspace(imported.workspaceId)!;
      last = await service.configurePdu(workspace.id, rackId, {
        ...selection, expectedRevision: workspace.revision, ctx,
      });
    }
    assert(last);
    const expected = [
      { section: 'LINECORD', code: FIRST_CORD, quantity: 4 },
      { section: 'LINECORD', code: FINAL_CORD, quantity: 2 },
      { section: 'PDU', code: FINAL_PDU, quantity: 3 },
      { section: 'PDU', code: FIRST_PDU, quantity: 2 },
    ];
    const selected = last.selected.map(({ section, code, quantity }) => ({ section, code, quantity }))
      .sort((left, right) => `${left.section}:${left.code}`.localeCompare(`${right.section}:${right.code}`));
    assert.deepEqual(selected, expected);
    assert.equal(last.totalPrice, expectedPrice);
    workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    const source = [...workspace.configurations.values()].find(session => session.configurationId === rackId)!;
    assertExactPower(object(source.raw), expected);
    const exported = await service.exportZip(workspace.id, { ctx, fileName: 'mcp-rack-power-multi',
      fileTypes: ['XML', 'QUOTE'], scope: 'workspace' });
    const bundle = await writeExportBundle(exported.stream, 'mcp-rack-power-multi', config);
    assert(bundle.xml);
    await service.close();
    service = new DcscService(config);
    workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    const restarted = [...workspace.configurations.values()].find(session => session.configurationId === rackId)!;
    assertExactPower(object(restarted.raw), expected);
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const reimported = await importXml(page, bundle.xml);
    const restored = rackConfiguration(reimported, rackId);
    assertExactPower(restored, expected);
    assert.equal(number(restored['totalPrice']), expectedPrice);
    await writeFile(path.join(outDir, 'mcp-browser-reimport-response.json'), JSON.stringify([reimported]));
    await context.close();
    return {
      workspaceId: workspace.id, rackId, totalPrice: expectedPrice, selected: powerLines(restored),
      revision: workspace.revision,
      export: { zipPath: path.relative(ROOT, bundle.zipPath), xmlPath: path.relative(ROOT, bundle.xml),
        bytes: bundle.bytes, sha256: bundle.sha256 },
      browserReimport: { totalPrice: restored['totalPrice'], selected: powerLines(restored) },
    };
  } finally {
    await service.close();
  }
}

async function main(): Promise<void> {
  const outputArg = process.argv.find((value) => value.startsWith('--out='));
  const mcpOnlyArg = process.argv.find((value) => value.startsWith('--mcp-only-price='));
  const mcpMultiArg = process.argv.find((value) => value.startsWith('--mcp-multi-price='));
  const browserOnly = process.argv.includes('--browser-only');
  const browserMulti = process.argv.includes('--browser-multi');
  const multi = process.argv.includes('--multi');
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const outDir = path.resolve(outputArg?.slice('--out='.length) ?? `artifacts/parity-rack-power/${stamp}`);
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    if (multi) {
      const browserResult = await browserMultiPowerGate(browser, outDir);
      const mcp = await mcpMultiPowerGate(browser, outDir, number(browserResult['finalPrice']));
      const result = { capturedAt: new Date().toISOString(), status: 'pass',
        mode: 'browser-mcp-multi-power-and-fresh-browser-reimport', browser: browserResult, mcp };
      await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (browserMulti) {
      const browserResult = await browserMultiPowerGate(browser, outDir);
      const result = { capturedAt: new Date().toISOString(), status: 'pass',
        mode: 'browser-second-power-code-and-non-unit-quantities', browser: browserResult };
      await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (mcpMultiArg) {
      const expectedPrice = Number(mcpMultiArg.slice('--mcp-multi-price='.length));
      assert(Number.isFinite(expectedPrice) && expectedPrice > 0, 'mcp-multi price must be positive.');
      const mcp = await mcpMultiPowerGate(browser, outDir, expectedPrice);
      const result = { capturedAt: new Date().toISOString(), status: 'pass',
        mode: 'mcp-multi-power-and-fresh-browser-reimport', expectedPrice, mcp };
      await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (browserOnly) {
      const browserResult = await browserGate(browser, outDir);
      const result = {
        capturedAt: new Date().toISOString(), status: 'pass', mode: 'browser-only',
        browser: browserResult.summary,
      };
      await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (mcpOnlyArg) {
      const expectedPrice = Number(mcpOnlyArg.slice('--mcp-only-price='.length));
      assert(Number.isFinite(expectedPrice) && expectedPrice > 0, 'mcp-only price must be positive.');
      const mcp = await mcpGate(browser, outDir, expectedPrice);
      const result = {
        capturedAt: new Date().toISOString(), status: 'pass',
        mode: 'mcp-with-provided-browser-price-and-fresh-browser-reimport', expectedPrice, mcp,
      };
      await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const browserResult = await browserGate(browser, outDir);
    const mcp = await mcpGate(browser, outDir, number(browserResult.summary['finalPrice']), browserResult.workbook);
    const result = {
      capturedAt: new Date().toISOString(), status: 'pass',
      browser: browserResult.summary, mcp,
      semantics: {
        pduAndLineCordAreIndependentQuantitySelections: true,
        changingModelsRequiresRemovingTheOldCodeAndAddingTheNewCode: true,
        rackReferencesAreConfigurationIds: true,
      },
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
