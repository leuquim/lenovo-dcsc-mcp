import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto('https://dcsc.lenovo.com/#/configuration/cto/7D73CTO1WW?hardwareType=server', {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(6000);

  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  // Find all elements containing text or class related to export/header
  const locators = page.locator('button, a, div, span, i, li');
  const count = await locators.count();
  console.log(`Checking ${count} elements...`);

  for (let i = 0; i < count; i++) {
    const el = locators.nth(i);
    const text = (await el.textContent())?.trim();
    const className = await el.getAttribute('class');
    const isVisible = await el.isVisible();

    if (isVisible && text && text.length < 50) {
      if (
        text.toLowerCase().includes('export') ||
        text.toLowerCase().includes('download') ||
        text.toLowerCase().includes('save') ||
        text.toLowerCase().includes('bom') ||
        text.toLowerCase().includes('summary') ||
        (className && className.includes('download')) ||
        (className && className.includes('export'))
      ) {
        console.log(`[Index ${i}] tag=${await el.evaluate((e) => e.tagName)} text="${text}" class="${className}"`);
      }
    }
  }

  await browser.close();
}

main().catch(console.error);
