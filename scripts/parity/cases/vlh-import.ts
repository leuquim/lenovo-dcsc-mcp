/** VLH Item Editor > Import Items: the website and dcsc_vlh_set import both receive HTTP 500 from POST /vlh/import. */
import assert from 'node:assert/strict';
import path from 'node:path';

import { selectBrowserSolutionMode } from '../browser.js';
import { HPC_MODE } from '../fabric.js';
import type { ParityCase } from '../harness.js';
import { goToWorkspace } from '../rackUi.js';
import { settle, visible } from '../settingsUi.js';
import { DCSC_HOME } from '../web.js';

const HPC_SEED = path.resolve('test/fixtures/parity/xml/manual-cabling-network.xml');
const UPSTREAM_STATUS = 500;

export default {
  id: 'vlh-import',
  tags: ['vlh'],
  async run(h) {
    const vlhFile = await h.step('export-vlh-file', async () => {
      const exported = await h.mcp.call('dcsc_vlh_set', { items: [{ description: 'New Item' }], fileName: 'vlh-import-source' });
      return String(exported['path']);
    });

    const websiteStatus = await h.step('website-import-items', async () => {
      const page = await h.web.newPage();
      page.setDefaultTimeout(90_000);
      await page.goto(DCSC_HOME, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await selectBrowserSolutionMode(page, HPC_MODE, { diagnosticsDir: h.out });
      await page.locator('input[type=file]').first().setInputFiles(HPC_SEED);
      await page.waitForURL(/#\/(?:rack-summary|summary)\//, { timeout: 120_000 });
      await settle(page);
      await goToWorkspace(page);
      await (await visible(page.getByText('VLH', { exact: true }), 'VLH toolbar button')).click();
      await (await visible(page.getByText('Import Items', { exact: true }), 'Import Items button')).click();
      const input = page.locator('.ant-modal input[type=file]').first();
      await input.waitFor({ state: 'attached' });
      const pending = page.waitForResponse(response => response.url().includes('/vlh/import') && response.request().method() === 'POST', { timeout: 120_000 });
      await input.setInputFiles(vlhFile);
      return (await pending).status();
    });
    assert.equal(websiteStatus, UPSTREAM_STATUS, `The website import returned HTTP ${websiteStatus}; the upstream refusal this case documents is gone.`);

    await h.skip('mcp-import-items', 'POST /vlh/import returns HTTP 500 for the website too (captures/p3-vlh-import.json).',
      () => h.mcp.call('dcsc_vlh_set', { action: 'import', filePath: vlhFile }));
  },
} satisfies ParityCase;
