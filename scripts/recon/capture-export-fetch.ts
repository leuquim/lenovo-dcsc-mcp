import { chromium } from 'playwright';
import type { Request } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function main() {
  const outputDir = path.resolve('artifacts/captured_export_network');
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const capturedRequests: Array<{ url: string; method: string; postData: any }> = [];

  page.on('request', async (req: Request) => {
    if (req.method() === 'POST') {
      const url = req.url();
      const postData = req.postData();
      capturedRequests.push({ url, method: req.method(), postData });
      if (url.includes('export') || (postData && postData.includes('configurations'))) {
        console.log(`\n>>> EXPORT REQUEST DETECTED: ${url} <<<`);
        fs.writeFileSync(path.join(outputDir, 'export_post_data.txt'), postData ?? '');
      }
    }
  });

  console.log('Navigating directly to 7DHCCTO1WW CTO configurator in live Web UI under HPC and AI mode...');
  await page.goto('https://dcsc.lenovo.com/#/configuration/cto/7DHCCTO1WW?hardwareType=server&solutionMode=HPC%20and%20AI%20-%20Systems&masterSlices=HPCGP,HPCRYO,HPCGPALL,HPCGPRYO', {
    waitUntil: 'networkidle',
    timeout: 45000,
  });
  await page.waitForTimeout(6000);

  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  // Override HTMLFormElement.prototype.submit to capture form submit
  await page.evaluate(() => {
    const origSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
      const formData: Record<string, string> = {};
      const inputs = this.querySelectorAll('input');
      inputs.forEach((inp) => {
        formData[inp.name] = inp.value;
      });
      (window as any).__capturedFormSubmit = {
        action: this.action,
        method: this.method,
        fields: formData,
      };
      return origSubmit.apply(this);
    };
  });

  // Click Summary
  console.log('Clicking Summary...');
  const summaryBtn = page.locator('button:has-text("Summary")').first();
  await summaryBtn.click();
  await page.waitForTimeout(4000);

  // Click Export dropdown
  console.log('Clicking Export dropdown...');
  const exportBtn = page.locator('button.action-button:has-text("Export"), button:has-text("Export")').first();
  await exportBtn.click();
  await page.waitForTimeout(2000);

  // Click Configuration
  console.log('Clicking Configuration option...');
  const configItem = page.locator('span:text-is("Configuration"), li:text-is("Configuration"), .ant-dropdown-menu-item:has-text("Configuration")').first();
  await configItem.click();
  await page.waitForTimeout(3000);

  // On Summary screen, click Export
  console.log('On Summary screen. Clicking Export button...');
  const summaryExportBtn = page.locator('button.action-button:has-text("Export"), button:has-text("Export")').first();
  if (await summaryExportBtn.isVisible({ timeout: 4000 })) {
    await summaryExportBtn.click();
    await page.waitForTimeout(2000);
  }

  // Click Download
  console.log('Clicking Download in Export modal...');
  const downloadBtn = page.locator('button:has-text("Download"), .ant-modal-footer button.ant-btn-primary').first();
  if (await downloadBtn.isVisible({ timeout: 4000 })) {
    await downloadBtn.click();
    await page.waitForTimeout(5000);
  }

  const capturedForm = await page.evaluate(() => (window as any).__capturedFormSubmit);
  if (capturedForm) {
    console.log('CAPTURED FORM SUBMIT VIA PROTOTYPE INTERCEPTION!');
    fs.writeFileSync(path.join(outputDir, 'prototype_captured_form.json'), JSON.stringify(capturedForm, null, 2));
    if (capturedForm.fields && capturedForm.fields.data) {
      try {
        fs.writeFileSync(path.join(outputDir, 'captured_web_data_payload.json'), JSON.stringify(JSON.parse(capturedForm.fields.data), null, 2));
        console.log('Saved parsed data payload to captured_web_data_payload.json!');
      } catch {}
    }
  }

  fs.writeFileSync(path.join(outputDir, 'all_post_requests.json'), JSON.stringify(capturedRequests, null, 2));
  await browser.close();
}

main().catch(console.error);
