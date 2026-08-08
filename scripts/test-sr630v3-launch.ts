import { chromium } from 'playwright';
import type { Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const outputDir = path.resolve('artifacts/sr630v3_launch');
  fs.mkdirSync(outputDir, { recursive: true });

  console.log('Launching Chromium...');
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
        } catch (e) {}
      }
    }
  });

  console.log('Navigating to SR630 V3 category page...');
  await page.goto('https://dcsc.lenovo.com/#/categories/STG%40Servers%40Rack%20Server%40ThinkSystem%20SR630%20V3', {
    waitUntil: 'networkidle',
    timeout: 45000,
  });
  await page.waitForTimeout(5000);

  // Close banners
  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  await page.screenshot({ path: path.join(outputDir, '1-category-page.png') });

  // Click Configure on 7D73CTO1WW or Configure button
  console.log('Looking for Configure / 7D73CTO1WW button...');
  const configBtn = page.locator('button:has-text("Configure"), a:has-text("Configure"), button:has-text("Build")').first();
  if (await configBtn.isVisible({ timeout: 5000 })) {
    console.log('Clicking Configure button...');
    await configBtn.click();
    await page.waitForTimeout(12000);
  }

  await page.screenshot({ path: path.join(outputDir, '2-configurator.png') });

  // Search for any export element
  const elements = page.locator('button, a, div, span');
  const count = await elements.count();
  console.log(`Searching ${count} elements for Export...`);

  for (let i = 0; i < count; i++) {
    const text = (await elements.nth(i).textContent())?.trim();
    if (text === 'Export' || text === 'EXPORT' || text === 'Export Configuration') {
      console.log(`MATCH at index ${i}: "${text}"`);
      await elements.nth(i).click({ force: true });
      await page.waitForTimeout(3000);
      await page.screenshot({ path: path.join(outputDir, '3-export-clicked.png') });
      break;
    }
  }

  await browser.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
