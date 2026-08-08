import { chromium } from 'playwright';

async function main() {
  console.log('Launching browser in headed mode...');
  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({
    viewport: null,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  console.log('Navigating to https://dcsc.lenovo.com/ ...');
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'networkidle', timeout: 30000 });

  await page.waitForTimeout(3000);

  // Close OneTrust cookie banner if present
  try {
    const otAccept = page.locator('#onetrust-accept-btn-handler');
    if (await otAccept.isVisible()) await otAccept.click();
  } catch (e) {}

  // Dismiss country popup
  try {
    const dontChange = page.locator('button:has-text("Dont change"), button:has-text("Don\'t change")');
    if (await dontChange.isVisible()) await dontChange.click();
  } catch (e) {}

  await page.waitForTimeout(1000);

  // Click Tools in top nav bar
  console.log('Clicking "Tools" in header...');
  const toolsHeader = page.locator('text="Tools"').first();
  if (await toolsHeader.isVisible()) {
    await toolsHeader.highlight();
    await toolsHeader.click({ force: true });
    console.log('Clicked Tools header menu.');
    await page.waitForTimeout(1500);
  }

  // Click "Use Prior Configuration" card
  console.log('Clicking "Use Prior Configuration"...');
  const priorCard = page.locator('text="Use Prior Configuration"').first();
  if (await priorCard.isVisible()) {
    await priorCard.highlight();
    await priorCard.click({ force: true });
    console.log('Clicked Use Prior Configuration card.');
    await page.waitForTimeout(2000);
  }

  await page.screenshot({ path: 'scratch/dcsc-import-menu.png' });
  console.log('Saved screenshot to scratch/dcsc-import-menu.png');

  console.log('Headed Chromium browser is running live on screen. Leaving open...');
  await new Promise((r) => setTimeout(r, 600000));
}

main().catch((err) => {
  console.error('Playwright error:', err);
});
