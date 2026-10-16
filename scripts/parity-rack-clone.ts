/**
 * Browser oracle for Copy and Clone Multiple on a racked GP configuration.
 *
 * Each action starts from the same anonymous browser-exported one-rack XML so
 * their identity and dependency semantics can be compared without sharing UI
 * history. Raw request/response bodies are retained without browser headers.
 *
 * Usage:
 *   npx tsx scripts/parity-rack-clone.ts --action=copy --fresh
 *   npx tsx scripts/parity-rack-clone.ts --action=clone --fresh
 *   npx tsx scripts/parity-rack-clone.ts --action=clone --fresh --linked-edit
 *   npx tsx scripts/parity-rack-clone.ts --action=clone --fresh --linked-edit=member
 *   npx tsx scripts/parity-rack-clone.ts --action=clone --fresh --delete=root
 *   npx tsx scripts/parity-rack-clone.ts --action=clone --fresh --clones=2 --delete=root
 *   npx tsx scripts/parity-rack-clone.ts --mcp
 *   npx tsx scripts/parity-rack-clone.ts --mcp --clones=2 --delete=root
 *   npx tsx scripts/parity-rack-clone.ts --mcp --copy
 *   npx tsx scripts/parity-rack-clone.ts --mcp --linked-edit=member
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page, type Request, type Response } from 'playwright';
import { ConfigSchema } from '../src/config/schema.js';
import { buildExportGroups } from '../src/domain/exportGroups.js';
import { writeExportBundle } from '../src/files/artifactStore.js';
import { DcscService } from '../src/mcp/service.js';

type Obj = Record<string, unknown>;
type Action = 'copy' | 'clone';

const ROOT = process.cwd();
const SOURCE_XML = path.join(ROOT, 'test/fixtures/parity/xml/one-rack-sr630-v3.xml');
const SERVER_CODE = '7D73CTO1WW';

function object(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return value === undefined || value === null ? '' : String(value); }
function number(value: unknown): number { const n = Number(value); return Number.isFinite(n) ? n : 0; }

function physical(value: unknown): Obj {
  const body = object(value);
  const workspace = object(body['workspaceInformation']);
  const racks = array(body['rackArea']).length ? array(body['rackArea']) : array(workspace['rackData']);
  const nonRack = Object.hasOwn(body, 'nonRackArea') ? array(body['nonRackArea']) : array(workspace['nonRackData']);
  const configurations = array(body['configurations']).length
    ? array(body['configurations']) : array(workspace['configurations']);
  return {
    configurations: configurations.map((entry) => {
      const item = object(entry);
      return { id: text(item['id']), code: text(item['sliceCtoCode'] ?? item['code']),
        quantity: number(item['quantity']), totalPrice: number(item['totalPrice']) };
    }),
    racks: racks.map((entry) => {
      const rack = object(entry);
      return { id: text(rack['id']), code: text(rack['code']), lockedSpace: rack['lockedSpace'] ?? [],
        items: array(rack['rackItems']).map((raw) => {
          const item = object(raw);
          return { id: text(item['id']), originalId: text(item['originalId']), code: text(item['code']),
            position: number(item['position']), size: number(item['size']), lock: item['lock'] === true };
        }) };
    }),
    nonRack: nonRack.map((entry) => {
      const item = object(entry);
      return { id: text(item['id']), originalId: text(item['originalId']), code: text(item['code']) };
    }),
    cloneDependency: workspace['cloneDependency'] ?? body['cloneDependency'] ?? {},
    cloneDependencyColor: body['cloneDependencyColor'] ?? {},
  };
}

async function closeCookie(page: Page): Promise<void> {
  const close = page.locator('.dcsc-cookie-close').first();
  if (await close.isVisible({ timeout: 2_000 }).catch(() => false)) await close.click();
}

async function importWorkspace(page: Page): Promise<void> {
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await closeCookie(page);
  const file = page.locator('input[type="file"]').first();
  await file.waitFor({ state: 'attached', timeout: 30_000 });
  const imported = page.waitForResponse((response) =>
    response.url().includes('/multiple/cfxml_import') && response.request().method() === 'POST',
  { timeout: 120_000 });
  await file.setInputFiles(SOURCE_XML);
  assert.equal((await imported).status(), 200);
  await page.waitForURL(/#\/(?:rack-summary|summary)\//, { timeout: 120_000 });
  await page.getByText('Go to Workspace', { exact: true }).first().click();
  await page.waitForURL(/#\/rack-configuration/, { timeout: 60_000 });
  await page.waitForTimeout(7_000);
}

async function freshWorkspace(page: Page, outDir: string): Promise<void> {
  await page.goto('https://dcsc.lenovo.com/#/categories/STG%40Servers%40Rack%20Server%40ThinkSystem%20SR630%20V3',
    { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await closeCookie(page);
  await page.waitForTimeout(5_000);
  const configure = page.locator(
    'button:has-text("Customize"), a:has-text("Customize"), [role="button"]:has-text("Customize")',
  ).first();
  await configure.waitFor({ state: 'visible', timeout: 30_000 });
  await configure.click();
  await page.waitForURL(/#\/configuration\/cto\//, { timeout: 60_000 });
  await page.waitForTimeout(8_000);
  await page.getByText('Summary', { exact: true }).first().click();
  await page.waitForURL(/#\/rack-summary\//, { timeout: 60_000 });
  await page.waitForTimeout(8_000);
  await page.getByText('Go to Workspace', { exact: true }).first().click();
  await page.waitForURL(/#\/rack-configuration/, { timeout: 60_000 });
  await page.waitForTimeout(6_000);

  await page.getByText('Rack', { exact: true }).first().click();
  await page.waitForTimeout(1_000);
  const rackDerived = page.waitForResponse((response) =>
    response.url().includes('/api/ctos/autoDerive') && response.request().method() === 'POST',
  { timeout: 120_000 });
  await page.getByText(/7D6DCTO1WW/).first().dblclick();
  await rackDerived;
  await page.waitForTimeout(5_000);

  const serverPanel = page.getByText(/\(1\)\s*\[\s*7D73CTO1WW\s*\].*Server/i).first();
  if (await serverPanel.isVisible().catch(() => false)) {
    await serverPanel.click();
    await page.getByText(/^Move To$/i).last().waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => undefined);
    const move = page.getByText(/^Move To$/i).last();
    if (await move.isVisible().catch(() => false)) {
      await move.click();
      const destination = page.getByText('A1 - Rack', { exact: true }).last();
      await destination.waitFor({ state: 'visible', timeout: 10_000 });
      const derived = page.waitForResponse((response) =>
        response.url().includes('/api/ctos/autoDerive') && response.request().method() === 'POST',
      { timeout: 120_000 });
      await destination.click();
      await derived;
      await page.waitForTimeout(6_000);
      assert.equal(await page.locator('.rack-server').count(), 1, 'Fresh server was not accepted in rack A1.');
      return;
    }
    await page.keyboard.press('Escape');
  }

  const groups = page.locator('.ant-collapse-item').filter({ hasText: /7D73CTO1WW/ });
  const diagnostics: Obj[] = [];
  let moved = false;
  for (let index = 0; index < await groups.count(); index += 1) {
    const group = groups.nth(index);
    if (!await group.isVisible().catch(() => false)) continue;
    if ((await group.locator('.ant-collapse-header').first().getAttribute('aria-expanded')) !== 'true') {
      await group.locator('.ant-collapse-header').first().click();
    }
    const settings = group.locator('.anticon-setting');
    for (let settingIndex = 0; settingIndex < await settings.count(); settingIndex += 1) {
      await settings.nth(settingIndex).click();
      await page.getByText('Copy', { exact: true }).last().waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => undefined);
      const menus = await page.locator('.ant-popover:visible, .ant-dropdown:visible').allInnerTexts();
      diagnostics.push({ index, settingIndex, group: (await group.innerText()).slice(0, 2_000), menus });
      const move = page.getByText(/^Move To$/i).last();
      if (!await move.isVisible().catch(() => false)) {
        await page.keyboard.press('Escape');
        continue;
      }
      await move.click();
      const destination = page.getByText('A1 - Rack', { exact: true }).last();
      await destination.waitFor({ state: 'visible', timeout: 10_000 });
      const derived = page.waitForResponse((response) =>
        response.url().includes('/api/ctos/autoDerive') && response.request().method() === 'POST',
      { timeout: 120_000 });
      await destination.click();
      await derived;
      await page.waitForTimeout(6_000);
      moved = true;
      break;
    }
    if (moved) break;
  }
  await writeFile(path.join(outDir, 'fresh-nonrack-menu-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  assert(moved, 'Fresh workspace server Move To menu was not found.');
  assert.equal(await page.locator('.rack-server').count(), 1, 'Fresh server was not accepted in rack A1.');
}

async function openPlacedMenu(page: Page): Promise<string> {
  await page.locator('.rack-server').first().click();
  const menu = page.locator('.ant-popover:visible, .ant-dropdown:visible').last();
  await menu.waitFor({ state: 'visible', timeout: 10_000 });
  return menu.innerText();
}

function installCapture(page: Page, outDir: string): { calls: Array<{ request: Request; ordinal: number }> } {
  const calls: Array<{ request: Request; ordinal: number }> = [];
  page.on('request', (request) => {
    if (!request.url().includes('/api/ctos/')) return;
    const ordinal = calls.length + 1;
    calls.push({ request, ordinal });
    const body = (() => { try { return request.postDataJSON() as unknown; } catch { return request.postData(); } })();
    void writeFile(path.join(outDir, `${String(ordinal).padStart(2, '0')}-request.json`), JSON.stringify({
      url: request.url(), method: request.method(), body, summary: physical(body),
    }, null, 2));
  });
  page.on('response', (response: Response) => {
    const call = calls.find((entry) => entry.request === response.request());
    if (!call) return;
    void (async () => {
      let body: unknown = {};
      if (response.url().includes('/api/ctos/racks/customize') ||
          response.url().includes('/api/ctos/autoDerive')) {
        try { body = await response.json() as unknown; } catch { body = {}; }
      }
      await writeFile(path.join(outDir, `${String(call.ordinal).padStart(2, '0')}-response.json`), JSON.stringify({
        url: response.url(), status: response.status(), body, summary: physical(body),
      }, null, 2));
    })();
  });
  return { calls };
}

async function editLinkedSource(
  page: Page,
  outDir: string,
  initiator: 'source' | 'member',
): Promise<void> {
  const workspaceUrl = page.url();
  const servers = page.locator('.rack-server');
  await (initiator === 'source' ? servers.first() : servers.last()).click();
  await page.getByText('Customize', { exact: true }).last().click();
  await page.waitForURL(/#\/configuration\/cto\//, { timeout: 60_000 });
  await page.waitForTimeout(7_000);
  await page.getByText('Processors', { exact: true }).first().click();
  await page.waitForTimeout(1_000);
  await page.getByText('Processors', { exact: true }).last().click();
  await page.waitForTimeout(3_000);
  const selector = page.locator('[class~="BYW3"] .ant-select-selection').first();
  if (!await selector.isVisible({ timeout: 30_000 }).catch(() => false)) {
    await writeFile(path.join(outDir, 'linked-edit-page.txt'), (await page.locator('body').innerText()).slice(0, 50_000));
    throw new Error(`Linked ${initiator} edit could not find the BYW3 quantity selector.`);
  }
  await selector.click();
  const choices = page.locator('.ant-select-dropdown:visible .ant-select-dropdown-menu-item');
  const derived = page.waitForResponse(response =>
    response.url().includes('/api/ctos/autoDerive') && response.request().method() === 'POST',
  { timeout: 120_000 });
  await choices.filter({ hasText: /^2$/ }).click();
  const response = await derived;
  assert.equal(response.status(), 200, 'Linked source edit derive status');
  await page.waitForTimeout(5_000);
  await writeFile(path.join(outDir, 'linked-edit.json'), JSON.stringify({
    initiator, feature: 'BYW3', quantity: 2, url: response.url(),
  }, null, 2));
  await writeFile(path.join(outDir, 'linked-edit-settled.json'), JSON.stringify({
    url: page.url(), body: (await page.locator('body').innerText()).slice(0, 50_000),
  }, null, 2));
  const workspaceButton = page.getByText('Go to Workspace', { exact: true }).first();
  if (await workspaceButton.isVisible().catch(() => false)) await workspaceButton.click();
  else {
    await page.goBack({ waitUntil: 'domcontentloaded' });
    if (!/#\/rack-configuration/.test(page.url())) await page.goto(workspaceUrl);
  }
  await page.waitForURL(/#\/rack-configuration/, { timeout: 60_000 });
  await page.waitForTimeout(5_000);
}

async function deleteLinkedItem(
  page: Page,
  outDir: string,
  target: 'root' | 'member',
): Promise<void> {
  const servers = page.locator('.rack-server');
  const before = await servers.count();
  assert(before >= 2, 'Linked deletion requires at least two physical members.');
  await (target === 'root' ? servers.first() : servers.last()).click();
  await page.getByText('Delete', { exact: true }).last().waitFor({ state: 'visible', timeout: 10_000 });
  const pending = page.waitForResponse(response =>
    response.url().includes('/api/ctos/racks/customize') && response.request().method() === 'POST',
  { timeout: 120_000 });
  await page.getByText('Delete', { exact: true }).last().click();
  const modal = page.locator('.ant-modal:visible').last();
  if (await modal.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await writeFile(path.join(outDir, 'linked-delete-dialog.json'), JSON.stringify({
      target, text: await modal.allInnerTexts(), buttons: await modal.locator('button:visible').allInnerTexts(),
    }, null, 2));
    await modal.locator('button.ant-btn-primary:visible').last().click();
  }
  const response = await pending;
  assert.equal(response.status(), 200, `Linked ${target} deletion customize status`);
  await page.waitForFunction(expected => document.querySelectorAll('.rack-server').length < Number(expected),
    before, { timeout: 120_000 });
  await page.waitForTimeout(8_000);
  await writeFile(path.join(outDir, 'linked-delete.json'), JSON.stringify({
    target, before, after: await page.locator('.rack-server').count(), response: response.url(),
  }, null, 2));
}

async function captureExportForm(page: Page, outDir: string, action: Action): Promise<Obj> {
  await page.getByText('Export', { exact: true }).first().click();
  await page.getByText('Export Preference', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('input.ant-input:visible').last().fill(`browser-rack-${action}`);
  const pending = page.waitForResponse(response =>
    response.url().includes('/api/ctos/export_zip') && response.request().method() === 'POST',
  { timeout: 120_000 });
  await page.getByText('Save', { exact: true }).last().click();
  const response = await pending;
  assert.equal(response.status(), 200, 'Browser clone export status');
  const form = response.request().postData() ?? '';
  await writeFile(path.join(outDir, 'browser-export-form.txt'), form);
  const encoded = new URLSearchParams(form).get('data');
  assert(encoded, 'Browser clone export form omitted data.');
  const data = JSON.parse(encoded) as Obj;
  await writeFile(path.join(outDir, 'browser-export-data.json'), JSON.stringify(data, null, 2));
  const encodedGroups = new URLSearchParams(form).get('groups');
  const groups = encodedGroups ? JSON.parse(encodedGroups) as unknown : [];
  await writeFile(path.join(outDir, 'browser-export-groups.json'), JSON.stringify(groups, null, 2));
  const workspace = object(data['workspaceInformation']);
  return {
    cloneDependency: workspace['cloneDependency'],
    configurations: array(data['configurations']).map(entry => {
      const configuration = object(entry);
      return {
        id: text(configuration['id']), name: text(configuration['name']),
        code: text(configuration['sliceCtoCode'] ?? configuration['code']),
        quantity: number(configuration['quantity']), totalPrice: number(configuration['totalPrice']),
      };
    }),
    groups,
  };
}

async function runAction(
  action: Action,
  outDir: string,
  fresh: boolean,
  linkedEdit: 'source' | 'member' | undefined,
  linkedDelete: 'root' | 'member' | undefined,
  cloneCount: number,
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const browserErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text().slice(0, 4_000));
    });
    page.on('pageerror', (error) => browserErrors.push(error.message.slice(0, 4_000)));
    if (fresh) await freshWorkspace(page, outDir);
    else await importWorkspace(page);
    const capture = installCapture(page, outDir);
    const menu = await openPlacedMenu(page);
    await writeFile(path.join(outDir, 'menu.txt'), menu);
    const before = await page.locator('.rack-server').count();
    const closed = new Promise<'closed'>((resolve) => page.once('close', () => resolve('closed')));
    if (action === 'copy') {
      await page.getByText('Copy', { exact: true }).last().click();
      const modal = page.locator('.ant-modal:visible').last();
      await modal.getByText('Number of copies', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
      const count = modal.locator('input.ant-input-number-input').first();
      await count.fill('1');
      await count.press('Tab');
      await writeFile(path.join(outDir, 'copy-dialog.json'), JSON.stringify({
        text: await modal.allInnerTexts(),
        buttons: await modal.locator('button:visible').allInnerTexts(),
        inputs: await modal.locator('input').evaluateAll(inputs => inputs.map((node) => {
          const input = node as HTMLInputElement;
          return { type: input.type, value: input.value, checked: input.checked };
        })),
      }, null, 2));
      await modal.locator('button.ant-btn-primary:visible').last().click();
    } else {
      await page.getByText('Clone Multiple', { exact: true }).last().click();
      const modal = page.locator('.ant-modal:visible').last();
      await modal.getByText('Number of clones', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
      const count = modal.locator('input.ant-input-number-input').first();
      await count.fill(String(cloneCount));
      await count.press('Tab');
      await writeFile(path.join(outDir, 'clone-dialog.json'), JSON.stringify({
        text: await page.locator('.ant-modal:visible').allInnerTexts(),
        buttons: await page.locator('.ant-modal:visible button:visible').allInnerTexts(),
      }, null, 2));
      await page.locator('.ant-modal:visible button.ant-btn-primary:visible').last().click();
    }
    let outcome: 'accepted' | 'closed';
    try {
      outcome = await Promise.race([
        page.waitForFunction((expected) => document.querySelectorAll('.rack-server').length > Number(expected), before,
          { timeout: 180_000 }).then(() => 'accepted' as const),
        closed,
      ]);
    } catch (error) {
      await writeFile(path.join(outDir, 'failure.json'), JSON.stringify({
        capturedAt: new Date().toISOString(), status: 'failed', action, before,
        error: error instanceof Error ? error.message : String(error),
        calls: capture.calls.map((entry) => entry.request.url()), browserErrors,
        body: (await page.locator('body').innerText()).slice(0, 40_000),
      }, null, 2));
      throw error;
    }
    if (outcome === 'closed') throw new Error(`DCSC closed the page during ${action}.`);
    await page.waitForTimeout(12_000);
    const after = await page.locator('.rack-server').count();
    const items = await page.locator('.rack-server').evaluateAll((nodes) => nodes.map((node) => ({
      text: node.textContent?.trim(), style: node.getAttribute('style'), className: node.getAttribute('class'),
    })));
    const lastCustomize = [...capture.calls].reverse().find((entry) => entry.request.url().includes('/racks/customize'));
    assert(lastCustomize, `${action} emitted no customize request.`);
    const sent = lastCustomize.request.postDataJSON() as unknown;
    const summary = physical(sent);
    const serverConfigurations = array(summary['configurations']).map(object)
      .filter((entry) => entry['code'] === SERVER_CODE);
    const expectedServers = action === 'clone' ? cloneCount + 1 : 2;
    assert.equal(serverConfigurations.length, expectedServers,
      `${action} must send ${expectedServers} independent server identities.`);
    assert.equal(new Set(serverConfigurations.map((entry) => entry['id'])).size, expectedServers);
    if (linkedDelete) {
      assert.equal(action, 'clone', 'Linked deletion requires Clone Multiple.');
      assert.equal(linkedEdit, undefined, 'Run linked edit and deletion as independent browser oracles.');
      await deleteLinkedItem(page, outDir, linkedDelete);
    }
    if (linkedEdit) {
      assert.equal(action, 'clone', 'Linked editing requires Clone Multiple.');
      await editLinkedSource(page, outDir, linkedEdit);
    }
    const exportForm = await captureExportForm(page, outDir, action);
    const result = { capturedAt: new Date().toISOString(), status: 'pass', action, before, after,
      calls: capture.calls.map((entry) => entry.request.url()), menu, request: summary, domItems: items,
      exportForm };
    await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(outDir, 'browser-errors.json'), JSON.stringify(browserErrors, null, 2));
    console.log(JSON.stringify(result, null, 2));
    await context.close();
  } finally {
    await browser.close();
  }
}

async function browserImport(page: Page, xmlPath: string): Promise<Obj> {
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await closeCookie(page);
  const file = page.locator('input[type="file"]').first();
  await file.waitFor({ state: 'attached', timeout: 30_000 });
  const pending = page.waitForResponse(response =>
    response.url().includes('/multiple/cfxml_import') && response.request().method() === 'POST',
  { timeout: 120_000 });
  await file.setInputFiles(xmlPath);
  const response = await pending;
  assert.equal(response.status(), 200, 'MCP clone browser reimport status');
  const raw = await response.json() as unknown;
  await page.waitForURL(/#\/(?:rack-summary|summary)\//, { timeout: 120_000 });
  return object(Array.isArray(raw) ? raw[0] : raw);
}

/** Source-backed MCP Clone Multiple, export, and fresh-browser handoff gate. */
async function runMcpGate(
  outDir: string,
  linkedEdit: 'source' | 'member' | undefined,
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const config = ConfigSchema.parse({
    files: { persistSessions: false, artifactDir: path.join(outDir, 'artifacts') },
    logLevel: 'error', pacing: { perToolRequestBudget: 80 },
  });
  const service = new DcscService(config);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const ctx = service.newCtx();
    const imported = await service.importConfig({
      content: await readFile(SOURCE_XML, 'utf8'), ctx, solutionMode: 'General Purpose',
      fileName: path.basename(SOURCE_XML),
    });
    let workspace = service.sessions.getWorkspace(imported.workspaceId);
    assert(workspace, 'MCP import did not publish a workspace.');
    const source = [...workspace.configurations.values()].find(session => session.product.code === SERVER_CODE);
    assert(source, 'MCP import omitted the source server.');
    const sourceRack = workspace.rackArea.find(rack =>
      array(rack['rackItems']).map(object).some(item => item['id'] === source.configurationId));
    assert(sourceRack, 'MCP import did not retain the source rack placement.');
    const rackId = text(sourceRack['id']);
    const beforeRevision = workspace.revision;
    const cloned = await service.cloneConfiguration({
      sessionHandle: source.id, count: 1, labelPrefix: 'Node', placement: 'same-rack',
      expectedRevision: beforeRevision, ctx,
    });
    workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    const clone = cloned.clones[0]!;
    assert.deepEqual(cloned.placements, [{ configurationId: clone.configurationId, rackId, position: 2 }]);
    assert.equal(source.raw.quantity, 1);
    assert.equal(clone.raw.quantity, 1);
    assert.equal(clone.raw.totalPrice, source.raw.totalPrice);
    assert.deepEqual(workspace.serverState.cloneDependency, {
      [source.configurationId]: [source.configurationId, clone.configurationId],
      [rackId]: [rackId],
    });

    let linkedResult: Obj | undefined;
    if (linkedEdit) {
      const target = linkedEdit === 'source' ? source : clone;
      await service.configure(target, [{ section: 'PROCESSOR', code: 'BYW3', quantity: 2 }],
        ctx, target.revision);
      workspace = service.sessions.getWorkspace(imported.workspaceId)!;
      const members = [source, clone];
      for (const member of members) {
        const processor = member.raw.tabs?.flatMap(tab => tab.subTabs ?? [])
          .flatMap(subTab => subTab.sections ?? []).find(section => section.name === 'PROCESSOR');
        assert.deepEqual(processor?.results?.map(result => ({ code: result.code, quantity: result.quantity })),
          [{ code: 'BYW3', quantity: 2 }]);
        assert.equal(member.raw.totalPrice, 26_415.51);
      }
      const products = buildExportGroups(workspace)[0]!.products;
      const serverHardware = products.find(product => product.code === SERVER_CODE);
      assert.deepEqual(serverHardware && {
        id: serverHardware.id, code: serverHardware.code, quantity: serverHardware.quantity,
        price: serverHardware.price, unitPrice: serverHardware.unitPrice,
      }, {
        id: source.configurationId, code: SERVER_CODE, quantity: 2,
        price: 47_413.02, unitPrice: 23_706.51,
      });
      linkedResult = {
        initiatedFrom: linkedEdit, requestedConfigurationId: target.configurationId,
        authoritativeConfigurationId: source.configurationId,
        configurations: members.map(member => ({ id: member.configurationId,
          quantity: member.raw.quantity, totalPrice: member.raw.totalPrice, processor: 2 })),
        group: serverHardware,
      };
    }

    const exported = await service.exportZip(workspace.id, {
      ctx, fileName: 'mcp-clone-multiple', fileTypes: ['XML', 'QUOTE'], scope: 'workspace',
    });
    const bundle = await writeExportBundle(exported.stream, 'mcp-clone-multiple', config);
    assert(bundle.xml, 'MCP Clone Multiple export ZIP contains no XML.');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const handoff = await browserImport(page, bundle.xml);
    await writeFile(path.join(outDir, 'browser-import-response.json'), JSON.stringify(handoff, null, 2));
    const configurations = array(handoff['configuration']).map(object);
    const expectedIds = [source.configurationId, clone.configurationId].sort();
    const servers = configurations.filter(configuration =>
      text(configuration['sliceCtoCode'] ?? configuration['code']) === SERVER_CODE);
    assert.deepEqual(servers.map(configuration => text(configuration['id'])).sort(), expectedIds);
    assert.deepEqual(servers.map(configuration => number(configuration['quantity'])), [1, 1]);
    assert.deepEqual(servers.map(configuration => number(configuration['totalPrice'])),
      [number(source.raw.totalPrice), number(source.raw.totalPrice)]);
    if (linkedEdit) {
      const browserProcessors = servers.map(configuration => array(configuration['tabs'])
        .flatMap(tab => array(object(tab)['subTabs']))
        .flatMap(subTab => array(object(subTab)['sections']))
        .find(section => object(section)['name'] === 'PROCESSOR'));
      assert.deepEqual(browserProcessors.map(section => array(object(section)['results'])
        .map(result => ({ code: object(result)['code'], quantity: object(result)['quantity'] }))), [
        [{ code: 'BYW3', quantity: 2 }], [{ code: 'BYW3', quantity: 2 }],
      ]);
    }
    const placed = array(object(handoff['floorInformation'])['floorGrid'])
      .flatMap(cell => array(object(cell)['items']).map(object))
      .filter(item => expectedIds.includes(text(item['id'])))
      .sort((left, right) => number(left['position']) - number(right['position']));
    assert.deepEqual(placed.map(item => number(item['position'])), [1, 2]);
    assert.deepEqual(placed.map(item => text(item['id'])).sort(), expectedIds);

    const result = {
      capturedAt: new Date().toISOString(), status: 'pass', mode: 'mcp-clone-multiple',
      source: { id: source.configurationId, quantity: source.raw.quantity, totalPrice: source.raw.totalPrice },
      clone: { id: clone.configurationId, label: clone.label, quantity: clone.raw.quantity,
        totalPrice: clone.raw.totalPrice },
      placements: cloned.placements, cloneDependency: workspace.serverState.cloneDependency,
      revision: { before: beforeRevision, after: workspace.revision },
      export: { zipPath: path.relative(ROOT, bundle.zipPath), xmlPath: path.relative(ROOT, bundle.xml),
        bytes: bundle.bytes, sha256: bundle.sha256 },
      browserReimport: {
        configurationCount: configurations.length,
        servers: servers.map(configuration => ({ id: configuration['id'], name: configuration['name'],
          quantity: configuration['quantity'], totalPrice: configuration['totalPrice'] })),
        placements: placed.map(item => ({ id: item['id'], position: item['position'], size: item['size'] })),
      },
      ...(linkedResult ? { linkedEdit: linkedResult } : {}),
    };
    await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (browser) await browser.close();
    await service.close();
  }
}

