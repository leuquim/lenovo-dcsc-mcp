import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import type { Json } from './mcp.js';

export { openBrowserImportHome, selectBrowserSolutionMode } from './browser.js';

export const DCSC_HOME = 'https://dcsc.lenovo.com/';
const CFXML_IMPORT_PATH = '/multiple/cfxml_import';

/** Reads the import response body through CDP: Playwright discards it when the SPA navigates away, and Chromium's default buffer truncates large ones. */
export async function watchImportResponse(page: Page): Promise<{ response: Promise<{ status: number; raw: unknown }> }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable', { maxTotalBufferSize: 256 * 1024 * 1024, maxResourceBufferSize: 128 * 1024 * 1024 });
  let timer: NodeJS.Timeout | undefined;
  const response = new Promise<{ status: number; raw: unknown }>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Browser import response timed out.')), 180_000);
    const imports = new Set<string>();
    cdp.on('Network.responseReceived', event => {
      if (!event.response.url.includes(CFXML_IMPORT_PATH)) return;
      if (event.response.status === 200) imports.add(event.requestId);
      else resolve({ status: event.response.status, raw: undefined });
    });
    cdp.on('Network.loadingFinished', event => {
      if (!imports.has(event.requestId)) return;
      cdp.send('Network.getResponseBody', { requestId: event.requestId })
        .then(({ body, base64Encoded }) => resolve({ status: 200, raw: JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body) as unknown }), reject);
    });
    cdp.on('Network.loadingFailed', event => {
      if (imports.has(event.requestId)) reject(new Error(`Browser import failed: ${event.errorText}`));
    });
  });
  // Handled here too, so a failed upload that never awaits the response leaves no unhandled rejection.
  response.catch(() => undefined).finally(() => {
    clearTimeout(timer);
    void cdp.detach().catch(() => undefined);
  });
  return { response };
}

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
      const { response } = await watchImportResponse(page);
      await input.setInputFiles(file);
      const { status, raw } = await response;
      if (status !== 200) throw new Error(`Browser import returned HTTP ${status}.`);
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
