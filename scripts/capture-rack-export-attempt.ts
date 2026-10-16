/**
 * Attempt to capture a successful rack-bearing export_zip form POST from the SPA.
 * Criterion: either save a payload with non-empty rackData/rackArea, or record failure.
 *
 * Usage: npx tsx scripts/capture-rack-export-attempt.ts
 * Output: artifacts/export_capture_attempt/ + log lines for {SCRATCH}
 */
import { chromium, type Page } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUT = 'artifacts/export_capture_attempt';
const XML = 'artifacts/nvidia_ai_factory_blueprints/nvidia-blueprint-7dm9cto1ww.xml';

interface Cap {
  url: string;
  method: string;
  postData?: string;
  status?: number;
}

const captured: Cap[] = [];

function attach(page: Page) {
  page.on('request', (req) => {
    const url = req.url();
    if (!/export_zip|export|p2p-report/i.test(url)) return;
    const postData = req.postData();
    captured.push({
      url,
      method: req.method(),
      ...(postData === null ? {} : { postData }),
    });
    console.log('REQ', req.method(), url.slice(0, 120), 'bodyLen=', (req.postData() ?? '').length);
  });
  page.on('response', async (res) => {
    const url = res.url();
    if (!/export_zip|export|p2p-report/i.test(url)) return;
    const entry = captured.find((c) => c.url === url && c.status === undefined);
    if (entry) entry.status = res.status();
    console.log('RES', res.status(), url.slice(0, 120));
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    console.log(s);
    log.push(s);
  };

  const hasXml = fs.existsSync(XML);
  note(`xml present: ${hasXml} (${XML})`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  attach(page);

  // Hook hidden form submit
  await page.addInitScript(() => {
    (window as unknown as { __exportCaptures: unknown[] }).__exportCaptures = [];
    const orig = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
      const fields: Record<string, string> = {};
      this.querySelectorAll('input').forEach((inp) => {
        fields[(inp as HTMLInputElement).name] = (inp as HTMLInputElement).value;
      });
      (window as unknown as { __exportCaptures: unknown[] }).__exportCaptures.push({
        action: this.action,
        method: this.method,
        fields,
        at: Date.now(),
      });
      return orig.call(this);
    };
  });

  note('goto dcsc home');
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(2500);
  try {
    const cc = page.locator('.dcsc-cookie-close').first();
    if (await cc.isVisible({ timeout: 2000 })) await cc.click();
  } catch {
    /* ignore */
  }

  if (hasXml) {
    note('import blueprint via Use Prior Configuration');
    try {
      await page.locator('.start-configuration-new-new-tile:has-text("Use Prior Configuration")').first().click();
      await page.waitForTimeout(2000);
      await page.locator('input[type="file"]').first().setInputFiles(path.resolve(XML));
      await page.waitForTimeout(15000);
      await page.screenshot({ path: `${OUT}/01-after-import.png`, fullPage: true });
    } catch (e) {
      note(`import UI failed: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  // Go to workspace if available
  try {
    const goWs = page.locator('.summary__action:has-text("Go to Workspace"), button:has-text("Go to Workspace")').first();
    if (await goWs.isVisible({ timeout: 5000 })) {
      note('Go to Workspace');
      await goWs.click();
      await page.waitForTimeout(10000);
      await page.screenshot({ path: `${OUT}/02-workspace.png`, fullPage: true });
    }
  } catch {
    note('no Go to Workspace');
  }

  // Try add rack category
  try {
    const rack = page.locator('span:text-is("Rack"), a:has-text("Rack")').first();
    if (await rack.isVisible({ timeout: 4000 })) {
      note('open Rack category');
      await rack.click();
      await page.waitForTimeout(6000);
      const card = page.locator('[class*="product"], [class*="card"]').filter({ hasText: /42U|Rack Cabinet/i }).first();
      if ((await card.count()) > 0) {
        note('click rack cabinet card');
        await card.click();
        await page.waitForTimeout(8000);
      }
    }
  } catch (e) {
    note(`rack add skipped: ${(e as Error).message.slice(0, 120)}`);
  }

  // Export flow
  note('attempt Export UI');
  try {
    const exportBtn = page
      .locator('button.action-button:has-text("Export"), button:has-text("Export")')
      .first();
    if (await exportBtn.isVisible({ timeout: 8000 })) {
      await exportBtn.click();
      await page.waitForTimeout(2000);
      // Prefer full configuration / zip export menu items
      const items = page.locator('.ant-dropdown-menu-item, span, li, button');
      const n = await items.count();
      for (let i = 0; i < Math.min(n, 40); i++) {
        const t = ((await items.nth(i).textContent()) ?? '').trim();
        if (/configuration|zip|all files|download/i.test(t) && t.length < 40) {
          note(`click menu item: ${t}`);
          try {
            await items.nth(i).click({ timeout: 2000 });
            await page.waitForTimeout(2000);
          } catch {
            /* continue */
          }
        }
      }
      const dl = page.locator('button:has-text("Download"), .ant-modal-footer button.ant-btn-primary').first();
      if (await dl.isVisible({ timeout: 3000 })) {
        note('click Download');
        await dl.click();
        await page.waitForTimeout(6000);
      }
    } else {
      note('Export button not visible');
    }
  } catch (e) {
    note(`export UI error: ${(e as Error).message.slice(0, 200)}`);
  }

  await page.screenshot({ path: `${OUT}/03-after-export-attempt.png`, fullPage: true });

  const formCaps = await page.evaluate(
    () => (window as unknown as { __exportCaptures?: unknown[] }).__exportCaptures ?? [],
  );
  note(`form submit captures: ${Array.isArray(formCaps) ? formCaps.length : 0}`);
  note(`network export-related captures: ${captured.length}`);

  fs.writeFileSync(`${OUT}/network-captures.json`, JSON.stringify(captured, null, 2));
  fs.writeFileSync(`${OUT}/form-captures.json`, JSON.stringify(formCaps, null, 2));

  let foundRackPayload = false;
  for (const c of captured) {
    if (!c.postData) continue;
    try {
      const params = new URLSearchParams(c.postData);
      const data = params.get('data');
      if (!data) continue;
      const obj = JSON.parse(data) as {
        workspace?: { rackArea?: unknown[] };
        workspaceInformation?: { rackData?: unknown[] };
      };
      const ra = obj.workspace?.rackArea?.length ?? 0;
      const rd = obj.workspaceInformation?.rackData?.length ?? 0;
      note(`parsed export data: rackArea=${ra} rackData=${rd} url=${c.url.slice(0, 80)}`);
      if (ra > 0 || rd > 0) {
        foundRackPayload = true;
        fs.writeFileSync(`${OUT}/SUCCESS-rack-bearing-export-data.json`, JSON.stringify(obj, null, 2));
      } else {
        fs.writeFileSync(`${OUT}/export-data-no-racks.json`, JSON.stringify(obj, null, 2));
      }
    } catch {
      /* not form-urlencoded data */
    }
  }

  if (Array.isArray(formCaps)) {
    for (const fc of formCaps as Array<{ fields?: { data?: string } }>) {
      const data = fc.fields?.data;
      if (!data) continue;
      try {
        const obj = JSON.parse(data) as {
          workspace?: { rackArea?: unknown[] };
          workspaceInformation?: { rackData?: unknown[] };
        };
        const ra = obj.workspace?.rackArea?.length ?? 0;
        const rd = obj.workspaceInformation?.rackData?.length ?? 0;
        note(`form capture rackArea=${ra} rackData=${rd}`);
        if (ra > 0 || rd > 0) {
          foundRackPayload = true;
          fs.writeFileSync(`${OUT}/SUCCESS-form-rack-export-data.json`, JSON.stringify(obj, null, 2));
        }
      } catch {
        /* ignore */
      }
    }
  }

  note(foundRackPayload ? 'RESULT: captured rack-bearing export payload' : 'RESULT: no rack-bearing export payload captured');
  fs.writeFileSync(`${OUT}/attempt.log`, log.join('\n') + '\n');
  await browser.close();
  process.exit(foundRackPayload ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
