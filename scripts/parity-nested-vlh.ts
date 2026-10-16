/**
 * Browser-authoritative lifecycle probe for DCSC's current dense chassis/node
 * products. This deliberately starts from the visible catalog and records the
 * server-authored hierarchy before any MCP implementation is attempted.
 *
 * Run with the process-wide browser lock:
 *   flock -n /tmp/lenovo-dcsc-headless.lock npx tsx scripts/parity-nested-vlh.ts --out=...
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Page, type Response } from 'playwright';
import { ConfigSchema } from '../src/config/schema.js';
import { buildExportData } from '../src/domain/reduce.js';
import { writeExportBundle } from '../src/files/artifactStore.js';
import { DcscService } from '../src/mcp/service.js';

type Obj = Record<string, unknown>;

const MODE = 'AI & HPC – ThinkSystem Hardware';
const RACK = '7D6DCTO1WW';
const CHASSIS = '7DD0CTOLWW';
const NODE = '7DD1CTOLWW';
const routes: Record<string, string> = {
  [CHASSIS]: 'STG%40Servers%40Multi-Node%40ThinkSystem%20D3%20Chassis',
  [NODE]: 'STG%40Servers%40Multi-Node%40ThinkSystem%20SD535%20V3',
};
const execFileAsync = promisify(execFile);

const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Obj : {};
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown): string => value === undefined || value === null ? '' : String(value);
const number = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0;

interface CapturedCall {
  ordinal: number;
  phase: string;
  endpoint: string;
  status: number;
  requestPath: string;
  requestFile?: string;
  responseFile?: string;
}

function layout(value: unknown): Obj {
  const root = object(value);
  const workspaceInformation = object(root['workspaceInformation']);
  const workspace = object(root['workspace']);
  const rackArea = rows(root['rackArea']).length ? rows(root['rackArea'])
    : rows(workspaceInformation['rackData']).length ? rows(workspaceInformation['rackData']) : rows(workspace['rackArea']);
  const nonRackArea = Object.hasOwn(root, 'nonRackArea') ? rows(root['nonRackArea'])
    : rows(workspaceInformation['nonRackData']).length ? rows(workspaceInformation['nonRackData']) : rows(workspace['nonRackArea']);
  const configurations = rows(root['configurations']).length ? rows(root['configurations'])
    : rows(root['configuration']).length ? rows(root['configuration']) : rows(workspaceInformation['configurations']);
  const physical = (item: Obj): Obj => ({
    id: text(item['id']), originalId: text(item['originalId']), code: text(item['code'] ?? item['sliceCtoCode']),
    type: text(item['type']), position: number(item['position']), size: number(item['size']),
    occupiedBay: item['occupiedBay'], capacity: item['capacity'], chassisModel: item['chassisModel'],
    asVLH: item['asVLH'] === true, vlhId: item['vlhId'],
    nodes: rows(item['nodes']).map(physical), children: rows(item['children']).map(physical),
  });
  return {
    configurations: configurations.map(item => ({ id: text(item['id']), code: text(item['code'] ?? item['sliceCtoCode']),
      type: text(item['type']), quantity: number(item['quantity']), totalPrice: number(item['totalPrice']),
      asVLH: item['asVLH'] === true, vlhId: item['vlhId'] })),
    racks: rackArea.map(physical), nonRack: nonRackArea.map(physical),
    vlhItems: root['vlhItems'] ?? workspace['vlhItems'],
    cloneDependency: root['cloneDependency'] ?? workspaceInformation['cloneDependency'] ?? workspace['cloneDependency'],
  };
}

async function closeCookie(page: Page): Promise<void> {
  const close = page.locator('.dcsc-cookie-close').first();
  if (await close.isVisible({ timeout: 2_000 }).catch(() => false)) await close.click();
}

async function selectMode(page: Page): Promise<void> {
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await closeCookie(page);
  await page.getByText(/^General Purpose$/i).first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByText(/^General Purpose$/i).first().click();
  await page.locator('.ant-popover:visible [role="combobox"]').click();
  await page.getByText(MODE, { exact: true }).last().click();
  await page.locator('.ant-popover:visible #apply').click();
  await page.waitForTimeout(5_000);
}

async function launch(page: Page, code: string): Promise<void> {
  await page.goto(`https://dcsc.lenovo.com/#/categories/${routes[code]}`, {
    waitUntil: 'domcontentloaded', timeout: 90_000,
  });
  await page.waitForTimeout(5_000);
  const pending = page.waitForResponse(response => response.request().method() === 'POST' &&
    response.url().includes(`/api/ctos/${code}/launch`), { timeout: 120_000 });
  const button = page.locator(`a[href*="${code}"] button`).first();
  await button.waitFor({ state: 'visible', timeout: 30_000 });
  await button.click();
  assert.equal((await pending).status(), 200, `${code} launch status`);
  await page.waitForURL(/#\/configuration\/cto\//, { timeout: 60_000 });
  await page.waitForTimeout(8_000);
  await page.getByText('Summary', { exact: true }).first().click();
  await page.waitForURL(/#\/rack-summary\//, { timeout: 60_000 });
  await page.waitForTimeout(8_000);
}

function installCapture(page: Page, outDir: string, phase: () => string): CapturedCall[] {
  const calls: CapturedCall[] = [];
  page.on('response', (response: Response) => {
    void (async () => {
      if (response.request().method() !== 'POST') return;
      if (!/\/(?:api\/ctos\/(?:racks\/customize|autoDerive|[^/]+\/launch|racks\/[^/]+\/launch)|api\/ctos\/export_zip)/.test(response.url())) return;
      const ordinal = calls.length + 1;
      const prefix = String(ordinal).padStart(2, '0');
      const request = response.request();
      const call: CapturedCall = { ordinal, phase: phase(), endpoint: new URL(response.url()).pathname,
        requestPath: new URL(response.url()).pathname + new URL(response.url()).search, status: response.status() };
      const post = request.postData();
      if (post && !response.url().includes('/export_zip')) {
        call.requestFile = `${prefix}-request.json`;
        try { await writeFile(path.join(outDir, call.requestFile), JSON.stringify(JSON.parse(post), null, 2)); }
        catch { await writeFile(path.join(outDir, `${prefix}-request.txt`), post); }
      }
      if (response.url().includes('/racks/customize')) {
        try {
          call.responseFile = `${prefix}-response.json`;
          await writeFile(path.join(outDir, call.responseFile), JSON.stringify(await response.json(), null, 2));
        } catch { /* status and request remain authoritative */ }
      }
      calls.push(call);
      await writeFile(path.join(outDir, 'calls.json'), JSON.stringify(calls, null, 2));
    })().catch(() => undefined);
  });
  return calls;
}

