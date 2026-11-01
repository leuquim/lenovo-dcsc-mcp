/** Header Settings and locale primitives of the DCSC web app. */
import type { Locator, Page } from 'playwright';

const VISIBLE_DEADLINE_MS = 45_000;
const POLL_MS = 200;
const SETTLE_MS = 700;
const WITHDRAWN_OPTION_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

export async function visible(locator: Locator, description: string): Promise<Locator> {
  const deadline = Date.now() + VISIBLE_DEADLINE_MS;
  while (Date.now() < deadline) {
    for (let index = 0; index < await locator.count(); index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`Could not find visible ${description}.`);
}

export async function settle(page: Page): Promise<void> {
  await page.locator('.ant-spin-spinning:visible').first()
    .waitFor({ state: 'hidden', timeout: VISIBLE_DEADLINE_MS }).catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
}

export async function openHome(page: Page, origin: string): Promise<void> {
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await settle(page);
  const cookie = page.locator('.dcsc-cookie-close').first();
  if (await cookie.isVisible({ timeout: 1_000 }).catch(() => false)) await cookie.click();
}

/** Switches the locale popover to Germany, English, EUR and saves it. */
export async function setGermanEnglishEuro(page: Page, origin: string): Promise<void> {
  await openHome(page, origin);
  await (await visible(page.getByText('/ English / USD', { exact: true }), 'locale preferences')).click();
  await page.locator('.country .ant-select-selection').click();
  await (await visible(page.locator('.ant-select-dropdown:visible').getByText('Germany', { exact: true }), 'Germany option')).click();
  await page.locator('.language .ant-select-selection').click();
  await (await visible(page.locator('.ant-select-dropdown:visible').getByText('English', { exact: true }), 'English option')).click();
  await page.getByRole('button', { name: 'Save Preferences' }).click();
  await settle(page);
  await visible(page.getByText('/ English / EUR', { exact: true }), 'DE/EUR locale marker');
}

/**
 * Picks the n-th "Include products and parts withdrawn since" option of the Settings popover
 * (0 is "Available ONLY") and returns its date as YYYY-MM-DD.
 */
export async function chooseWithdrawnSince(page: Page, optionIndex: number): Promise<string> {
  await page.getByText('Settings', { exact: true }).first().click();
  const popover = page.locator('.ant-popover:visible').filter({ hasText: 'Available ONLY' }).first();
  await popover.locator('[role=combobox]').click();
  const option = page.locator('.ant-select-dropdown:visible li').nth(optionIndex);
  const label = (await option.innerText()).trim();
  const date = WITHDRAWN_OPTION_DATE.exec(label);
  if (!date) throw new Error(`Withdrawn-since option "${label}" is not a MM/DD/YYYY date.`);
  await option.click();
  return `${date[3]}-${date[1]}-${date[2]}`;
}
