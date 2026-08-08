import { chromium } from 'playwright';
import type { Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as yauzl from 'yauzl';

async function main() {
  const outputDir = path.resolve('artifacts/official_vs_mcp_import');
  fs.mkdirSync(outputDir, { recursive: true });

  console.log('Launching browser to capture Web UI export & test re-import...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Intercept export POST call from Web UI
  page.on('request', async (req: Request) => {
    if (req.url().includes('/export_zip')) {
      console.log('Detected /export_zip request from Web UI!');
      const postData = req.postData();
      if (postData) {
        fs.writeFileSync(path.join(outputDir, 'web_export_raw_post.txt'), postData);
        try {
          const params = new URLSearchParams(postData);
          const parsed: Record<string, any> = {};
          params.forEach((v, k) => {
            try { parsed[k] = JSON.parse(v); } catch { parsed[k] = v; }
          });
          fs.writeFileSync(path.join(outputDir, 'web_export_parsed_post.json'), JSON.stringify(parsed, null, 2));
          console.log('Saved Web UI export POST payload breakdown.');
        } catch (e) {}
      }
    }
  });

  console.log('Navigating to SR630 V3 configurator directly...');
  await page.goto('https://dcsc.lenovo.com/#/configurator/cto/7D73CTO1WW', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(10000);

  // Close DCSC cookie mask banner if visible
  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  await page.screenshot({ path: path.join(outputDir, '1-configurator-loaded.png') });

  // Trigger export from Web UI
  console.log('Looking for Export button in Web UI...');
  const exportLink = page.locator('text="Export"').first();
  let webZipPath = '';
  if (await exportLink.isVisible({ timeout: 5000 })) {
    await exportLink.click();
    await page.waitForTimeout(2000);

    await page.screenshot({ path: path.join(outputDir, '2-export-menu-open.png') });

    // Look for Export modal / download button
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    
    // Check for Export button inside modal
    const modalExportBtn = page.locator('.ant-modal button:has-text("Export"), button:has-text("Export")').last();
    if (await modalExportBtn.isVisible({ timeout: 3000 })) {
      console.log('Clicking Export button inside modal...');
      await modalExportBtn.click();
    }

    const download = await downloadPromise;
    if (download) {
      webZipPath = path.join(outputDir, 'web_official_export.zip');
      await download.saveAs(webZipPath);
      console.log(`Successfully saved Web UI export zip to ${webZipPath}`);
    } else {
      console.warn('Download event did not trigger automatically.');
    }
  }

  // If downloaded, extract official XML
  let officialXmlPath = '';
  if (webZipPath && fs.existsSync(webZipPath)) {
    await new Promise<void>((resolve) => {
      yauzl.open(webZipPath, { lazyEntries: true }, (err, zip) => {
        if (err || !zip) return resolve();
        zip.on('entry', (entry) => {
          if (entry.fileName.endsWith('.xml')) {
            zip.openReadStream(entry, (err, readStream) => {
              if (err || !readStream) return resolve();
              let data = '';
              readStream.on('data', (c) => (data += c));
              readStream.on('end', () => {
                officialXmlPath = path.join(outputDir, 'web_official.xml');
                fs.writeFileSync(officialXmlPath, data);
                console.log(`Extracted ${officialXmlPath} (${data.length} bytes)`);
                resolve();
              });
            });
          } else {
            zip.readEntry();
          }
        });
        zip.readEntry();
      });
    });
  }

  // Now test re-import of Web UI exported XML vs MCP exported XML
  console.log('\nTesting re-import in DCSC Web UI...');
  await page.goto('https://dcsc.lenovo.com/#/start', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  const tile = page.locator('.start-configuration-new-new-tile:has-text("Use Prior Configuration")').first();
  if (await tile.isVisible({ timeout: 5000 })) {
    await tile.click();
    await page.waitForTimeout(2000);
  }

  const fileInput = page.locator('input[type="file"]').first();
  
  if (officialXmlPath && fs.existsSync(officialXmlPath)) {
    console.log('\n--- Testing Re-Import of OFFICIAL Web UI XML ---');
    await fileInput.setInputFiles(officialXmlPath);
    await page.waitForTimeout(8000);
    await page.screenshot({ path: path.join(outputDir, '3-official-xml-import-result.png') });
    console.log('Current URL after official XML import:', page.url());
  }

  const mcpXmlPath = path.resolve('artifacts/mcp-export-test.xml');
  if (fs.existsSync(mcpXmlPath)) {
    console.log('\n--- Testing Re-Import of MCP Generated XML ---');
    await page.goto('https://dcsc.lenovo.com/#/start', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    try {
      const cookieClose = page.locator('.dcsc-cookie-close').first();
      if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
    } catch {}

    const tile2 = page.locator('.start-configuration-new-new-tile:has-text("Use Prior Configuration")').first();
    if (await tile2.isVisible({ timeout: 5000 })) {
      await tile2.click();
      await page.waitForTimeout(2000);
    }

    const fileInput2 = page.locator('input[type="file"]').first();
    await fileInput2.setInputFiles(mcpXmlPath);
    await page.waitForTimeout(8000);
    await page.screenshot({ path: path.join(outputDir, '4-mcp-xml-import-result.png') });
    console.log('Current URL after MCP XML import:', page.url());
  }

  await browser.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Fatal capture error:', err);
  process.exit(1);
});
