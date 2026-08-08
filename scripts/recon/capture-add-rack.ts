/**
 * Focused capture of the "add a rack cabinet to the workspace" operation.
 * Tries a plain click on the catalog menu item, then a drag into the rack
 * workspace if the click produces no API traffic.
 */
import { chromium, type Page } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs';

const OUT = 'artifacts/rack_probe';
const XML = 'artifacts/nvidia_ai_factory_blueprints/nvidia-blueprint-7dm9cto1ww.xml';
const RACK = '7D6DCTO1WW'; // 42U Onyx Heavy Duty Rack Cabinet

interface Captured {
  phase: string;
  url: string;
  method: string;
  status: number;
  reqBody?: string;
  resBody?: string;
}

let phase = 'boot';
const captured: Captured[] = [];

function attach(page: Page) {
  page.on('response', async (res) => {
    const url = res.url();
    if (!/dcsc\.lenovo\.com\/api\//.test(url)) return;
    const e: Captured = { phase, url, method: res.request().method(), status: res.status() };
    try {
      e.reqBody = res.request().postData() ?? undefined;
    } catch {}
    try {
      e.resBody = await res.text();
    } catch {}
    captured.push(e);
  });
}

function since(mark: number) {
  return captured.slice(mark).map((c) => `${c.method} ${c.url.split('?')[0]}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  attach(page);

  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  try {
    const cc = page.locator('.dcsc-cookie-close').first();
    if (await cc.isVisible({ timeout: 2000 })) await cc.click();
  } catch {}

  phase = 'import';
  await page.locator('.start-configuration-new-new-tile:has-text("Use Prior Configuration")').first().click();
  await page.waitForTimeout(2000);
  await page.locator('input[type="file"]').first().setInputFiles(path.resolve(XML));
  await page.waitForTimeout(15000);

  await page.locator('.summary__action:has-text("Go to Workspace")').first().click();
  await page.waitForTimeout(10000);

  await page.locator('span:text-is("Rack")').first().click();
  await page.waitForTimeout(6000);

  const item = page.locator(`li.ant-menu-item:has-text("${RACK}"), .menu-item:has-text("${RACK}")`).first();
  console.log('rack menu item count:', await item.count());
  console.log('visible:', await item.isVisible().catch(() => false));

  phase = 'click-rack';
  let mark = captured.length;
  await item.click();
  await page.waitForTimeout(8000);
  console.log('\nAPI calls after click:', since(mark));

  if (since(mark).length === 0) {
    console.log('\nClick produced nothing — trying drag into .rack-workspace');
    phase = 'drag-rack';
    mark = captured.length;
    const target = page.locator('.rack-workspace').first();
    const from = await item.boundingBox();
    const to = await target.boundingBox();
    if (from && to) {
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 25 });
      await page.mouse.up();
      await page.waitForTimeout(8000);
      console.log('API calls after drag:', since(mark));
    } else {
      console.log('could not resolve bounding boxes', { from: !!from, to: !!to });
    }
  }

  await page.screenshot({ path: `${OUT}/add-rack-result.png`, fullPage: true });
  const text = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  console.log('\n--- PAGE TEXT ---\n', text);

  fs.writeFileSync(`${OUT}/add-rack-capture.json`, JSON.stringify(captured, null, 2));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
