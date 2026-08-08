import { chromium } from 'playwright';
import type { Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const outputDir = path.resolve('artifacts/summary_dom_dump');
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on('request', async (req: Request) => {
    if (req.url().includes('/export_zip')) {
      console.log('\n>>> SUCCESS! CAPTURED /export_zip REQUEST FROM WEB UI! <<<');
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
          console.log('Saved parsed POST payload!');
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
    await page.waitForTimeout(4000);
  }

  const exportBtn = page.locator('button:has-text("Export"), a:has-text("Export")').first();
  if (await exportBtn.isVisible({ timeout: 5000 })) {
    console.log('Clicking Export...');
    await exportBtn.click();
    await page.waitForTimeout(4000);
  }

  // Save DOM content
  fs.writeFileSync(path.join(outputDir, 'page.html'), await page.content());
  await page.screenshot({ path: path.join(outputDir, 'after-export-click.png') });

  // Log all visible buttons and inputs
  const elements = page.locator('button, input, a, div[role="button"], span');
  const count = await elements.count();
  console.log(`Found ${count} total elements.`);

  for (let i = 0; i < count; i++) {
    const el = elements.nth(i);
    if (await el.isVisible()) {
      const text = (await el.textContent())?.trim().replace(/\s+/g, ' ');
      const type = await el.getAttribute('type');
      const cls = await el.getAttribute('class');
      if (text && text.length < 80) {
        console.log(`Visible [${i}] tag=${await el.evaluate(e => e.tagName)} text="${text}" type=${type} class="${cls}"`);
      }
    }
  }

  await browser.close();
}

main().catch(console.error);
