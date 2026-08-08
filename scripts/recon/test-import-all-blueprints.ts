import { chromium } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function testBlueprint(page: any, xmlName: string): Promise<string> {
  const xmlPath = path.resolve(`artifacts/nvidia_ai_factory_blueprints/${xmlName}`);
  console.log(`\n----------------------------------------------------`);
  console.log(`Uploading ${xmlName} to DCSC Web UI homepage tile...`);

  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(3000);

  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  const tile = page.locator('.start-configuration-new-new-tile:has-text("Use Prior Configuration")').first();
  await tile.click();
  await page.waitForTimeout(2000);

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(xmlPath);
  await page.waitForTimeout(10000);

  const url = page.url();
  console.log(`Current page URL after upload: ${url}`);

  const modalText = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('.ant-modal-content, .ant-message-notice, .ant-notification-notice, .error-message, div[role="dialog"]'));
    if (dialogs.length > 0) return dialogs.map(d => d.textContent).join('\n---\n');
    return 'No error modal displayed. Loaded URL: ' + window.location.href;
  });

  return modalText;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const xmlFiles = [
    'nvidia-blueprint-7dm9cto1ww.xml',
    'nvidia-blueprint-7dj5cto1ww.xml',
    'nvidia-blueprint-7dhccto1ww.xml',
    'nvidia-blueprint-7dlzcto2ww.xml',
  ];

  for (const xmlFile of xmlFiles) {
    const result = await testBlueprint(page, xmlFile);
    console.log(`Result for ${xmlFile}:\n${result}\n`);
  }

  await browser.close();
}

main().catch(console.error);
