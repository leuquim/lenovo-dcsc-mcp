import { chromium } from 'playwright';
import type { Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const outputDir = path.resolve('artifacts/official_captured_export');
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on('request', async (req: Request) => {
    if (req.url().includes('/export_zip') || req.url().includes('/export')) {
      console.log(`\n>>> CAPTURED REQUEST: [${req.method()}] ${req.url()} <<<`);
      const postData = req.postData();
      if (postData) {
        fs.writeFileSync(path.join(outputDir, 'web_export_raw_post.txt'), postData);
        try {
          const params = new URLSearchParams(postData);
          const parsedObj: Record<string, any> = {};
          params.forEach((v, k) => {
            try { parsedObj[k] = JSON.parse(v); } catch { parsedObj[k] = v; }
          });
          fs.writeFileSync(path.join(outputDir, 'web_export_parsed_data.json'), JSON.stringify(parsedObj, null, 2));
          console.log('Saved parsed POST payload to web_export_parsed_data.json');
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

  // Click Summary
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

  // Click Configuration option in dropdown
  const configOption = page.locator('span:has-text("Configuration"), div:has-text("Configuration")').last();
  if (await configOption.isVisible({ timeout: 3000 })) {
    console.log('Clicking Configuration option...');
    await configOption.click();
    await page.waitForTimeout(4000);
  }

  await page.screenshot({ path: path.join(outputDir, '2-after-configuration-click.png') });

  // Log all visible buttons on screen now
  const buttons = page.locator('button, a, input');
  const count = await buttons.count();
  console.log(`Found ${count} buttons/inputs after clicking Configuration:`);

  for (let i = 0; i < count; i++) {
    const el = buttons.nth(i);
    if (await el.isVisible()) {
      const text = (await el.textContent())?.trim().replace(/\s+/g, ' ');
      const cls = await el.getAttribute('class');
      console.log(`Visible [${i}] tag=${await el.evaluate(e => e.tagName)} text="${text}" class="${cls}"`);
      if (text === 'Export' || text === 'OK' || text === 'Download') {
        console.log(`Clicking modal action button "${text}"...`);
        await el.click();
        await page.waitForTimeout(8000);
      }
    }
  }

  await page.screenshot({ path: path.join(outputDir, '3-after-modal-action.png') });

  await browser.close();
  console.log('Done.');
}

main().catch(console.error);
