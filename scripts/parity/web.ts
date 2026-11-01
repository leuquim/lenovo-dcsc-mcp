import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import type { Json } from './mcp.js';

export { openBrowserImportHome, selectBrowserSolutionMode } from './browser.js';

export const DCSC_HOME = 'https://dcsc.lenovo.com/';
const CFXML_IMPORT_PATH = '/multiple/cfxml_import';

export function createWeb(outDir: string) {
  let browser: Browser | undefined;
  const contexts: BrowserContext[] = [];

  const newPage = async (): Promise<Page> => {
    browser ??= await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 }, serviceWorkers: 'block', acceptDownloads: true,
    });
    contexts.push(context);
    return context.newPage();
  };

  return {
    newPage,
    /** Imports a CFXML file through the native landing page in a fresh context and returns the import response. */
    async importCfxml(file: string, label: string): Promise<Json> {
      const page = await newPage();
      await page.goto(DCSC_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const input = page.locator('input[type="file"]').first();
      await input.waitFor({ state: 'attached', timeout: 60_000 });
      const pending = page.waitForResponse(response =>
        response.url().includes(CFXML_IMPORT_PATH) && response.request().method() === 'POST', { timeout: 180_000 });
      await input.setInputFiles(file);
      const response = await pending;
      if (response.status() !== 200) throw new Error(`Browser import returned HTTP ${response.status()}.`);
      const raw = await response.json() as unknown;
      await writeFile(path.join(outDir, `${label}-browser-import.json`), JSON.stringify(raw, null, 2));
      await page.context().close();
      const body = Array.isArray(raw) ? raw[0] : raw;
      return body && typeof body === 'object' ? body as Json : {};
    },
    async close(): Promise<void> {
      await Promise.allSettled(contexts.map(context => context.close()));
      await browser?.close();
    },
  };
}
export type Web = ReturnType<typeof createWeb>;