async function group(page: Page, code: string) {
  const candidates = page.locator('.ant-collapse-item').filter({ hasText: new RegExp(code) });
  for (let index = await candidates.count() - 1; index >= 0; index -= 1) {
    if (await candidates.nth(index).isVisible().catch(() => false)) return candidates.nth(index);
  }
  throw new Error(`Could not find a visible non-rack group for ${code}.`);
}

async function dragChassisToRack(page: Page, source: ReturnType<Page['locator']>): Promise<void> {
  const sourceBox = await source.boundingBox();
  assert(sourceBox, 'Nested chassis drag source must have visible bounds.');
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 10, sourceBox.y + sourceBox.height / 2, { steps: 5 });
  await page.waitForTimeout(500);
  const targets = page.locator('.rack-empty-unit:visible');
  for (let index = await targets.count() - 1; index >= 0; index -= 1) {
    const target = targets.nth(index);
    const box = await target.boundingBox();
    if (!box) continue;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await page.waitForTimeout(200);
    const placementStyle = await target.locator('.rack-empty-placement').getAttribute('style') ?? '';
    if (!placementStyle.includes('background-color')) continue;
    await page.waitForTimeout(500);
    await page.mouse.up();
    return;
  }
  await page.mouse.up();
  throw new Error('No rack U accepted the compatible nested chassis drag.');
}

