import { chromium } from 'playwright';
import type { Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const outputDir = path.resolve('artifacts/captured_all_network');
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const allRequests: Array<{ url: string; method: string; headers: any; postData?: any }> = [];

  page.on('request', async (req: Request) => {
    if (req.method() === 'POST' || req.url().includes('export')) {
      let postData: any = req.postData();
      if (postData) {
        try {
          if (postData.includes('data=')) {
            const params = new URLSearchParams(postData);
            const parsedObj: Record<string, any> = {};
            params.forEach((v, k) => {
              try { parsedObj[k] = JSON.parse(v); } catch { parsedObj[k] = v; }
            });
            postData = parsedObj;
          } else {
            postData = JSON.parse(postData);
          }
        } catch (e) {}
      }

      allRequests.push({
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        postData,
      });
      console.log(`[Captured Request] ${req.method()} ${req.url()}`);
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

  console.log('Clicking Summary...');
  const summaryBtn = page.locator('button:has-text("Summary")').first();
  await summaryBtn.click();
  await page.waitForTimeout(4000);

  console.log('Clicking Export dropdown...');
  const exportBtn = page.locator('button.action-button:has-text("Export"), button:has-text("Export")').first();
  await exportBtn.click();
  await page.waitForTimeout(2000);

  console.log('Clicking Configuration option in dropdown...');
  const configItem = page.locator('span:text-is("Configuration"), li:text-is("Configuration"), .ant-dropdown-menu-item:has-text("Configuration")').first();
  await configItem.click();
  await page.waitForTimeout(6000);

  fs.writeFileSync(path.join(outputDir, 'captured_requests.json'), JSON.stringify(allRequests, null, 2));
  console.log(`Captured ${allRequests.length} total POST / export requests.`);

  await browser.close();
}

main().catch(console.error);
