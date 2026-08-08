import { chromium } from 'playwright';
import type { Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

async function inspectImportModal() {
  const outputDir = path.resolve('artifacts/modal_inspection');
  fs.mkdirSync(outputDir, { recursive: true });

  const xmlPath = path.resolve('artifacts/mcp-export-test.xml');

  console.log('Launching browser to inspect Import modal...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleLogs: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => pageErrors.push(err.stack || err.message));

  console.log('Navigating to DCSC...');
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(3000);

  // Close banners
  try {
    const otAccept = page.locator('#onetrust-accept-btn-handler');
    if (await otAccept.isVisible({ timeout: 2000 })) await otAccept.click();
  } catch {}
  try {
    const dontChange = page.locator('button:has-text("Dont change"), button:has-text("Don\'t change")');
    if (await dontChange.isVisible({ timeout: 2000 })) await dontChange.click();
  } catch {}

  await page.waitForTimeout(1000);

  // Click Tools header
  const toolsHeader = page.locator('text="Tools"').first();
  if (await toolsHeader.isVisible({ timeout: 5000 })) {
    await toolsHeader.click({ force: true });
    await page.waitForTimeout(1500);
  }

  // Click Use Prior Configuration
  const priorCard = page.locator('text="Use Prior Configuration"').first();
  if (await priorCard.isVisible({ timeout: 5000 })) {
    await priorCard.click({ force: true });
    await page.waitForTimeout(3000);
  }

  // Save screenshot & HTML of modal
  await page.screenshot({ path: path.join(outputDir, 'modal.png') });
  const bodyHtml = await page.content();
  fs.writeFileSync(path.join(outputDir, 'modal.html'), bodyHtml);
  console.log('Saved modal screenshot & HTML dump.');

  // Find all file inputs in DOM (including hidden ones)
  const inputs = page.locator('input');
  const count = await inputs.count();
  console.log(`Found ${count} total input elements on page.`);

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    const type = await input.getAttribute('type');
    const id = await input.getAttribute('id');
    const name = await input.getAttribute('name');
    const isVisible = await input.isVisible();
    console.log(`Input ${i}: type=${type}, id=${id}, name=${name}, visible=${isVisible}`);

    if (type === 'file') {
      console.log(`Attempting upload on file input ${i} (id=${id})...`);
      await input.setInputFiles(xmlPath);
      console.log(`Successfully attached file to input ${i}!`);
      await page.waitForTimeout(2000);
    }
  }

  await page.screenshot({ path: path.join(outputDir, 'after-file-attached.png') });

  // Look for any Open/Import/Submit button that became enabled
  const buttons = page.locator('button');
  const bCount = await buttons.count();
  console.log(`Found ${bCount} total buttons.`);

  for (let i = 0; i < bCount; i++) {
    const b = buttons.nth(i);
    const text = (await b.textContent())?.trim();
    const isVis = await b.isVisible();
    const isEnabled = await b.isEnabled();
    if (isVis && text) {
      console.log(`Button ${i}: "${text}" (Enabled=${isEnabled})`);
      if (text.toLowerCase().includes('open') || text.toLowerCase().includes('import') || text.toLowerCase().includes('upload')) {
        if (isEnabled) {
          console.log(`Clicking button "${text}"...`);
          await b.click();
          await page.waitForTimeout(10000);
          break;
        }
      }
    }
  }

  await page.screenshot({ path: path.join(outputDir, 'after-import-submit.png') });

  fs.writeFileSync(path.join(outputDir, 'console.json'), JSON.stringify(consoleLogs, null, 2));
  fs.writeFileSync(path.join(outputDir, 'errors.json'), JSON.stringify(pageErrors, null, 2));

  console.log('Inspection complete.');
  await browser.close();
}

inspectImportModal().catch((err) => {
  console.error('Fatal inspection error:', err);
  process.exit(1);
});
