/** Rack summary page flows for hardware plus standalone software workspaces (CTO and LFO). */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { Locator, Page } from 'playwright';

import { captureBrowserExport as exportThroughDialog, CAPTURE_EXPORT_FORMS, readGrandTotal } from './exportUi.js';
import { settle, visible } from './settingsUi.js';
import { DCSC_HOME } from './web.js';

export type Json = Record<string, unknown>;
export type ExportCapture = { path: string; fields: Record<string, string> };
type CommercialProduct = { code: string; type: string; quantity: number; price: number | null; unitPrice: number | null };
type XmlProduct = {
  code: string; type: string; quantity: number; unitPrice: number;
  children: Array<{ code: string; type: string; quantity: number; unitPrice: number }>;
};

export const SOFTWARE_CODE = '7S1S002WWW';
const HARDWARE_CODE = 'BFYB';
const HARDWARE_DESCRIPTION = 'Operating mode selection for: "Maximum Performance Mode"';

export const object = (value: unknown): Json => typeof value === 'object' && value !== null ? value as Json : {};
export const array = (value: unknown): unknown[] => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string => value === undefined || value === null ? '' : String(value);
export function money(value: unknown): number {
  const amount = Number(value);
  assert(Number.isFinite(amount), `Expected a finite monetary value, received ${String(value)}.`);
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** Imports an XML file in the given page (which must carry the export-form capture script) and waits for the summary. */
export async function importInBrowser(page: Page, xmlPath: string, summaryRoute: RegExp): Promise<{ response: unknown; total: number }> {
  page.setDefaultTimeout(90_000);
  await page.addInitScript({ content: CAPTURE_EXPORT_FORMS });
  await page.goto(DCSC_HOME, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const file = page.locator('input[type=file]').first();
  await file.waitFor({ state: 'attached', timeout: 60_000 });
  const pending = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes('/multiple/cfxml_import'), { timeout: 120_000 });
  await file.setInputFiles(xmlPath);
  const response = await pending;
  assert.equal(response.status(), 200, `Browser import returned HTTP ${response.status()}.`);
  const imported = await response.json() as unknown;
  await page.waitForURL(summaryRoute, { timeout: 90_000 });
  await settle(page);
  const cookie = page.locator('.dcsc-cookie-close').first();
  if (await cookie.isVisible({ timeout: 1_000 }).catch(() => false)) await cookie.click();
  return { response: imported, total: await readGrandTotal(page) };
}

async function visibleCustomize(page: Page, last: boolean): Promise<Locator> {
  const customizes = page.getByText('Customize', { exact: true });
  await visible(customizes, 'summary Customize action');
  const candidates: Locator[] = [];
  for (let index = 0; index < await customizes.count(); index += 1) {
    if (await customizes.nth(index).isVisible()) candidates.push(customizes.nth(index));
  }
  const target = last ? candidates.at(-1) : candidates[0];
  assert(target, 'Summary did not expose a visible Customize action.');
  return target;
}

async function selectSoftwareQuantityOnCatalog(page: Page, quantity: number, summaryRoute: RegExp): Promise<void> {
  const row = page.locator('.software-feature').filter({
    has: page.locator('.software-feature__code').filter({ hasText: new RegExp(`^${SOFTWARE_CODE}$`) }),
  });
  assert.equal(await row.count(), 1, `Could not isolate ${SOFTWARE_CODE} software row.`);
  await (await visible(row.getByRole('combobox'), `${SOFTWARE_CODE} quantity selector`)).click();
  await (await visible(page.locator('.ant-select-dropdown:visible .ant-select-dropdown-menu-item')
    .filter({ hasText: new RegExp(`^${quantity}$`) }), `software quantity ${quantity}`)).click();
  await settle(page);
  await (await visible(page.getByRole('button', { name: 'Summary' }), 'software Summary button')).click();
  await page.waitForURL(summaryRoute, { timeout: 90_000 });
  await settle(page);
}

/** Summary > standalone software Customize > pick a quantity > back to the summary. */
export async function setBrowserSoftwareQuantity(page: Page, quantity: number, summaryRoute: RegExp): Promise<void> {
  await (await visibleCustomize(page, true)).click();
  await page.waitForURL(/#\/software(?:\?|$)/, { timeout: 90_000 });
  await settle(page);
  await selectSoftwareQuantityOnCatalog(page, quantity, summaryRoute);
}

/** Product Catalog > Software on the summary of a hardware-only workspace. */
export async function composeBrowserSoftware(page: Page, quantity: number, summaryRoute: RegExp): Promise<void> {
  await (await visible(page.getByText('Show Product Catalog', { exact: true }), 'Show Product Catalog action')).click();
  await (await visible(page.getByText('Software', { exact: true }), 'Software catalog category')).click();
  await page.waitForURL(/#\/software(?:\?|$)/, { timeout: 90_000 });
  await settle(page);
  await selectSoftwareQuantityOnCatalog(page, quantity, summaryRoute);
}

const selectedQuantity = (configuration: Json, code: string): number => {
  const result = array(configuration['tabs']).flatMap(tab => array(object(tab)['subTabs']))
    .flatMap(tab => array(object(tab)['sections'])).flatMap(section => array(object(section)['results']))
    .map(object).find(item => text(item['code']) === code);
  return Number(result?.['quantity'] ?? 0);
};

/** LFO hardware Customize > the Maximum Performance Mode option > back to the summary. */
export async function setBrowserHardwareOption(
  page: Page,
  outDir: string,
  routes: {
    derivePath?: '/lfos/autoDerive' | '/ctos/autoDerive';
    configuration?: RegExp;
    summary?: RegExp;
    expectInitialDerive?: boolean;
  } = {},
): Promise<{ query: Json; request: Json; response: Json; totalPrice: number; price: number }> {
  const derivePath = routes.derivePath ?? '/lfos/autoDerive';
  const hardware = await visibleCustomize(page, false);
  const initial = routes.expectInitialDerive === false ? undefined : page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes(derivePath), { timeout: 120_000 });
  await hardware.click();
  await page.waitForURL(routes.configuration ?? /#\/configuration\/lfo\//, { timeout: 90_000 });
  if (initial) assert.equal((await initial).status(), 200, 'Browser LFO customization launch failed.');
  await settle(page);
  const description = await visible(page.getByText(HARDWARE_DESCRIPTION, { exact: true }), HARDWARE_DESCRIPTION);
  const input = description.locator('xpath=ancestor::*[.//input[@type="radio"]][1]//input[@type="radio"]');
  assert.equal(await input.count(), 1, `Could not isolate the ${HARDWARE_CODE} radio input.`);
  const pending = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes(derivePath), { timeout: 120_000 });
  await input.click();
  const derive = await pending;
  assert.equal(derive.status(), 200, `Browser LFO hardware edit returned HTTP ${derive.status()}.`);
  const request = derive.request().postDataJSON() as Json;
  const response = object(await derive.json());
  const url = new URL(derive.url());
  const query: Json = {
    configurationId: url.searchParams.get('configurationId'),
    entranceFlag: url.searchParams.get('entranceFlag'),
    ...(url.searchParams.has('guideMode') ? { guideMode: url.searchParams.get('guideMode') === 'true' } : {}),
    ...(url.searchParams.has('isLfo') ? { isLfo: url.searchParams.get('isLfo') === 'true' } : {}),
    ...(url.searchParams.has('scope') ? { scope: url.searchParams.get('scope') } : {}),
  };
  await writeFile(path.join(outDir, 'browser-lfo-hardware-request.json'), `${JSON.stringify(request, null, 2)}\n`);
  await writeFile(path.join(outDir, 'browser-lfo-hardware-response.json'), `${JSON.stringify(response, null, 2)}\n`);
  await settle(page);
  const configuration = object(array(response['configurations'])[0]);
  assert.equal(selectedQuantity(configuration, HARDWARE_CODE), 1, `Browser response did not select ${HARDWARE_CODE}.`);
  await (await visible(page.getByRole('button', { name: 'Summary' }), 'hardware Summary button')).click();
  await page.waitForURL(routes.summary ?? /#\/rack-summary\/rack-lfo/, { timeout: 90_000 });
  await settle(page);
  return {
    query, request, response,
    totalPrice: money(configuration['totalPrice']),
    price: money(configuration['price'] ?? object(array(configuration['totalPrices'])[0])['price']),
  };
}

/** Summary Export dialog capture with the form's decoded groups and data alongside the archive. */
export async function captureBrowserExport(page: Page, outDir: string, name: string) {
  const exported = await exportThroughDialog(page, outDir, name);
  return {
    capture: exported.form, archive: exported.archive, xmlPath: exported.xmlPath, xml: exported.xml,
    groups: JSON.parse(exported.form.fields['groups'] ?? '[]') as unknown,
    data: object(JSON.parse(exported.form.fields['data'] ?? '{}')),
  };
}

const compareProduct = (left: CommercialProduct, right: CommercialProduct) =>
  left.type.localeCompare(right.type) || left.code.localeCompare(right.code) ||
  left.quantity - right.quantity || Number(left.unitPrice ?? -1) - Number(right.unitPrice ?? -1);

export function normalizedGroups(value: unknown): CommercialProduct[] {
  return array(value).flatMap(group => array(object(group)['products'])).map(raw => {
    const product = object(raw);
    return {
      code: text(product['code']).replaceAll('-', ''),
      type: text(product['type']).toLowerCase(),
      quantity: Number(product['quantity'] ?? 0),
      price: product['price'] === null || product['price'] === undefined ? null : money(product['price']),
      unitPrice: product['unitPrice'] === null || product['unitPrice'] === undefined ? null : money(product['unitPrice']),
    };
  }).sort(compareProduct);
}

const compareXml = (left: { type: string; code: string; quantity: number; unitPrice: number },
  right: { type: string; code: string; quantity: number; unitPrice: number }) =>
  left.type.localeCompare(right.type) || left.code.localeCompare(right.code) ||
  left.quantity - right.quantity || left.unitPrice - right.unitPrice;

export function normalizedXml(xml: string): XmlProduct[] {
  const parsed = object(new XMLParser({ ignoreAttributes: false, parseTagValue: true }).parse(xml));
  const line = (raw: unknown) => {
    const item = object(raw);
    const identity = object(object(item['ProductIdentification'])['PartnerProductIdentification']);
    return {
      code: text(identity['ProprietaryProductIdentifier']).replaceAll('-', ''),
      type: text(identity['ProductTypeCode']),
      quantity: Number(item['Quantity'] ?? 0),
      unitPrice: money(object(object(item['UnitListPrice'])['FinancialAmount'])['MonetaryAmount'] ?? 0),
    };
  };
  return array(object(object(parsed['CFXML'])['CFData'])['ProductLineItem']).map(raw => ({
    ...line(raw),
    children: array(object(raw)['ProductSubLineItem']).map(line).sort(compareXml),
  })).sort(compareXml);
}
