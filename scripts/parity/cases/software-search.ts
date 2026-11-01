/** Software page MT/CTO/LFO ID search (CTO mode) against dcsc_search kind software. */
import { enumerateIds } from '../continuations.js';
import type { ParityCase } from '../harness.js';
import { openHome, settle } from '../settingsUi.js';
import { DCSC_HOME } from '../web.js';

const PRODUCT = '7D73CTO1WW';
const SEARCH_INPUT = 'input[placeholder="MT/CTO/LFO ID"]';
const SEARCH_PAGE = 50;

const featureCodes = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(featureCodes);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const own = Array.isArray(record['features'])
    ? record['features'].flatMap(feature => typeof (feature as Record<string, unknown>)?.['code'] === 'string' ? [(feature as Record<string, string>)['code']!] : [])
    : [];
  return [...own, ...Object.entries(record).filter(([key]) => key !== 'features').flatMap(([, child]) => featureCodes(child))];
};

export default {
  id: 'software-search',
  tags: ['software', 'catalog'],
  async run(h) {
    const { mcp, web, step, compare } = h;

    const native = await step('website-search', async () => {
      const page = await web.newPage();
      page.setDefaultTimeout(90_000);
      await openHome(page, DCSC_HOME);
      await page.getByText('Software', { exact: true }).first().click();
      await settle(page);
      await page.getByText('CTO', { exact: true }).first().click();
      await settle(page);
      const pending = page.waitForResponse(response => response.request().method() === 'GET'
        && response.url().includes(`/api/software/portal/search/${PRODUCT}`), { timeout: 120_000 });
      await page.locator(SEARCH_INPUT).fill(PRODUCT);
      await page.locator('button.ant-search-btn').click();
      const response = await pending;
      return { mode: new URL(response.url()).searchParams.get('mode'), codes: [...new Set(featureCodes(await response.json()))].sort() };
    });

    await step('mcp-search', async () => {
      const found = await enumerateIds(mcp, 'dcsc_search', { search: { kind: 'software', productCode: PRODUCT, mode: 'CTO', limit: SEARCH_PAGE } }, 'software', 'code');
      compare('search-mode', 'cto', native.mode);
      compare('search-software', native.codes, [...new Set(found.ids)].sort());
    });
  },
} satisfies ParityCase;
