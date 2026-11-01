/** OS & Software tab primitives of the DCSC configurator. */
import assert from 'node:assert/strict';
import type { Locator, Page, Response } from 'playwright';

import { openHome, settle, visible } from './settingsUi.js';
import { DCSC_HOME } from './web.js';

const SOFTWARE_DERIVE = /\/api\/ctos\/autoDerive(?:\?|$)/;
const TOTAL_LABEL = /^(?:total|configuration) price:?$/i;
const AMOUNT = /([$€£])\s*([0-9][0-9,.]*)/;
const CURRENCY_BY_SYMBOL: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' };

export async function clickVisible(locator: Locator, description: string): Promise<void> {
  const target = await visible(locator, description);
  await target.scrollIntoViewIfNeeded();
  await target.click({ timeout: 20_000 });
}

export async function openMicrosoftCal(page: Page): Promise<void> {
  await clickVisible(page.getByText('Microsoft', { exact: true }), 'Microsoft software tab');
  await (await visible(page.getByText('Windows Server 2025 CAL', { exact: true }), 'Windows Server 2025 CAL section label')).click();
  await page.waitForTimeout(300);
}

export async function clickCheckbox(page: Page, index: number, description: string): Promise<void> {
  const checkbox = page.locator('label.ant-checkbox-wrapper:not(.screen):visible').nth(index);
  await checkbox.waitFor({ state: 'visible', timeout: 20_000 });
  assert.equal(await checkbox.locator('input[type="checkbox"]').count(), 1, `${description} has no checkbox input.`);
  await checkbox.click();
}

export async function userCalPanel(page: Page): Promise<Locator> {
  const heading = await visible(page.getByText('Windows Server 2025 User CALs', { exact: true }), 'Windows Server 2025 User CALs group');
  return heading.locator('xpath=ancestor::*[.//*[normalize-space(text())="Reset"]][1]');
}

export async function chooseAntOption(page: Page, select: Locator, optionText: string): Promise<void> {
  await select.scrollIntoViewIfNeeded();
  await select.click();
  const dropdown = await visible(page.locator('.ant-select-dropdown:visible'), `${optionText} dropdown`);
  await clickVisible(dropdown.locator('.ant-select-dropdown-menu-item').filter({ hasText: optionText }), `${optionText} option`);
}

const isSoftwareDerive = (response: Response) =>
  response.request().method() === 'POST' && SOFTWARE_DERIVE.test(response.url())
  && new URL(response.url()).searchParams.get('isCustomizeOSSoftware') === 'true';

/** Runs a UI interaction and returns the software derive request and response it triggers. */
export async function softwareDeriveAfter(page: Page, interact: () => Promise<unknown>): Promise<{ request: Record<string, unknown>; patch: Record<string, unknown> }> {
  const pending = page.waitForResponse(isSoftwareDerive, { timeout: 90_000 });
  try {
    await interact();
  } catch (error) {
    void pending.catch(() => undefined);
    throw error;
  }
  const response = await pending;
  assert.equal(response.status(), 200, `Software derive returned ${response.status()}.`);
  const result = { request: response.request().postDataJSON() as Record<string, unknown>, patch: await response.json() as Record<string, unknown> };
  await settle(page);
  return result;
}

/** Opens the SR630 V3 configurator on its OS & Software > XClarity sub-tab. */
export async function openSoftwareTab(page: Page, productCode: string): Promise<void> {
  await openHome(page, DCSC_HOME);
  await page.goto(new URL('#/categories/STG%40Servers%40Rack%20Server%40ThinkSystem%20SR630%20V3', DCSC_HOME).href,
    { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const customize = await visible(page.locator('button:has-text("Customize"), a:has-text("Customize"), [role="button"]:has-text("Customize")'),
    'first Customize control');
  const launch = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes(`/api/ctos/${productCode}/launch`), { timeout: 90_000 });
  const initialDerive = page.waitForResponse(response =>
    response.request().method() === 'POST' && SOFTWARE_DERIVE.test(response.url())
    && new URL(response.url()).searchParams.get('isCustomizeOSSoftware') !== 'true', { timeout: 90_000 });
  await customize.click();
  const [launched, derived] = await Promise.all([launch, initialDerive]);
  assert.equal(launched.status(), 200);
  assert.equal(derived.status(), 200);
  await settle(page);
  await clickVisible(page.getByText('OS & Software', { exact: true }), 'OS & Software tab');
  await clickVisible(page.getByText('XClarity', { exact: true }), 'XClarity sub-tab');
}

/** The configuration price the page shows, polled until it reads the expected amount when one is given. */
export async function displayedTotal(page: Page, expected?: number): Promise<{ totalPrice: number; currency: string }> {
  const deadline = Date.now() + 20_000;
  let last: { totalPrice: number; currency: string } | undefined;
  while (Date.now() < deadline) {
    const lines = (await page.locator('body').innerText()).split('\n').map(line => line.trim()).filter(Boolean);
    const currency = lines.some(line => /(?:^|\W)USD(?:\W|$)/.test(line)) ? 'USD' : '';
    for (let index = 0; index < lines.length; index += 1) {
      if (!TOTAL_LABEL.test(lines[index] ?? '')) continue;
      const match = lines.slice(index + 1, index + 5).map(line => AMOUNT.exec(line)).find(Boolean);
      if (!match) continue;
      last = { totalPrice: Math.round(Number(match[2]!.replace(/,/g, '')) * 100) / 100,
        currency: currency || CURRENCY_BY_SYMBOL[match[1]!] || match[1]! };
      break;
    }
    if (last && (expected === undefined || last.totalPrice === expected)) return last;
    await page.waitForTimeout(250);
  }
  return last ?? { totalPrice: Number.NaN, currency: '' };
}
