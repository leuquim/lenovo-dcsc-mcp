import { chromium } from 'playwright';
import type { Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const outputDir = path.resolve('artifacts/captured_web_payload');
  fs.mkdirSync(outputDir, { recursive: true });

  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on('request', async (req: Request) => {
    if (req.url().includes('/export')) {
      console.log(`\n======================================================`);
      console.log(`>>> CAPTURED DCSC WEB UI EXPORT REQUEST: [${req.method()}] ${req.url()} <<<`);
      console.log(`======================================================`);
      const postData = req.postData();
      if (postData) {
        fs.writeFileSync(path.join(outputDir, 'web_export_raw_post.txt'), postData);
        try {
          const params = new URLSearchParams(postData);
          const parsedObj: Record<string, any> = {};
          params.forEach((v, k) => {
            try {
              parsedObj[k] = JSON.parse(v);
            } catch {
              parsedObj[k] = v;
            }
          });
          fs.writeFileSync(path.join(outputDir, 'web_export_parsed_data.json'), JSON.stringify(parsedObj, null, 2));
          console.log('Successfully saved parsed POST payload to web_export_parsed_data.json!');
        } catch (e) {
          console.error('Error parsing POST data:', e);
        }
      }
    }
  });

  console.log('Navigating to SR630 V3 CTO configurator...');
  await page.goto('https://dcsc.lenovo.com/#/configuration/cto/7D73CTO1WW?hardwareType=server', {
    waitUntil: 'networkidle',
    timeout: 45000,
  });
  await page.waitForTimeout(10000);

  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  // 1. Click Summary button in action bar
  console.log('Step 1: Clicking "Summary" button...');
  const summaryBtn = page.locator('button:has-text("Summary")').first();
  await summaryBtn.waitFor({ state: 'visible', timeout: 15000 });
  await summaryBtn.click();
  await page.waitForTimeout(4000);

  await page.screenshot({ path: path.join(outputDir, '1-summary-step.png') });

  // 2. Click Export button in top right action bar
  console.log('Step 2: Clicking "Export" button...');
  const exportBtn = page.locator('button.action-button:has-text("Export"), button:has-text("Export")').first();
  await exportBtn.waitFor({ state: 'visible', timeout: 10000 });
  await exportBtn.click();
  await page.waitForTimeout(2000);

  await page.screenshot({ path: path.join(outputDir, '2-export-dropdown-step.png') });

  // 3. Click "Configuration" in the dropdown list
  console.log('Step 3: Clicking "Configuration" option in dropdown...');
  const configItem = page.locator('span:text-is("Configuration"), li:text-is("Configuration"), .ant-dropdown-menu-item:has-text("Configuration")').first();
  await configItem.waitFor({ state: 'visible', timeout: 8000 });
  await configItem.click();
  await page.waitForTimeout(3000);

  await page.screenshot({ path: path.join(outputDir, '3-configuration-clicked-step.png') });

  // 4. Check if an export modal dialog appeared
  console.log('Step 4: Checking for Export modal dialog...');
  const modalExportBtn = page.locator('.ant-modal button:has-text("Export"), .ant-modal button:has-text("OK"), button.ant-btn-primary:has-text("Export")').first();
  if (await modalExportBtn.isVisible({ timeout: 4000 })) {
    console.log('Found modal Export/OK button! Clicking...');
    await modalExportBtn.click();
    await page.waitForTimeout(8000);
  } else {
    console.log('No modal dialog detected, checking if export triggered directly...');
  }

  await page.screenshot({ path: path.join(outputDir, '4-final-step.png') });

  await browser.close();
  console.log('Capture script execution complete.');
}

main().catch((err) => {
  console.error('Fatal capture script error:', err);
  process.exit(1);
});
