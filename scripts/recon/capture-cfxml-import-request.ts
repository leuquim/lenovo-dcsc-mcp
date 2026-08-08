/**
 * Captures the raw multipart body the DCSC SPA sends to /api/multiple/cfxml_import,
 * so the MCP server can reproduce it byte-for-byte.
 */
import { chromium } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const xmlPath = path.resolve('artifacts/nvidia_ai_factory_blueprints/nvidia-blueprint-7dm9cto1ww.xml');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.route('**/cfxml_import*', async (route) => {
    const req = route.request();
    const buf = req.postDataBuffer();
    fs.mkdirSync('artifacts/import_probe', { recursive: true });
    fs.writeFileSync('artifacts/import_probe/cfxml_import_request.bin', buf ?? Buffer.alloc(0));
    console.log('=== URL ===');
    console.log(req.url());
    console.log('=== HEADERS ===');
    console.log(JSON.stringify(await req.allHeaders(), null, 2));
    console.log('=== BODY (first 3000 chars, XML elided) ===');
    const s = (buf ?? Buffer.alloc(0)).toString('utf8');
    console.log(s.slice(0, 1500));
    console.log('...\n[TAIL]\n' + s.slice(-800));
    console.log(`=== body bytes: ${buf?.length ?? 0} ===`);
    await route.continue();
  });

  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  try {
    const cc = page.locator('.dcsc-cookie-close').first();
    if (await cc.isVisible({ timeout: 2000 })) await cc.click();
  } catch {}

  await page.locator('.start-configuration-new-new-tile:has-text("Use Prior Configuration")').first().click();
  await page.waitForTimeout(2000);
  await page.locator('input[type="file"]').first().setInputFiles(xmlPath);
  await page.waitForTimeout(15000);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
