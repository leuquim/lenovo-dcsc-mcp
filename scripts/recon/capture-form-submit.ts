import { chromium } from 'playwright';
import type { Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const outputDir = path.resolve('artifacts/captured_hidden_form');
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on('request', async (req: Request) => {
    if (req.method() === 'POST') {
      const url = req.url();
      console.log(`[POST Request] ${url}`);
      const postData = req.postData();
      if (postData && (url.includes('export') || postData.includes('data='))) {
        console.log(`\n======================================================`);
        console.log(`>>> CAPTURED DCSC FORM EXPORT SUBMIT TO ${url}! <<<`);
        console.log(`======================================================`);
        fs.writeFileSync(path.join(outputDir, 'export_form_raw.txt'), postData);
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
          fs.writeFileSync(path.join(outputDir, 'export_form_parsed.json'), JSON.stringify(parsedObj, null, 2));
          console.log('Saved parsed form data to export_form_parsed.json!');
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
  await summaryBtn.click();
  await page.waitForTimeout(4000);

  // Click Export dropdown button
  const exportBtn = page.locator('button.action-button:has-text("Export"), button:has-text("Export")').first();
  await exportBtn.click();
  await page.waitForTimeout(2000);

  // Click Configuration option in dropdown
  console.log('Clicking Configuration option in dropdown...');
  const configItem = page.locator('span:text-is("Configuration"), li:text-is("Configuration"), .ant-dropdown-menu-item:has-text("Configuration")').first();
  await configItem.click();
  await page.waitForTimeout(2000);

  // Dump hidden form inputs from DOM before & after clicking
  const formAction = await page.evaluate(() => {
    const form = document.getElementById('hidden-form') as HTMLFormElement;
    if (!form) return null;
    const inputs = form.querySelectorAll('input');
    const data: Record<string, any> = { action: form.action, method: form.method, fields: {} };
    inputs.forEach((inp) => {
      try {
        data.fields[inp.name] = JSON.parse(inp.value);
      } catch {
        data.fields[inp.name] = inp.value;
      }
    });
    return data;
  });

  console.log('Dumping hidden form DOM data:');
  fs.writeFileSync(path.join(outputDir, 'dom_hidden_form.json'), JSON.stringify(formAction, null, 2));

  await page.waitForTimeout(5000);
  await browser.close();
  console.log('Done.');
}

main().catch(console.error);
