/** Native reference catalog Export vs dcsc_export kind reference, stdio persistence and import handoff. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizers, sha256, type Json, type ParityCase } from '../harness.js';

const CATEGORY_ID = '57d87668ec5695ab80433cf8866bf525';
const CRN_ID = 'SID0000978';
const PERSISTED_KEYS = ['configurations', 'rackArea', 'nonRackArea', 'serverState', 'revision'];
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];

export default {
  id: 'reference-download',
  tags: ['reference', 'import'],
  async run(h) {
    const { mcp, web, step, compare, out } = h;
    const savedWorkspace = async (id: string) => {
      const state = object(JSON.parse(await readFile(mcp.sessionFile, 'utf8')));
      const workspace = rows(state['workspaces']).find(entry => entry['id'] === id);
      assert(workspace, `Workspace ${id} was not persisted.`);
      return workspace;
    };

    const artifact = await step('mcp-download', () =>
      mcp.call('dcsc_export', { kind: 'reference', crnId: CRN_ID, solutionMode: 'General Purpose' }));
    const original = await readFile(String(artifact['path']));

    const nativePath = path.join(out, 'native-original.xml');
    await step('native-download', async () => {
      const page = await web.newPage();
      await page.goto(`https://dcsc.lenovo.com/#/reference-solution/categories/${CATEGORY_ID}/solutions`, { waitUntil: 'domcontentloaded' });
      const button = page.locator(`#${CRN_ID}`).getByRole('button', { name: 'Export', exact: true });
      await button.waitFor({ timeout: 60_000 });
      const pendingDownload = page.waitForEvent('download', { timeout: 120_000 });
      await button.evaluate(element => (element as HTMLElement).click());
      await (await pendingDownload).saveAs(nativePath);
      compare('download-bytes', sha256(await readFile(nativePath)), sha256(original));
    });

    const nativeImport = await step('native-import', () => web.importCfxml(nativePath, 'native'));

    const id = await step('mcp-import', async () => {
      const imported = await mcp.call('dcsc_import', { filePath: artifact['path'] });
      const id = String(imported['session']);
      const saved = await savedWorkspace(id);
      compare('import-configurations', normalizers.configurations(nativeImport['configuration']),
        normalizers.configurations(rows(saved['configurations']).map(entry => entry['raw'])));
      return id;
    });

    await step('restart', async () => {
      const before = await savedWorkspace(id);
      await mcp.killAndRestart();
      await mcp.call('dcsc_workspace_get', { session: id });
      const after = await savedWorkspace(id);
      compare('restart-persisted-state', Object.fromEntries(PERSISTED_KEYS.map(key => [key, before[key]])),
        Object.fromEntries(PERSISTED_KEYS.map(key => [key, after[key]])));
    });
  },
} satisfies ParityCase;