/** MCP three-member Clone Multiple root deletion and browser handoff gate. */
async function runMcpRootDeleteGate(outDir: string, count: number): Promise<void> {
  assert(count >= 2, 'The root-deletion parity gate requires at least two clones.');
  await mkdir(outDir, { recursive: true });
  const config = ConfigSchema.parse({
    files: { persistSessions: false, artifactDir: path.join(outDir, 'artifacts') },
    logLevel: 'error', pacing: { perToolRequestBudget: 80 },
  });
  const service = new DcscService(config);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const ctx = service.newCtx();
    const imported = await service.importConfig({ content: await readFile(SOURCE_XML, 'utf8'), ctx,
      solutionMode: 'General Purpose', fileName: path.basename(SOURCE_XML) });
    let workspace = service.sessions.getWorkspace(imported.workspaceId);
    assert(workspace, 'MCP import did not publish a workspace.');
    const source = [...workspace.configurations.values()].find(session => session.product.code === SERVER_CODE);
    assert(source, 'MCP import omitted the source server.');
    const rack = workspace.rackArea.find(candidate =>
      array(candidate['rackItems']).map(object).some(item => item['id'] === source.configurationId));
    assert(rack, 'MCP import omitted the source placement.');
    const rackId = text(rack['id']);
    const cloned = await service.cloneConfiguration({ sessionHandle: source.id, count, labelPrefix: 'Node',
      placement: 'same-rack', expectedRevision: workspace.revision, ctx });
    workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    const cloneIds = cloned.clones.map(clone => clone.configurationId);
    assert.deepEqual(workspace.serverState.cloneDependency, {
      [source.configurationId]: [source.configurationId, ...cloneIds], [rackId]: [rackId],
    });

    const beforeDeleteRevision = workspace.revision;
    await service.editLayout(workspace.id, { action: 'remove', configurationId: source.configurationId,
      expectedRevision: beforeDeleteRevision, ctx });
    workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    assert.deepEqual(workspace.serverState.cloneDependency, {
      [rackId]: [rackId], [cloneIds[0]!]: cloneIds,
    });
    assert(![...workspace.configurations.values()].some(session => session.configurationId === source.configurationId));
    const group = buildExportGroups(workspace)[0]!.products.find(product =>
      product.type === 'hardware' && product.code === SERVER_CODE);
    assert.deepEqual(group && { id: group.id, quantity: group.quantity }, { id: cloneIds[0], quantity: count });

    const exported = await service.exportZip(workspace.id, { ctx, fileName: 'mcp-clone-root-delete',
      fileTypes: ['XML', 'QUOTE'], scope: 'workspace' });
    const bundle = await writeExportBundle(exported.stream, 'mcp-clone-root-delete', config);
    assert(bundle.xml, 'MCP root-delete export ZIP contains no XML.');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const handoff = await browserImport(page, bundle.xml);
    await writeFile(path.join(outDir, 'browser-import-response.json'), JSON.stringify(handoff, null, 2));
    const servers = array(handoff['configuration']).map(object).filter(configuration =>
      text(configuration['sliceCtoCode'] ?? configuration['code']) === SERVER_CODE);
    assert.deepEqual(servers.map(configuration => text(configuration['id'])).sort(), [...cloneIds].sort());
    assert.deepEqual(servers.map(configuration => number(configuration['quantity'])), cloneIds.map(() => 1));
    const placed = array(object(handoff['floorInformation'])['floorGrid'])
      .flatMap(cell => array(object(cell)['items']).map(object))
      .filter(item => cloneIds.includes(text(item['id'])))
      .sort((left, right) => number(left['position']) - number(right['position']));
    assert.deepEqual(placed.map(item => text(item['id'])).sort(), [...cloneIds].sort());
    assert.deepEqual(placed.map(item => number(item['position'])), cloneIds.map((_, index) => index + 2));

    const result = {
      capturedAt: new Date().toISOString(), status: 'pass', mode: 'mcp-linked-root-delete',
      deletedRoot: source.configurationId, survivors: cloneIds, rackId,
      cloneDependency: workspace.serverState.cloneDependency,
      revision: { beforeDelete: beforeDeleteRevision, afterDelete: workspace.revision },
      commercial: group,
      export: { zipPath: path.relative(ROOT, bundle.zipPath), xmlPath: path.relative(ROOT, bundle.xml),
        bytes: bundle.bytes, sha256: bundle.sha256 },
      browserReimport: { servers: servers.map(configuration => ({ id: configuration['id'],
        quantity: configuration['quantity'], totalPrice: configuration['totalPrice'] })),
      placements: placed.map(item => ({ id: item['id'], position: item['position'], size: item['size'] })) },
    };
    await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (browser) await browser.close();
    await service.close();
  }
}

