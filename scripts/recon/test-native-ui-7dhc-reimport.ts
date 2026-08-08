import { chromium } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const outDir = path.resolve('artifacts/web_native_test');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  console.log('Navigating to 7DHCCTO1WW in live Web UI under HPC & AI mode...');
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

  console.log('Clicking Export on Summary screen...');
  const exportBtn = page.locator('button.action-button:has-text("Export"), button:has-text("Export")').first();
  await exportBtn.click();
  await page.waitForTimeout(2000);

  console.log('Clicking Download in Export modal...');
  const downloadBtn = page.locator('button:has-text("Download"), .ant-modal-footer button.ant-btn-primary').first();

  let nativeXmlPath = '';
  if (await downloadBtn.isVisible({ timeout: 4000 })) {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
      downloadBtn.click(),
    ]);

    if (download) {
      const zipSavePath = path.join(outDir, 'native_ui_7dhc.zip');
      await download.saveAs(zipSavePath);
      console.log(`Saved native UI export zip to ${zipSavePath}`);

      const yauzl = await import('yauzl');
      const zipBuf = fs.readFileSync(zipSavePath);
      nativeXmlPath = path.join(outDir, 'native_ui_7dhc.xml');

      await new Promise<void>((resolve) => {
        yauzl.fromBuffer(zipBuf, { lazyEntries: true }, (err, zip) => {
          if (err || !zip) return resolve();
          zip.on('entry', (entry) => {
            if (entry.fileName.endsWith('.xml')) {
              zip.openReadStream(entry, (err, readStream) => {
                if (err || !readStream) return resolve();
                let data = '';
                readStream.on('data', (c) => (data += c));
                readStream.on('end', () => {
                  fs.writeFileSync(nativeXmlPath, data);
                  console.log(`Extracted native UI XML to ${nativeXmlPath} (${data.length} bytes)`);
                  resolve();
                });
              });
            } else zip.readEntry();
          });
          zip.readEntry();
        });
      });
    }
  }

  if (nativeXmlPath && fs.existsSync(nativeXmlPath)) {
    console.log('\n----------------------------------------------------');
    console.log('Re-importing native Web UI XML into homepage tile...');
    await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    const tile = page.locator('.start-configuration-new-new-tile:has-text("Use Prior Configuration")').first();
    await tile.click();
    await page.waitForTimeout(2000);

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(nativeXmlPath);
    await page.waitForTimeout(10000);

    console.log('Current page URL after upload:', page.url());
    const modalText = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('.ant-modal-content, .ant-message-notice, .ant-notification-notice, .error-message, div[role="dialog"]'));
      if (dialogs.length > 0) return dialogs.map(d => d.textContent).join('\n---\n');
      return 'No error modal displayed. Loaded URL: ' + window.location.href;
    });

    console.log('\n--- Result for Web UI Native 7DHC XML ---');
    console.log(modalText);
  }

  await browser.close();
}

main().catch(console.error);