async function moveNonRack(page: Page, code: string, outDir: string): Promise<void> {
  const container = await group(page, code);
  if ((await container.locator('.ant-collapse-header').first().getAttribute('aria-expanded')) !== 'true') {
    await container.locator('.ant-collapse-header').first().click();
  }
  await page.waitForTimeout(750);
  const cloneGroup = container.locator('.ant-collapse-item').last();
  if (await cloneGroup.count() > 0 &&
      (await cloneGroup.locator('.ant-collapse-header').first().getAttribute('aria-expanded')) !== 'true') {
    await cloneGroup.locator('.ant-collapse-header').first().click();
    await page.waitForTimeout(750);
  }
  await writeFile(path.join(outDir, `move-source-${code}.html`), await container.evaluate(element => element.outerHTML));
  const pending = page.waitForResponse(response => response.request().method() === 'POST' &&
    response.url().includes('/api/ctos/racks/customize'), { timeout: 180_000 });
  if (code === CHASSIS) {
    const source = container.locator('.rack-chassis, .rack-horizontal-chassis, .rack-server').last();
    await source.waitFor({ state: 'visible', timeout: 15_000 });
    await dragChassisToRack(page, source);
  } else {
    const target = page.locator('.rack-chassis:visible, .rack-horizontal-chassis:visible').last();
    await target.click();
    const addNode = page.getByText('Add Node', { exact: true }).last();
    await addNode.waitFor({ state: 'visible', timeout: 15_000 });
    await addNode.click();
    const menus = page.locator('.ant-cascader-menus:visible');
    await menus.waitFor({ state: 'visible', timeout: 15_000 });
    await writeFile(path.join(outDir, `move-options-${code}.json`), JSON.stringify(await menus.allInnerTexts(), null, 2));
    for (const option of [
      page.getByText('Already Configured Nodes', { exact: true }).last(),
      page.getByText(new RegExp(`\\[${code}\\].*Node.*Non Rack Area`, 'i')).last(),
    ]) {
      await option.waitFor({ state: 'visible', timeout: 15_000 });
      await option.hover();
      await page.waitForTimeout(500);
    }
    await page.getByText('As Copy', { exact: true }).last().click();
  }
  assert.equal((await pending).status(), 200, `${code} move customize`);
  await page.waitForTimeout(12_000);
}

async function disableAutomatedRackPdu(page: Page, outDir: string): Promise<void> {
  const label = page.locator('.auto-connect__label:visible').first();
  const settings = label.locator('xpath=..').locator('.anticon-setting').first();
  await settings.waitFor({ state: 'visible', timeout: 15_000 });
  await settings.click();
  const automatedPdu = page.getByText('Automated Rack PDU', { exact: true }).last();
  await automatedPdu.waitFor({ state: 'visible', timeout: 10_000 });
  const checkbox = automatedPdu.locator('xpath=ancestor::label[1]').locator('input[type="checkbox"]');
  const before = await checkbox.isChecked();
  if (before) {
    await automatedPdu.click();
    await page.waitForTimeout(8_000);
  }
  await writeFile(path.join(outDir, 'auto-connect-settings.json'), JSON.stringify({
    automatedRackPduBefore: before, automatedRackPduAfter: await checkbox.isChecked(),
  }, null, 2));
  await settings.click().catch(() => undefined);
  await page.waitForTimeout(500);
}

async function addRack(page: Page): Promise<void> {
  await page.getByText('Rack', { exact: true }).first().click();
  const pending = page.waitForResponse(response => response.request().method() === 'POST' &&
    response.url().includes('/api/ctos/autoDerive'), { timeout: 180_000 });
  await page.getByText(new RegExp(RACK)).first().dblclick();
  assert.equal((await pending).status(), 200, 'rack derive status');
  await page.waitForTimeout(8_000);
}

