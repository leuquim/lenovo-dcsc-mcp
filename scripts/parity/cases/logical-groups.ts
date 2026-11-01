/** Summary > More > Logical Groups: the groups the website posts in the export form against dcsc_export groups. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ParityCase } from '../harness.js';
import { createLogicalGroupsInBrowser, exportXml, openSummary } from '../rackUi.js';
import { logicalGroups } from '../workspaceXml.js';

const SOURCE_XML = path.resolve('test/fixtures/parity/xml/sr630-v3-qty1.xml');
const MOVED_PART = '7S0XCTO6WW';
const GROUPS = [{ name: 'G1', products: [] as string[] }, { name: 'G2', parent: 'G1', products: [MOVED_PART] }];

export default {
  id: 'logical-groups',
  tags: ['export', 'groups'],
  async run(h) {
    const website = await h.step('website-groups', async () => {
      const page = await openSummary(h, SOURCE_XML);
      await createLogicalGroupsInBrowser(page, GROUPS);
      return logicalGroups(await exportXml(h, page, 'website-groups'));
    });

    await h.step('mcp-groups', async () => {
      const imported = await h.mcp.call('dcsc_import', { filePath: SOURCE_XML, solutionMode: 'General Purpose' });
      const exported = await h.mcp.call('dcsc_export', { kind: 'reports', session: imported['session'], fileName: 'mcp-groups',
        fileTypes: ['XML'], groups: GROUPS });
      const mcp = logicalGroups(await readFile(String(exported['xml']), 'utf8'));
      h.compare('group-tree-and-membership', website.map(({ name, parent, index, products }) => ({ name, parent, index,
        moved: products.includes(MOVED_PART) })), mcp.map(({ name, parent, index, products }) => ({ name, parent, index,
        moved: products.includes(MOVED_PART) })));
    });
  },
} satisfies ParityCase;
