import { chromium } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const xmlPath = path.resolve('artifacts/nvidia_ai_factory_blueprints/nvidia-blueprint-7dhccto1ww.xml');
  console.log(`Uploading ${xmlPath} to live DCSC Web UI...`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.text().includes('import') || msg.text().includes('xml')) {
      console.log(`[Browser Console ${msg.type()}] ${msg.text()}`);
    }
  });

  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(3000);

  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  console.log('Clicking "Use Prior Configuration" tile...');
  const tile = page.locator('.start-configuration-new-new-tile:has-text("Use Prior Configuration")').first();
  await tile.click();
  await page.waitForTimeout(2000);

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(xmlPath);
  console.log('File uploaded to input. Waiting 15s for DCSC backend import processing...');
  await page.waitForTimeout(15000);

  const screenshotPath = 'artifacts/debug_import_error.png';
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`Saved screenshot to ${screenshotPath}`);

  const modalText = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('.ant-modal-content, .ant-message-notice, .ant-notification-notice, .error-message, div[role="dialog"]'));
    if (dialogs.length > 0) return dialogs.map(d => d.textContent).join('\n---\n');
    return document.body.innerText.slice(0, 1500);
  });

  console.log('\n--- Visible DOM Text / Modal Output ---');
  console.log(modalText);

  await browser.close();
}

main().catch(console.error);