async function captureExport(page: Page, outDir: string): Promise<Obj> {
  await page.getByText('Export', { exact: true }).first().click();
  await page.getByText('Export Preference', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('input.ant-input:visible').last().fill('nested-vlh-browser');
  const pending = page.waitForResponse(response => response.request().method() === 'POST' &&
    response.url().includes('/api/ctos/export_zip'), { timeout: 180_000 });
  const downloadPending = page.waitForEvent('download', { timeout: 180_000 });
  await page.getByText('Save', { exact: true }).last().click();
  const response = await pending;
  assert.equal(response.status(), 200, 'nested export status');
  const form = response.request().postData() ?? '';
  await writeFile(path.join(outDir, 'export-form.txt'), form);
  const fields = new URLSearchParams(form);
  const data = JSON.parse(fields.get('data') ?? '{}') as Obj;
  const groups = JSON.parse(fields.get('groups') ?? '[]') as unknown;
  await writeFile(path.join(outDir, 'export-data.json'), JSON.stringify(data, null, 2));
  await writeFile(path.join(outDir, 'export-groups.json'), JSON.stringify(groups, null, 2));
  const download = await downloadPending;
  const zipPath = path.join(outDir, 'nested-vlh.zip');
  await download.saveAs(zipPath);
  const body = await readFile(zipPath);
  return { status: response.status(), bytes: body.byteLength,
    sha256: createHash('sha256').update(body).digest('hex'), layout: layout(data), groups };
}

async function unplaceChassis(page: Page): Promise<void> {
  const chassis = page.locator('.rack-chassis:visible, .rack-horizontal-chassis:visible').last();
  await chassis.click();
  const move = page.getByText('Move To', { exact: true }).last();
  await move.waitFor({ state: 'visible', timeout: 15_000 });
  await move.click();
  const pending = page.waitForResponse(response => response.request().method() === 'POST' &&
    response.url().includes('/api/ctos/racks/customize'), { timeout: 180_000 });
  await page.getByText('Non Rack Items', { exact: true }).last().click();
  assert.equal((await pending).status(), 200, 'nested chassis unplace status');
  await page.waitForTimeout(12_000);
}

async function freshImport(
  browser: Awaited<ReturnType<typeof chromium.launch>>, outDir: string,
  sourcePath = path.join(outDir, 'nested-vlh.zip'),
): Promise<Obj> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  try {
    await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await closeCookie(page);
    const input = page.locator('input[type="file"]').first();
    await input.waitFor({ state: 'attached', timeout: 30_000 });
    const pending = page.waitForResponse(response => response.request().method() === 'POST' &&
      response.url().includes('/multiple/cfxml_import'), { timeout: 180_000 });
    await input.setInputFiles(sourcePath);
    const response = await pending;
    const body = await response.text();
    await writeFile(path.join(outDir, 'fresh-import-response.txt'), body);
    assert.equal(response.status(), 200, `fresh nested import status; body=${body.slice(0, 300)}`);
    const parsed = JSON.parse(body) as unknown;
    const envelope = object(Array.isArray(parsed) ? parsed[0] : parsed);
    await writeFile(path.join(outDir, 'fresh-import-response.json'), JSON.stringify(parsed, null, 2));
    return { status: response.status(), url: page.url(), layout: layout(envelope), raw: envelope };
  } finally {
    await context.close();
  }
}

async function extractXml(outDir: string): Promise<string> {
  const zipPath = path.join(outDir, 'nested-vlh.zip');
  const { stdout } = await execFileAsync('unzip', ['-p', zipPath, '*.xml'], {
    encoding: 'buffer', maxBuffer: 8 * 1024 * 1024,
  });
  assert(stdout.length > 0, 'Nested export ZIP contains no XML member.');
  const xmlPath = path.join(outDir, 'nested-vlh.xml');
  await writeFile(xmlPath, stdout);
  return xmlPath;
}

