/** Nested chassis and node removal: website customize, derive and export bodies against the recorded contract and the MCP's customize request. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { openBrowserImportHome } from '../browser.js';
import { CAPTURE_EXPORT_FORMS } from '../exportUi.js';
import type { Json, ParityCase } from '../harness.js';
import { exportFromWorkspace, rows } from '../rackUi.js';
import { object } from '../softwareSummaryUi.js';

type Action = 'remove-chassis' | 'remove-node' | 'unplace-node';

const SOURCE = path.resolve('test/fixtures/parity/xml/nested-racked-browser.xml');
const CONTRACTS = path.resolve('test/fixtures/parity/nested-removal-contracts.json');
const WEBSITE_MODE = 'AI & HPC – ThinkSystem Hardware';
const MCP_MODE = 'HPC and AI - Systems';
const CUSTOMIZE_QUERY_FIELDS = ['autoArrange', 'autoConnect', 'cogValidation'];
const CONTRACT_KEY: Record<Action, string> = { 'remove-chassis': 'deleteChassis', 'remove-node': 'deleteNode', 'unplace-node': 'moveNodeToNonRack' };

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const sorted = (value: string[]) => [...value].sort();
const ids = (value: unknown) => rows(value).map(item => item['id']).filter((id): id is string => typeof id === 'string');
const keys = (value: unknown) => sorted(Object.keys(object(value)));
const view = (configurations: unknown, dependencyIds: string[], nonRack: unknown, racks: Json[], rackItems: Json[], nodes: unknown) => ({
  configurations: sorted(ids(configurations)), dependencyIds, nonRack: sorted(ids(nonRack)), racks: ids(racks), rackItems: ids(rackItems), nodesInChassis: ids(nodes),
});
const customizeView = (body: unknown) => {
  const racks = rows(object(body)['rackArea']);
  const items = racks.flatMap(rack => rows(rack['rackItems']));
  return view(object(body)['configurations'], keys(object(body)['cloneDependency']), object(body)['nonRackArea'], racks, items, items[0]?.['nodes']);
};
const deriveView = (body: unknown) => {
  const workspace = object(object(body)['workspaceInformation']);
  const racks = rows(workspace['rackData']);
  const items = racks.flatMap(rack => rows(rack['rackItems']));
  return view(object(body)['configurations'], keys(workspace['cloneDependency']), workspace['nonRackData'], racks, items, items[0]?.['nodes']);
};
const exportView = (body: unknown) => {
  const workspace = object(object(body)['workspace']);
  const racks = rows(workspace['rackArea']);
  const items = racks.flatMap(rack => rows(rack['children']));
  return view(object(body)['configurations'], keys(object(body)['cloneDependencyColor']), workspace['nonRackArea'], racks, items, items[0]?.['children']);
};
const queryOf = (query: Json | undefined) => Object.fromEntries(CUSTOMIZE_QUERY_FIELDS.map(field => [field, String(query?.[field])]));

function expectedViews(oracle: Json, action: Action) {
  const identities = object(oracle['identities']);
  const [rack, chassis, sourceNode, copiedNode] = ['rack', 'chassis', 'looseSourceNode', 'copiedNestedNode'].map(key => String(identities[key]));
  const contract = object(oracle[CONTRACT_KEY[action]]);
  const finalConfigurations = sorted(strings(action === 'remove-chassis' ? contract['deriveConfigurationIds'] : contract['configurationIds']));
  const finalDependencies = action === 'remove-chassis' ? finalConfigurations : sorted(strings(contract['deriveCloneDependencyIds']));
  const nonRack = sorted(action === 'unplace-node' ? [sourceNode!, copiedNode!] : [sourceNode!]);
  const rackItems = action === 'remove-chassis' ? [] : [chassis!];
  const common = { nonRack, racks: [rack!], rackItems, nodesInChassis: [] as string[] };
  return {
    customize: { ...common, configurations: sorted(strings(action === 'remove-chassis' ? contract['customizeConfigurationIds'] : contract['configurationIds'])),
      dependencyIds: sorted([rack!, chassis!, sourceNode!, copiedNode!]) },
    derive: { ...common, configurations: finalConfigurations, dependencyIds: finalDependencies },
    exported: { ...common, configurations: finalConfigurations, dependencyIds: sorted(strings(contract['exportCloneColorIds'])) },
  };
}

function removalCase(action: Action): ParityCase {
  return {
    id: `nested-${action}`,
    tags: ['rack', 'nested'],
    mode: 'in-process',
    async run(h) {
      const { mcp, step, compare, compareRequest } = h;
      const oracle = object(JSON.parse(await readFile(CONTRACTS, 'utf8')));
      const expected = expectedViews(oracle, action);

      const website = await step('website', async () => {
        const page = await h.web.newPage();
        page.setDefaultTimeout(90_000);
        await page.addInitScript({ content: CAPTURE_EXPORT_FORMS });
        await openBrowserImportHome(page, WEBSITE_MODE, { diagnosticsDir: h.out, timeout: 30_000 });
        const input = page.locator('input[type="file"]').first();
        await input.waitFor({ state: 'attached', timeout: 30_000 });
        const imported = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/multiple/cfxml_import'), { timeout: 180_000 });
        await input.setInputFiles(SOURCE);
        assert.equal((await imported).status(), 200);
        await page.waitForURL(/#\/rack-summary\//, { timeout: 90_000 });
        await page.waitForTimeout(8_000);
        const toWorkspace = page.getByText('Go to Workspace', { exact: true }).first();
        if (await toWorkspace.isVisible({ timeout: 20_000 }).catch(() => false)) await toWorkspace.click();
        await page.waitForURL(/#\/rack-configuration/, { timeout: 90_000 });
        await page.waitForTimeout(8_000);
        const banner = page.locator('.dcsc-cookie-content').first();
        if (await banner.isVisible({ timeout: 1_000 }).catch(() => false)) await page.locator('.dcsc-cookie-close').first().click({ force: true });

        const target = action === 'remove-chassis'
          ? page.locator('.rack-chassis:visible, .rack-horizontal-chassis:visible').last()
          : page.locator('.rack-chassis-node:visible, .rack-horizontal-chassis-node:visible').last();
        await target.waitFor({ state: 'visible', timeout: 30_000 });
        if (action === 'remove-chassis') await target.click();
        else {
          await target.locator('.rack-horizontal-chassis-node-inner, .rack-chassis-node-inner').hover();
          await page.getByText('Customize Node', { exact: true }).last().waitFor({ state: 'visible', timeout: 30_000 });
        }
        const customized = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/api/ctos/racks/customize'), { timeout: 180_000 });
        const derived = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/api/ctos/autoDerive'), { timeout: 180_000 });
        if (action === 'unplace-node') {
          await page.getByText('Move To', { exact: true }).last().click();
          await page.getByText('Non Rack Items', { exact: true }).last().click();
        } else {
          await page.getByText(action === 'remove-chassis' ? 'Delete' : 'Delete Node', { exact: true }).last().click();
          await page.waitForTimeout(500);
          const confirm = page.locator('.ant-modal:visible button:visible').filter({ hasText: /^(?:Remove|Delete|Yes|OK)$/i }).last();
          if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) await confirm.click();
        }
        const [customizeResponse, deriveResponse] = await Promise.all([customized, derived]);
        assert.equal(customizeResponse.status(), 200, `${action} customize failed`);
        assert.equal(deriveResponse.status(), 200, `${action} derive failed`);
        await page.waitForTimeout(12_000);
        const customizeUrl = new URL(customizeResponse.url());
        const deriveUrl = new URL(deriveResponse.url());
        const exported = await exportFromWorkspace(page, h.out, `nested-${action}`);
        return {
          customize: { method: 'POST', path: customizeUrl.pathname, query: Object.fromEntries(CUSTOMIZE_QUERY_FIELDS.map(field => [field, customizeUrl.searchParams.get(field)])),
            body: customizeResponse.request().postDataJSON() as unknown },
          derive: deriveResponse.request().postDataJSON() as unknown,
          deriveQuery: { guideMode: deriveUrl.searchParams.get('guideMode'), entranceFlag: deriveUrl.searchParams.has('entranceFlag'), customizingIds: deriveUrl.searchParams.has('customizingIds') },
          exportData: JSON.parse(exported.form.fields['data'] ?? '{}') as unknown,
        };
      });

      compare('website-customize-body', expected.customize, customizeView(website.customize.body));
      compare('website-customize-query', queryOf(object(object(object(oracle['wireSequence'])['customize'])['query'])), website.customize.query);
      compare('website-derive-body', expected.derive, deriveView(website.derive));
      compare('website-derive-query', { guideMode: String(object(object(object(oracle['wireSequence'])['derive'])['query'])['guideMode']), entranceFlag: false, customizingIds: false }, website.deriveQuery);
      compare('website-export-data', expected.exported, exportView(website.exportData));

      await step('mcp', async () => {
        const imported = await mcp.call('dcsc_import', { filePath: SOURCE, solutionMode: MCP_MODE });
        const workspace = String(imported['session']);
        const identities = object(oracle['identities']);
        const configurations = rows(mcp.persistedWorkspaces().find(entry => entry['id'] === workspace)?.['configurations']);
        const sessionOf = (configurationId: unknown) => String(configurations.find(entry => entry['configurationId'] === configurationId)?.['id']);
        const request = action === 'remove-chassis'
          ? { action: 'remove', configuration: sessionOf(identities['chassis']), contents: 'delete' }
          : { action: action === 'remove-node' ? 'detach' : 'unplace', configuration: sessionOf(identities['copiedNestedNode']) };
        await mcp.call('dcsc_rack_edit', { session: workspace, ...request });
        const customize = mcp.requests.filter(entry => entry.path === '/ctos/racks/customize').at(-1);
        assert(customize, `MCP ${action} did not call /ctos/racks/customize.`);
        compareRequest('customize-request', website.customize, { ...customize, query: queryOf(object(customize.query)) },
          { normalize: customizeView });
      });
    },
  };
}

export default (['remove-chassis', 'remove-node', 'unplace-node'] as const).map(removalCase);
