import { chromium } from 'playwright';
import type { Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

interface ApiLogEntry {
  timestamp: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: any;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: any;
}

async function runTrace() {
  const outputDir = path.resolve('artifacts/trace_web_dcsc');
  fs.mkdirSync(outputDir, { recursive: true });

  const apiLogs: ApiLogEntry[] = [];

  console.log('Starting Playwright Chromium browser...');
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

  // Listen to console logs and errors in page
  const consoleLogs: Array<{ type: string; text: string; location: any }> = [];
  page.on('console', (msg) => {
    consoleLogs.push({
      type: msg.type(),
      text: msg.text(),
      location: msg.location(),
    });
    if (msg.type() === 'error') {
      console.error(`[Browser Console Error] ${msg.text()}`);
    }
  });

  page.on('pageerror', (err) => {
    console.error(`[Browser Page Uncaught Error] ${err.stack || err.message}`);
    consoleLogs.push({
      type: 'pageerror',
      text: err.stack || err.message,
      location: null,
    });
  });

  // Network interception for /api/ calls
  page.on('request', async (req: Request) => {
    if (req.url().includes('/api/')) {
      let postData: any = req.postData();
      if (postData) {
        try {
          if (postData.startsWith('data=') || req.headers()['content-type']?.includes('application/x-www-form-urlencoded')) {
            const params = new URLSearchParams(postData);
            const parsedObj: Record<string, any> = {};
            params.forEach((val, key) => {
              try {
                parsedObj[key] = JSON.parse(val);
              } catch {
                parsedObj[key] = val;
              }
            });
            postData = parsedObj;
          } else {
            postData = JSON.parse(postData);
          }
        } catch (e) {
          // keep string
        }
      }

      apiLogs.push({
        timestamp: new Date().toISOString(),
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        postData,
      });
    }
  });

  page.on('response', async (res: Response) => {
    if (res.url().includes('/api/')) {
      const match = apiLogs.find((entry) => entry.url === res.url() && !entry.status);
      if (match) {
        match.status = res.status();
        match.responseHeaders = res.headers();
        try {
          const contentType = res.headers()['content-type'] || '';
          if (contentType.includes('json')) {
            match.responseBody = await res.json();
          } else if (contentType.includes('text') || contentType.includes('xml')) {
            match.responseBody = (await res.text()).slice(0, 10000);
          } else {
            match.responseBody = `[Binary content ${res.headers()['content-length']} bytes]`;
          }
        } catch (e) {
          match.responseBody = '[Unable to parse response body]';
        }
      }
    }
  });

  console.log('Navigating to DCSC Web UI...');
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(3000);

  // Dismiss banners
  try {
    const otAccept = page.locator('#onetrust-accept-btn-handler');
    if (await otAccept.isVisible({ timeout: 2000 })) await otAccept.click();
  } catch {}

  try {
    const dontChange = page.locator('button:has-text("Dont change"), button:has-text("Don\'t change")');
    if (await dontChange.isVisible({ timeout: 2000 })) await dontChange.click();
  } catch {}

  await page.waitForTimeout(2000);

  // Directly navigate to SR630 V3 CTO launcher URL
  console.log('Navigating to configurator for SR630 V3 (7D73CTO1WW)...');
  await page.goto('https://dcsc.lenovo.com/#/configurator/cto/7D73CTO1WW', { waitUntil: 'networkidle' });
  await page.waitForTimeout(10000);

  // Save screenshot of configurator UI
  await page.screenshot({ path: path.join(outputDir, 'configurator-loaded.png') });
  console.log('Saved screenshot of configurator UI.');

  // Trigger export from Web UI
  console.log('Looking for Export button in Web UI...');
  const exportBtn = page.locator('button:has-text("Export"), div:has-text("Export")').first();
  if (await exportBtn.isVisible({ timeout: 5000 })) {
    await exportBtn.click();
    await page.waitForTimeout(2000);
  }

  // Write trace log
  fs.writeFileSync(path.join(outputDir, 'api_trace.json'), JSON.stringify(apiLogs, null, 2));
  fs.writeFileSync(path.join(outputDir, 'browser_console.json'), JSON.stringify(consoleLogs, null, 2));
  console.log(`Saved API trace log with ${apiLogs.length} requests.`);

  await browser.close();
}

runTrace().catch((err) => {
  console.error('Fatal trace error:', err);
  process.exit(1);
});
