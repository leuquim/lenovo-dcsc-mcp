import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function main() {
  const outputDir = path.resolve('artifacts/captured_web_export_form');
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

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

  // Override form submit method to capture form data before submission
  await page.evaluate(() => {
    const form = document.getElementById('hidden-form') as HTMLFormElement;
    if (form) {
      form.addEventListener('submit', () => {
        const formData: Record<string, string> = {};
        const inputs = form.querySelectorAll('input');
        inputs.forEach((inp) => {
          formData[inp.name] = inp.value;
        });
        (window as any).__capturedExportForm = {
          action: form.action,
          method: form.method,
          fields: formData,
        };
      });
    }
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
    await page.waitForTimeout(4000);
  }

  const captured = await page.evaluate(() => (window as any).__capturedExportForm);
  if (captured) {
    console.log('Successfully captured Web UI form submit payload!');
    fs.writeFileSync(path.join(outputDir, 'captured_form.json'), JSON.stringify(captured, null, 2));
    if (captured.fields && captured.fields.data) {
      try {
        const dataObj = JSON.parse(captured.fields.data);
        fs.writeFileSync(path.join(outputDir, 'captured_data.json'), JSON.stringify(dataObj, null, 2));
        console.log('Saved parsed data object to captured_data.json!');
      } catch {}
    }
  } else {
    console.log('Form submit event was not fired or not captured.');
  }

  await browser.close();
}

main().catch(console.error);
