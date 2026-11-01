/** Summary > a rack line's Add Hardware: the rack contents and BOM of the exported workspace against dcsc_rack_edit addHardware. */
import { readFile } from 'node:fs/promises';

import { normalizers, type Json, type ParityCase } from '../harness.js';
import { addHardwareInBrowser, exportXml, openSummary } from '../rackUi.js';
import { SOURCE_XML } from '../rackPower.js';
import { workspaceContents } from '../workspaceXml.js';

const PRODUCT_CODE = '7D73CTO1WW';
const MENU_PATH = ['Servers', 'Rack Server', 'ThinkSystem SR630 V3'];
const evidence = (xml: string) => ({ ...workspaceContents(xml), bom: normalizers.cfxml(xml) });

export default {
  id: 'rack-add-hardware',
  tags: ['rack', 'export'],
  async run(h) {
    const website = await h.step('website-add-hardware', async () => {
      const page = await openSummary(h, SOURCE_XML);
      await addHardwareInBrowser(page, MENU_PATH, PRODUCT_CODE);
      return evidence(await exportXml(h, page, 'website-add-hardware'));
    });

    await h.step('mcp-add-hardware', async () => {
      const imported = await h.mcp.call('dcsc_import', { filePath: SOURCE_XML, solutionMode: 'General Purpose' });
      const rackId = String((h.mcp.persistedWorkspaces()[0]!['rackArea'] as Json[])[0]!['id']);
      await h.mcp.call('dcsc_rack_edit', { session: imported['session'], action: 'addHardware', rackId, productCode: PRODUCT_CODE });
      const exported = await h.mcp.call('dcsc_export', { kind: 'reports', session: imported['session'], fileName: 'mcp-add-hardware', fileTypes: ['XML'] });
      h.compare('rack-contents-and-bom', website, evidence(await readFile(String(exported['xml']), 'utf8')));
    });
  },
} satisfies ParityCase;
