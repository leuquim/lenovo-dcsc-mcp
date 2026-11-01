/** Website rack workspace helpers shared by the rack and nested-chassis cases. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';

import { zipText } from './archives.js';
import { auditForms } from './exportUi.js';
import type { Harness, Json } from './harness.js';
import { array, importInBrowser, object } from './softwareSummaryUi.js';

export const ONE_RACK_XML = path.resolve('test/fixtures/parity/xml/one-rack-sr630-v3.xml');
export const SUMMARY_ROUTE = /#\/(?:rack-summary|summary)\//;
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
