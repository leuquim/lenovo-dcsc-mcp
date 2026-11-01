/** Website rack helpers: Summary and Workspace rack actions, workspace import and export. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';

import { zipText } from './archives.js';
import { auditForms, captureBrowserExport } from './exportUi.js';
import type { Harness, Json } from './harness.js';
import { settle, visible } from './settingsUi.js';
import { array, importInBrowser, object } from './softwareSummaryUi.js';


export const SUMMARY_ROUTE = /#\/(?:rack-summary|summary)\//;
const WORKSPACE_ROUTE = /#\/rack-configuration/;

/** A fresh website page that imported the file and shows its Summary, with the export-form capture installed. */
export async function openSummary(h: Harness, xmlPath: string): Promise<Page> {
  const page = await h.web.newPage();
  await importInBrowser(page, xmlPath, SUMMARY_ROUTE);
  return page;
}

async function clickText(page: Page, text: string | RegExp, description: string, last = false): Promise<void> {
  const matches = page.getByText(text, typeof text === 'string' ? { exact: true } : {});
  const target = await visible(last ? matches.last() : matches, description);
  await target.click();
  await settle(page);
}

/** Exports the XML through the Export dialog and returns the export XML. */
export async function exportXml(h: Harness, page: Page, name: string): Promise<string> {
  return (await captureBrowserExport(page, h.out, name)).xml;
}

export async function goToWorkspace(page: Page): Promise<void> {
  await clickText(page, 'Go to Workspace', 'Go to Workspace');
  await page.waitForURL(WORKSPACE_ROUTE, { timeout: 60_000 });
  await settle(page);
}

export async function backToSummary(page: Page): Promise<void> {
  await clickText(page, 'Summary', 'Summary button', true);
  await page.waitForURL(SUMMARY_ROUTE, { timeout: 60_000 });
  await settle(page);
}

/** Summary > More > Logical Groups: creates the groups, moves the parts, saves, then Export posts the groups form field. */
export async function createLogicalGroupsInBrowser(page: Page,
  groups: Array<{ name: string; parent?: string; products: string[] }>): Promise<void> {
  await clickText(page, 'More', 'More menu');
  await clickText(page, 'Logical Groups', 'Logical Groups item');
  for (const group of groups) {
    await (await visible(page.getByPlaceholder(/group name/i), 'Group Name input')).fill(group.name);
    if (group.parent) {
      await (await visible(page.locator('.ant-modal:visible .ant-select').first(), 'Sub-group-of select')).click();
      await clickText(page, group.parent, `parent option ${group.parent}`, true);
    }
    await clickText(page, 'Create', 'Create button');
  }
  for (const group of groups.filter(entry => entry.products.length > 0)) {
    for (const code of group.products) {
      const row = page.locator('.ant-modal:visible tr, .ant-modal:visible li').filter({ hasText: code }).first();
      await (await visible(row.locator('input[type=checkbox]'), `checkbox of ${code}`)).check();
    }
    await (await visible(page.getByText('Move to Group', { exact: true }), 'Move to Group select')).click();
    await clickText(page, group.name, `target option ${group.name}`, true);
  }
  await clickText(page, 'Save', 'Save button', true);
}

/** Summary > a non-rack item's Add Container > Rack > the rack model. */
export async function addContainerInBrowser(page: Page, rackCode: string): Promise<void> {
  await clickText(page, 'Add Container', 'Add Container link');
  await clickText(page, 'Rack', 'Rack menu', true);
  await clickText(page, new RegExp(rackCode), `rack ${rackCode}`, true);
}

/** Summary > a rack line's Add Hardware > the cascading menu path > the product row. */
export async function addHardwareInBrowser(page: Page, menuPath: string[], productCode: string): Promise<void> {
  await clickText(page, 'Add Hardware', 'Add Hardware link');
  for (const label of menuPath) await clickText(page, label, `menu ${label}`, true);
  await clickText(page, new RegExp(productCode), `product ${productCode}`, true);
}

/** Workspace > Rack button > Change rack model > the rack model. */
export async function changeRackModelInBrowser(page: Page, rackCode: string): Promise<void> {
  await (await visible(page.locator('.rack .rack__actions button'), 'Rack button')).click();
  await clickText(page, 'Change rack model', 'Change rack model');
  await clickText(page, new RegExp(rackCode), `rack model ${rackCode}`, true);
}

