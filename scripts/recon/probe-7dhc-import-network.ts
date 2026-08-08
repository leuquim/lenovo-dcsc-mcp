/**
 * Captures the full network conversation during a DCSC Web UI import so we can
 * see exactly why 7DHCCTO1WW is rejected, rather than inferring it from the modal.
 *
 * Usage: npx tsx scripts/probe-7dhc-import-network.ts [xmlName]
 */
import { chromium } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs';

const OUT_DIR = 'artifacts/import_probe';

interface Captured {
  url: string;
  method: string;
  status: number;
  reqBody?: string;
  resBody?: string;
}

async function probe(xmlName: string) {
  const xmlPath = path.resolve(`artifacts/nvidia_ai_factory_blueprints/${xmlName}`);
  const slug = xmlName.replace(/\.xml$/, '');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const captured: Captured[] = [];
  const consoleErrors: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  page.on('response', async (res) => {
    const url = res.url();
    // Only DCSC API traffic, skip static assets.
    if (!/dcsc\.lenovo\.com/.test(url)) return;
    if (/\.(js|css|png|jpg|svg|woff2?|ico)(\?|$)/.test(url)) return;

    const entry: Captured = { url, method: res.request().method(), status: res.status() };
    try {
      entry.reqBody = res.request().postData()?.slice(0, 4000) ?? undefined;
    } catch {}
    try {
      const body = await res.text();
      entry.resBody = body.slice(0, 6000);
    } catch {}
    captured.push(entry);
  });

  console.log(`\n=== Probing import of ${xmlName} ===`);
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  const tile = page.locator('.start-configuration-new-new-tile:has-text("Use Prior Configuration")').first();
  await tile.click();
  await page.waitForTimeout(2000);

  // Clear traffic captured before the actual upload so the log is focused.
  captured.length = 0;

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(xmlPath);
  await page.waitForTimeout(20000);

  const url = page.url();
  const modalText = await page.evaluate(() => {
    const dialogs = Array.from(
      document.querySelectorAll(
        '.ant-modal-content, .ant-message-notice, .ant-notification-notice, .error-message, div[role="dialog"]',
      ),
    );
    return dialogs.map((d) => (d as HTMLElement).innerText).join('\n---\n');
  });
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));

  await page.screenshot({ path: `${OUT_DIR}/${slug}.png`, fullPage: true });

  console.log(`Final URL: ${url}`);
  console.log(`\n--- Modal text ---\n${modalText || '(none)'}`);
  console.log(`\n--- Console errors ---\n${consoleErrors.join('\n') || '(none)'}`);
  console.log(`\n--- API calls after upload (${captured.length}) ---`);
  for (const c of captured) {
    console.log(`\n[${c.status}] ${c.method} ${c.url}`);
    if (c.reqBody) console.log(`  REQ: ${c.reqBody.slice(0, 600)}`);
    if (c.resBody) console.log(`  RES: ${c.resBody.slice(0, 1200)}`);
  }

  fs.writeFileSync(
    `${OUT_DIR}/${slug}.json`,
    JSON.stringify({ xmlName, finalUrl: url, modalText, bodyText, consoleErrors, captured }, null, 2),
  );
  console.log(`\nSaved full capture to ${OUT_DIR}/${slug}.json`);

  await browser.close();
}

const arg = process.argv[2] ?? 'nvidia-blueprint-7dhccto1ww.xml';
probe(arg).catch((e) => {
  console.error(e);
  process.exit(1);
});