/** Source-backed MCP independent Copy, commercial export, and browser handoff gate. */
async function runMcpCopyGate(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const config = ConfigSchema.parse({
    files: { persistSessions: false, artifactDir: path.join(outDir, 'artifacts') },
    logLevel: 'error', pacing: { perToolRequestBudget: 80 },
  });
  const service = new DcscService(config);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const ctx = service.newCtx();
    const imported = await service.importConfig({
      content: await readFile(SOURCE_XML, 'utf8'), ctx, solutionMode: 'General Purpose',
      fileName: path.basename(SOURCE_XML),
    });
    let workspace = service.sessions.getWorkspace(imported.workspaceId);
    assert(workspace, 'MCP import did not publish a workspace.');
    const source = [...workspace.configurations.values()].find(session => session.product.code === SERVER_CODE);
    assert(source, 'MCP import omitted the source server.');
    const sourceRack = workspace.rackArea.find(rack =>
      array(rack['rackItems']).map(object).some(item => item['id'] === source.configurationId));
    assert(sourceRack, 'MCP import did not retain the source rack placement.');
    const rackId = text(sourceRack['id']);
    const beforeRevision = workspace.revision;
    const copied = await service.copyRackItem(source.id, {
      expectedRevision: beforeRevision, ctx,
    });
    workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    const copy = copied.copy;
    assert.equal(copy.raw.name, `Copy_${source.raw.name}`);
    assert.equal(copy.raw.quantity, 1);
    assert.equal(copy.raw.totalPrice, source.raw.totalPrice);
    assert.deepEqual(copied.placement, { configurationId: copy.configurationId, rackId, position: 2 });
    assert.deepEqual(workspace.serverState.cloneDependency, {
      [source.configurationId]: [source.configurationId],
      [rackId]: [rackId],
      [copy.configurationId]: [copy.configurationId],
    });
    const serverHardware = buildExportGroups(workspace)[0]!.products.filter(product =>
      product.code === SERVER_CODE && product.type === 'hardware');
    assert.deepEqual(serverHardware.map(product => product.id), [source.configurationId, copy.configurationId]);
    assert.deepEqual(serverHardware.map(product => product.quantity), [1, 1]);
    assert.equal(serverHardware[0]!.unitPrice, serverHardware[1]!.unitPrice);

    const exported = await service.exportZip(workspace.id, {
      ctx, fileName: 'mcp-rack-copy', fileTypes: ['XML', 'QUOTE'], scope: 'workspace',
    });
    const bundle = await writeExportBundle(exported.stream, 'mcp-rack-copy', config);
    assert(bundle.xml, 'MCP Copy export ZIP contains no XML.');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const handoff = await browserImport(page, bundle.xml);
    await writeFile(path.join(outDir, 'browser-import-response.json'), JSON.stringify(handoff, null, 2));
    const configurations = array(handoff['configuration']).map(object);
    const expectedIds = [source.configurationId, copy.configurationId].sort();
    const servers = configurations.filter(configuration =>
      text(configuration['sliceCtoCode'] ?? configuration['code']) === SERVER_CODE);
    assert.deepEqual(servers.map(configuration => text(configuration['id'])).sort(), expectedIds);
    assert.deepEqual(servers.map(configuration => number(configuration['quantity'])), [1, 1]);
    assert.deepEqual(servers.map(configuration => number(configuration['totalPrice'])),
      [number(source.raw.totalPrice), number(copy.raw.totalPrice)]);
    assert.deepEqual(servers.map(configuration => text(configuration['name'])).sort(), ['Copy_Server', 'Server']);
    const placed = array(object(handoff['floorInformation'])['floorGrid'])
      .flatMap(cell => array(object(cell)['items']).map(object))
      .filter(item => expectedIds.includes(text(item['id'])))
      .sort((left, right) => number(left['position']) - number(right['position']));
    assert.deepEqual(placed.map(item => number(item['position'])), [1, 2]);
    assert.deepEqual(placed.map(item => text(item['id'])).sort(), expectedIds);

    const result = {
      capturedAt: new Date().toISOString(), status: 'pass', mode: 'mcp-rack-copy',
      source: { id: source.configurationId, name: source.raw.name, quantity: source.raw.quantity,
        totalPrice: source.raw.totalPrice },
      copy: { id: copy.configurationId, name: copy.raw.name, quantity: copy.raw.quantity,
        totalPrice: copy.raw.totalPrice },
      placement: copied.placement, cloneDependency: workspace.serverState.cloneDependency,
      commercial: serverHardware.map(product => ({ id: product.id, quantity: product.quantity,
        price: product.price, unitPrice: product.unitPrice })),
      revision: { before: beforeRevision, after: workspace.revision },
      export: { zipPath: path.relative(ROOT, bundle.zipPath), xmlPath: path.relative(ROOT, bundle.xml),
        bytes: bundle.bytes, sha256: bundle.sha256 },
      browserReimport: {
        configurationCount: configurations.length,
        servers: servers.map(configuration => ({ id: configuration['id'], name: configuration['name'],
          quantity: configuration['quantity'], totalPrice: configuration['totalPrice'] })),
        placements: placed.map(item => ({ id: item['id'], position: item['position'], size: item['size'] })),
      },
    };
    await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (browser) await browser.close();
    await service.close();
  }
}