/** Workspace > Floor and Cabling > Floor Preference modal: Show cable lines (view-only), Row +, rack distance, cold aisle, tray cabling. */
export async function setFloorPreferenceInBrowser(page: Page,
  change: { rowPlus: number; rackDist: number; coldDist: number; trayCabling: boolean }): Promise<void> {
  await (await visible(page.locator('.anticon-setting'), 'Floor Preference gear')).click();
  await settle(page);
  await (await visible(page.getByText('Show cable lines', { exact: false }).locator('xpath=preceding::input[@type="checkbox"][1] | following::input[@type="checkbox"][1]'), 'Show cable lines checkbox')).click();
  for (let step = 0; step < change.rowPlus; step += 1) await clickText(page, /^Row\s*\+$/, 'Row +');
  const fill = async (label: string, value: number) => {
    const input = await visible(page.getByText(label, { exact: true }).locator('xpath=following::input[1]'), `${label} input`);
    await input.fill(String(value));
    await input.press('Tab');
  };
  await fill('Rack distance', change.rackDist);
  await fill('Cold aisle', change.coldDist);
  const tray = await visible(page.getByText('Tray cabling', { exact: false }).locator('xpath=preceding::input[@type="checkbox"][1] | following::input[@type="checkbox"][1]'), 'Tray cabling checkbox');
  if ((await tray.isChecked()) !== change.trayCabling) await tray.click();
  await clickText(page, 'Close', 'Close button');
}


export const ONE_RACK_XML = path.resolve('test/fixtures/parity/xml/one-rack-sr630-v3.xml');
export const SERVER_CODE = '7D73CTO1WW';
export const RACK_CODE = '7D6DCTO1WW';
export const rows = (value: unknown): Json[] => array(value).map(object);

/** Imports an XML in a fresh website page and opens the rack workspace. */
export async function openWorkspace(h: Harness, xmlPath: string): Promise<Page> {
  const page = await h.web.newPage();
  await importInBrowser(page, xmlPath, SUMMARY_ROUTE);
  await page.getByText('Go to Workspace', { exact: true }).first().click();
  await page.waitForURL(/#\/rack-configuration/, { timeout: 60_000 });
  await page.waitForTimeout(7_000);
  return page;
}

/** The import envelope the website returns for an XML file. */
export async function reimportEnvelope(h: Harness, xmlPath: string): Promise<Json> {
  const { response } = await importInBrowser(await h.web.newPage(), xmlPath, SUMMARY_ROUTE);
  return object(array(response)[0]);
}

/** Export Preference > Save from the workspace page: the form the SPA posted, and the archive replayed through the browser. */
export async function exportFromWorkspace(page: Page, out: string, name: string) {
  const before = (await auditForms(page)).length;
  await page.getByText('Export', { exact: true }).first().click();
  await page.getByText('Export Preference', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('input.ant-input:visible').last().fill(name);
  await page.getByText('Save', { exact: true }).last().click();
  await page.waitForTimeout(800);
  const form = (await auditForms(page)).slice(before).find(candidate => candidate.path.includes('/export_zip'));
  assert(form, `${name}: browser did not submit its export form.`);
  const response = await page.context().request.post(form.path, { form: form.fields, timeout: 120_000 });
  assert(response.ok(), `${name}: browser export returned HTTP ${response.status()}.`);
  const zipPath = path.join(out, `${name}.zip`);
  await writeFile(zipPath, await response.body());
  const xml = await zipText(zipPath, '.xml');
  const xmlPath = path.join(out, `${name}.xml`);
  await writeFile(xmlPath, xml);
  return { form, zipPath, xml, xmlPath };
}

/** Rack contents, loose items and configurations of a customize request/response or an import envelope. */
export function physicalLayout(value: unknown) {
  const body = object(value);
  const workspace = object(body['workspaceInformation']);
  const racks = array(body['rackArea']).length ? array(body['rackArea']) : array(workspace['rackData']);
  const configurations = array(body['configurations']).length ? array(body['configurations']) : array(workspace['configurations']);
  return {
    configurations: rows(configurations).map(item => ({ code: item['sliceCtoCode'] ?? item['code'], quantity: Number(item['quantity']), totalPrice: Number(item['totalPrice']) }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    racks: rows(racks).map(rack => ({ code: rack['code'], items: rows(rack['rackItems']).map(item => ({ code: item['code'], position: item['position'], size: item['size'] })) })),
  };
}
