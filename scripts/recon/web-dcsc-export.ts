import { chromium } from 'playwright';
import type { Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as yauzl from 'yauzl';

async function main() {
  const outputDir = path.resolve('artifacts/web_dcsc_export');
  fs.mkdirSync(outputDir, { recursive: true });

  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on('request', async (req: Request) => {
    if (req.url().includes('/export_zip')) {
      console.log('>>> CAPTURED /export_zip REQUEST! <<<');
      const postData = req.postData();
      if (postData) {
        fs.writeFileSync(path.join(outputDir, 'web_export_raw_post.txt'), postData);
        try {
          const params = new URLSearchParams(postData);
          const parsed: Record<string, any> = {};
          params.forEach((v, k) => {
            try { parsed[k] = JSON.parse(v); } catch { parsed[k] = v; }
          });
          fs.writeFileSync(path.join(outputDir, 'web_export_parsed_post.json'), JSON.stringify(parsed, null, 2));
          console.log('Saved parsed /export_zip payload!');
        } catch (e) {}
      }
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

  const searchBox = page.locator('input[placeholder*="Search"], input[type="text"]').first();
  if (await searchBox.isVisible({ timeout: 3000 })) {
    await searchBox.fill('7D73CTO1WW');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4000);
  }

  const selectBtn = page.locator('button:has-text("Select"), button:has-text("Configure")').first();
  if (await selectBtn.isVisible({ timeout: 5000 })) {
    console.log('Clicking Select/Configure...');
    await selectBtn.click();
    await page.waitForTimeout(12000);
  }

  // Dump all clickable elements in top bar / action bar
  const buttons = page.locator('button, a, div.header__topbar__utils__item, span');
  const bCount = await buttons.count();
  console.log(`Found ${bCount} clickable elements.`);

  for (let i = 0; i < Math.min(bCount, 100); i++) {
    const text = (await buttons.nth(i).textContent())?.trim();
    if (text && (text.includes('Export') || text.includes('Download') || text.includes('Tools') || text.includes('Save'))) {
      console.log(`Element ${i}: "${text}"`);
    }
  }

  // Save current DOM HTML & screenshot
  fs.writeFileSync(path.join(outputDir, 'configurator_page.html'), await page.content());
  await page.screenshot({ path: path.join(outputDir, 'configurator_state.png') });

  // Try clicking Export or Export icon
  const exportTarget = page.locator('text="Export", i.anticon-download, span:has-text("Export")').first();
  if (await exportTarget.isVisible({ timeout: 5000 })) {
    console.log('Found Export target! Clicking...');
    await exportTarget.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(outputDir, 'after_export_click.png') });
  }

  await browser.close();
  console.log('Finished.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
