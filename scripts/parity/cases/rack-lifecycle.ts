/** Two-rack workspace lifecycle: website add rack, move, unplace, auto-place and export against dcsc_rack_edit, undo/redo and export. */
import assert from 'node:assert/strict';
import type { Page } from 'playwright';

import { inspectExportWorkbook, type WorkbookInspection, type WorkbookSheet } from '../../lib/xlsx-inspection.js';
import type { Json, ParityCase } from '../harness.js';
import { exportFromWorkspace, ONE_RACK_XML, openWorkspace, RACK_CODE, reimportEnvelope, rows, SERVER_CODE } from '../rackUi.js';
import { object } from '../softwareSummaryUi.js';

const ALL_REPORT_TYPES = ['XML', 'QUOTE', 'FLOOR', 'RACK_REPORT', 'RACK_DIAGRAM', 'POWER_REPORT', 'QUOTE_GROUP', 'SUMMARY', 'MESSAGE_HISTORY'];
const WORKBOOK_SHEETS = ['Quote', 'Floor Report', 'Rack Report', 'Rack Diagram', 'Power Report', 'ConfigGroupView', 'Summary', 'Message History'];
const SHEETS_WITH_DRAWINGS = ['Quote', 'Floor Report', 'Rack Report', 'Power Report', 'ConfigGroupView', 'Summary'];
const UNPLACED = { rack: null, position: null };
const A1_U1 = { rack: 'A1', position: 1 };
const A2_U1 = { rack: 'A2', position: 1 };
const EXPECTED_WORKBOOK = {
  sheetNames: WORKBOOK_SHEETS, drawingsValid: true,
  quote: { racks: 2, servers: 1, quantitiesOne: true, pricesPositive: true, serverCordsQuantityTwo: true },
  floorRackLocations: ['A1', 'A2'],
  diagram: { locations: true, rackCount: 2, serverAtA2U1: true },
  power: { serverIdentity: true, inputPowerPositive: true },
  groupView: { racks: 2, servers: 1 }, summary: { racks: 2, servers: 1 },
  messageHistory: { headers: true, diagnosticRow: true, marker: true },
};
const EXPECTED_REIMPORT_OCCUPIED = [{ coordinate: 'A2', items: [{ code: SERVER_CODE, position: 1, size: 1 }] }];
const num = (value: unknown) => Number(value) || 0;
const text = (value: unknown) => value === null || value === undefined ? '' : String(value);
const byJson = (left: unknown, right: unknown) => JSON.stringify(left).localeCompare(JSON.stringify(right));

const rowsWith = (sheet: WorkbookSheet, column: string, value: string) => sheet.rows.filter(row => row.cells[column] === value);
const positive = (value: string | undefined) => Number((value ?? '').replaceAll(',', '')) > 0;
const commercialLines = (workbook: WorkbookInspection) => workbook.sheets['Quote']!.rows
  .filter(row => [RACK_CODE, SERVER_CODE].includes(row.cells['A'] ?? '') && /^(Rack|Server)\s*:/.test(row.cells['C'] ?? ''))
  .map(row => ({ code: row.cells['A'], quantity: row.cells['E'], price: row.cells['F'] })).sort(byJson);
const diagnosticLines = (workbook: WorkbookInspection) => workbook.sheets['Message History']!.rows
  .filter(row => ['Warning', 'Normal', 'Error'].includes(row.cells['A'] ?? ''))
  .map(row => ({ severity: row.cells['A'], message: row.cells['B'] ?? '', information: row.cells['C'] ?? '' }));

