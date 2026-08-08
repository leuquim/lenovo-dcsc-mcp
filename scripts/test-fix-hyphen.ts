import { chromium } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const originalPath = path.resolve('artifacts/nvidia_ai_factory_blueprints/nvidia-blueprint-7dhccto1ww.xml');
  const fixedPath = path.resolve('artifacts/nvidia_ai_factory_blueprints/fixed-7dhccto1ww.xml');

  let xml = fs.readFileSync(originalPath, 'utf8');
  console.log('Original XML contains 7DHC-CTO1WW:', xml.includes('7DHC-CTO1WW'));

  // Replace hyphenated product code 7DHC-CTO1WW with clean 7DHCCTO1WW
  xml = xml.replace(/7DHC-CTO1WW/g, '7DHCCTO1WW');
  fs.writeFileSync(fixedPath, xml);
  console.log(`Wrote fixed XML to ${fixedPath}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

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
  await fileInput.setInputFiles(fixedPath);
  console.log('Uploaded fixed-7dhccto1ww.xml. Waiting 15s for DCSC backend import processing...');
  await page.waitForTimeout(15000);

  const modalText = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('.ant-modal-content, .ant-message-notice, .ant-notification-notice, .error-message, div[role="dialog"]'));
    if (dialogs.length > 0) return dialogs.map(d => d.textContent).join('\n---\n');
    return document.body.innerText.slice(0, 1500);
  });

  console.log('\n--- Visible DOM Text / Modal Output ---');
  console.log(modalText);

  await page.screenshot({ path: 'artifacts/fixed_import_result.png', fullPage: true });
  await browser.close();
}

main().catch(console.error);
