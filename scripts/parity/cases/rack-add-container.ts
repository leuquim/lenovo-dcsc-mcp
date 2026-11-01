/** Summary > a non-rack item's Add Container: the rack and its contents in the exported workspace against dcsc_rack_add with a configuration. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Json, ParityCase } from '../harness.js';
import { addContainerInBrowser, exportXml, openSummary } from '../rackUi.js';
import { workspaceContents } from '../workspaceXml.js';

const SOURCE_XML = path.resolve('test/fixtures/parity/xml/sr630-v3-qty1.xml');
const RACK_CODE = '7D6DCTO1WW';

export default {
  id: 'rack-add-container',
  tags: ['rack', 'export'],
  async run(h) {
    const website = await h.step('website-add-container', async () => {
      const page = await openSummary(h, SOURCE_XML);
      await addContainerInBrowser(page, RACK_CODE);
      return workspaceContents(await exportXml(h, page, 'website-container'));
    });

    await h.step('mcp-add-container', async () => {
      const imported = await h.mcp.call('dcsc_import', { filePath: SOURCE_XML, solutionMode: 'General Purpose' });
      const configuration = String(((imported['configurations'] as Json[])[0] as Json)['id']);
      const added = await h.mcp.call('dcsc_rack_add', { session: imported['session'], rackCode: RACK_CODE, configuration });
      h.compare('layout-has-no-unplaced-item', { rackCount: 1, unplacedCount: 0 },
        { rackCount: added['rackCount'], unplacedCount: added['unplacedCount'] });
      const exported = await h.mcp.call('dcsc_export', { kind: 'reports', session: imported['session'], fileName: 'mcp-container', fileTypes: ['XML'] });
      h.compare('rack-contents-and-loose-items', website, workspaceContents(await readFile(String(exported['xml']), 'utf8')));
    });
  },
} satisfies ParityCase;
