/**
 * Drives the DCSC Web UI through the rack workflow and captures the full
 * request/response for every API call, so the MCP server can reproduce
 * rack placement, power and cabling faithfully instead of modelling them
 * locally.
 *
 * Flow: import a known-good config -> Go to Workspace -> add a rack ->
 * place the server in it -> observe power/PDU/cabling traffic.
 *
 * Usage: npx tsx scripts/capture-rack-workflow.ts
 */
import { chromium, type Page } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs';

const OUT = 'artifacts/rack_probe';
const XML = 'artifacts/nvidia_ai_factory_blueprints/nvidia-blueprint-7dm9cto1ww.xml';

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
    const entry: Captured = { phase, url, method: res.request().method(), status: res.status() };
    try {
      entry.reqBody = res.request().postData() ?? undefined;
    } catch {}
    try {
      entry.resBody = await res.text();
    } catch {}
    captured.push(entry);
  });
}

async function describe(page: Page, label: string) {
  const text = await page.evaluate(() => document.body.innerText.slice(0, 1800));
  fs.writeFileSync(`${OUT}/text-${label}.txt`, text);
  await page.screenshot({ path: `${OUT}/${label}.png`, fullPage: true });
  console.log(`\n===== [${label}] URL: ${page.url()} =====`);
  console.log(text.slice(0, 1200));
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
  await describe(page, '01-summary');

  phase = 'workspace';
  const goWs = page.locator('.summary__action:has-text("Go to Workspace")').first();
  await goWs.click();
  await page.waitForTimeout(8000);
  await describe(page, '02-workspace');

  // The workspace catalog has a "Rack" category; opening it lists rack
  // cabinets that can be added to the layout.
  phase = 'rack-category';
  await page.locator('span:text-is("Rack")').first().click();
  await page.waitForTimeout(8000);
  await describe(page, '03-rack-category');

  const rackItems = await page.evaluate(() => {
    const out: Array<{ cls: string; text: string }> = [];
    for (const el of Array.from(document.querySelectorAll('[class*="product"], [class*="item"], [class*="card"]'))) {
      const text = (el as HTMLElement).innerText?.trim().slice(0, 80) ?? '';
      if (!/rack|cabinet/i.test(text)) continue;
      out.push({ cls: (el.getAttribute('class') ?? '').slice(0, 80), text });
    }
    return out.slice(0, 40);
  });
  fs.writeFileSync(`${OUT}/rack-items.json`, JSON.stringify(rackItems, null, 2));
  console.log('\n--- RACK PRODUCTS OFFERED ---');
  for (const r of rackItems) console.log(`  class="${r.cls}"  "${r.text.replace(/\n/g, ' | ')}"`);

  // Add the first rack cabinet we can see.
  phase = 'add-rack';
  const rackCard = page
    .locator('[class*="product"], [class*="item"], [class*="card"]')
    .filter({ hasText: /42U|48U|Rack Cabinet/i })
    .first();
  if ((await rackCard.count()) > 0) {
    await rackCard.click();
    await page.waitForTimeout(8000);
    await describe(page, '04-after-add-rack');
  } else {
    console.log('!! no rack card found to click');
  }

  // Enumerate what the workspace offers so we can find the rack controls.
  const controls = await page.evaluate(() => {
    const out: Array<{ tag: string; cls: string; text: string }> = [];
    const sel = 'button, a, [role="button"], .ant-btn, [class*="rack"], [class*="add"], [class*="tool"]';
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const text = (el as HTMLElement).innerText?.trim().slice(0, 50) ?? '';
      const cls = (el.getAttribute('class') ?? '').slice(0, 90);
      if (!text && !cls) continue;
      out.push({ tag: el.tagName, cls, text });
    }
    return out.slice(0, 300);
  });
  fs.writeFileSync(`${OUT}/workspace-controls.json`, JSON.stringify(controls, null, 2));
  console.log('\n--- WORKSPACE CONTROLS (rack/add related) ---');
  for (const c of controls) {
    if (/rack|add|cabinet|enclos|pdu|power/i.test(c.text) || /rack|add|pdu|power/i.test(c.cls)) {
      console.log(`<${c.tag}> class="${c.cls}"  text="${c.text.replace(/\n/g, ' | ')}"`);
    }
  }

  fs.writeFileSync(`${OUT}/capture.json`, JSON.stringify(captured, null, 2));
  console.log(`\nCaptured ${captured.length} API calls -> ${OUT}/capture.json`);
  console.log('Endpoints by phase:');
  for (const p of [...new Set(captured.map((c) => c.phase))]) {
    console.log(` [${p}]`);
    for (const u of [...new Set(captured.filter((c) => c.phase === p).map((c) => `${c.method} ${c.url.split('?')[0]}`))]) {
      console.log('   ', u);
    }
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
