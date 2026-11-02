/** Website rack helpers: Summary and Workspace rack actions, workspace import and export. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from 'playwright';

import { zipText } from './archives.js';
import { auditForms, captureBrowserExport } from './exportUi.js';
import type { Harness, Json } from './harness.js';
import { settle, visible } from './settingsUi.js';
import { array, importInBrowser, object } from './softwareSummaryUi.js';


export const SUMMARY_ROUTE = /#\/(?:rack-summary|summary)\//;
const RACK_DISTANCE_INPUT = 2;
const COLD_AISLE_INPUT = 4;
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
  await clickText(page, 'Summary', 'Summary button');
  await page.waitForURL(SUMMARY_ROUTE, { timeout: 60_000 });
  await settle(page);
}

/** Summary > More > Logical Groups: creates the groups, moves the parts, saves, then Export posts the groups form field. */
export async function createLogicalGroupsInBrowser(page: Page,
  groups: Array<{ name: string; parent?: string; products: string[] }>): Promise<void> {
  await clickText(page, 'More', 'More menu');
  await clickText(page, 'Logical Groups', 'Logical Groups item');
  const modal = page.locator('.ant-modal:visible').first();
  const pickOption = async (select: Locator, label: string) => {
    await select.click();
    await (await visible(page.locator('.ant-select-dropdown:visible li').filter({ hasText: label }), `option ${label}`)).click();
    await settle(page);
  };
  for (const group of groups) {
    await (await visible(modal.locator('#name'), 'Group Name input')).fill(group.name);
    if (group.parent) await pickOption(modal.locator('.create-group-form .ant-select-selection'), group.parent);
    await clickText(page, 'Create', 'Create button');
  }
  for (const group of groups.filter(entry => entry.products.length > 0)) {
    for (const code of group.products) {
      const row = modal.locator('tr.ant-table-row').filter({ hasText: code }).first();
      await (await visible(row.locator('input[type=checkbox]'), `checkbox of ${code}`)).check({ force: true });
    }
    await pickOption(modal.locator('.move-to-group-section .ant-select-selection').first(), group.name);
  }
  await (await visible(modal.locator('.action-save'), 'Save button')).click();
  await settle(page);
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
  const menus = page.locator('.ant-cascader-menus:visible');
  for (const label of [...menuPath, productCode]) {
    await (await visible(menus.locator('li').filter({ hasText: label }).last(), `menu ${label}`)).click();
    await settle(page);
  }
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
  const panel = page.getByText('Floor and Cabling', { exact: true }).first().locator('xpath=ancestor::div[contains(@class,"ant-row")][1]');
  await (await visible(panel.locator('.anticon-setting'), 'Floor Preference gear')).click();
  const popover = page.locator('.ant-popover:visible').filter({ hasText: 'Floor Preference' }).first();
  await (await visible(popover.locator('label', { hasText: 'Show cable lines' }), 'Show cable lines checkbox')).click();
  for (let step = 0; step < change.rowPlus; step += 1) await popover.getByRole('button', { name: 'Row +' }).click();
  const distances = popover.locator('input.ant-input-number-input');
  const fill = async (index: number, value: number) => {
    await distances.nth(index).fill(String(value));
    await distances.nth(index).press('Tab');
  };
  await fill(RACK_DISTANCE_INPUT, change.rackDist);
  await fill(COLD_AISLE_INPUT, change.coldDist);
  const tray = popover.locator('input.ant-checkbox-input').last();
  if ((await tray.isChecked()) !== change.trayCabling) await tray.setChecked(change.trayCabling, { force: true });
  await popover.getByRole('button', { name: 'Close' }).last().click();
  await settle(page);
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
