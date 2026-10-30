import type { Page } from 'playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Exercise the actual native UI; capture its generated export form before download. */
export async function captureUnconfiguredEdit(page: Page, out: string, expectedPrice: number): Promise<Record<string, unknown>[]> {
  const settle = async () => {
    await page.waitForLoadState('networkidle', { timeout: 60_000 });
    // The SPA performs deferred derivation/rendering after the response completes.
    await page.waitForTimeout(4000);
  };
  await page.waitForURL(/rack-summary/, { timeout: 120_000 });
  await settle();
  await page.getByText('Customize', { exact: true }).first().evaluate(e => (e as HTMLElement).click());
  await page.getByText('Unconfigured', { exact: true }).first().waitFor({ timeout: 90_000 });
  await settle();
  await page.locator('.configurator-tabs__main-tab__item').filter({ hasText: 'Unconfigured' }).click({ force: true });
  await settle();
  const software = page.locator('.configurator-tabs__sub-tab__item').filter({ hasText: 'OS & Software' });
  await software.waitFor({ timeout: 90_000 });
  await software.evaluate(e => (e as HTMLElement).click());
  const sectionTitle = page.getByText('Commvault Software', { exact: true }).first();
  await sectionTitle.waitFor({ timeout: 90_000 });
  await sectionTitle.evaluate(e => (e as HTMLElement).click());
  await settle();
  const section = page.locator('[name="UNCONFIGURED_COMMVAULT_SOFTWARE"]')
    .locator('xpath=ancestor::div[contains(@class,"ant-collapse-item")][1]');
  const quantity = section.locator('input[value="8"]').first();
  await quantity.fill('4'); await quantity.press('Tab');
  await settle();
  await writeFile(path.join(out, 'native-unconfigured-after-input.txt'), await page.locator('body').innerText());
  await writeFile(path.join(out, 'native-unconfigured-after-input.html'), await page.content());
  const price = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(expectedPrice);
  await page.getByText(price, { exact: true }).first().waitFor({ timeout: 60_000 });
  await writeFile(path.join(out, 'native-unconfigured-edited.txt'), await page.locator('body').innerText());
  await page.getByRole('button', { name: 'Summary', exact: true }).click();
  await page.waitForURL(/rack-summary/, { timeout: 120_000 }); await settle();
  await page.evaluate(() => {
    const state = window as unknown as { capturedForms: Array<{ action: string; data: Record<string, FormDataEntryValue> }> };
    state.capturedForms = [];
    HTMLFormElement.prototype.submit = function () {
      state.capturedForms.push({ action: this.action, data: Object.fromEntries(new FormData(this).entries()) });
    };
  });
  await page.getByRole('button', { name: 'Export', exact: true }).first().evaluate(e => (e as HTMLElement).click());
  const save = page.getByRole('button', { name: 'Save', exact: true }).last();
  await save.waitFor(); await save.evaluate(e => (e as HTMLElement).click());
  await page.waitForFunction(() => (window as unknown as { capturedForms: unknown[] }).capturedForms.length > 0, undefined, { timeout: 30_000 });
  const forms = await page.evaluate(() => (window as unknown as { capturedForms: Array<{ data: Record<string, string> }> }).capturedForms);
  await writeFile(path.join(out, 'native-unconfigured-export.json'), JSON.stringify(forms, null, 2));
  return JSON.parse(forms[0]!.data['groups']!) as Record<string, unknown>[];
}
