/** Authoritative browser capture for nested chassis/node remove and unplace actions. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page, type Response } from 'playwright';
import { openBrowserImportHome } from './parity/browser.js';

type Obj = Record<string, unknown>;
type Action = 'remove-chassis' | 'remove-node' | 'unplace-node';
const source = path.resolve('test/fixtures/parity/xml/nested-racked-browser.xml');
const oracleSource = path.resolve('test/fixtures/parity/nested-removal-contracts.json');
const argument = (prefix: string) => process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
const action = (argument('--action=') ?? 'remove-chassis') as Action;
const inspectNode = process.argv.includes('--inspect-node');
assert(['remove-chassis', 'remove-node', 'unplace-node'].includes(action), `Unknown action ${action}.`);
const out = path.resolve(argument('--out=') ?? `artifacts/parity-nested-removal/${action}`);
const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Obj : {};
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const sorted = (value: string[]): string[] => [...value].sort();
const ids = (value: unknown): string[] => rows(value)
  .map(item => item['id']).filter((id): id is string => typeof id === 'string');

async function closeCookie(page: Page): Promise<void> {
  const banner = page.locator('.dcsc-cookie-content').first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!await banner.isVisible({ timeout: 1_000 }).catch(() => false)) return;
    await page.locator('.dcsc-cookie-close').first().click({ force: true });
    if (!await banner.isVisible({ timeout: 2_000 }).catch(() => false)) return;
  }
  assert.equal(await banner.isVisible().catch(() => false), false, 'Cookie banner remained over the workspace.');
}

async function saveCall(response: Response, ordinal: number): Promise<Obj> {
  const request = response.request();
  const prefix = String(ordinal).padStart(2, '0');
  const requestText = request.postData() ?? '';
  const responseText = await response.text().catch(() => '');
  await writeFile(path.join(out, `${prefix}-request.txt`), requestText);
  await writeFile(path.join(out, `${prefix}-response.txt`), responseText);
  try { await writeFile(path.join(out, `${prefix}-request.json`), JSON.stringify(JSON.parse(requestText), null, 2)); } catch {
    // Some endpoints use multipart or an empty body; the exact text is retained above.
  }
  try { await writeFile(path.join(out, `${prefix}-response.json`), JSON.stringify(JSON.parse(responseText), null, 2)); } catch {
    // Binary/non-JSON response text is retained above.
  }
  return { ordinal, endpoint: new URL(response.url()).pathname, requestPath: response.url(), status: response.status(),
    requestFile: `${prefix}-request.txt`, responseFile: `${prefix}-response.txt` };
}

async function exportState(page: Page): Promise<{ result: Obj; data: Obj }> {
  await page.getByText('Export', { exact: true }).first().click();
  await page.getByText('Export Preference', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('input.ant-input:visible').last().fill(`nested-${action}`);
  const pending = page.waitForResponse(response => response.request().method() === 'POST' &&
    response.url().includes('/api/ctos/export_zip'), { timeout: 180_000 });
  const downloadPending = page.waitForEvent('download', { timeout: 180_000 });
  await page.getByText('Save', { exact: true }).last().click();
  const response = await pending;
  assert.equal(response.status(), 200);
  const fields = new URLSearchParams(response.request().postData() ?? '');
  const data = JSON.parse(fields.get('data') ?? '{}') as Obj;
  const groups = JSON.parse(fields.get('groups') ?? '[]') as unknown;
  await writeFile(path.join(out, 'export-data.json'), JSON.stringify(data, null, 2));
  await writeFile(path.join(out, 'export-groups.json'), JSON.stringify(groups, null, 2));
  const download = await downloadPending;
  const zip = path.join(out, `nested-${action}.zip`);
  await download.saveAs(zip);
  const bytes = await readFile(zip);
  return { result: { status: response.status(), bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }, data };
}

function assertNativeContract(customize: Obj, derive: Obj, exported: Obj, oracle: Obj): void {
  const identities = object(oracle['identities']);
  const rackId = String(identities['rack']);
  const chassisId = String(identities['chassis']);
  const sourceNodeId = String(identities['looseSourceNode']);
  const copiedNodeId = String(identities['copiedNestedNode']);
  const allIds = sorted([rackId, chassisId, sourceNodeId, copiedNodeId]);
  const contract = object(oracle[action === 'remove-chassis' ? 'deleteChassis'
    : action === 'remove-node' ? 'deleteNode' : 'moveNodeToNonRack']);
  const expectedFinalConfigurations = action === 'remove-chassis'
    ? strings(contract['deriveConfigurationIds']) : strings(contract['configurationIds']);
  const expectedFinalDependencies = action === 'remove-chassis'
    ? expectedFinalConfigurations : strings(contract['deriveCloneDependencyIds']);
  const expectedNonRackIds = action === 'remove-chassis' ? [sourceNodeId]
    : action === 'remove-node' ? [sourceNodeId] : [sourceNodeId, copiedNodeId];
  const expectedChassis = action !== 'remove-chassis';

  const customizeRacks = rows(customize['rackArea']);
  const customizeRackItems = customizeRacks.flatMap(rack => rows(rack['rackItems']));
  assert.deepEqual(sorted(ids(customize['configurations'])),
    action === 'remove-chassis' ? sorted(strings(contract['customizeConfigurationIds']))
      : sorted(strings(contract['configurationIds'])), 'Customize configuration membership changed.');
  assert.deepEqual(sorted(Object.keys(object(customize['cloneDependency']))), allIds,
    'Customize must receive the pre-action clone dependency map.');
  assert.deepEqual(sorted(ids(customize['nonRackArea'])), sorted(expectedNonRackIds),
    'Customize non-rack physical membership changed.');
  assert.deepEqual(ids(customizeRacks), [rackId], 'Customize rack identity changed.');
  assert.deepEqual(ids(customizeRackItems), expectedChassis ? [chassisId] : [],
    'Customize rack-item disposition changed.');
  if (expectedChassis) assert.deepEqual(ids(customizeRackItems[0]?.['nodes']), [],
    'Customize unexpectedly retained a node inside the chassis.');

  const deriveWorkspace = object(derive['workspaceInformation']);
  const deriveRacks = rows(deriveWorkspace['rackData']);
  const deriveRackItems = deriveRacks.flatMap(rack => rows(rack['rackItems']));
  assert.deepEqual(sorted(ids(derive['configurations'])), sorted(expectedFinalConfigurations),
    'Derive configuration membership changed.');
  assert.deepEqual(sorted(Object.keys(object(deriveWorkspace['cloneDependency']))),
    sorted(expectedFinalDependencies), 'Derive clone dependency membership changed.');
  assert.deepEqual(sorted(ids(deriveWorkspace['nonRackData'])), sorted(expectedNonRackIds),
    'Derive non-rack physical membership changed.');
  assert.deepEqual(ids(deriveRacks), [rackId], 'Derive rack identity changed.');
  assert.deepEqual(ids(deriveRackItems), expectedChassis ? [chassisId] : [],
    'Derive rack-item disposition changed.');
  if (expectedChassis) assert.deepEqual(ids(deriveRackItems[0]?.['nodes']), [],
    'Derive unexpectedly retained a node inside the chassis.');

  const exportedWorkspace = object(exported['workspace']);
  const exportRacks = rows(exportedWorkspace['rackArea']);
  const exportRackItems = exportRacks.flatMap(rack => rows(rack['children']));
  assert.deepEqual(sorted(ids(exported['configurations'])), sorted(expectedFinalConfigurations),
    'Export configuration membership changed.');
  assert.deepEqual(sorted(Object.keys(object(exported['cloneDependencyColor']))),
    sorted(strings(contract['exportCloneColorIds'])), 'Export clone-color membership changed.');
  assert.deepEqual(sorted(ids(exportedWorkspace['nonRackArea'])), sorted(expectedNonRackIds),
    'Export non-rack physical membership changed.');
  assert.deepEqual(ids(exportRacks), [rackId], 'Export rack identity changed.');
  assert.deepEqual(ids(exportRackItems), expectedChassis ? [chassisId] : [],
    'Export rack-item disposition changed.');
  if (expectedChassis) assert.deepEqual(ids(exportRackItems[0]?.['children']), [],
    'Export unexpectedly retained a node inside the chassis.');
}

async function main(): Promise<void> {
  await mkdir(out, { recursive: true });
  const oracle = object(JSON.parse(await readFile(oracleSource, 'utf8')));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  const calls: Obj[] = [];
  const captures = new Set<Promise<void>>();
  let captureFailure: unknown;
  let captureOrdinal = 0;
  let phase = 'import';
  page.on('response', response => {
    if (response.request().method() !== 'POST') return;
    if (!/\/api\/ctos\/(?:racks\/customize|autoDerive)/.test(response.url())) return;
    const capturePhase = phase;
    const capture = (async () => {
      calls.push({ phase: capturePhase, ...await saveCall(response, ++captureOrdinal) });
    })().catch((error: unknown) => { captureFailure ??= error; });
    captures.add(capture);
    void capture.finally(() => captures.delete(capture));
  });
  const flushCaptures = async (): Promise<void> => {
    while (captures.size > 0) await Promise.all([...captures]);
    if (captureFailure) throw captureFailure;
  };
  try {
    await openBrowserImportHome(page, 'AI & HPC – ThinkSystem Hardware', {
      diagnosticsDir: path.join(out, 'bootstrap-readiness'),
      timeout: 30_000,
    });
    await closeCookie(page);
    const input = page.locator('input[type="file"]').first();
    await input.waitFor({ state: 'attached', timeout: 30_000 });
    const imported = page.waitForResponse(response => response.request().method() === 'POST' &&
      response.url().includes('/multiple/cfxml_import'), { timeout: 180_000 });
    await input.setInputFiles(source);
    const importResponse = await imported;
    assert.equal(importResponse.status(), 200, (await importResponse.text()).slice(0, 300));
    await page.waitForURL(/#\/rack-summary\//, { timeout: 90_000 });
    await page.waitForTimeout(8_000);
    const workspace = page.getByText('Go to Workspace', { exact: true }).first();
    if (await workspace.isVisible({ timeout: 20_000 }).catch(() => false)) await workspace.click();
    await page.waitForURL(/#\/rack-configuration/, { timeout: 90_000 });
    await page.waitForTimeout(8_000);
    await closeCookie(page);
    await flushCaptures();

    phase = action;
    const target = action === 'remove-chassis'
      ? page.locator('.rack-chassis:visible, .rack-horizontal-chassis:visible').last()
      : page.locator('.rack-chassis-node:visible, .rack-horizontal-chassis-node:visible').last();
    await target.waitFor({ state: 'visible', timeout: 30_000 });
    if (inspectNode) {
      const inventory = await page.locator('.rack-chassis-node:visible, .rack-horizontal-chassis-node:visible')
        .evaluateAll(elements => elements.map((element) => {
          const rect = element.getBoundingClientRect();
          const reactKey = Object.keys(element).find(key => key.startsWith('__reactProps'));
          const props = reactKey ? (element as unknown as Record<string, unknown>)[reactKey] : undefined;
          const propertyRecord = props && typeof props === 'object' ? props as Record<string, unknown> : {};
          return { outerHTML: element.outerHTML, parentHTML: element.parentElement?.outerHTML,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            reactPropKeys: Object.keys(propertyRecord),
            reactPrimitiveProps: Object.fromEntries(Object.entries(propertyRecord)
              .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))),
          };
        }));
      await writeFile(path.join(out, 'node-dom.json'), JSON.stringify(inventory, null, 2));
      console.log(JSON.stringify({ status: 'node-dom-captured', out, count: inventory.length }, null, 2));
      return;
    }
    if (action === 'remove-chassis') await target.click();
    else {
      await target.locator('.rack-horizontal-chassis-node-inner, .rack-chassis-node-inner').hover();
      await page.getByText('Customize Node', { exact: true }).last().waitFor({ state: 'visible', timeout: 30_000 });
    }
    await writeFile(path.join(out, 'action-menu.txt'), (await page.locator('body').innerText()).slice(0, 80_000));
    const customizePending = page.waitForResponse(response => response.request().method() === 'POST' &&
      response.url().includes('/api/ctos/racks/customize'), { timeout: 180_000 })
      .catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    const derivePending = page.waitForResponse(response => response.request().method() === 'POST' &&
      response.url().includes('/api/ctos/autoDerive'), { timeout: 180_000 })
      .catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    if (action === 'unplace-node') {
      await page.getByText('Move To', { exact: true }).last().click();
      await page.getByText('Non Rack Items', { exact: true }).last().click();
    } else {
      await page.getByText(action === 'remove-chassis' ? 'Delete' : 'Delete Node', { exact: true }).last().click();
      await page.waitForTimeout(500);
      const confirm = page.locator('.ant-modal:visible button:visible').filter({ hasText: /^(?:Remove|Delete|Yes|OK)$/i }).last();
      if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) await confirm.click();
    }
    const [customizeResponse, deriveResponse] = await Promise.all([customizePending, derivePending]);
    if (customizeResponse instanceof Error) throw customizeResponse;
    if (deriveResponse instanceof Error) throw deriveResponse;
    assert.equal(customizeResponse.status(), 200,
      `${action} customize failed: ${(await customizeResponse.text()).slice(0, 300)}`);
    assert.equal(deriveResponse.status(), 200,
      `${action} derive failed: ${(await deriveResponse.text()).slice(0, 300)}`);
    await page.waitForTimeout(12_000);
    await flushCaptures();
    const actionCalls = calls.filter(call => call['phase'] === action)
      .sort((left, right) => Number(left['ordinal']) - Number(right['ordinal']));
    assert.equal(actionCalls.length, 2, `${action} must make exactly one customize and one derive call.`);
    assert.deepEqual(actionCalls.map(call => call['endpoint']),
      ['/api/ctos/racks/customize', '/api/ctos/autoDerive'], `${action} endpoint sequence changed.`);
    assert(actionCalls.every(call => call['status'] === 200), `${action} action call returned a non-200 response.`);
    const customizeUrl = new URL(String(actionCalls[0]?.['requestPath']));
    assert.deepEqual(Object.fromEntries(['autoArrange', 'autoConnect', 'cogValidation']
      .map(key => [key, customizeUrl.searchParams.get(key)])),
    { autoArrange: 'true', autoConnect: 'true', cogValidation: 'true' },
    `${action} customize query changed.`);
    const deriveUrl = new URL(String(actionCalls[1]?.['requestPath']));
    assert.equal(deriveUrl.searchParams.get('guideMode'), 'true', `${action} derive omitted guideMode=true.`);
    assert.equal(deriveUrl.searchParams.has('entranceFlag'), false, `${action} derive added an entranceFlag.`);
    assert.equal(deriveUrl.searchParams.has('customizingIds'), false, `${action} derive added customizingIds.`);
    const customizeRequest = object(JSON.parse(await readFile(path.join(out,
      String(actionCalls[0]?.['requestFile'])), 'utf8')));
    const deriveRequest = object(JSON.parse(await readFile(path.join(out,
      String(actionCalls[1]?.['requestFile'])), 'utf8')));
    await writeFile(path.join(out, 'workspace-after.txt'), (await page.locator('body').innerText()).slice(0, 80_000));
    phase = 'export';
    const exportCapture = await exportState(page);
    assertNativeContract(customizeRequest, deriveRequest, exportCapture.data, oracle);
    const result = { status: 'pass', action, source, oracle: oracleSource,
      calls: [...calls].sort((left, right) => Number(left['ordinal']) - Number(right['ordinal'])),
      exported: exportCapture.result };
    await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await writeFile(path.join(out, 'failure.json'), JSON.stringify({ phase, action,
      error: error instanceof Error ? error.stack : String(error), calls,
      body: (await page.locator('body').innerText().catch(() => '')).slice(0, 80_000) }, null, 2));
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
