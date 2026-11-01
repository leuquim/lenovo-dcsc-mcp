import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { errors, type Locator, type Page } from 'playwright';

interface SolutionModeReadinessOptions {
  diagnosticsDir: string;
  timeout?: number;
}

interface BrowserImportHomeOptions extends SolutionModeReadinessOptions {
  origin?: string;
  attempts?: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** The picker lists UI labels; the API solution mode names differ for HPC. */
const PICKER_LABELS: Record<string, string> = { 'HPC and AI - Systems': 'AI & HPC – ThinkSystem Hardware' };

function normalizeModeLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

async function dismissCookieIfPresent(page: Page, timeout = 1_500): Promise<void> {
  const close = page.locator('.dcsc-cookie-close').first();
  try {
    await close.waitFor({ state: 'visible', timeout });
  } catch (error) {
    if (error instanceof errors.TimeoutError) return;
    throw error;
  }
  await close.click();
  await close.waitFor({ state: 'hidden', timeout: 5_000 });
}

async function openHeaderModePopover(
  page: Page,
  modeTrigger: Locator,
  timeout: number,
): Promise<Locator> {
  const popover = page.locator('.ant-popover:visible')
    .filter({ has: page.locator('.header-settings') });
  const deadline = Date.now() + timeout;
  let lastTimeout: unknown;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await dismissCookieIfPresent(page, Math.min(1_500, remaining));
    if (await popover.isVisible()) return popover;
    const attemptRemaining = deadline - Date.now();
    if (attemptRemaining <= 0) break;
    const attemptTimeout = Math.min(5_000, attemptRemaining);
    try {
      await modeTrigger.click({ timeout: attemptTimeout });
      await popover.waitFor({ state: 'visible', timeout: attemptTimeout });
      return popover;
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
      lastTimeout = error;
    }
  }
  if (lastTimeout !== undefined) throw lastTimeout;
  throw new Error('Timed out before the header solution-mode popover could be opened.');
}

async function inspect(locator: Locator): Promise<unknown> {
  try {
    return await locator.evaluateAll(elements => elements.map(element => ({
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 1_000),
      outerHTML: element.outerHTML.slice(0, 8_000),
    })));
  } catch (error) {
    return { inspectionError: errorText(error) };
  }
}

async function writeReadinessDiagnostics(
  page: Page,
  requestedMode: string,
  diagnosticsDir: string,
  failure: unknown,
): Promise<void> {
  await mkdir(diagnosticsDir, { recursive: true });
  const [modeTriggers, visiblePopovers, visibleDropdowns, bodyText] = await Promise.all([
    inspect(page.locator('.mode_picker_glow')),
    inspect(page.locator('.ant-popover:visible')),
    inspect(page.locator('.ant-select-dropdown:visible')),
    page.locator('body').innerText().then(text => text.slice(0, 50_000)).catch(error =>
      `Inspection failed: ${errorText(error)}`),
  ]);
  const report = {
    requestedMode,
    url: page.url(),
    failure: errorText(failure),
    modeTriggers,
    visiblePopovers,
    visibleDropdowns,
    bodyText,
  };
  await Promise.allSettled([
    writeFile(path.join(diagnosticsDir, 'mode-readiness.json'), JSON.stringify(report, null, 2)),
    page.screenshot({ path: path.join(diagnosticsDir, 'mode-readiness.png'), fullPage: true }),
  ]);
}

/** Selects the SPA header solution mode and proves the import control is ready. */
export async function selectBrowserSolutionMode(
  page: Page,
  solutionMode: string,
  options: SolutionModeReadinessOptions,
): Promise<void> {
  const requestedMode = PICKER_LABELS[solutionMode] ?? solutionMode;
  const timeout = options.timeout ?? 30_000;
  try {
    const modeTrigger = page.locator('.mode_picker_glow').first();
    await Promise.all([
      dismissCookieIfPresent(page),
      modeTrigger.waitFor({ state: 'visible', timeout }),
    ]);
    const currentMode = normalizeModeLabel(await modeTrigger.innerText());
    if (currentMode !== normalizeModeLabel(requestedMode)) {
      const popover = await openHeaderModePopover(page, modeTrigger, timeout);
      const combobox = popover.locator('[role="combobox"]');
      await combobox.waitFor({ state: 'visible', timeout });
      await combobox.click();
      const dropdown = page.locator('.ant-select-dropdown:visible');
      await dropdown.waitFor({ state: 'visible', timeout });
      const option = dropdown.getByText(requestedMode, { exact: true });
      await option.waitFor({ state: 'visible', timeout });
      await option.click();
      const apply = popover.locator('#apply');
      await apply.waitFor({ state: 'visible', timeout });
      await apply.click();
    }
    await page.waitForFunction(expected =>
      [...document.querySelectorAll('.mode_picker_glow')].some(element => {
        const style = window.getComputedStyle(element);
        const visible = element.getClientRects().length > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
        return visible
          && (element.textContent ?? '').replace(/\s+/g, ' ').trim() === expected;
      }), normalizeModeLabel(requestedMode), { timeout });
    const fileInput = page.locator('input[type=file]').first();
    await fileInput.waitFor({ state: 'attached', timeout });
    await page.waitForFunction(() => {
      const input = document.querySelector('input[type=file]');
      return input instanceof HTMLInputElement && !input.disabled;
    }, undefined, { timeout });
  } catch (error) {
    await Promise.allSettled([
      writeReadinessDiagnostics(page, requestedMode, options.diagnosticsDir, error),
    ]);
    throw error;
  }
}