function workbookFacts(workbook: WorkbookInspection) {
  const quote = workbook.sheets['Quote']!;
  const racks = rowsWith(quote, 'A', RACK_CODE).filter(row => /^Rack\s*:/.test(row.cells['C'] ?? ''));
  const servers = rowsWith(quote, 'A', SERVER_CODE).filter(row => /^Server\s*:/.test(row.cells['C'] ?? ''));
  const diagram = workbook.sheets['Rack Diagram']!;
  const diagramValues = diagram.rows.flatMap(row => row.values);
  const power = workbook.sheets['Power Report']!;
  const inputPower = power.rows.find(row => row.cells['D'] === 'Input Power (W)');
  const history = workbook.sheets['Message History']!;
  const countIn = (name: string, column: string, code: string) => rowsWith(workbook.sheets[name]!, column, code).length;
  return {
    sheetNames: workbook.sheetNames,
    drawingsValid: SHEETS_WITH_DRAWINGS.every(name => {
      const media = workbook.sheets[name]!.media;
      return media.length > 0 && media.every(item => item.bytes > 0 && (item.width ?? 0) > 0 && (item.height ?? 0) > 0);
    }),
    quote: {
      racks: racks.length, servers: servers.length,
      quantitiesOne: [...racks, ...servers].every(row => row.cells['E'] === '1.0'),
      pricesPositive: [...racks, ...servers].every(row => positive(row.cells['F'])),
      serverCordsQuantityTwo: rowsWith(quote, 'A', '6400').some(row => row.cells['E'] === '2.0'),
    },
    floorRackLocations: rowsWith(workbook.sheets['Floor Report']!, 'A', RACK_CODE).map(row => row.cells['D']).sort(),
    diagram: {
      locations: diagramValues.includes('A1') && diagramValues.includes('A2'),
      rackCount: diagramValues.filter(value => value === RACK_CODE).length,
      serverAtA2U1: diagram.rows.some(row => row.cells['BF'] === '1' && row.cells['CZ'] === SERVER_CODE),
    },
    power: {
      serverIdentity: power.rows.some(row => row.cells['E'] === SERVER_CODE),
      inputPowerPositive: !!inputPower && positive(inputPower.cells['E']) && positive(inputPower.cells['F']) && positive(inputPower.cells['G']),
    },
    groupView: { racks: countIn('ConfigGroupView', 'B', RACK_CODE), servers: countIn('ConfigGroupView', 'B', SERVER_CODE) },
    summary: { racks: countIn('Summary', 'A', RACK_CODE), servers: countIn('Summary', 'A', SERVER_CODE) },
    messageHistory: {
      headers: history.rows.some(row => row.cells['A'] === 'Severity'),
      diagnosticRow: history.rows.some(row => ['Warning', 'Normal', 'Error'].includes(row.cells['A'] ?? '') && (row.cells['B'] ?? '').length > 0),
      marker: history.rows.some(row => row.cells['B'] === 'History'),
    },
  };
}

function reimportFacts(envelope: Json) {
  const occupied = rows(object(envelope['floorInformation'])['floorGrid']).filter(tile => rows(tile['items']).length > 0);
  const configurations = rows(envelope['configuration']);
  return {
    configurations: configurations.map(item => ({ code: text(item['sliceCtoCode']), type: text(item['type']), quantity: num(item['quantity']), totalPrice: num(item['totalPrice']) })).sort(byJson),
    ids: configurations.map(item => text(item['id'])).sort(),
    rackCount: rows(object(envelope['workspace'])['rackArea']).length,
    nonRackCount: rows(object(envelope['workspace'])['nonRackArea']).length,
    occupied: occupied.map(tile => ({ coordinate: text(tile['coordinate']),
      items: rows(tile['items']).map(item => ({ code: item['code'], position: num(item['position']), size: num(item['size']) })) })),
  };
}

const derive = (page: Page) => page.waitForResponse(response =>
  response.url().includes('/api/ctos/autoDerive') && response.request().method() === 'POST', { timeout: 120_000 });
