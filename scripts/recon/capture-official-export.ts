import { chromium } from 'playwright';
import type { Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as yauzl from 'yauzl';

async function main() {
  const outputDir = path.resolve('artifacts/official_export');
  fs.mkdirSync(outputDir, { recursive: true });

  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // Listen to /export_zip POST request
  page.on('request', async (req: Request) => {
    if (req.url().includes('/export_zip')) {
      console.log('\n>>> CAPTURED /export_zip REQUEST FROM WEB UI! <<<');
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
          console.log('Saved parsed POST data to web_export_parsed_data.json');
        } catch (e) {
          console.error('Failed to parse POST data:', e);
        }
      }
    }
  });

  console.log('Navigating directly to SR630 V3 CTO configurator...');
  await page.goto('https://dcsc.lenovo.com/#/configuration/cto/7D73CTO1WW?hardwareType=server', {
    waitUntil: 'networkidle',
    timeout: 45000,
  });
  await page.waitForTimeout(10000);

  // Close banners
  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  try {
    const dontChange = page.locator('button:has-text("Dont change"), button:has-text("Don\'t change")');
    if (await dontChange.isVisible({ timeout: 2000 })) await dontChange.click();
  } catch {}

  await page.screenshot({ path: path.join(outputDir, '1-configurator-loaded.png') });

  // Inspect all text elements to locate Export
  const elements = page.locator('button, a, div, span, li');
  const count = await elements.count();
  console.log(`Found ${count} elements on configurator page.`);

  let exportClicked = false;
  for (let i = 0; i < count; i++) {
    const txt = (await elements.nth(i).textContent())?.trim();
    if (txt === 'Export' || txt === 'Export Configuration' || txt === 'EXPORT') {
      console.log(`Clicking Export element at index ${i}: "${txt}"`);
      await elements.nth(i).click({ force: true });
      exportClicked = true;
      await page.waitForTimeout(3000);
      break;
    }
  }

  await page.screenshot({ path: path.join(outputDir, '2-after-export-click.png') });

  if (exportClicked) {
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);

    // Click Export / Download in the modal dialog if present
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

      // Extract XML
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
      console.warn('Download event timed out.');
    }
  }

  await browser.close();
  console.log('Finished capture script.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
