/** Services page primitives of the DCSC web app. */
import assert from 'node:assert/strict';
import type { Page, Request } from 'playwright';

import type { Json } from './mcp.js';
import { openHome, settle } from './settingsUi.js';
import { DCSC_HOME } from './web.js';

export const SERVICE_PRODUCT = '7D73CTO1WW';
const SERVICE_PRODUCT_SEARCH = '7D73';
const DERIVE_PATH = '/api/services/autoDerive';
const SERVICE_POST_PATTERN = /\/api\/(?:services|service_pacs)\//;

/** Opens Services > Select Services and picks the product, returning the launch derive and catalog responses. */
export async function openServiceProduct(page: Page): Promise<{ derive: Json; catalog: Json; productSearch: string[] }> {
  page.setDefaultTimeout(90_000);
  await openHome(page, `${DCSC_HOME}#/services`);
  await page.waitForTimeout(2_500);
  await page.getByText('Select Services', { exact: true }).click();
  await settle(page);
  await page.locator('#selectMode').fill(SERVICE_PRODUCT_SEARCH);
  await page.waitForTimeout(800);
  const productSearch = (await page.locator('.ant-select-dropdown-menu-item').allInnerTexts())
    .flatMap(text => /^\s*(\S+)/.exec(text)?.[1] ?? []);
  const derivePending = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes(DERIVE_PATH), { timeout: 120_000 });
  const catalogPending = page.waitForResponse(response =>
    response.request().method() === 'GET' && response.url().includes(`/api/service_pacs/${SERVICE_PRODUCT}`), { timeout: 120_000 });
  await page.locator('.ant-select-dropdown-menu-item').filter({ hasText: new RegExp(SERVICE_PRODUCT) }).first().click();
  const [derive, catalog] = await Promise.all([derivePending, catalogPending]);
  assert.equal(derive.status(), 200);
  assert.equal(catalog.status(), 200);
  await settle(page);
  return { derive: await derive.json() as Json, catalog: await catalog.json() as Json, productSearch };
}

/** Clicks a service code, which selects or (on a selected add-on) removes it. */
export async function toggleService(page: Page, code: string): Promise<void> {
  const pending = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes(DERIVE_PATH), { timeout: 120_000 });
  await page.getByText(code, { exact: true }).first().click();
  const response = await pending;
  assert.equal(response.status(), 200, `Service ${code} returned HTTP ${response.status()}.`);
  await settle(page);
}

/** Opens the service summary and returns its authoritative response. */
export async function openServiceSummary(page: Page): Promise<unknown> {
  const pending = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes('/api/services/summaries'), { timeout: 120_000 });
  await page.getByRole('button', { name: 'Summary' }).click();
  const response = await pending;
  assert.equal(response.status(), 200);
  await page.waitForURL(/#\/summary\/service$/, { timeout: 90_000 });
  await settle(page);
  return await response.json() as unknown;
}

/** Clicks a button that downloads an archive and saves it. */
export async function downloadByClick(page: Page, click: () => Promise<unknown>, savePath: string): Promise<void> {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), click()]);
  await download.saveAs(savePath);
}

/** Native product-quantity clicks on the summary; counts the service POSTs they trigger. */
export async function clickProductQuantity(page: Page, control: 'control-add' | 'control-minus', expected: string):
Promise<{ value: string; servicePosts: number }> {
  const quantity = page.locator('.workspace-tab__quantity');
  let servicePosts = 0;
  const count = (request: Request): void => {
    if (request.method() === 'POST' && SERVICE_POST_PATTERN.test(request.url())) servicePosts += 1;
  };
  page.on('request', count);
  await quantity.locator(`.${control}`).click();
  await page.waitForFunction(value =>
    (document.querySelector('.workspace-tab__quantity .quantity-input') as HTMLInputElement | null)?.value === value, expected);
  await page.waitForTimeout(750);
  page.off('request', count);
  return { value: await quantity.locator('.quantity-input').inputValue(), servicePosts };
}
