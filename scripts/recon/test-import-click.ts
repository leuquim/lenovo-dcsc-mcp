import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

async function testClickImport() {
  const outputDir = path.resolve('artifacts/import_click_test');
  fs.mkdirSync(outputDir, { recursive: true });

  const xmlPath = path.resolve('artifacts/mcp-export-test.xml');

  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleLogs: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => pageErrors.push(err.stack || err.message));

  console.log('Navigating to DCSC...');
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(3000);

  // Close DCSC cookie mask banner
  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  try {
    const otAccept = page.locator('#onetrust-accept-btn-handler');
    if (await otAccept.isVisible({ timeout: 2000 })) await otAccept.click();
  } catch {}
  try {
    const dontChange = page.locator('button:has-text("Dont change"), button:has-text("Don\'t change")');
    if (await dontChange.isVisible({ timeout: 2000 })) await dontChange.click();
  } catch {}

  await page.waitForTimeout(1000);

  // Click the tile directly
  console.log('Clicking "Use Prior Configuration" tile...');
  const tile = page.locator('.start-configuration-new-new-tile:has-text("Use Prior Configuration")').first();
  if (await tile.isVisible({ timeout: 5000 })) {
    await tile.click();
    console.log('Clicked tile. Waiting 3s...');
    await page.waitForTimeout(3000);
  }

  await page.screenshot({ path: path.join(outputDir, '1-after-tile-click.png') });
  console.log('Current URL:', page.url());

  // Check for any input[type="file"] or drag & drop target
  const fileInputs = page.locator('input[type="file"]');
  const fileInputCount = await fileInputs.count();
  console.log(`Found ${fileInputCount} input[type="file"] elements.`);

  if (fileInputCount > 0) {
    console.log('Uploading file to input[type="file"]...');
    await fileInputs.first().setInputFiles(xmlPath);
    await page.waitForTimeout(5000);
    await page.screenshot({ path: path.join(outputDir, '2-after-upload.png') });
  } else {
    console.log('Dumping current DOM HTML to check import form structure...');
    fs.writeFileSync(path.join(outputDir, 'import_page.html'), await page.content());
  }

  fs.writeFileSync(path.join(outputDir, 'console.json'), JSON.stringify(consoleLogs, null, 2));
  fs.writeFileSync(path.join(outputDir, 'errors.json'), JSON.stringify(pageErrors, null, 2));

  await browser.close();
}

testClickImport().catch((err) => {
  console.error('Click import error:', err);
  process.exit(1);
});