async function dismissCookie(page: Page): Promise<void> {
  const close = page.locator('.dcsc-cookie-close').first();
  if (await close.isVisible({ timeout: 2_000 }).catch(() => false)) await close.click();
}
async function placement(page: Page) {
  const racks = page.locator('.rack');
  for (let index = 0; index < await racks.count(); index += 1) {
    const rack = racks.nth(index);
    const server = rack.locator('.rack-server');
    if (await server.count() === 0) continue;
    const style = await server.first().getAttribute('style') ?? '';
    return { rack: (await rack.locator('.rack__description').innerText()).trim(),
      position: Math.round(Number(/bottom:\s*([0-9.]+)px/.exec(style)?.[1] ?? 0) / 15) + 1 };
  }
  return UNPLACED;
}
async function openMoveTo(page: Page, open: () => Promise<void>): Promise<void> {
  await dismissCookie(page);
  const moveTo = page.locator('.ant-menu-submenu-title:visible').filter({ hasText: /^Move To$/ });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await moveTo.count() === 0) { await open(); await page.waitForTimeout(350); }
    if (await moveTo.count() > 0) { await moveTo.last().click({ force: true }); return; }
    await page.keyboard.press('Escape');
  }
  throw new Error('The native Move To menu did not become visible after three attempts.');
}
async function moveTo(page: Page, destination: 'A1' | 'A2' | 'Non Rack Items', source: 'placed' | 'non-rack'): Promise<void> {
  await openMoveTo(page, async () => {
    if (source === 'placed') { await page.locator('.rack-server').first().click({ force: true }); return; }
    const group = page.locator('.ant-collapse-item').filter({ hasText: new RegExp(SERVER_CODE) }).last();
    if ((await group.locator('.ant-collapse-header').first().getAttribute('aria-expanded')) !== 'true') await group.locator('.ant-collapse-header').first().click({ force: true });
    await group.locator('.anticon-setting').click({ force: true });
  });
  const derived = derive(page);
  await page.getByText(destination === 'Non Rack Items' ? destination : `${destination} - Rack`, { exact: true }).last().click();
  await derived;
  await page.waitForTimeout(5_000);
}