const actionArg = process.argv.find((value) => value.startsWith('--action='))?.slice('--action='.length);
const action: Action = actionArg === 'clone' ? 'clone' : 'copy';
const fresh = process.argv.includes('--fresh');
const mcp = process.argv.includes('--mcp');
const mcpCopy = mcp && process.argv.includes('--copy');
const linkedEditArg = process.argv.find(value => value === '--linked-edit' || value.startsWith('--linked-edit='));
const linkedEdit = linkedEditArg === '--linked-edit=member' ? 'member'
  : linkedEditArg ? 'source' : undefined;
const linkedDeleteArg = process.argv.find(value => value.startsWith('--delete='))?.slice('--delete='.length);
const linkedDelete = linkedDeleteArg === 'root' || linkedDeleteArg === 'member' ? linkedDeleteArg : undefined;
const cloneCount = Number(process.argv.find(value => value.startsWith('--clones='))?.slice('--clones='.length) ?? 1);
assert(Number.isInteger(cloneCount) && cloneCount >= 1 && cloneCount <= 32, '--clones must be an integer from 1 to 32.');
const outArg = process.argv.find((value) => value.startsWith('--out='))?.slice('--out='.length);
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const outDir = path.resolve(outArg ?? `artifacts/parity-rack/clone-${mcp ? 'mcp' : action}-${stamp}`);
if (mcp && linkedDelete === 'root') await runMcpRootDeleteGate(outDir, cloneCount);
else if (mcpCopy) await runMcpCopyGate(outDir);
else if (mcp) await runMcpGate(outDir, linkedEdit);
else await runAction(action, outDir, fresh, linkedEdit, linkedDelete, cloneCount);