async function main(): Promise<void> {
  const arg = process.argv.find(value => value.startsWith('--out='));
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const outDir = path.resolve(arg?.slice('--out='.length) ?? `artifacts/parity-nested-vlh/${stamp}`);
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  let phase = 'mode';
  const calls = installCapture(page, outDir, () => phase);
  try {
    await selectMode(page);
    phase = 'launch-chassis';
    await launch(page, CHASSIS);
    phase = 'launch-node';
    await launch(page, NODE);
    await writeFile(path.join(outDir, 'summary.txt'), (await page.locator('body').innerText()).slice(0, 80_000));
    phase = 'workspace';
    await page.getByText('Go to Workspace', { exact: true }).first().click();
    await page.waitForURL(/#\/rack-configuration/, { timeout: 60_000 });
    await page.waitForTimeout(8_000);
    await writeFile(path.join(outDir, 'workspace-before.txt'), (await page.locator('body').innerText()).slice(0, 80_000));
    phase = 'add-rack';
    await addRack(page);
    phase = 'disable-automated-rack-pdu';
    await disableAutomatedRackPdu(page, outDir);
    phase = 'place-chassis';
    await moveNonRack(page, CHASSIS, outDir);
    phase = 'place-node-in-chassis';
    await moveNonRack(page, NODE, outDir);
    const nestedOptions = {
      chassisCount: await page.locator('.rack-chassis:visible, .rack-horizontal-chassis:visible').count(),
      nodeCount: await page.locator('.rack-chassis-node:visible, .rack-horizontal-chassis-node:visible').count(),
    };
    await writeFile(path.join(outDir, 'nested-dom.json'), JSON.stringify(nestedOptions, null, 2));
    await writeFile(path.join(outDir, 'workspace-after-chassis.txt'), (await page.locator('body').innerText()).slice(0, 80_000));
    if (process.argv.includes('--unplace-chassis')) {
      phase = 'unplace-chassis';
      await unplaceChassis(page);
      await writeFile(path.join(outDir, 'workspace-after-unplace.txt'), (await page.locator('body').innerText()).slice(0, 80_000));
      if (process.argv.includes('--replace-chassis')) {
        phase = 'replace-chassis';
        await moveNonRack(page, CHASSIS, outDir);
        await writeFile(path.join(outDir, 'workspace-after-replace.txt'),
          (await page.locator('body').innerText()).slice(0, 80_000));
      }
    }
    phase = 'export';
    const exported = await captureExport(page, outDir);
    phase = 'fresh-import';
    const imported = await freshImport(browser, outDir, await extractXml(outDir));
    const result = { capturedAt: new Date().toISOString(), status: 'discovery-pass', products: {
      rack: RACK, chassis: CHASSIS, node: NODE,
    }, calls, nestedOptions, exported, imported };
    await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    // Keep the terminal report usable: the full import envelope can be several
    // megabytes and remains available in result.json/fresh-import-response.json.
    console.log(JSON.stringify({
      status: result.status, outDir, products: result.products, nestedOptions,
      calls: calls.length, exported: {
        status: exported.status, bytes: exported.bytes, sha256: exported.sha256,
        layout: exported.layout,
      }, imported: { status: imported.status, url: imported.url, layout: imported.layout },
    }, null, 2));
  } catch (error) {
    await writeFile(path.join(outDir, 'failure.json'), JSON.stringify({ capturedAt: new Date().toISOString(), phase,
      url: page.url(), error: error instanceof Error ? error.stack : String(error), calls,
      body: (await page.locator('body').innerText().catch(() => '')).slice(0, 80_000) }, null, 2));
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runMcp(): Promise<void> {
  const arg = process.argv.find(value => value.startsWith('--out='));
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const outDir = path.resolve(arg?.slice('--out='.length) ?? `artifacts/parity-nested-vlh/${stamp}-mcp`);
  await mkdir(outDir, { recursive: true });
  const config = ConfigSchema.parse({ files: { persistSessions: false, artifactDir: path.join(outDir, 'artifacts') },
    logLevel: 'error', pacing: { perToolRequestBudget: 80 } });
  const service = new DcscService(config);
  try {
    const ctx = service.newCtx();
    const solution = { solutionMode: 'HPC and AI - Systems',
      masterSlices: ['HPCGP', 'HPCRYO', 'HPCGPALL', 'HPCGPRYO'] };
    const chassis = await service.launch({ productCode: CHASSIS, mode: 'cto', solution, ctx });
    let workspace = service.sessions.getWorkspace(chassis.workspaceId)!;
    const node = await service.launch({ productCode: NODE, mode: 'cto', solution, ctx,
      workspaceId: workspace.id, expectedRevision: workspace.revision });
    workspace = service.sessions.getWorkspace(chassis.workspaceId)!;
    await service.addRack(workspace.id, RACK, ctx, workspace.revision);
    workspace = service.sessions.getWorkspace(chassis.workspaceId)!;
    const rack = workspace.rackArea.find(item => text(item['code']).toUpperCase() === RACK)!;
    assert(rack, 'MCP did not add the selected D3-compatible rack.');
    await service.placeInRack(workspace.id, { rackId: text(rack['id']), sessionId: chassis.configurationId,
      expectedRevision: workspace.revision, ctx });
    workspace = service.sessions.getWorkspace(chassis.workspaceId)!;
    const placedChassis = rows(rack['rackItems']).find(item => item['id'] === chassis.configurationId) ??
      rows(workspace.rackArea.find(item => item['id'] === rack['id'])?.['rackItems'])
        .find(item => item['id'] === chassis.configurationId);
    assert(placedChassis, 'MCP did not retain the D3 chassis placement.');
    await writeFile(path.join(outDir, 'before-nested-state.json'), JSON.stringify({
      rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
      configurations: [...workspace.configurations.values()].map(session => ({ id: session.configurationId,
        code: session.product.code, name: session.raw.name, quantity: session.raw.quantity })),
    }, null, 2));
    const nested = await service.placeInRack(workspace.id, { rackId: text(rack['id']),
      chassisId: chassis.configurationId, sessionId: node.configurationId,
      expectedRevision: workspace.revision, ctx });
    workspace = service.sessions.getWorkspace(chassis.workspaceId)!;
    assert(nested.nestedPlacement, 'MCP placement did not return nestedPlacement.');
    const copied = workspace.configurations.get(nested.nestedPlacement.session);
    assert(copied, 'MCP nested placement did not publish the copied configuration.');
    const projectedExport = buildExportData({ workspace, solution, fileTypes: ['XML', 'QUOTE'],
      validationMode: workspace.validationMode });
    await writeFile(path.join(outDir, 'pre-export-state.json'), JSON.stringify({
      workspace: { rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
        cloneDependency: workspace.serverState.cloneDependency,
        cloneDependencyColor: workspace.serverState.cloneDependencyColor },
      configurations: [...workspace.configurations.values()].map(session => session.raw),
      projectedExport,
    }, null, 2));
    const exported = await service.exportZip(workspace.id, { ctx, fileName: 'nested-vlh-mcp',
      fileTypes: ['XML', 'QUOTE'], scope: 'workspace' });
    const bundle = await writeExportBundle(exported.stream, 'nested-vlh-mcp', config);
    assert(bundle.xml, 'MCP nested export did not contain XML.');
    const state = {
      workspaceId: workspace.id, revision: workspace.revision,
      source: { id: node.configurationId, name: node.raw.name, quantity: node.raw.quantity, totalPrice: node.raw.totalPrice },
      copy: { id: copied.configurationId, name: copied.raw.name, quantity: copied.raw.quantity,
        totalPrice: copied.raw.totalPrice, autoDerivedResultId: copied.raw.autoDerivedResultId,
        expansionMessages: copied.raw.expansionMessages },
      nestedPlacement: nested.nestedPlacement,
      layout: layout({ rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
        configurations: [...workspace.configurations.values()].map(session => session.raw),
        cloneDependency: workspace.serverState.cloneDependency }),
      cloneDependency: workspace.serverState.cloneDependency,
      cloneDependencyColor: workspace.serverState.cloneDependencyColor,
      export: { ...bundle, xml: bundle.xml },
    };
    await writeFile(path.join(outDir, 'mcp-state.json'), JSON.stringify(state, null, 2));
    await writeFile(path.join(outDir, 'result.json'), JSON.stringify({ capturedAt: new Date().toISOString(),
      status: 'mcp-pass', products: { rack: RACK, chassis: CHASSIS, node: NODE }, ...state }, null, 2));
    console.log(JSON.stringify({ status: 'mcp-pass', outDir, nestedPlacement: nested.nestedPlacement,
      xml: bundle.xml }, null, 2));
  } finally {
    await service.close();
  }
}

async function runFreshImportOnly(): Promise<void> {
  const arg = process.argv.find(value => value.startsWith('--out='));
  const outDir = path.resolve(arg?.slice('--out='.length) ?? 'artifacts/parity-nested-vlh/import-only');
  await mkdir(outDir, { recursive: true });
  const sourceArg = process.argv.find(value => value.startsWith('--import='));
  assert(sourceArg, '--import=<zip> is required.');
  const source = path.resolve(sourceArg.slice('--import='.length));
  const localSource = path.join(outDir, `import-source${path.extname(source) || '.xml'}`);
  await writeFile(localSource, await readFile(source));
  const browser = await chromium.launch({ headless: true });
  try {
    const imported = await freshImport(browser, outDir, localSource);
    const result = { capturedAt: new Date().toISOString(), status: 'fresh-import-pass',
      source, imported: { status: imported['status'], url: imported['url'], layout: imported['layout'] } };
    await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

const execution = process.argv.some(value => value.startsWith('--import=')) ? runFreshImportOnly()
  : process.argv.includes('--mcp') ? runMcp() : main();
execution.catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
