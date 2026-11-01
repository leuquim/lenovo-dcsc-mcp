/** The summary page's Export dialog: capturing the browser-authored export form and archive. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';

import { zipText } from './archives.js';
import { visible } from './settingsUi.js';

export interface CapturedForm { path: string; fields: Record<string, string> }

/** Init script that records the hidden export forms the SPA submits instead of navigating to them. */
export const CAPTURE_EXPORT_FORMS = `
  globalThis.__dcscAuditForms = [];
  HTMLFormElement.prototype.submit = function () {
    const fields = {};
    this.querySelectorAll('input').forEach(input => { fields[input.name] = input.value; });
    globalThis.__dcscAuditForms.push({ path: this.action, fields });
  };
`;

export const auditForms = (page: Page): Promise<CapturedForm[]> =>
  page.evaluate(() => (globalThis as unknown as { __dcscAuditForms?: CapturedForm[] }).__dcscAuditForms ?? []);

/** Exports XML (or every offered type) through the summary Export dialog and returns the form it posted plus the archive it produced. */
export async function captureBrowserExport(page: Page, out: string, name: string, options: { allTypes?: boolean; archiveName?: string } = {}) {
  await (await visible(page.getByRole('button', { name: 'Export' }), 'Export button')).evaluate(element => (element as HTMLElement).click());
  await visible(page.locator('button.ant-btn-primary').filter({ hasText: /^Save$/ }), 'export Save button');
  if (options.allTypes) {
    const boxes = page.locator('.ant-modal:visible label.ant-checkbox-wrapper');
    for (let index = 0; index < await boxes.count(); index += 1) {
      const label = boxes.nth(index);
      if (!(await label.locator('input[type=checkbox]').isChecked())) await label.click();
    }
  } else {
    const xmlChoice = await visible(page.getByText('XML', { exact: true }), 'XML export choice');
    const box = xmlChoice.locator('xpath=ancestor::*[self::label or contains(@class,"checkbox") or .//input[@type="checkbox"]][1]')
      .locator('input[type=checkbox]');
    if (!(await box.count()) || !(await box.isChecked())) await xmlChoice.click();
  }
  const filename = page.locator('input.ant-input[type=text]').last();
  if (await filename.count()) await filename.fill(name);
  const before = (await auditForms(page)).length;
  await page.locator('button.ant-btn-primary').filter({ hasText: /^Save$/ }).last().click();
  await page.waitForTimeout(800);
  const form = (await auditForms(page)).slice(before).find(candidate => candidate.path.includes('/export_zip'));
  assert(form, `${name}: browser did not submit its export form.`);
  const response = await page.context().request.post(form.path, { form: form.fields, timeout: 120_000 });
  assert(response.ok(), `${name}: browser export returned HTTP ${response.status()}.`);
  const archive = path.join(out, `${options.archiveName ?? name}.zip`);
  await writeFile(archive, await response.body());
  const xml = await zipText(archive, '.xml');
  const xmlPath = path.join(out, `${options.archiveName ?? name}.xml`);
  await writeFile(xmlPath, xml);
  return { form, archive, xml, xmlPath };
}

/** The Grand Total of the rack summary page. */
export async function readGrandTotal(page: Page): Promise<number> {
  const lines = (await page.locator('body').innerText()).split('\n').map(line => line.trim()).filter(Boolean);
  const label = lines.findIndex(line => /^grand total:?$/i.test(line));
  assert(label >= 0, 'Browser summary omitted Grand Total.');
  for (const line of lines.slice(label + 1, label + 5)) {
    const match = /[$€£]\s*([0-9][0-9,.]*)/.exec(line);
    if (match) return Math.round(Number(match[1]!.replace(/,/g, '')) * 100) / 100;
  }
  throw new Error('Could not read browser Grand Total.');
}
