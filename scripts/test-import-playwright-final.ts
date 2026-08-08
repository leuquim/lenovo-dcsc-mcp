import { chromium } from 'playwright';
import type { Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const outputDir = path.resolve('artifacts/e2e_import_validation');
  fs.mkdirSync(outputDir, { recursive: true });

  const xmlPath = path.resolve('artifacts/mcp-export-test.xml');
  console.log(`Validating XML file import at ${xmlPath}...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const apiCalls: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  page.on('pageerror', (err) => {
    pageErrors.push(err.stack || err.message);
  });

  page.on('request', (req: Request) => {
    if (req.url().includes('/api/')) {
      apiCalls.push(`[${req.method()}] ${req.url()}`);
    }
  });

  console.log('Navigating to DCSC homepage...');
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(3000);

  // Close banners
  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  // Click "Use Prior Configuration" tile
  console.log('Clicking "Use Prior Configuration" tile...');
  const tile = page.locator('.start-configuration-new-new-tile:has-text("Use Prior Configuration")').first();
  await tile.click();
  await page.waitForTimeout(3000);

  await page.screenshot({ path: path.join(outputDir, '1-prior-config-card.png') });

  // Locate input[type="file"] and upload XML
  const fileInput = page.locator('input[type="file"]').first();
  console.log('Uploading mcp-export-test.xml to DCSC Web UI...');
  await fileInput.setInputFiles(xmlPath);
  await page.waitForTimeout(8000);

  await page.screenshot({ path: path.join(outputDir, '2-after-xml-upload.png') });

  // Check if DCSC navigated to configurator / summary page or opened loaded configuration
  const pageUrl = page.url();
  console.log('Current URL after XML import:', pageUrl);

  fs.writeFileSync(path.join(outputDir, 'console_errors.json'), JSON.stringify(consoleErrors, null, 2));
  fs.writeFileSync(path.join(outputDir, 'page_errors.json'), JSON.stringify(pageErrors, null, 2));
  fs.writeFileSync(path.join(outputDir, 'api_calls.json'), JSON.stringify(apiCalls, null, 2));

  console.log(`Validation complete. Console errors: ${consoleErrors.length}, Page uncaught errors: ${pageErrors.length}`);
  await browser.close();

  if (pageErrors.length > 0) {
    console.error('Page errors encountered:', pageErrors);
  } else {
    console.log('NO UNCAUGHT BROWSER EXCEPTIONS!')
  }
}

main().catch((err) => {
  console.error('Fatal E2E test error:', err);
  process.exit(1);
});
