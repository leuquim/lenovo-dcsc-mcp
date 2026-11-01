/** Workspace > Rack button > Change rack model: the rack model and contents of the exported workspace against dcsc_rack_edit changeModel. */
import { readFile } from 'node:fs/promises';

import { normalizers, type Json, type ParityCase } from '../harness.js';
import { changeRackModelInBrowser, exportXml, goToWorkspace, backToSummary, openSummary } from '../rackUi.js';
import { SOURCE_XML } from '../rackPower.js';
import { workspaceContents } from '../workspaceXml.js';

const NEW_RACK_CODE = '7D6DCTO2WW';
const evidence = (xml: string) => ({ ...workspaceContents(xml), bom: normalizers.cfxml(xml) });

export default {
  id: 'rack-change-model',
  tags: ['rack', 'export'],
  async run(h) {
    const website = await h.step('website-change-model', async () => {
      const page = await openSummary(h, SOURCE_XML);
      await goToWorkspace(page);
      await changeRackModelInBrowser(page, NEW_RACK_CODE);
      await backToSummary(page);
      return evidence(await exportXml(h, page, 'website-change-model'));
    });

    await h.step('mcp-change-model', async () => {
      const imported = await h.mcp.call('dcsc_import', { filePath: SOURCE_XML, solutionMode: 'General Purpose' });
      const rackId = String((h.mcp.persistedWorkspaces()[0]!['rackArea'] as Json[])[0]!['id']);
      await h.mcp.call('dcsc_rack_edit', { session: imported['session'], action: 'changeModel', rackId, rackCode: NEW_RACK_CODE });
      const exported = await h.mcp.call('dcsc_export', { kind: 'reports', session: imported['session'], fileName: 'mcp-change-model', fileTypes: ['XML'] });
      h.compare('rack-model-contents-and-bom', website, evidence(await readFile(String(exported['xml']), 'utf8')));
    });
  },
} satisfies ParityCase;