/**
 * Opens a fresh DCSC landing document and proves that its mode picker and file
 * input have mounted. A retry is limited to an HTTP 502/503/504 document or a
 * successful landing response with a genuinely blank, control-free SPA shell;
 * selector or workflow failures stay terminal and keep their diagnostics.
 */
export async function openBrowserImportHome(
  page: Page,
  requestedMode: string,
  options: BrowserImportHomeOptions,
): Promise<void> {
  const origin = options.origin ?? 'https://dcsc.lenovo.com/';
  const attempts = options.attempts ?? 2;
  const timeout = options.timeout ?? 30_000;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 2) {
    throw new Error('Browser import readiness attempts must be one or two.');
  }
  await mkdir(options.diagnosticsDir, { recursive: true });
  const lifecycle: Array<Record<string, unknown>> = [];
  let currentAttempt = 0;
  const failedRequests: Array<Record<string, unknown>> = [];
  const errorResponses: Array<Record<string, unknown>> = [];
  const consoleErrors: Array<Record<string, unknown>> = [];
  const requestFailed = (request: { url(): string; resourceType(): string; failure(): { errorText: string } | null }): void => {
    failedRequests.push({ attempt: currentAttempt, url: request.url(), resourceType: request.resourceType(),
      error: request.failure()?.errorText ?? 'unknown request failure' });
  };
  const responseFailed = (response: { status(): number; url(): string; request(): { resourceType(): string } }): void => {
    if (response.status() >= 400) errorResponses.push({ attempt: currentAttempt, status: response.status(),
      url: response.url(), resourceType: response.request().resourceType() });
  };
  const consoleFailed = (message: { type(): string; text(): string }): void => {
    if (message.type() === 'error') consoleErrors.push({ attempt: currentAttempt, text: message.text().slice(0, 8_000) });
  };
  page.on('requestfailed', requestFailed);
  page.on('response', responseFailed);
  page.on('console', consoleFailed);
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      currentAttempt = attempt;
      const startedAt = new Date().toISOString();
      const startedMs = Date.now();
      let documentStatus: number | undefined;
      let documentStatusText: string | undefined;
      let documentUrl = origin;
      let documentHeaders: Record<string, string> = {};
      let workflowStarted = false;
      try {
        const response = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90_000 });
        documentStatus = response?.status();
        documentStatusText = response?.statusText();
        documentUrl = response?.url() ?? page.url();
        const headers = await response?.allHeaders() ?? {};
        documentHeaders = Object.fromEntries(['content-type', 'server', 'x-request-id', 'x-correlation-id', 'retry-after']
          .flatMap(name => headers[name] === undefined ? [] : [[name, headers[name]!]]));
        if (documentStatus !== undefined && (documentStatus < 200 || documentStatus >= 400)) {
          throw new Error(`DCSC landing document returned HTTP ${documentStatus}.`);
        }
        await page.locator('.mode_picker_glow').first().waitFor({ state: 'visible', timeout });
        workflowStarted = true;
        await selectBrowserSolutionMode(page, requestedMode, {
          diagnosticsDir: path.join(options.diagnosticsDir, `attempt-${attempt}`),
          timeout,
        });
        lifecycle.push({ attempt, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedMs,
          documentStatus, documentStatusText, documentUrl, documentHeaders, status: 'ready' });
        await writeFile(path.join(options.diagnosticsDir, 'bootstrap-readiness.json'), JSON.stringify({
          requestedMode, origin, status: 'ready', attempts: lifecycle,
          failedRequests, errorResponses, consoleErrors,
        }, null, 2));
        return;
      } catch (error) {
        const [bodyText, modeTriggers, fileInputs] = await Promise.all([
          page.locator('body').innerText().catch(() => ''),
          page.locator('.mode_picker_glow').count().catch(() => 0),
          page.locator('input[type=file]').count().catch(() => 0),
        ]);
        const blankShell = bodyText.trim() === '' && modeTriggers === 0 && fileInputs === 0;
        const retryableStatus = documentStatus === 502 || documentStatus === 503 || documentStatus === 504;
        const successfulDocument = documentStatus !== undefined && documentStatus >= 200 && documentStatus < 400;
        const retryable = retryableStatus || successfulDocument && !workflowStarted && blankShell;
        lifecycle.push({ attempt, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedMs,
          documentStatus, documentStatusText, documentUrl, documentHeaders,
          status: 'failed', phase: workflowStarted ? 'mode-selection' : 'bootstrap',
          retryable, blankShell, modeTriggers, fileInputs,
          bodyText: bodyText.slice(0, 50_000), error: errorText(error) });
        await writeFile(path.join(options.diagnosticsDir, 'bootstrap-readiness.json'), JSON.stringify({
          requestedMode, origin, status: 'failed', attempts: lifecycle,
          failedRequests, errorResponses, consoleErrors,
        }, null, 2));
        await Promise.allSettled([
          page.content().then(content => writeFile(path.join(options.diagnosticsDir, `attempt-${attempt}.html`), content)),
          page.screenshot({ path: path.join(options.diagnosticsDir, `attempt-${attempt}.png`), fullPage: true }),
        ]);
        if (!retryable || attempt === attempts) throw error;
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10_000 });
      }
    }
  } finally {
    page.off('requestfailed', requestFailed);
    page.off('response', responseFailed);
    page.off('console', consoleFailed);
  }
  throw new Error('DCSC import readiness exhausted without a terminal result.');
}
