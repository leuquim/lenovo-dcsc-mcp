import { chromium } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const xmlPath = path.resolve('artifacts/nvidia_ai_factory_blueprints/nvidia-blueprint-7dhccto1ww.xml');
  console.log(`Testing import of ${xmlPath} under HPC and AI - Systems mode...`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(3000);

  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  // Change Solution Mode dropdown to "HPC and AI - Systems"
  console.log('Selecting "HPC and AI - Systems" solution mode...');
  const solutionDropdown = page.locator('.header-solution-select, .ant-select-selection-selected-value, .solution-select').first();
  if (await solutionDropdown.isVisible({ timeout: 3000 })) {
    await solutionDropdown.click();
    await page.waitForTimeout(1000);
    const hpcOption = page.locator('.ant-select-dropdown-menu-item:has-text("HPC and AI"), li:has-text("HPC and AI")').first();
    if (await hpcOption.isVisible({ timeout: 2000 })) {
      await hpcOption.click();
      await page.waitForTimeout(3000);
    }
  }

  console.log('Clicking "Use Prior Configuration" tile...');
  const tile = page.locator('.start-configuration-new-new-tile:has-text("Use Prior Configuration")').first();
  await tile.click();
  await page.waitForTimeout(2000);

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(xmlPath);
  console.log('Uploaded nvidia-blueprint-7dhccto1ww.xml. Waiting 15s for DCSC backend import processing...');
  await page.waitForTimeout(15000);

  console.log('Current URL after import:', page.url());

  const modalText = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('.ant-modal-content, .ant-message-notice, .ant-notification-notice, .error-message, div[role="dialog"]'));
    if (dialogs.length > 0) return dialogs.map(d => d.textContent).join('\n---\n');
    return document.body.innerText.slice(0, 1500);
  });

  console.log('\n--- Visible DOM Text / Modal Output ---');
  console.log(modalText);

  await page.screenshot({ path: 'artifacts/hpc_import_result.png', fullPage: true });
  await browser.close();
}

main().catch(console.error);
