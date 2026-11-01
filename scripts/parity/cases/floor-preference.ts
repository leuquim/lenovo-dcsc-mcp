/** Workspace Floor Preference modal: the FloorInformation of the exported workspace against dcsc_floor_set preferences. */
import { readFile } from 'node:fs/promises';

import type { Json, ParityCase } from '../harness.js';
import { SOURCE_XML } from '../rackPower.js';
import { backToSummary, exportXml, goToWorkspace, openSummary, setFloorPreferenceInBrowser } from '../rackUi.js';
import { floorInformation } from '../workspaceXml.js';

const ROWS_AFTER_ONE_ROW_PLUS = 4;
const PREFERENCE = { rackDist: 0.5, coldDist: 4, trayCabling: true };

export default {
  id: 'floor-preference',
  tags: ['rack', 'floor', 'export'],
  async run(h) {
    const website = await h.step('website-floor-preference', async () => {
      const page = await openSummary(h, SOURCE_XML);
      await goToWorkspace(page);
      await setFloorPreferenceInBrowser(page, { rowPlus: 1, ...PREFERENCE });
      await backToSummary(page);
      return floorInformation(await exportXml(h, page, 'website-floor-preference'));
    });

    await h.step('mcp-floor-preference', async () => {
      const imported = await h.mcp.call('dcsc_import', { filePath: SOURCE_XML, solutionMode: 'General Purpose' });
      await h.mcp.call('dcsc_floor_set', { session: imported['session'], change: { kind: 'preferences',
        rowCount: ROWS_AFTER_ONE_ROW_PLUS, rackDist: PREFERENCE.rackDist, coldDist: PREFERENCE.coldDist, useTrayCabling: PREFERENCE.trayCabling } });
      const exported: Json = await h.mcp.call('dcsc_export', { kind: 'reports', session: imported['session'], fileName: 'mcp-floor-preference', fileTypes: ['XML'] });
      h.compare('floor-information', website, floorInformation(await readFile(String(exported['xml']), 'utf8')));
    });
  },
} satisfies ParityCase;
