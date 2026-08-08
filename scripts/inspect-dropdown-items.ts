import { chromium } from 'playwright';
import type { Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const outputDir = path.resolve('artifacts/dropdown_inspection');
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on('request', async (req: Request) => {
    if (req.url().includes('/export')) {
      console.log(`\n======================================================`);
      console.log(`>>> CAPTURED REQUEST: [${req.method()}] ${req.url()} <<<`);
      console.log(`======================================================`);
      const postData = req.postData();
      if (postData) {
        fs.writeFileSync(path.join(outputDir, 'web_export_raw_post.txt'), postData);
        try {
          const params = new URLSearchParams(postData);
          const parsed: Record<string, any> = {};
          params.forEach((v, k) => {
            try { parsed[k] = JSON.parse(v); } catch { parsed[k] = v; }
          });
          fs.writeFileSync(path.join(outputDir, 'web_export_parsed_data.json'), JSON.stringify(parsed, null, 2));
          console.log('Saved parsed POST data!');
        } catch (e) {}
      }
    }
  });

  console.log('Navigating to SR630 V3 CTO configurator...');
  await page.goto('https://dcsc.lenovo.com/#/configuration/cto/7D73CTO1WW?hardwareType=server', {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(8000);

  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  const summaryBtn = page.locator('button:has-text("Summary")').first();
  if (await summaryBtn.isVisible({ timeout: 5000 })) {
    await summaryBtn.click();
    await page.waitForTimeout(5000);
  }

  // Click Export dropdown
  const exportBtn = page.locator('button.action-button:has-text("Export"), button:has-text("Export")').first();
  if (await exportBtn.isVisible({ timeout: 5000 })) {
    await exportBtn.click();
    await page.waitForTimeout(2000);
  }

  // Save screenshot of dropdown open
  await page.screenshot({ path: path.join(outputDir, 'dropdown-open.png') });

  // Find all dropdown menu items in DOM
  const menuItems = page.locator('.ant-dropdown-menu-item, li[role="menuitem"], .ant-dropdown li');
  const count = await menuItems.count();
  console.log(`Found ${count} menu items in ant-dropdown:`);

  for (let i = 0; i < count; i++) {
    const text = (await menuItems.nth(i).textContent())?.trim();
    console.log(`Menu Item ${i}: "${text}"`);
  }

  // If item 0 or 'Quote' / 'Configuration' exists, click item 0
  if (count > 0) {
    console.log('Clicking Menu Item 0...');
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    await menuItems.first().click();
    await page.waitForTimeout(5000);
    
    await page.screenshot({ path: path.join(outputDir, 'after-menu-click.png') });

    const download = await downloadPromise;
    if (download) {
      const zipPath = path.join(outputDir, 'official_web_export.zip');
      await download.saveAs(zipPath);
      console.log(`Saved official Web UI zip to ${zipPath}`);
    }
  }

  await browser.close();
  console.log('Done.');
}

main().catch(console.error);
