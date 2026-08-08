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

async function runFullTrace() {
  const outputDir = path.resolve('artifacts/trace_full_web_dcsc');
  fs.mkdirSync(outputDir, { recursive: true });

  const apiLogs: ApiLogEntry[] = [];
  const consoleLogs: Array<{ type: string; text: string; location: any }> = [];

  console.log('Starting Chromium browser...');
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

  page.on('console', (msg) => {
    consoleLogs.push({
      type: msg.type(),
      text: msg.text(),
      location: msg.location(),
    });
    if (msg.type() === 'error') {
      console.error(`[Browser Error] ${msg.text()}`);
    }
  });

  page.on('pageerror', (err) => {
    console.error(`[Browser PageError] ${err.stack || err.message}`);
    consoleLogs.push({
      type: 'pageerror',
      text: err.stack || err.message,
      location: null,
    });
  });

  page.on('request', async (req: Request) => {
    if (req.url().includes('/api/')) {
      let postData: any = req.postData();
      if (postData) {
        try {
          if (postData.includes('data=') || req.headers()['content-type']?.includes('application/x-www-form-urlencoded')) {
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
            match.responseBody = (await res.text()).slice(0, 20000);
          } else {
            match.responseBody = `[Binary content ${res.headers()['content-length']} bytes]`;
          }
        } catch (e) {
          match.responseBody = '[Unable to parse response body]';
        }
      }
    }
  });

  console.log('Navigating to DCSC homepage...');
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(3000);

  // Dismiss popups
  try {
    const otAccept = page.locator('#onetrust-accept-btn-handler');
    if (await otAccept.isVisible({ timeout: 2000 })) await otAccept.click();
  } catch {}
  try {
    const dontChange = page.locator('button:has-text("Dont change"), button:has-text("Don\'t change")');
    if (await dontChange.isVisible({ timeout: 2000 })) await dontChange.click();
  } catch {}

  await page.waitForTimeout(2000);

  // Search catalog for SR630 V3
  console.log('Searching for 7D73CTO1WW...');
  const searchInput = page.locator('input[placeholder*="Search"], input[type="text"]').first();
  await searchInput.fill('7D73CTO1WW');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);

  // Click Configure on the SR630 V3 product card
  console.log('Clicking Configure button...');
  const configBtn = page.locator('button:has-text("Configure"), a:has-text("Configure")').first();
  if (await configBtn.isVisible({ timeout: 5000 })) {
    await configBtn.click();
    console.log('Clicked Configure. Waiting for configurator UI to settle...');
    await page.waitForTimeout(12000);
  }

  await page.screenshot({ path: path.join(outputDir, 'configurator-view.png') });

  // Save captured logs so far
  fs.writeFileSync(path.join(outputDir, 'api_trace.json'), JSON.stringify(apiLogs, null, 2));
  fs.writeFileSync(path.join(outputDir, 'browser_console.json'), JSON.stringify(consoleLogs, null, 2));

  console.log(`Captured ${apiLogs.length} API requests so far.`);
  await browser.close();
}

runFullTrace().catch((err) => {
  console.error('Fatal trace error:', err);
  process.exit(1);
});
