import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  console.log('Navigating to SR630 V3 category page...');
  await page.goto('https://dcsc.lenovo.com/#/categories/STG%40Servers%40Rack%20Server%40ThinkSystem%20SR630%20V3', {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(4000);

  // Dismiss cookie banner
  try {
    const cookieClose = page.locator('.dcsc-cookie-close').first();
    if (await cookieClose.isVisible({ timeout: 2000 })) await cookieClose.click();
  } catch {}

  const textNodes = page.locator('button, a, .ant-btn, .home-category__title, div[class*="title"], div[class*="btn"]');
  const count = await textNodes.count();
  console.log(`Found ${count} interactive text nodes.`);

  for (let i = 0; i < count; i++) {
    const txt = (await textNodes.nth(i).textContent())?.trim().replace(/\s+/g, ' ');
    const tag = await textNodes.nth(i).evaluate((el) => el.tagName.toLowerCase());
    const href = await textNodes.nth(i).getAttribute('href');
    if (txt) {
      console.log(`[${tag}] ${txt} ${href ? `(href=${href})` : ''}`);
    }
  }

  await browser.close();
}

main().catch(console.error);
