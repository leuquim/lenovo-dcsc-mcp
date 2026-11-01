/** Preconfigured launch: the configurator tabs the website builds from the SW and HW as_lfo_launch scopes against dcsc_launch mode lfo. */
import assert from 'node:assert/strict';

import type { Json, ParityCase } from '../harness.js';
import { settle, visible } from '../settingsUi.js';
import { DCSC_HOME } from '../web.js';

const PRODUCT = '7DCEA04VNA';
const CLIENT_ONLY_TAB = 'Unconfigured';
const rows = (value: unknown): Json[] => Array.isArray(value) ? value as Json[] : [];

export default {
  id: 'lfo-launch-scopes',
  tags: ['lfo'],
  async run(h) {
    const website = await h.step('website-launch', async () => {
      const page = await h.web.newPage();
      page.setDefaultTimeout(90_000);
      const scopes: string[] = [];
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname.endsWith('/as_lfo_launch')) scopes.push(String(url.searchParams.get('scope')));
      });
      await page.goto(DCSC_HOME, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await settle(page);
      await (await visible(page.getByText('Part Search', { exact: true }), 'Part Search')).click();
      await (await visible(page.getByText('Preconfigured', { exact: true }), 'Preconfigured mode')).click();
      const keyword = await visible(page.locator('.ant-modal:visible input[type=text]'), 'Part Search keyword');
      await keyword.fill(PRODUCT);
      await keyword.press('Enter');
      await (await visible(page.getByText('Select', { exact: true }), 'Select')).click();
      await (await visible(page.getByText('Add Items', { exact: true }), 'Add Items')).click();
      await page.waitForURL(/#\/rack-summary\/rack-lfo/, { timeout: 120_000 });
      await settle(page);
      await (await visible(page.getByText('Customize', { exact: true }), 'Customize')).click();
      await page.waitForURL(/#\/configuration\/lfo\//, { timeout: 90_000 });
      await settle(page);
      const tabs = (await page.locator('.ant-tabs-tab').allInnerTexts()).map(title => title.trim()).filter(title => title && title !== CLIENT_ONLY_TAB);
      assert.deepEqual(scopes.slice(0, 2), ['SW', 'HW'], 'The website did not load the SW scope then the HW scope.');
      return tabs;
    });

    await h.step('mcp-launch', async () => {
      await h.mcp.call('dcsc_launch', { productCode: PRODUCT, mode: 'lfo', solutionMode: 'General Purpose' });
      const configuration = rows(h.mcp.persistedWorkspaces()[0]!['configurations'])[0]!;
      const tabs = rows((configuration['raw'] as Json)['tabs']).map(tab => String(tab['title']));
      h.compare('configurator-tabs', website, tabs);
    });
  },
} satisfies ParityCase;
