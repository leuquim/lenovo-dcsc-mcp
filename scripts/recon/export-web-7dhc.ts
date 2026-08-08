import { chromium } from 'playwright';
import type { Request, Response } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function main() {
  const outputDir = path.resolve('artifacts/web_native_export');
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

  // Intercept the hidden form submission or network request when Export is clicked
  let exportPayload: Record<string, string> | null = null;
  page.on('request', (req: Request) => {
    if (req.method() === 'POST' && req.url().includes('export')) {
      console.log(`[Captured Export Request] ${req.url()}`);
      try {
        const postData = req.postData();
        if (postData) {
          fs.writeFileSync(path.join(outputDir, 'web_export_raw_post.txt'), postData);
        }
      } catch {}
    }
  });

  // Click Summary
  console.log('Clicking Summary...');
  const summaryBtn = page.locator('button:has-text("Summary")').first();
  await summaryBtn.click();
  await page.waitForTimeout(4000);

  // Click Export
  console.log('Clicking Export dropdown...');
  const exportBtn = page.locator('button.action-button:has-text("Export"), button:has-text("Export")').first();
  await exportBtn.click();
  await page.waitForTimeout(2000);

  // Click Configuration
  console.log('Clicking Configuration option...');
  const configItem = page.locator('span:text-is("Configuration"), li:text-is("Configuration"), .ant-dropdown-menu-item:has-text("Configuration")').first();
  await configItem.click();
  await page.waitForTimeout(3000);

  // Now on summary screen, click Export again
  console.log('On Summary screen. Clicking Export button...');
  const summaryExportBtn = page.locator('button.action-button:has-text("Export"), button:has-text("Export")').first();
  if (await summaryExportBtn.isVisible({ timeout: 4000 })) {
    await summaryExportBtn.click();
    await page.waitForTimeout(2000);
  }

  // Click Download button in Export modal
  console.log('Clicking Download in Export modal...');
  const downloadBtn = page.locator('button:has-text("Download"), .ant-modal-footer button.ant-btn-primary').first();
  if (await downloadBtn.isVisible({ timeout: 4000 })) {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
      downloadBtn.click(),
    ]);

    if (download) {
      const zipSavePath = path.join(outputDir, 'web_native_7dhccto1ww.zip');
      await download.saveAs(zipSavePath);
      console.log(`Successfully downloaded native Web UI export ZIP to ${zipSavePath}`);
    }
  }

  await page.waitForTimeout(5000);

  await browser.close();
}

main().catch(console.error);
