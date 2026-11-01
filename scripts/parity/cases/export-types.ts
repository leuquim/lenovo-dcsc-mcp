/** The reports each solution mode's Export dialog offers against the MCP's default export for the same mode. */
import path from 'node:path';

import { zipNames } from '../archives.js';
import { selectBrowserSolutionMode } from '../browser.js';
import { captureBrowserExport, CAPTURE_EXPORT_FORMS } from '../exportUi.js';
import type { Harness, ParityCase } from '../harness.js';
import { settle, visible } from '../settingsUi.js';
import { DCSC_HOME } from '../web.js';

const MODES = [
  { id: 'gp', solutionMode: 'General Purpose', product: '7D73CTO1WW' },
  { id: 'hpc', solutionMode: 'HPC and AI - Systems', product: '7D73CTOHWW' },
];
const OFFERED_FILE_NAME = 'export-types';

async function offeredReports(h: Harness, mode: (typeof MODES)[number]): Promise<string[]> {
  const page = await h.web.newPage();
  page.setDefaultTimeout(90_000);
  await page.addInitScript({ content: CAPTURE_EXPORT_FORMS });
  await page.goto(DCSC_HOME, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await selectBrowserSolutionMode(page, mode.solutionMode, { diagnosticsDir: h.out });
  await page.goto(new URL(`#/configuration/cto/${mode.product}?hardwareType=server`, DCSC_HOME).href, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await visible(page.getByText('Configuration Price', { exact: true }), 'Configuration Price');
  await settle(page);
  await (await visible(page.getByRole('button', { name: 'Summary' }), 'Summary button')).evaluate(element => (element as HTMLElement).click());
  await page.waitForURL(/rack-summary/, { waitUntil: 'commit', timeout: 60_000 });
  await settle(page);
  const exported = await captureBrowserExport(page, h.out, OFFERED_FILE_NAME, { allTypes: true, archiveName: `browser-${mode.id}-all-types` });
  return zipNames(exported.archive);
}

export default {
  id: 'export-types',
  tags: ['export'],
  async run(h) {
    for (const mode of MODES) {
      const offered = await h.step(`${mode.id}-website`, () => offeredReports(h, mode));
      await h.step(`${mode.id}-mcp`, async () => {
        const launched = await h.mcp.call('dcsc_launch', { productCode: mode.product, mode: 'cto', solutionMode: mode.solutionMode });
        const exported = await h.mcp.call('dcsc_export', { kind: 'reports', session: launched['session'], scope: 'configuration', fileName: OFFERED_FILE_NAME });
        h.compare(`${mode.id}-default-reports`, offered, await zipNames(path.resolve(String(exported['zipPath']))));
      });
    }
  },
} satisfies ParityCase;