export default {
  id: 'rack-lifecycle',
  tags: ['rack', 'export'],
  async run(h) {
    const { mcp, step, compare } = h;

    const website = await step('website', async () => {
      const page = await openWorkspace(h, ONE_RACK_XML);
      await page.getByText('Rack', { exact: true }).first().click();
      await page.waitForTimeout(1_000);
      const added = derive(page);
      await page.getByText(new RegExp(RACK_CODE)).first().dblclick();
      await added;
      await page.waitForTimeout(5_000);
      const placements = [{ rackCount: await page.locator('.rack').count(), ...await placement(page) }];
      for (const [destination, source] of [['A2', 'placed'], ['A1', 'placed'], ['Non Rack Items', 'placed']] as const) {
        await moveTo(page, destination, source);
        placements.push({ rackCount: await page.locator('.rack').count(), ...await placement(page) });
      }
      const toggle = page.locator('.auto-arrange .ant-switch');
      if ((await toggle.innerText()).trim() !== 'On') {
        const customized = page.waitForResponse(item => item.url().includes('/api/ctos/racks/customize') && item.url().includes('autoArrange=true'), { timeout: 120_000 });
        await toggle.click();
        await customized;
        await page.waitForTimeout(5_000);
      }
      await moveTo(page, 'A2', 'non-rack');
      placements.push({ rackCount: await page.locator('.rack').count(), ...await placement(page) });
      const history = await page.getByText(/^(Undo|Redo)$/).evaluateAll(elements => Object.fromEntries(elements.map(element =>
        [(element.textContent ?? '').trim().toLowerCase(), element.closest('button')?.hasAttribute('disabled') ?? false])));
      const exported = await exportFromWorkspace(page, h.out, 'browser-two-rack');
      const workbook = await inspectExportWorkbook(exported.zipPath);
      return { placements, history, exported, workbook, reimport: reimportFacts(await reimportEnvelope(h, exported.xmlPath)) };
    });

    compare('website-placements', [
      { rackCount: 2, ...A1_U1 }, { rackCount: 2, ...A2_U1 }, { rackCount: 2, ...A1_U1 },
      { rackCount: 2, ...UNPLACED }, { rackCount: 2, ...A2_U1 }], website.placements);
    compare('website-history-disabled', { undo: true, redo: true }, website.history);
    compare('website-workbook', EXPECTED_WORKBOOK, workbookFacts(website.workbook));
    compare('website-reimport', { configurations: 3, rackCount: 2, nonRackCount: 0, occupied: EXPECTED_REIMPORT_OCCUPIED },
      { configurations: website.reimport.configurations.length, rackCount: website.reimport.rackCount,
        nonRackCount: website.reimport.nonRackCount, occupied: website.reimport.occupied });

    await step('mcp', async () => {
      const imported = await mcp.call('dcsc_import', { content: website.exported.xml, solutionMode: 'General Purpose' });
      const workspace = String(imported['session']);
      const saved = () => mcp.persistedWorkspaces().find(entry => entry['id'] === workspace)!;
      const server = rows(saved()['configurations']).find(entry => object(entry['product'])['code'] === SERVER_CODE)!;
      const rackIds = rows(saved()['rackArea']).map(rack => text(rack['id']));
      assert.equal(rackIds.length, 2, 'MCP import rack count');
      const where = () => {
        const index = rows(saved()['rackArea']).findIndex(rack => rows(rack['rackItems']).some(item => item['id'] === server['configurationId']));
        const item = index < 0 ? undefined : rows(rows(saved()['rackArea'])[index]!['rackItems']).find(entry => entry['id'] === server['configurationId']);
        return index < 0 ? UNPLACED : { rack: `A${index + 1}`, position: num(item!['position']) };
      };
      const edit = (args: Json, expectError = false) => mcp.call('dcsc_rack_edit', { session: workspace, ...args }, { expectError });
      const placements = [where()];
      await edit({ action: 'place', configuration: server['id'], rackId: rackIds[0], uPosition: 1 }); placements.push(where());
      await edit({ action: 'place', configuration: server['id'], rackId: rackIds[1], uPosition: 1 }); placements.push(where());
      await edit({ action: 'unplace', configuration: server['id'] }); placements.push(where());
      const looseBefore = rows(saved()['nonRackArea']).map(item => text(item['id']));
      await edit({ action: 'arrange' });
      compare('arrange-keeps-non-rack-unplaced', { loose: looseBefore, placement: UNPLACED },
        { loose: rows(saved()['nonRackArea']).map(item => text(item['id'])), placement: where() });
      await edit({ action: 'place', configuration: server['id'], rackId: rackIds[1] }); placements.push(where());
      await mcp.call('dcsc_undo', { session: workspace, action: 'undo' }); placements.push(where());
      await mcp.call('dcsc_undo', { session: workspace, action: 'redo' }); placements.push(where());
      compare('mcp-placements', [A2_U1, A1_U1, A2_U1, UNPLACED, A2_U1, UNPLACED, A2_U1], placements);

      const expectedConfigurations = rows(saved()['configurations']).map(item => ({
        code: object(item['product'])['code'], type: object(item['product'])['type'],
        quantity: num(object(item['raw'])['quantity']), totalPrice: num(object(item['raw'])['totalPrice']) })).sort(byJson);
      const expectedIds = rows(saved()['configurations']).map(item => text(item['configurationId'])).sort();
      const exported = await mcp.call('dcsc_export', { kind: 'reports', session: workspace, scope: 'workspace', fileName: 'mcp-two-rack-lifecycle', fileTypes: ALL_REPORT_TYPES });
      const mcpWorkbook = await inspectExportWorkbook(String(exported['zipPath']));
      compare('mcp-workbook', EXPECTED_WORKBOOK, workbookFacts(mcpWorkbook));
      compare('workbook-quote-lines', commercialLines(website.workbook), commercialLines(mcpWorkbook));
      compare('workbook-diagnostics', diagnosticLines(website.workbook), diagnosticLines(mcpWorkbook));

      const reimported = reimportFacts(await reimportEnvelope(h, String(exported['xml'])));
      compare('browser-reimport-of-mcp-export', { ids: expectedIds, configurations: expectedConfigurations, occupied: EXPECTED_REIMPORT_OCCUPIED },
        { ids: reimported.ids, configurations: reimported.configurations.map(item => ({ code: item.code, type: item.type, quantity: item.quantity, totalPrice: item.totalPrice })).sort(byJson),
          occupied: reimported.occupied });
    });
  },
} satisfies ParityCase;
