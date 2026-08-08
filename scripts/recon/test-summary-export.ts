import { chromium } from 'playwright';
import type { Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as yauzl from 'yauzl';

async function main() {
  const outputDir = path.resolve('artifacts/summary_export');
  fs.mkdirSync(outputDir, { recursive: true });

  console.log('Launching Chromium...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // Listen to /export_zip POST request
  page.on('request', async (req: Request) => {
    if (req.url().includes('/export_zip')) {
      console.log('\n>>> SUCCESS! CAPTURED /export_zip REQUEST FROM WEB UI! <<<');
      const postData = req.postData();
      if (postData) {
        fs.writeFileSync(path.join(outputDir, 'web_export_raw_post.txt'), postData);
        try {
          const params = new URLSearchParams(postData);
          const parsedObj: Record<string, any> = {};
          params.forEach((v, k) => {
            try {
              parsedObj[k] = JSON.parse(v);
            } catch {
              parsedObj[k] = v;
            }
          });
          fs.writeFileSync(path.join(outputDir, 'web_export_parsed_data.json'), JSON.stringify(parsedObj, null, 2));
          console.log('Saved parsed POST payload to web_export_parsed_data.json');
        } catch (e) {}
      }
    }
  });

  console.log('Navigating to SR630 V3 CTO configurator...');
  await page.goto('https://dcsc.lenovo.com/#/configuration/cto/7D73CTO1WW?hardwareType=server', {
    waitUntil: 'networkidle',
    timeout: 45000,
  });
  await page.waitForTimeout(8000);

  // Close banners
  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  // Click "Summary" button
  console.log('Clicking "Summary" button...');
  const summaryBtn = page.locator('button:has-text("Summary")').first();
  if (await summaryBtn.isVisible({ timeout: 5000 })) {
    await summaryBtn.click();
    console.log('Clicked Summary button. Waiting 5s...');
    await page.waitForTimeout(5000);
  }

  await page.screenshot({ path: path.join(outputDir, '1-summary-page.png') });

  // Log all text elements on Summary page
  const textElements = page.locator('button, a, span, div.ant-btn');
  const count = await textElements.count();
  console.log(`Found ${count} elements on Summary page.`);

  for (let i = 0; i < count; i++) {
    const text = (await textElements.nth(i).textContent())?.trim();
    if (text && (text.includes('Export') || text.includes('Download') || text.includes('XML') || text.includes('Excel'))) {
      console.log(`Summary Page Element ${i}: "${text}"`);
    }
  }

  // Click Export button
  const exportBtn = page.locator('button:has-text("Export"), a:has-text("Export"), span:has-text("Export")').first();
  if (await exportBtn.isVisible({ timeout: 5000 })) {
    console.log('Found Export button on Summary page! Clicking...');
    
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    await exportBtn.click();
    await page.waitForTimeout(2000);

    await page.screenshot({ path: path.join(outputDir, '2-after-export-click.png') });

    // Look for modal confirm export button
    const modalExport = page.locator('.ant-modal button:has-text("Export"), button:has-text("Export")').last();
    if (await modalExport.isVisible({ timeout: 3000 })) {
      console.log('Clicking modal Export button...');
      await modalExport.click();
    }

    const download = await downloadPromise;
    if (download) {
      const zipPath = path.join(outputDir, 'official_web_export.zip');
      await download.saveAs(zipPath);
      console.log(`Saved official Web UI zip to ${zipPath}`);

      // Extract official XML
      await new Promise<void>((resolve) => {
        yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
          if (err || !zip) return resolve();
          zip.on('entry', (entry) => {
            if (entry.fileName.endsWith('.xml')) {
              zip.openReadStream(entry, (err, readStream) => {
                if (err || !readStream) return resolve();
                let data = '';
                readStream.on('data', (c) => (data += c));
                readStream.on('end', () => {
                  fs.writeFileSync(path.join(outputDir, 'official_web.xml'), data);
                  console.log(`Extracted official XML: ${data.length} bytes`);
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
    } else {
      console.warn('Download event did not fire.');
    }
  }

  await browser.close();
  console.log('Script finished.');
}

main().catch(console.error);
