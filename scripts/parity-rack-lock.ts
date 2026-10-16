/** Maintained browser oracle for rack-item and empty-U Lock/Unlock semantics. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page, type Request, type Response } from 'playwright';
import { ConfigSchema } from '../src/config/schema.js';
import { writeExportBundle } from '../src/files/artifactStore.js';
import { DcscService } from '../src/mcp/service.js';

type Obj = Record<string, unknown>;
const ROOT = process.cwd();
const SOURCE_XML = path.join(ROOT, 'test/fixtures/parity/xml/one-rack-sr630-v3.xml');

function object(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return value === undefined || value === null ? '' : String(value); }

async function closeCookie(page: Page): Promise<void> {
  const close = page.locator('.dcsc-cookie-close').first();
  if (await close.isVisible({ timeout: 2_000 }).catch(() => false)) await close.click();
}

async function importWorkspace(page: Page): Promise<void> {
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await closeCookie(page);
  const file = page.locator('input[type="file"]').first();
  await file.waitFor({ state: 'attached', timeout: 30_000 });
  const imported = page.waitForResponse(response => response.url().includes('/multiple/cfxml_import') &&
    response.request().method() === 'POST', { timeout: 120_000 });
  await file.setInputFiles(SOURCE_XML);
  assert.equal((await imported).status(), 200);
  await page.waitForURL(/#\/(?:rack-summary|summary)\//, { timeout: 120_000 });
  await page.getByText('Go to Workspace', { exact: true }).first().click();
  await page.waitForURL(/#\/rack-configuration/, { timeout: 60_000 });
  await page.waitForTimeout(7_000);
}

function installCapture(page: Page, outDir: string) {
  const calls: Array<{ request: Request; ordinal: number }> = [];
  page.on('request', request => {
    if (!request.url().includes('/api/ctos/')) return;
    const ordinal = calls.length + 1;
    calls.push({ request, ordinal });
    let body: unknown;
    try { body = request.postDataJSON() as unknown; } catch { body = request.postData(); }
    void writeFile(path.join(outDir, `${String(ordinal).padStart(2, '0')}-request.json`),
      JSON.stringify({ url: request.url(), method: request.method(), body }, null, 2));
  });
  page.on('response', (response: Response) => {
    const call = calls.find(entry => entry.request === response.request());
    if (!call) return;
    void (async () => {
      let body: unknown = null;
      try { body = await response.json() as unknown; } catch { body = null; }
      await writeFile(path.join(outDir, `${String(call.ordinal).padStart(2, '0')}-response.json`),
        JSON.stringify({ url: response.url(), status: response.status(), body }, null, 2));
    })();
  });
  return calls;
}

function firstRack(body: unknown): Obj {
  const value = object(body);
  return object(array(value['rackArea'])[0]);
}

function workspaceSnapshot(workspace: NonNullable<ReturnType<DcscService['sessions']['getWorkspace']>>) {
  const copy = structuredClone(workspace);
  copy.lastAccessAt = 0;
  for (const session of copy.configurations.values()) session.lastAccessAt = 0;
  return copy;
}

async function exportState(page: Page, outDir: string): Promise<Obj> {
  await page.getByText('Export', { exact: true }).first().click();
  await page.getByText('Export Preference', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('input.ant-input:visible').last().fill('browser-rack-lock');
  const pending = page.waitForResponse(response => response.url().includes('/api/ctos/export_zip') &&
    response.request().method() === 'POST', { timeout: 120_000 });
  await page.getByText('Save', { exact: true }).last().click();
  const response = await pending;
  assert.equal(response.status(), 200);
  const form = response.request().postData() ?? '';
  await writeFile(path.join(outDir, 'browser-export-form.txt'), form);
  const encoded = new URLSearchParams(form).get('data');
  assert(encoded, 'Lock export form omitted data.');
  const data = JSON.parse(encoded) as Obj;
  await writeFile(path.join(outDir, 'browser-export-data.json'), JSON.stringify(data, null, 2));
  return data;
}

async function browserImport(page: Page, xmlPath: string): Promise<Obj> {
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await closeCookie(page);
  const file = page.locator('input[type="file"]').first();
  await file.waitFor({ state: 'attached', timeout: 30_000 });
  const pending = page.waitForResponse(response => response.url().includes('/multiple/cfxml_import') &&
    response.request().method() === 'POST', { timeout: 120_000 });
  await file.setInputFiles(xmlPath);
  const response = await pending;
  assert.equal(response.status(), 200, 'MCP lock browser reimport status');
  const raw = await response.json() as unknown;
  await page.waitForURL(/#\/(?:rack-summary|summary)\//, { timeout: 120_000 });
  return object(Array.isArray(raw) ? raw[0] : raw);
}

async function runMcpLock(outDir: string): Promise<void> {
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
    const source = [...workspace.configurations.values()].find(session => session.product.code === '7D73CTO1WW');
    assert(source, 'MCP import omitted the source server.');
    const rack = workspace.rackArea.find(candidate =>
      array(candidate['rackItems']).map(object).some(item => item['id'] === source.configurationId));
    assert(rack, 'MCP import omitted the source rack placement.');
    const rackId = text(rack['id']);
    const beforeRevision = workspace.revision;
    await service.setRackLock(workspace.id, {
      target: { rackId, position: 42 }, locked: true,
      expectedRevision: workspace.revision, ctx,
    });
    workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    const beforeReservedPlacement = workspaceSnapshot(workspace);
    const rejectedRevision = workspace.revision;
    let rejection = '';
    try {
      await service.placeInRack(workspace.id, {
        rackId, sessionId: source.id, position: 42,
        expectedRevision: workspace.revision, ctx,
      });
      assert.fail('MCP accepted placement into reserved U42.');
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }
    assert.match(rejection, /locked rack space/i,
      'MCP reserved-U placement did not fail for the reservation itself.');
    workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    assert.equal(workspace.revision, rejectedRevision,
      'Rejected reserved-U placement changed the workspace revision.');
    assert.deepEqual(workspaceSnapshot(workspace), beforeReservedPlacement,
      'Rejected reserved-U placement changed workspace state or history.');
    const rackAfterRejection = workspace.rackArea.find(candidate => candidate['id'] === rackId)!;
    const itemAfterRejection = array(rackAfterRejection['rackItems']).map(object)
      .find(item => item['id'] === source.configurationId);
    assert(itemAfterRejection, 'Rejected reserved-U placement lost the source item.');
    assert.equal(itemAfterRejection['position'], 1,
      'Rejected reserved-U placement changed the accepted source position.');
    assert.deepEqual(rackAfterRejection['lockedSpace'], [42],
      'Rejected reserved-U placement changed the accepted reservation.');
    const rejectedAcceptedState = {
      itemPosition: itemAfterRejection['position'],
      itemLock: itemAfterRejection['lock'],
      lockedSpace: rackAfterRejection['lockedSpace'],
    };

    await service.setRackLock(source.id, {
      target: { itemId: source.configurationId }, locked: true,
      expectedRevision: workspace.revision, ctx,
    });
    workspace = service.sessions.getWorkspace(imported.workspaceId)!;
    const acceptedRack = workspace.rackArea.find(candidate => candidate['id'] === rackId)!;
    const acceptedItem = array(acceptedRack['rackItems']).map(object)
      .find(item => item['id'] === source.configurationId);
    assert.equal(acceptedItem?.['lock'], true, 'MCP did not retain the accepted item lock.');
    assert.deepEqual(acceptedRack['lockedSpace'], [42], 'MCP canonical empty-U lock is not one-based U42.');

    const exported = await service.exportZip(workspace.id, {
      ctx, fileName: 'mcp-rack-lock', fileTypes: ['XML', 'QUOTE'], scope: 'workspace',
    });
    const bundle = await writeExportBundle(exported.stream, 'mcp-rack-lock', config);
    assert(bundle.xml, 'MCP Lock export ZIP contains no XML.');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const handoff = await browserImport(page, bundle.xml);
    await writeFile(path.join(outDir, 'browser-import-response.json'), JSON.stringify(handoff, null, 2));
    const floorGrid = array(object(handoff['floorInformation'])['floorGrid']).map(object);
    const importedRack = floorGrid.find(cell => cell['id'] === rackId);
    assert(importedRack, 'Fresh browser import omitted the locked rack.');
    assert.deepEqual(importedRack['lockedSpace'], [41], 'Fresh browser did not retain zero-based U42 lock.');
    const importedItem = array(importedRack['items']).map(object)
      .find(item => item['id'] === source.configurationId);

    const result = {
      capturedAt: new Date().toISOString(),
      status: 'pass',
      mode: 'mcp-rack-lock',
      source: { configurationId: source.configurationId, rackId },
      canonical: { itemLock: acceptedItem['lock'], lockedSpace: acceptedRack['lockedSpace'] },
      revision: { before: beforeRevision, after: workspace.revision },
      reservedPlacement: {
        targetPosition: 42,
        sourceWasUnlocked: true,
        rejection,
        revisionAtAttempt: rejectedRevision,
        revisionAfterAttempt: rejectedRevision,
        stateAndHistoryUnchangedAtRejection: true,
        historyDepth: {
          undo: beforeReservedPlacement.history?.undo.length ?? 0,
          redo: beforeReservedPlacement.history?.redo.length ?? 0,
        },
        acceptedState: rejectedAcceptedState,
      },
      export: { zipPath: path.relative(ROOT, bundle.zipPath), xmlPath: path.relative(ROOT, bundle.xml),
        bytes: bundle.bytes, sha256: bundle.sha256 },
      browserReimport: {
        lockedSpace: importedRack['lockedSpace'], item: importedItem,
        itemLockRoundtrip: 'not-represented-by-cfxml',
        oracle: 'Native browser export replay also omits item lock on fresh browser import.',
      },
    };
    await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    assert.equal(importedItem?.['lock'], undefined,
      'Fresh browser unexpectedly retained an item lock that native CFXML currently omits.');
  } finally {
    if (browser) await browser.close();
    await service.close();
  }
}

const outArg = process.argv.find(value => value.startsWith('--out='))?.slice('--out='.length);
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const outDir = path.resolve(outArg ?? `artifacts/parity-rack/lock-${stamp}`);
const mcp = process.argv.includes('--mcp');
if (mcp) {
  await runMcpLock(outDir);
  process.exit(0);
}
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await importWorkspace(page);
  const calls = installCapture(page, outDir);

  await page.locator('.rack-server').first().click();
  await page.getByText('Lock', { exact: true }).last().waitFor({ state: 'visible', timeout: 10_000 });
  const itemPending = page.waitForResponse(response => response.url().includes('/api/ctos/racks/customize') &&
    response.request().method() === 'POST', { timeout: 120_000 });
  await page.getByText('Lock', { exact: true }).last().click();
  assert.equal((await itemPending).status(), 200);
  await page.waitForTimeout(5_000);
  const itemCall = calls.find(entry => entry.request.url().includes('/api/ctos/racks/customize'));
  assert(itemCall, 'Item Lock emitted no rack customize request.');
  const itemBody = itemCall.request.postDataJSON() as unknown;
  const lockedItem = object(array(firstRack(itemBody)['rackItems'])[0]);
  assert.equal(lockedItem['lock'], true, 'Item Lock request did not mark the physical item locked.');

  await closeCookie(page);
  const empties = page.locator('.rack-empty-unit:visible');
  await empties.last().waitFor({ state: 'visible', timeout: 20_000 });
  const emptyCount = await empties.count();
  assert(emptyCount > 0, 'Workspace exposed no empty U for space Lock.');
  // The first empty-unit node can geometrically overlap the U1 server after
  // DCSC re-renders the locked item. The topmost empty U is unobstructed.
  await empties.last().click({ force: true });
  await page.getByText('Lock', { exact: true }).last().waitFor({ state: 'visible', timeout: 10_000 });
  const beforeSpaceCalls = calls.length;
  const spacePending = page.waitForResponse(response => response.url().includes('/api/ctos/racks/customize') &&
    response.request().method() === 'POST', { timeout: 120_000 });
  await page.getByText('Lock', { exact: true }).last().click();
  assert.equal((await spacePending).status(), 200);
  await page.waitForTimeout(8_000);
  const spaceCall = calls.slice(beforeSpaceCalls).find(entry =>
    entry.request.url().includes('/api/ctos/racks/customize'));
  assert(spaceCall, 'Empty-U Lock emitted no rack customize request.');
  const spaceBody = spaceCall.request.postDataJSON() as unknown;
  const lockedRack = firstRack(spaceBody);
  assert(array(lockedRack['lockedSpace']).length > 0, 'Empty-U Lock request omitted lockedSpace.');
  assert.equal(object(array(lockedRack['rackItems'])[0])['lock'], true,
    'Empty-U Lock request lost the existing item lock.');

  // Isolate the reserved-U rule from the independent item lock. This direct
  // POST reuses the exact website customize envelope and context, explicitly
  // clears the source item lock, and requests U42 in the same payload.
  const conflictBody = structuredClone(spaceBody);
  const conflictRack = firstRack(conflictBody);
  const conflictItem = object(array(conflictRack['rackItems'])[0]);
  conflictItem['lock'] = false;
  conflictItem['position'] = 42;
  conflictItem['endPosition'] = 43;
  await writeFile(path.join(outDir, 'native-reserved-u-request.json'), JSON.stringify({
    url: spaceCall.request.url(), method: 'POST', body: conflictBody,
  }, null, 2));
  const conflictResponse = await page.request.fetch(spaceCall.request.url(), {
    method: 'POST', data: conflictBody, timeout: 120_000,
  });
  const conflictRaw = await conflictResponse.json() as unknown;
  await writeFile(path.join(outDir, 'native-reserved-u-response.json'), JSON.stringify({
    url: conflictResponse.url(), status: conflictResponse.status(), body: conflictRaw,
  }, null, 2));
  assert.equal(conflictResponse.status(), 200, 'Native reserved-U customize status.');
  const correctedRack = firstRack(conflictRaw);
  const correctedRackItem = array(correctedRack['rackItems']).map(object)
    .find(item => item['id'] === conflictItem['id']);
  const correctedLooseItem = array(object(conflictRaw)['nonRackArea']).map(object)
    .find(item => item['id'] === conflictItem['id']);
  assert.deepEqual(correctedRack['lockedSpace'], conflictRack['lockedSpace'],
    'Native reserved-U correction removed the reservation instead of rejecting placement.');
  assert.notEqual(correctedRackItem?.['position'], 42,
    'Native DCSC accepted an item in reserved U42.');
  assert(correctedRackItem || correctedLooseItem,
    'Native reserved-U response lost the attempted physical item.');

  const exported = await exportState(page, outDir);
  const workspace = object(exported['workspaceInformation']);
  const exportRack = object(array(workspace['rackData'])[0]);
  const result = {
    capturedAt: new Date().toISOString(), status: 'pass',
    itemLock: { requestRack: firstRack(itemBody) },
    spaceLock: { requestRack: lockedRack },
    reservedPlacement: {
      request: {
        lockedSpace: conflictRack['lockedSpace'],
        item: { id: conflictItem['id'], position: conflictItem['position'],
          endPosition: conflictItem['endPosition'], lock: conflictItem['lock'] },
      },
      response: {
        errors: object(conflictRaw)['errors'],
        rackErrors: correctedRack['errors'],
        lockedSpace: correctedRack['lockedSpace'],
        rackItem: correctedRackItem && {
          id: correctedRackItem['id'], position: correctedRackItem['position'],
          endPosition: correctedRackItem['endPosition'], lock: correctedRackItem['lock'],
          errors: correctedRackItem['errors'],
        },
        nonRackItem: correctedLooseItem && {
          id: correctedLooseItem['id'], position: correctedLooseItem['position'],
          endPosition: correctedLooseItem['endPosition'], lock: correctedLooseItem['lock'],
          errors: correctedLooseItem['errors'],
        },
      },
      rejectedOrCorrected: true,
      sourceWasUnlocked: true,
    },
    export: {
      rack: exportRack,
      configurationCount: array(exported['configurations']).length,
    },
    calls: calls.map(entry => entry.request.url()),
  };
  await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
