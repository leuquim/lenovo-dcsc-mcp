/** Rack item and empty-U Lock: website customize requests against dcsc_rack_edit lock, the reserved-U rule, export and re-import. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Page, Request } from 'playwright';

import type { ParityCase } from '../harness.js';
import { exportFromWorkspace, ONE_RACK_XML, rows, SERVER_CODE, SUMMARY_ROUTE } from '../rackUi.js';
import { importInBrowser, object } from '../softwareSummaryUi.js';

const RESERVED_U = 42;
const CUSTOMIZE_API_PATH = '/api/ctos/racks/customize';

const firstRack = (body: unknown): Json => rows(object(body)['rackArea'])[0] ?? {};
const lockShape = (body: unknown) => {
  const rack = firstRack(body);
  return { lockedSpace: rack['lockedSpace'], itemLocks: rows(rack['rackItems']).map(item => item['lock'] === true) };
};
const exportedLockedSpace = (fields: unknown) => {
  const data = object(JSON.parse(String(object(fields)['data'] ?? '{}')));
  return { lockedSpace: object(rows(object(data['workspaceInformation'])['rackData'])[0])['lockedSpace'] };
};
const withoutAccessTimes = (value: unknown): unknown => Array.isArray(value) ? value.map(withoutAccessTimes)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'lastAccessAt')
      .map(([key, inner]) => [key, withoutAccessTimes(inner)]))
    : value;

async function clickLock(page: Page): Promise<void> {
  const pending = page.waitForResponse(response =>
    response.url().includes(CUSTOMIZE_API_PATH) && response.request().method() === 'POST', { timeout: 120_000 });
  await page.getByText('Lock', { exact: true }).last().click();
  assert.equal((await pending).status(), 200);
}

export default {
  id: 'rack-lock',
  tags: ['rack', 'export'],
  mode: 'in-process',
  async run(h) {
    const { mcp, step, compare, compareRequest } = h;

    const website = await step('website', async () => {
      const page = await h.web.newPage();
      await importInBrowser(page, ONE_RACK_XML, SUMMARY_ROUTE);
      await page.getByText('Go to Workspace', { exact: true }).first().click();
      await page.waitForURL(/#\/rack-configuration/, { timeout: 60_000 });
      await page.waitForTimeout(7_000);
      const customizes: Request[] = [];
      page.on('request', request => {
        if (request.method() !== 'POST') return;
        if (request.url().includes(CUSTOMIZE_API_PATH)) customizes.push(request);
      });

      await page.locator('.rack-server').first().click();
      await page.getByText('Lock', { exact: true }).last().waitFor({ state: 'visible', timeout: 10_000 });
      await clickLock(page);
      await page.waitForTimeout(5_000);

      const empties = page.locator('.rack-empty-unit:visible');
      await empties.last().waitFor({ state: 'visible', timeout: 20_000 });
      await empties.last().click({ force: true });
      await page.getByText('Lock', { exact: true }).last().waitFor({ state: 'visible', timeout: 10_000 });
      await clickLock(page);
      await page.waitForTimeout(8_000);
      const spaceLock = customizes.at(-1)!;
      const spaceBody = object(spaceLock.postDataJSON());

      const conflict = structuredClone(spaceBody);
      const conflictItem = rows(firstRack(conflict)['rackItems'])[0]!;
      conflictItem['lock'] = false;
      conflictItem['position'] = RESERVED_U;
      conflictItem['endPosition'] = RESERVED_U + 1;
      const conflictResponse = await page.request.fetch(spaceLock.url(), { method: 'POST', data: conflict, timeout: 120_000 });
      assert.equal(conflictResponse.status(), 200, 'Native reserved-U customize status.');
      const corrected = object(await conflictResponse.json());
      const correctedItem = [...rows(firstRack(corrected)['rackItems']), ...rows(corrected['nonRackArea'])]
        .find(item => item['id'] === conflictItem['id']);

      const exported = await exportFromWorkspace(page, h.out, 'browser-rack-lock');
      return {
        lockRequest: { method: 'POST', path: new URL(spaceLock.url()).pathname, body: spaceBody },
        refusedReservedU: {
          itemAtReserved: correctedItem?.['position'] === RESERVED_U,
          itemKept: correctedItem !== undefined,
          lockedSpaceKept: JSON.stringify(firstRack(corrected)['lockedSpace']) === JSON.stringify(firstRack(conflict)['lockedSpace']),
        },
        exportRequest: { method: 'POST', path: exported.form.path, body: exported.form.fields },
      };
    });

    await step('mcp', async () => {
      const imported = await mcp.call('dcsc_import', { content: await readFile(ONE_RACK_XML, 'utf8'), solutionMode: 'General Purpose' });
      const workspace = String(imported['session']);
      const saved = () => mcp.persistedWorkspaces().find(entry => entry['id'] === workspace)!;
      const source = rows(saved()['configurations']).find(entry => object(entry['product'])['code'] === SERVER_CODE)!;
      const configurationId = String(source['configurationId']);
      const rackId = String(rows(saved()['rackArea']).find(rack => rows(rack['rackItems']).some(item => item['id'] === configurationId))?.['id']);
      const rackState = () => {
        const rack = rows(saved()['rackArea']).find(candidate => candidate['id'] === rackId)!;
        const item = rows(rack['rackItems']).find(entry => entry['id'] === configurationId);
        return { rack, item };
      };

      await mcp.call('dcsc_rack_edit', { session: workspace, action: 'lock', rackId, uPosition: RESERVED_U });
      const beforeRejection = withoutAccessTimes(saved());
      await mcp.call('dcsc_rack_edit', { session: workspace, action: 'place', configuration: String(source['id']), rackId, uPosition: RESERVED_U },
        { expectError: true });
      const { rack, item } = rackState();
      compare('reserved-u-placement-refused', website.refusedReservedU, {
        itemAtReserved: item?.['position'] === RESERVED_U,
        itemKept: item !== undefined,
        lockedSpaceKept: JSON.stringify(rack['lockedSpace']) === JSON.stringify([RESERVED_U]),
      });
      compare('rejected-placement-leaves-state', beforeRejection, withoutAccessTimes(saved()));

      await mcp.call('dcsc_rack_edit', { session: workspace, action: 'lock', itemId: configurationId });
      const lockRequest = mcp.requests.filter(request => request.path === CUSTOMIZE_API_PATH.replace('/api', '')).at(-1);
      assert(lockRequest, 'MCP lock did not call /ctos/racks/customize.');
      compareRequest('lock-request', website.lockRequest, lockRequest, { normalize: lockShape });
      compare('accepted-lock-state', { itemLock: true, lockedSpace: [RESERVED_U] },
        { itemLock: rackState().item?.['lock'], lockedSpace: rackState().rack['lockedSpace'] });

      const exported = await mcp.call('dcsc_export', { kind: 'reports', session: workspace, scope: 'workspace', fileName: 'mcp-rack-lock', fileTypes: ['XML', 'QUOTE'] });
      const exportRequest = mcp.requests.filter(request => request.path.endsWith('/export_zip')).at(-1);
      assert(exportRequest, 'MCP export did not post /export_zip.');
      compareRequest('export-lock-state', website.exportRequest, exportRequest, { normalize: exportedLockedSpace });

      const page = await h.web.newPage();
      const { response } = await importInBrowser(page, String(exported['xml']), SUMMARY_ROUTE);
      const handoff = object(Array.isArray(response) ? response[0] : response);
      const importedRack = rows(object(handoff['floorInformation'])['floorGrid']).find(cell => cell['id'] === rackId);
      const importedItem = rows(object(importedRack)['items']).find(entry => entry['id'] === configurationId);
      compare('browser-reimport-lock', { lockedSpace: [RESERVED_U - 1], itemLock: undefined },
        { lockedSpace: importedRack?.['lockedSpace'], itemLock: importedItem?.['lock'] });
    });
  },
} satisfies ParityCase;
