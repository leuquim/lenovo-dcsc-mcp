/** Website rack Customize > Power flow and power-line readers shared by the rack-power parity cases. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from 'playwright';
import yauzl from 'yauzl';

import { inspectExportWorkbook, type WorkbookInspection, type WorkbookSheet } from '../lib/xlsx-inspection.js';
import { importedConfigurations, object, rows, text, type Obj } from './fabric.js';

export const SOURCE_XML = path.resolve('test/fixtures/parity/xml/one-rack-sr630-v3.xml');
export const RACK_CODE = '7D6DCTO1WW';
export const FIRST_PDU = 'CE6L';
export const FIRST_CORD = '6275';
export const FINAL_PDU = 'C0D8';
export const FINAL_CORD = '6500';
const POWER_SECTIONS = ['PDU', 'LINECORD', 'RACK_POWERCABLE'];
const FILLER_CODES = new Set(['4275', '4273', '4271', 'B34A', 'B349', 'B348']);
const WORKBOOK_SHEETS = ['Quote', 'Floor Report', 'Rack Report', 'Rack Diagram', 'Power Report', 'ConfigGroupView', 'Summary', 'Message History'];

export interface PowerLine { section: string; code: string; quantity: number }
export interface DeriveStep { code: string; quantity: number; guideMode: string | null; totalPrice: number; selected: PowerLine[] }

const num = (value: unknown): number => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };
const byKey = (left: PowerLine, right: PowerLine) => `${left.section}:${left.code}`.localeCompare(`${right.section}:${right.code}`);

export function powerLines(configuration: Obj): PowerLine[] {
  const lines = rows(configuration['tabs']).flatMap(tab => rows(tab['subTabs'])).flatMap(tab => rows(tab['sections']))
    .flatMap(section => rows(section['results']))
    .filter(result => POWER_SECTIONS.includes(text(result['characterName']).toUpperCase()) && num(result['quantity']) > 0)
    .map(result => ({ section: text(result['characterName']).toUpperCase(), code: text(result['code']), quantity: num(result['quantity']) }));
  return lines.sort(byKey);
}
export function fillerLines(configuration: Obj) {
  const characters = rows(configuration['unSelectableCharacters']);
  const sections = characters.length > 0 ? characters : rows(configuration['tabs']).flatMap(tab => rows(tab['subTabs'])).flatMap(tab => rows(tab['sections']));
  return sections.flatMap(section => rows(section['results'])).filter(result => FILLER_CODES.has(text(result['code'])))
    .map(result => ({ code: text(result['code']), quantity: num(result['quantity']) })).sort((left, right) => left.code.localeCompare(right.code));
}
export function rackConfiguration(payload: Obj, id?: string): Obj {
  const racks = importedConfigurations(payload).filter(candidate => text(candidate['sliceCtoCode'] ?? candidate['code']) === RACK_CODE);
  const found = id ? racks.find(candidate => text(candidate['id']) === id) : racks[0];
  assert(found, `Response omitted rack configuration${id ? ` ${id}` : ''}.`);
  return found;
}

export async function enterRackPower(page: Page): Promise<void> {
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

export async function selectQuantity(page: Page, code: string, quantity: number): Promise<DeriveStep> {
  await page.locator(`[class~="${code}"] .ant-select-selection`).first().click();
  const choices = page.locator('.ant-select-dropdown:visible .ant-select-dropdown-menu-item');
  const responsePromise = page.waitForResponse(response => response.url().includes('/api/ctos/autoDerive') && response.request().method() === 'POST', { timeout: 120_000 });
  await choices.filter({ hasText: new RegExp(`^${quantity}$`) }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, `${code} derive status`);
  const rack = rackConfiguration(object(await response.json()));
  await page.waitForTimeout(2_000);
  assert.equal((await page.locator(`[class~="${code}"] .ant-select-selection`).first().innerText()).trim(), String(quantity));
  return { code, quantity, guideMode: new URL(response.url()).searchParams.get('guideMode'), totalPrice: num(rack['totalPrice']), selected: powerLines(rack) };
}

/** Drives Back to Workspace > Export > Save and replays the captured export request to read the ZIP. */
export async function websiteExport(page: Page, outDir: string, name: string): Promise<{ zipPath: string; xmlPath: string }> {
  await page.getByText('Back to Workspace', { exact: true }).click();
  await page.waitForURL(/#\/rack-configuration/, { timeout: 60_000 });
  await page.waitForTimeout(5_000);
  await page.getByText('Export', { exact: true }).first().click();
  await page.getByText('Export Preference', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('input.ant-input:visible').last().fill(name);
  const requestPromise = page.waitForRequest(request => request.url().includes('/api/ctos/export_zip') && request.method() === 'POST', { timeout: 120_000 });
  await page.getByText('Save', { exact: true }).last().click();
  const request = await requestPromise;
  const response = await page.request.fetch(request.url(), { method: 'POST', data: request.postData() ?? '',
    headers: { 'content-type': request.headers()['content-type'] ?? 'application/x-www-form-urlencoded' }, timeout: 120_000 });
  assert.equal(response.status(), 200, 'browser export replay status');
  const zipPath = path.join(outDir, `${name}.zip`);
  await writeFile(zipPath, await response.body());
  const xmlPath = path.join(outDir, `${name}.xml`);
  await writeFile(xmlPath, await firstXmlMember(zipPath));
  return { zipPath, xmlPath };
}

function firstXmlMember(zipPath: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error('Could not open export ZIP.'));
      zip.readEntry();
      zip.on('entry', entry => {
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
}

const rowsWith = (sheet: WorkbookSheet, column: string, value: string) => sheet.rows.filter(row => row.cells[column] === value);
export function selectedWorkbookLines(workbook: WorkbookInspection, codes: string[]) {
  return workbook.sheets['Quote']!.rows.filter(row => codes.includes(row.cells['A'] ?? ''))
    .map(row => ({ code: row.cells['A']!, quantity: row.cells['E'] ?? '', price: row.cells['F'] ?? '' })).sort((left, right) => left.code.localeCompare(right.code));
}

/** Structural checks on an export workbook for the given rack count and power selections. */
export function assertPowerWorkbook(workbook: WorkbookInspection, source: string, expected: { rackCount: number; selections: Array<{ code: string; quantity: number }> }): void {
  assert.deepEqual(workbook.sheetNames, WORKBOOK_SHEETS, `${source} workbook sheets`);
  for (const sheetName of ['Quote', 'Floor Report', 'Rack Report', 'Power Report', 'ConfigGroupView', 'Summary']) {
    const media = workbook.sheets[sheetName]!.media;
    assert(media.length > 0, `${source} ${sheetName} has no drawing relationship.`);
    assert(media.every(item => item.bytes > 0 && item.width !== null && item.width > 0 && item.height !== null && item.height > 0), `${source} ${sheetName} contains an empty or invalid PNG.`);
  }
  const quote = workbook.sheets['Quote']!;
  const racks = rowsWith(quote, 'A', RACK_CODE).filter(row => /^Rack\s*:/.test(row.cells['C'] ?? ''));
  assert.equal(racks.length, expected.rackCount, `${source} Quote rack count`);
  assert(racks.every(row => row.cells['E'] === '1.0' && Number(row.cells['F']) > 0), `${source} Quote rack qty/price`);
  for (const selection of expected.selections) {
    assert(rowsWith(quote, 'A', selection.code).some(row => Number(row.cells['E']) === selection.quantity), `${source} Quote ${selection.code} quantity`);
  }
  assert.deepEqual(rowsWith(workbook.sheets['Floor Report']!, 'A', RACK_CODE).map(row => row.cells['D']).sort(),
    Array.from({ length: expected.rackCount }, (_, index) => `A${index + 1}`), `${source} Floor rack identities`);
  const diagram = workbook.sheets['Rack Diagram']!.rows.flatMap(row => row.values);
  for (let index = 1; index <= expected.rackCount; index += 1) assert(diagram.includes(`A${index}`), `${source} Rack Diagram missing A${index}`);
  assert.equal(diagram.filter(value => value === RACK_CODE).length, expected.rackCount, `${source} Rack Diagram rack count`);
  const inputPower = workbook.sheets['Power Report']!.rows.filter(row => row.cells['D'] === 'Input Power (W)');
  assert(inputPower.length > 0 && inputPower.every(row => ['E', 'F', 'G'].every(column => Number((row.cells[column] ?? '').replaceAll(',', '')) > 0)), `${source} Power Report numeric values`);
  for (const sheetName of ['ConfigGroupView', 'Summary']) {
    assert.equal(rowsWith(workbook.sheets[sheetName]!, sheetName === 'ConfigGroupView' ? 'B' : 'A', RACK_CODE).length, expected.rackCount, `${source} ${sheetName} rack count`);
  }
  const history = workbook.sheets['Message History']!;
  assert(history.rows.some(row => row.cells['A'] === 'Severity'), `${source} Message History headers`);
  assert(history.rows.some(row => ['Warning', 'Normal', 'Error'].includes(row.cells['A'] ?? '') && (row.cells['B'] ?? '').length > 0), `${source} Message History rows`);
}

export { inspectExportWorkbook };
