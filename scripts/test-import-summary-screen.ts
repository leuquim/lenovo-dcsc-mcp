import { chromium } from 'playwright';
import * as path from 'node:path';

async function main() {
  const xmlPath = path.resolve('artifacts/nvidia_ai_factory_blueprints/nvidia-blueprint-7dhccto1ww.xml');
  console.log(`Testing import of ${xmlPath} on Summary screen...`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto('https://dcsc.lenovo.com/#/configuration/cto/7DHCCTO1WW?hardwareType=server&solutionMode=HPC%20and%20AI%20-%20Systems&masterSlices=HPCGP,HPCRYO,HPCGPALL,HPCGPRYO', {
    waitUntil: 'networkidle',
    timeout: 45000,
  });
  await page.waitForTimeout(6000);

  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  console.log('Clicking Summary...');
  const summaryBtn = page.locator('button:has-text("Summary")').first();
  await summaryBtn.click();
  await page.waitForTimeout(4000);

  console.log('Clicking Import dropdown/button on summary screen...');
  const importBtn = page.locator('button.action-button:has-text("Import"), button:has-text("Import")').first();
  if (await importBtn.isVisible({ timeout: 3000 })) {
    await importBtn.click();
    await page.waitForTimeout(1000);
    const configItem = page.locator('span:text-is("Configuration"), li:text-is("Configuration"), .ant-dropdown-menu-item:has-text("Configuration")').first();
    if (await configItem.isVisible({ timeout: 2000 })) await configItem.click();
  }

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(xmlPath);
  console.log('Uploaded XML. Waiting 15s for DCSC import processing...');
  await page.waitForTimeout(15000);

  const modalText = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('.ant-modal-content, .ant-message-notice, .ant-notification-notice, .error-message, div[role="dialog"]'));
    if (dialogs.length > 0) return dialogs.map(d => d.textContent).join('\n---\n');
    return document.body.innerText.slice(0, 1500);
  });

  console.log('\n--- Visible DOM Text / Modal Output ---');
  console.log(modalText);

  await page.screenshot({ path: 'artifacts/summary_import_result.png', fullPage: true });
  await browser.close();
}

main().catch(console.error);
