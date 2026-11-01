/** Live real-MCP nested chassis lifecycle, durability, edit and history gate. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readJsonProjection } from './lib/read-json-projection.js';
import { inspectExportWorkbook } from './lib/xlsx-inspection.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Obj : {};
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((entry): entry is string => typeof entry === 'string') : [];

interface ExpectedHistoryAction {
  command: 'ADD' | 'UPDATE' | 'MOVE' | 'REMOVE' | 'CHANGE' | 'COPY' | 'CLONE' | 'UNCLONE' | 'IMPORT';
  code?: string;
  type?: string;
  location?: string;
  quantity?: number;
  descriptionIncludes?: string;
}

const historyValues = (saved: Obj): unknown[] => {
  const state = object(saved['serverState']);
  if (Array.isArray(state['historyInformation'])) return state['historyInformation'];
  const fallback = object(state['messageHistory'])['history'];
  return Array.isArray(fallback) ? fallback : [];
};

const historyRows = (saved: Obj): Obj[] => historyValues(saved)
  .filter((value): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value));

const stableHistoryRow = (row: Obj): Obj => ({
  timestamp: row['timestamp'], key: row['key'], command: row['command'],
  description: row['description'], sessionTimestamp: row['sessionTimestamp'],
});

const assertHistoryRow = (row: Obj, expected: ExpectedHistoryAction, label: string): void => {
  assert.equal(row['command'], expected.command, `${label} appended the wrong Message History command.`);
  assert.match(String(row['key'] ?? ''),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    `${label} Message History key is not a native UUID v4.`);
  assert.match(String(row['timestamp'] ?? ''), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/,
    `${label} Message History timestamp is not native-shaped.`);
  assert.match(String(row['sessionTimestamp'] ?? ''), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/,
    `${label} Message History session timestamp is not native-shaped.`);
  assert.equal(row['tooltip'], '', `${label} Message History tooltip differs from a newly generated native row.`);
  const description = String(row['description'] ?? '');
  const title = `${expected.command.charAt(0)}${expected.command.slice(1).toLowerCase()}`;
  const commandPrefix = expected.quantity === undefined
    ? `${title} :`
    : `${title} x${expected.quantity}:`;
  assert(description.startsWith(commandPrefix),
    `${label} Message History description does not match its command.`);
  if (expected.code) assert(description.includes(expected.code.toUpperCase()),
    `${label} Message History description omits ${expected.code}.`);
  if (expected.type) assert(description.includes(` ${expected.type} `),
    `${label} Message History description omits ${expected.type}.`);
  if (expected.descriptionIncludes) assert(description.includes(expected.descriptionIncludes),
    `${label} Message History description omits ${expected.descriptionIncludes}.`);
  if (expected.location) assert(description.endsWith(` at ${expected.location}`),
    `${label} Message History description has the wrong location: ${description}`);
};

const assertHistoryContains = (expected: Obj, actual: Obj, label: string): void => {
  const signature = (row: Obj): string => JSON.stringify(stableHistoryRow(row));
  const actualCounts = new Map<string, number>();
  for (const row of historyRows(actual)) {
    const value = signature(row);
    actualCounts.set(value, (actualCounts.get(value) ?? 0) + 1);
  }
  const expectedCounts = new Map<string, number>();
  for (const row of historyRows(expected)) {
    if (!String(row['key'] ?? '')) continue;
    const value = signature(row);
    expectedCounts.set(value, (expectedCounts.get(value) ?? 0) + 1);
  }
  for (const [value, count] of expectedCounts) {
    assert((actualCounts.get(value) ?? 0) >= count,
      `${label} lost or changed ${count} Message History row(s): ${value}`);
  }
};

async function main(): Promise<void> {
  const outArg = process.argv.find(value => value.startsWith('--out='));
  const out = path.resolve(outArg?.slice('--out='.length) ??
    `artifacts/parity-nested-stdio/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(out, { recursive: true });
  const configFile = path.join(out, 'config.json');
  const sessionFile = path.join(out, 'sessions.json');
  await writeFile(configFile, JSON.stringify({ logLevel: 'error', files: {
    persistSessions: true, sessionFile, artifactDir: path.join(out, 'exports'),
  }, pacing: { perToolRequestBudget: 100 } }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !entry[0].startsWith('DCSC_')));
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let stage = 'start';
  let sequence = 0;
  const calls: Obj[] = [];
  const historyEvidence: Obj[] = [];
  const nativeLooseXml = path.resolve('test/fixtures/parity/xml/nested-loose-browser.xml');
  const nativeRackedXml = path.resolve('test/fixtures/parity/xml/nested-racked-browser.xml');
  const nativeDetachedXml = path.resolve('test/fixtures/parity/xml/nested-detached-browser.xml');
  const start = async () => {
    transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/server.ts'], stderr: 'pipe',
      env: { ...env, DCSC_CONFIG: configFile } });
    client = new Client({ name: 'nested-parity', version: '1.0.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    for (const name of ['dcsc_launch', 'dcsc_add_rack', 'dcsc_place_in_rack', 'dcsc_edit_layout',
      'dcsc_workspace_history', 'dcsc_export', 'dcsc_import', 'dcsc_session_info']) {
      assert(tools.tools.some(tool => tool.name === name), `${name} is not registered.`);
    }
  };
  const call = async (name: string, args: Obj, expectError = false): Promise<Obj> => {
    const response = await client!.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
    const item = (response.content as Array<{ type: string; text?: string }>).find(entry => entry.type === 'text');
    const text = item?.text ?? '';
    const result = object(JSON.parse(text));
    const record = { name, arguments: args, isError: response.isError === true,
      bytes: Buffer.byteLength(text), result };
    calls.push(record);
    await writeFile(path.join(out, `${String(++sequence).padStart(3, '0')}-${name}.json`),
      JSON.stringify(record, null, 2));
    assert.equal(response.isError === true, expectError, `${name}: ${text}`);
    assert(record.bytes <= 8_000, `${name} exceeds the response budget.`);
    return result;
  };
  const snapshot = async (workspaceId?: string): Promise<Obj> => {
    const saved = object(JSON.parse(await readFile(sessionFile, 'utf8')));
    assert.equal(saved['version'], 2);
    const workspaces = rows(saved['workspaces']);
    const found = workspaceId === undefined ? workspaces[0] : workspaces.find(entry => entry['id'] === workspaceId);
    assert(found, `Persisted workspace ${workspaceId ?? '(first)'} was not found.`);
    return found;
  };
  const configBySession = (saved: Obj, session: string): Obj => {
    const found = rows(saved['configurations']).find(entry => entry['id'] === session);
    assert(found, `Persisted configuration ${session} was not found.`);
    return found;
  };
  const semanticState = (saved: Obj): Obj => ({
    configurations: rows(saved['configurations']).map(entry => ({
      id: entry['id'], configurationId: entry['configurationId'], raw: entry['raw'],
    })),
    rackArea: saved['rackArea'], nonRackArea: saved['nonRackArea'], floorItems: saved['floorItems'],
    cables: saved['cables'], powerSelections: saved['powerSelections'],
    cloneDependency: object(saved['serverState'])['cloneDependency'],
    cloneDependencyColor: object(saved['serverState'])['cloneDependencyColor'],
  });
  const assertAppendedHistory = (
    label: string,
    before: Obj | undefined,
    after: Obj,
    expected: ExpectedHistoryAction,
  ): Obj => {
    const prior = before ? historyValues(before) : [];
    const current = historyValues(after);
    assert.equal(current.length, prior.length + 1,
      `${label} did not append exactly one Message History row.`);
    assert.deepEqual(current.slice(0, prior.length), prior,
      `${label} rewrote prior Message History rows.`);
    const appended = object(current.at(-1));
    assertHistoryRow(appended, expected, label);
    historyEvidence.push({ label, ...stableHistoryRow(appended), tooltip: appended['tooltip'] });
    return appended;
  };
  const assertExactHistory = (saved: Obj, expected: readonly unknown[], label: string): void => {
    assert.deepEqual(historyValues(saved), expected, `${label} changed Message History rows.`);
  };
  const assertImportedHistory = (saved: Obj, filePath: string, label: string): Obj => {
    const imported = object(historyValues(saved).at(-1));
    assertHistoryRow(imported, { command: 'IMPORT' }, label);
    assert.equal(imported['description'], `Import : ${path.basename(filePath)}`,
      `${label} Message History does not identify its source file.`);
    assert.equal(object(saved['serverState'])['actionHistorySessionTimestamp'], imported['timestamp'],
      `${label} did not start a new durable Message History session.`);
    historyEvidence.push({ label, ...stableHistoryRow(imported), tooltip: imported['tooltip'] });
    return imported;
  };
  const assertHistoryWorkbook = async (exported: Obj, expected: readonly Obj[], label: string): Promise<Obj> => {
    const zipPath = String(exported['zipPath'] ?? '');
    assert(zipPath, `${label} export returned no ZIP path.`);
    const workbook = await inspectExportWorkbook(zipPath);
    const sheet = workbook.sheets['Message History'];
    assert(sheet, `${label} export has no Message History sheet.`);
    const values = sheet.rows.flatMap(row => row.values);
    const expectedDescriptions = new Map<string, number>();
    for (const row of expected) {
      const description = String(row['description']);
      expectedDescriptions.set(description, (expectedDescriptions.get(description) ?? 0) + 1);
    }
    for (const [description, count] of expectedDescriptions) {
      assert(values.filter(value => value === description).length >= count,
        `${label} Message History sheet omits ${count} occurrence(s) of ${description}.`);
    }
    return { sheet: sheet.name, populatedRows: sheet.rows.filter(row => row.values.length > 0).length,
      assertedRows: expected.length };
  };
  const physicalChildren = (item: Obj): Obj[] => [
    ...rows(item['rackItems']),
    ...rows(item['items']),
    ...rows(item['nodes']),
  ];
  const physicalIds = (value: unknown): string[] => {
    const found: string[] = [];
    const visit = (item: Obj): void => {
      if (typeof item['id'] === 'string') found.push(item['id']);
      for (const child of physicalChildren(item)) visit(child);
    };
    for (const item of rows(value)) visit(item);
    return found;
  };
  const assertNodePhysicalState = (saved: Obj, nodeId: string,
    expected: 'nested' | 'loose' | 'detached'): void => {
    const rackIds = physicalIds(saved['rackArea']);
    const looseIds = physicalIds(saved['nonRackArea']);
    assert.equal(rackIds.includes(nodeId), expected === 'nested',
      `Node ${nodeId} rack state is not ${expected}.`);
    assert.equal(looseIds.includes(nodeId), expected === 'loose',
      `Node ${nodeId} non-rack state is not ${expected}.`);
  };
  const expectedToolProjection = (saved: Obj): Obj => ({
    configurations: rows(saved['configurations']).map(item => ({
      id: item['id'], productCode: object(item['product'])['code'], quantity: object(item['raw'])['quantity'],
    })),
    rackArea: saved['rackArea'],
    nonRackArea: saved['nonRackArea'],
    cloneDependency: object(saved['serverState'])['cloneDependency'] ?? {},
    cloneDependencyColor: object(saved['serverState'])['cloneDependencyColor'] ?? {},
  });
  const toolProjection = async (workspaceId: string): Promise<Obj> => {
    const info = await call('dcsc_session_info', { session: workspaceId });
    const revision = Number(info['workspaceRevision']);
    assert(Number.isInteger(revision), `Workspace ${workspaceId} projection has no revision.`);
    const detail = (path: string[], type: 'object' | 'array') => readJsonProjection(call, {
      tool: 'dcsc_session_info', arguments: { session: workspaceId,
        expectedRevision: revision, path, offset: 0, limit: 50 },
    }, type);
    return {
      configurations: rows(info['configurations']).map(item => ({
        id: item['id'], productCode: item['productCode'], quantity: item['quantity'],
      })),
      rackArea: await detail(['rawRackArea'], 'array'),
      nonRackArea: await detail(['rawNonRackArea'], 'array'),
      cloneDependency: await detail(['cloneDependency'], 'object'),
      cloneDependencyColor: await detail(['cloneDependencyColor'], 'object'),
    };
  };
  const crashRestart = async (): Promise<void> => {
    assert(transport!.pid, 'MCP transport has no child pid.');
    process.kill(transport!.pid!, 'SIGKILL');
    await client!.close().catch(() => undefined);
    client = undefined;
    await start();
  };
  const verifyLooseImport = async (label: string, filePath: string): Promise<Obj> => {
    stage = `import-${label}`;
    const imported = await call('dcsc_import', { filePath, solutionMode: 'HPC and AI - Systems' });
    const importedWorkspace = String(imported['workspace']);
    assert(importedWorkspace && importedWorkspace !== 'undefined', `${label} import returned no workspace.`);
    const accepted = await snapshot(importedWorkspace);
    assertImportedHistory(accepted, filePath, `${label} import`);
    const chassis = rows(accepted['nonRackArea']).find(item => item['type'] === 'chassis');
    assert(chassis && rows(chassis['nodes']).length === 1,
      `${label} import did not hydrate the loose chassis -> node hierarchy.`);
    const childId = String(rows(chassis['nodes'])[0]?.['id']);
    assert(rows(accepted['configurations']).some(entry => entry['configurationId'] === childId),
      `${label} imported nested node has no configuration session.`);
    const acceptedProjection = expectedToolProjection(accepted);
    stage = `crash-after-${label}-import`;
    await crashRestart();
    const restoredProjection = await toolProjection(importedWorkspace);
    assert.deepEqual(restoredProjection, acceptedProjection,
      `${label} public workspace projection changed across SIGKILL/restart.`);
    assert.deepEqual(semanticState(await snapshot(importedWorkspace)), semanticState(accepted),
      `${label} import changed across SIGKILL/restart.`);
    assertExactHistory(await snapshot(importedWorkspace), historyValues(accepted),
      `${label} import immediate SIGKILL/restart`);
    stage = `export-${label}-import`;
    const exportedImport = await call('dcsc_export', { session: importedWorkspace,
      fileName: `nested-${label}-imported`, fileTypes: ['XML', 'QUOTE'] });
    assert((await readFile(String(exportedImport['xml']))).length > 0,
      `${label} imported workspace export XML is empty.`);
    return { workspace: importedWorkspace, chassisId: chassis['id'], childId, exportXml: exportedImport['xml'] };
  };
  const verifyNodeEditImport = async (label: string, filePath: string, nodeConfigurationId: string,
    expected: 'loose' | 'detached', expectedConfigurationCount: number): Promise<Obj> => {
    stage = `import-${label}`;
    const imported = await call('dcsc_import', { filePath, solutionMode: 'HPC and AI - Systems' });
    const importedWorkspace = String(imported['workspace']);
    assert(importedWorkspace && importedWorkspace !== 'undefined', `${label} import returned no workspace.`);
    const accepted = await snapshot(importedWorkspace);
    assertImportedHistory(accepted, filePath, `${label} import`);
    assert.equal(rows(accepted['configurations']).length, expectedConfigurationCount,
      `${label} import restored an unexpected number of editable configurations.`);
    assert.equal(rows(accepted['configurations']).some(entry => entry['configurationId'] === nodeConfigurationId),
      expected === 'loose', expected === 'loose'
        ? `${label} import lost the loose node configuration.`
        : `${label} import unexpectedly restored the website-detached configuration.`);
    assertNodePhysicalState(accepted, nodeConfigurationId, expected);
    const acceptedDependencies = object(object(accepted['serverState'])['cloneDependency']);
    const acceptedColors = object(object(accepted['serverState'])['cloneDependencyColor']);
    assert.equal(Object.hasOwn(acceptedColors, nodeConfigurationId), expected === 'loose',
      `${label} clone color does not match its ${expected} physical state.`);
    if (Object.hasOwn(acceptedDependencies, nodeConfigurationId)) {
      assert(strings(acceptedDependencies[nodeConfigurationId]).includes(nodeConfigurationId),
        `${label} imported a malformed clone dependency for its node.`);
    }
    const acceptedProjection = expectedToolProjection(accepted);
    stage = `crash-after-${label}-import`;
    await crashRestart();
    assert.deepEqual(await toolProjection(importedWorkspace), acceptedProjection,
      `${label} public workspace projection changed across SIGKILL/restart.`);
    assert.deepEqual(semanticState(await snapshot(importedWorkspace)), semanticState(accepted),
      `${label} import changed across SIGKILL/restart.`);
    assertExactHistory(await snapshot(importedWorkspace), historyValues(accepted),
      `${label} import immediate SIGKILL/restart`);
    stage = `export-${label}-import`;
    const exportedImport = await call('dcsc_export', { session: importedWorkspace,
      fileName: `nested-${label}-imported`, fileTypes: ['XML', 'QUOTE'] });
    assert((await readFile(String(exportedImport['xml']))).length > 0,
      `${label} imported workspace export XML is empty.`);
    return { workspace: importedWorkspace, exportXml: exportedImport['xml'] };
  };
  const verifyParentRemoval = async (contents: 'delete' | 'unplace'): Promise<Obj> => {
    const label = `parent-remove-${contents}`;
    stage = `import-${label}`;
    const imported = await call('dcsc_import', { filePath: nativeRackedXml,
      solutionMode: 'HPC and AI - Systems' });
    const importedWorkspace = String(imported['workspace']);
    const before = await snapshot(importedWorkspace);
    assertImportedHistory(before, nativeRackedXml, `${label} import`);
    const rack = rows(before['rackArea'])[0];
    const chassis = rows(rack?.['rackItems']).find(item => item['type'] === 'chassis');
    assert(chassis, `${label} fixture has no racked chassis.`);
    const child = rows(chassis['nodes'])[0];
    assert(child, `${label} fixture has no nested node.`);
    const chassisId = String(chassis['id']);
    const childId = String(child['id']);
    const beforeIds = rows(before['configurations']).map(entry => String(entry['configurationId']));
    assert(beforeIds.includes(chassisId) && beforeIds.includes(childId),
      `${label} fixture configurations do not cover its physical hierarchy.`);
    const beforeDependencies = object(object(before['serverState'])['cloneDependency']);
    const beforeColors = object(object(before['serverState'])['cloneDependencyColor']);
    stage = label;
    await call('dcsc_edit_layout', { session: importedWorkspace, action: 'remove',
      configuration: chassisId, contents });
    stage = `crash-after-${label}`;
    await crashRestart();
    const accepted = await snapshot(importedWorkspace);
    const afterIds = rows(accepted['configurations']).map(entry => String(entry['configurationId']));
    assert(!afterIds.includes(chassisId), `${label} retained the removed chassis configuration.`);
    assert.equal(afterIds.includes(childId), contents === 'unplace',
      `${label} child configuration disposition does not match the explicit contents policy.`);
    assert(!physicalIds(accepted['rackArea']).includes(chassisId), `${label} retained the physical chassis.`);
    assertNodePhysicalState(accepted, childId, contents === 'unplace' ? 'loose' : 'detached');
    const dependencies = object(object(accepted['serverState'])['cloneDependency']);
    const colors = object(object(accepted['serverState'])['cloneDependencyColor']);
    const removedDependencyIds = new Set(contents === 'delete' ? [chassisId, childId] : [chassisId]);
    const retainedDependencyIds = (value: Obj) => Object.keys(value)
      .filter(id => !removedDependencyIds.has(id)).sort();
    assert.deepEqual(Object.keys(dependencies).sort(), retainedDependencyIds(beforeDependencies),
      `${label} clone dependency disposition differs from the imported seed.`);
    assert.deepEqual(Object.keys(colors).sort(), retainedDependencyIds(beforeColors),
      `${label} clone color disposition differs from the imported seed.`);
    assertAppendedHistory(label, before, accepted,
      { command: 'REMOVE', type: 'Chassis', code: '7DD0CTOLWW' });
    const acceptedHistory = structuredClone(historyValues(accepted));
    const acceptedProjection = expectedToolProjection(accepted);
    assert.deepEqual(await toolProjection(importedWorkspace), acceptedProjection,
      `${label} public projection changed after immediate SIGKILL/restart.`);
    stage = `undo-${label}`;
    await call('dcsc_workspace_history', { session: importedWorkspace, action: 'undo' });
    const restored = await snapshot(importedWorkspace);
    assert(physicalIds(restored['rackArea']).includes(chassisId) &&
      physicalIds(restored['rackArea']).includes(childId), `${label} undo did not restore the nested hierarchy.`);
    assertExactHistory(restored, historyValues(before), `${label} undo`);
    stage = `redo-${label}`;
    await call('dcsc_workspace_history', { session: importedWorkspace, action: 'redo' });
    const redone = await snapshot(importedWorkspace);
    assert.deepEqual(semanticState(redone), semanticState(accepted),
      `${label} redo did not restore the accepted removal state.`);
    assertExactHistory(redone, acceptedHistory, `${label} redo`);
    stage = `export-${label}`;
    const exported = await call('dcsc_export', { session: importedWorkspace,
      fileName: `nested-${label}`, fileTypes: ['XML', 'QUOTE', 'MESSAGE_HISTORY'] });
    assert((await readFile(String(exported['xml']))).length > 0, `${label} export XML is empty.`);
    const workbook = await assertHistoryWorkbook(exported, historyRows(accepted), label);
    stage = `reimport-${label}`;
    const reimported = await call('dcsc_import', { filePath: String(exported['xml']),
      solutionMode: 'HPC and AI - Systems' });
    const reimportedWorkspace = String(reimported['workspace']);
    const roundTrip = await snapshot(reimportedWorkspace);
    const roundTripIds = rows(roundTrip['configurations']).map(entry => String(entry['configurationId']));
    assert.equal(roundTripIds.length, contents === 'unplace' ? 3 : 2,
      `${label} export/reimport restored an unexpected configuration count.`);
    assert(!roundTripIds.includes(chassisId), `${label} export/reimport restored the deleted chassis.`);
    assert.equal(roundTripIds.includes(childId), contents === 'unplace',
      `${label} export/reimport child disposition does not match its explicit contents policy.`);
    assert(!physicalIds(roundTrip['rackArea']).includes(chassisId),
      `${label} export/reimport restored the physical chassis.`);
    assertNodePhysicalState(roundTrip, childId, contents === 'unplace' ? 'loose' : 'detached');
    assertHistoryContains(accepted, roundTrip, `${label} CFXML reimport`);
    return { workspace: importedWorkspace, chassisId, childId, exportXml: exported['xml'],
      reimportedWorkspace, reimportedConfigurations: roundTripIds.length, workbook };
  };
  try {
    await start();
    stage = 'launch-chassis';
    const chassis = await call('dcsc_launch', { productCode: '7DD0CTOLWW', mode: 'cto',
      solutionMode: 'HPC and AI - Systems' });
    const workspace = String(chassis['workspace']);
    const chassisSession = String(chassis['session']);
    const afterChassisLaunch = await snapshot(workspace);
    const chassisId = String(configBySession(afterChassisLaunch, chassisSession)['configurationId']);
    assertAppendedHistory('launch-chassis', undefined, afterChassisLaunch,
      { command: 'ADD', type: 'Chassis', code: '7DD0CTOLWW', location: 'Non Rack Area' });
    stage = 'launch-node';
    const node = await call('dcsc_launch', { productCode: '7DD1CTOLWW', mode: 'cto',
      solutionMode: 'HPC and AI - Systems', workspace });
    const nodeSession = String(node['session']);
    const afterNodeLaunch = await snapshot(workspace);
    const nodeId = String(configBySession(afterNodeLaunch, nodeSession)['configurationId']);
    assertAppendedHistory('launch-node', afterChassisLaunch, afterNodeLaunch,
      { command: 'ADD', type: 'Node', code: '7DD1CTOLWW', location: 'Non Rack Area' });
    stage = 'add-rack';
    const added = await call('dcsc_add_rack', { session: workspace, rackCode: '7D6DCTO1WW' });
    const rackId = String(rows(added['racks'])[0]?.['rackId']);
    assert(rackId && rackId !== 'undefined', 'dcsc_add_rack returned no rack identity.');
    const beforePlacement = await snapshot(workspace);
    assertAppendedHistory('add-rack', afterNodeLaunch, beforePlacement,
      { command: 'ADD', type: 'Rack', code: '7D6DCTO1WW', location: 'Rack Area' });
    stage = 'place-chassis';
    await call('dcsc_place_in_rack', { session: workspace, rackId, configuration: chassisSession });
    const afterChassisPlacement = await snapshot(workspace);
    assertAppendedHistory('place-chassis', beforePlacement, afterChassisPlacement,
      { command: 'MOVE', type: 'Chassis', code: '7DD0CTOLWW' });
    stage = 'copy-node';
    const placed = await call('dcsc_place_in_rack', { session: workspace, rackId,
      chassisId, configuration: nodeSession });
    const nested = object(placed['nestedPlacement']);
    const copySession = String(nested['session']);
    const copyId = String(nested['nodeId']);
    assert.equal(nested['chassisId'], chassisId);
    const accepted = await snapshot(workspace);
    assert.equal(configBySession(accepted, copySession)['configurationId'], copyId);
    assert.deepEqual(object(object(accepted['serverState'])['cloneDependency'])[copyId], [copyId]);
    assertAppendedHistory('copy-node', afterChassisPlacement, accepted,
      { command: 'COPY', quantity: 1, type: 'Node', code: '7DD1CTOLWW',
        descriptionIncludes: 'ThinkSystem SD535 V3', location: 'Chassis' });
    const acceptedProjection = expectedToolProjection(accepted);
    const acceptedHistory = structuredClone(historyValues(accepted));

    stage = 'crash-after-copy';
    await crashRestart();
    assert.deepEqual(await snapshot(workspace), accepted, 'Acknowledged nested copy did not survive SIGKILL/restart.');
    assertExactHistory(await snapshot(workspace), acceptedHistory,
      'Nested-copy immediate SIGKILL/restart');
    assert.deepEqual(await toolProjection(workspace), acceptedProjection,
      'Acknowledged nested copy public projection changed after SIGKILL/restart.');

    stage = 'independent-copy-edit';
    const options = await call('dcsc_list_options', { session: copySession, query: 'processor', limit: 100 });
    const choice = rows(options['options']).find(option => option['selected'] !== true && option['sectionId'] && option['code']);
    assert(choice, 'No alternate processor option was available for the copied node.');
    const beforeEdit = await snapshot(workspace);
    const sourceBefore = structuredClone(object(configBySession(beforeEdit, nodeSession)['raw']));
    await call('dcsc_configure', { session: copySession,
      changes: [{ section: choice['sectionId'], code: choice['code'], quantity: 1 }] });
    const afterEdit = await snapshot(workspace);
    assert.deepEqual(object(configBySession(afterEdit, nodeSession)['raw']), sourceBefore,
      'Editing the copied nested node changed its loose source configuration.');
    assert.notDeepEqual(object(configBySession(afterEdit, copySession)['raw']),
      object(configBySession(beforeEdit, copySession)['raw']), 'Copied-node edit produced no configuration change.');
    assertAppendedHistory('independent-copy-edit', beforeEdit, afterEdit,
      { command: 'UPDATE', type: 'Node', code: '7DD1CTOLWW' });

    stage = 'unplace-chassis';
    await call('dcsc_edit_layout', { session: workspace, action: 'unplace', configuration: chassisId });
    const unplaced = await snapshot(workspace);
    const looseChassis = rows(unplaced['nonRackArea']).find(item => item['id'] === chassisId);
    assert(looseChassis && rows(looseChassis['nodes']).some(item => item['id'] === copyId),
      'Unplacing the chassis did not retain its nested copied node.');
    assertAppendedHistory('unplace-chassis', afterEdit, unplaced,
      { command: 'MOVE', type: 'Chassis', code: '7DD0CTOLWW', location: 'Non Rack Area' });
    const unplacedHistory = structuredClone(historyValues(unplaced));
    stage = 'undo-unplace';
    await call('dcsc_workspace_history', { session: workspace, action: 'undo' });
    const restoredPlacement = await snapshot(workspace);
    assert(JSON.stringify(restoredPlacement['rackArea']).includes(copyId), 'Undo did not restore the nested rack placement.');
    assertExactHistory(restoredPlacement, historyValues(afterEdit),
      'Undo unplace-chassis');
    stage = 'redo-unplace';
    await call('dcsc_workspace_history', { session: workspace, action: 'redo' });
    const redoneUnplaced = await snapshot(workspace);
    assert.deepEqual(semanticState(redoneUnplaced), semanticState(unplaced),
      'Redo did not restore the complete unplaced chassis state.');
    assertExactHistory(redoneUnplaced, unplacedHistory, 'Redo unplace-chassis');
    stage = 'export-unplaced-chassis';
    const unplacedExport = await call('dcsc_export', { session: workspace, fileName: 'nested-stdio-unplaced',
      fileTypes: ['XML', 'QUOTE', 'MESSAGE_HISTORY'] });
    assert((await readFile(String(unplacedExport['xml']))).length > 0,
      'Unplaced nested chassis export XML is empty.');
    const unplacedWorkbook = await assertHistoryWorkbook(unplacedExport, historyRows(unplaced),
      'Unplaced nested chassis');
    stage = 'replace-chassis';
    await call('dcsc_edit_layout', { session: workspace, action: 'move', configuration: chassisId, rackId });
    const replaced = await snapshot(workspace);
    assert(JSON.stringify(replaced['rackArea']).includes(copyId), 'Re-placing the chassis lost its nested node.');
    assertAppendedHistory('replace-chassis', unplaced, replaced,
      { command: 'MOVE', type: 'Chassis', code: '7DD0CTOLWW' });
    const replacedHistory = structuredClone(historyValues(replaced));

    stage = 'detach-node';
    await call('dcsc_edit_layout', { session: workspace, action: 'detach', configuration: copyId });
    stage = 'crash-after-detach-node';
    await crashRestart();
    const detached = await snapshot(workspace);
    assert.equal(rows(detached['configurations']).length, rows(replaced['configurations']).length,
      'Native-style Delete Node removed the retained commercial configuration.');
    assertNodePhysicalState(detached, copyId, 'detached');
    assert(!Object.hasOwn(object(object(detached['serverState'])['cloneDependency']), copyId),
      'Native-style Delete Node retained the detached node clone dependency.');
    assert(!Object.hasOwn(object(object(detached['serverState'])['cloneDependencyColor']), copyId),
      'Native-style Delete Node retained the detached node clone color.');
    assertAppendedHistory('detach-node', replaced, detached,
      { command: 'REMOVE', type: 'Node', code: '7DD1CTOLWW', location: 'Chassis' });
    const detachedHistory = structuredClone(historyValues(detached));
    const detachedProjection = expectedToolProjection(detached);
    assert.deepEqual(await toolProjection(workspace), detachedProjection,
      'Detached-node public projection changed after immediate SIGKILL/restart.');
    assertExactHistory(await snapshot(workspace), detachedHistory,
      'Detached-node immediate SIGKILL/restart');
    stage = 'undo-detach-node';
    await call('dcsc_workspace_history', { session: workspace, action: 'undo' });
    const undoDetached = await snapshot(workspace);
    assertNodePhysicalState(undoDetached, copyId, 'nested');
    assertExactHistory(undoDetached, replacedHistory, 'Undo detach-node');
    stage = 'redo-detach-node';
    await call('dcsc_workspace_history', { session: workspace, action: 'redo' });
    const redoDetached = await snapshot(workspace);
    assert.deepEqual(semanticState(redoDetached), semanticState(detached),
      'Redo did not restore the complete detached-node state.');
    assertExactHistory(redoDetached, detachedHistory, 'Redo detach-node');
    stage = 'export-detached-node';
    const detachedExport = await call('dcsc_export', { session: workspace,
      fileName: 'nested-stdio-detached-node', fileTypes: ['XML', 'QUOTE', 'MESSAGE_HISTORY'] });
    assert((await readFile(String(detachedExport['xml']))).length > 0,
      'Detached-node export XML is empty.');
    const detachedWorkbook = await assertHistoryWorkbook(detachedExport, historyRows(detached),
      'Detached nested node');
    assert.equal(detachedExport['detachedNodesDroppedOnReimport'], 1,
      'Detached-node export did not disclose its one-node Lenovo reimport loss.');
    assert.match(String(detachedExport['reimportWarning'] ?? ''), /Lenovo reimport drops physically detached nodes/,
      'Detached-node export did not return its actionable reimport warning.');
    const detachedImport = await verifyNodeEditImport('detached-node', String(detachedExport['xml']),
      copyId, 'detached', 3);
    assertHistoryContains(detached, await snapshot(String(detachedImport['workspace'])),
      'Detached-node CFXML reimport');
    const nativeDetachedImport = await verifyNodeEditImport('native-detached-node', nativeDetachedXml,
      'US__-b01d-4208-99bc-55c8cc5464cf1000', 'detached', 3);

    stage = 'restore-before-unplace-node';
    await call('dcsc_workspace_history', { session: workspace, action: 'undo' });
    const restoredBeforeUnplaceNode = await snapshot(workspace);
    assertNodePhysicalState(restoredBeforeUnplaceNode, copyId, 'nested');
    assertExactHistory(restoredBeforeUnplaceNode, replacedHistory,
      'Restore before unplace-node');
    stage = 'unplace-node';
    await call('dcsc_edit_layout', { session: workspace, action: 'unplace', configuration: copyId });
    stage = 'crash-after-unplace-node';
    await crashRestart();
    const looseNode = await snapshot(workspace);
    assert.equal(rows(looseNode['configurations']).length, rows(replaced['configurations']).length,
      'Move Node To Non Rack removed the retained commercial configuration.');
    assertNodePhysicalState(looseNode, copyId, 'loose');
    assert(Object.hasOwn(object(object(looseNode['serverState'])['cloneDependency']), copyId),
      'Move Node To Non Rack dropped the loose node clone dependency.');
    assert(Object.hasOwn(object(object(looseNode['serverState'])['cloneDependencyColor']), copyId),
      'Move Node To Non Rack dropped the loose node clone color.');
    assertAppendedHistory('unplace-node', restoredBeforeUnplaceNode, looseNode,
      { command: 'MOVE', type: 'Node', code: '7DD1CTOLWW', location: 'Non Rack Area' });
    const looseNodeHistory = structuredClone(historyValues(looseNode));
    const looseNodeProjection = expectedToolProjection(looseNode);
    assert.deepEqual(await toolProjection(workspace), looseNodeProjection,
      'Loose-node public projection changed after immediate SIGKILL/restart.');
    assertExactHistory(await snapshot(workspace), looseNodeHistory,
      'Loose-node immediate SIGKILL/restart');
    stage = 'undo-unplace-node';
    await call('dcsc_workspace_history', { session: workspace, action: 'undo' });
    const undoLooseNode = await snapshot(workspace);
    assertNodePhysicalState(undoLooseNode, copyId, 'nested');
    assertExactHistory(undoLooseNode, replacedHistory, 'Undo unplace-node');
    stage = 'redo-unplace-node';
    await call('dcsc_workspace_history', { session: workspace, action: 'redo' });
    const redoLooseNode = await snapshot(workspace);
    assert.deepEqual(semanticState(redoLooseNode), semanticState(looseNode),
      'Redo did not restore the complete loose-node state.');
    assertExactHistory(redoLooseNode, looseNodeHistory, 'Redo unplace-node');
    stage = 'export-unplaced-node';
    const looseNodeExport = await call('dcsc_export', { session: workspace,
      fileName: 'nested-stdio-unplaced-node', fileTypes: ['XML', 'QUOTE', 'MESSAGE_HISTORY'] });
    assert((await readFile(String(looseNodeExport['xml']))).length > 0,
      'Loose-node export XML is empty.');
    const looseNodeWorkbook = await assertHistoryWorkbook(looseNodeExport, historyRows(looseNode),
      'Loose nested node');
    const looseNodeImport = await verifyNodeEditImport('loose-node', String(looseNodeExport['xml']),
      copyId, 'loose', 4);
    assertHistoryContains(looseNode, await snapshot(String(looseNodeImport['workspace'])),
      'Loose-node CFXML reimport');

    stage = 'restore-final-nested-state';
    await call('dcsc_workspace_history', { session: workspace, action: 'undo' });
    const restoredFinal = await snapshot(workspace);
    assertNodePhysicalState(restoredFinal, copyId, 'nested');
    assertExactHistory(restoredFinal, replacedHistory, 'Final undo branch');

    stage = 'export';
    const exported = await call('dcsc_export', { session: workspace, fileName: 'nested-stdio',
      fileTypes: ['XML', 'QUOTE', 'MESSAGE_HISTORY'] });
    assert((await readFile(String(exported['xml']))).length > 0, 'Nested stdio export XML is empty.');
    const finalWorkbook = await assertHistoryWorkbook(exported, historyRows(restoredFinal),
      'Final nested workspace');
    stage = 'final-crash-restart';
    const finalState = await snapshot(workspace);
    const finalProjection = expectedToolProjection(finalState);
    await crashRestart();
    assert.deepEqual(await snapshot(workspace), finalState,
      'Final edited nested state did not survive SIGKILL/restart.');
    assertExactHistory(await snapshot(workspace), historyValues(finalState),
      'Final immediate SIGKILL/restart');
    assert.deepEqual(await toolProjection(workspace), finalProjection,
      'Final edited nested public projection changed after SIGKILL/restart.');
    const nativeImport = await verifyLooseImport('native-loose', nativeLooseXml);
    const mcpImport = await verifyLooseImport('mcp-loose', String(unplacedExport['xml']));
    assertHistoryContains(unplaced, await snapshot(String(mcpImport['workspace'])),
      'Unplaced-chassis CFXML reimport');
    const parentDelete = await verifyParentRemoval('delete');
    const parentUnplace = await verifyParentRemoval('unplace');
    const report = { status: 'pass', scope: 'live-real-stdio-nested-copy-edit-history-crash-restart',
      workspace, rackId, chassisId, sourceNodeId: nodeId, copyId, copySession,
      processorEdit: { sectionId: choice['sectionId'], code: choice['code'] },
      unplacedExportXml: unplacedExport['xml'], exportXml: exported['xml'],
      nodeEdits: {
        detached: { exportXml: detachedExport['xml'], import: detachedImport,
          nativeImport: nativeDetachedImport,
          importLimitation: 'Native and MCP detached-node XML retain four commercial lines, but Lenovo reimport restores three editable configurations and drops the detached line; dcsc_export reports this loss.' },
        unplaced: { exportXml: looseNodeExport['xml'], import: looseNodeImport },
      },
      parentRemoval: { delete: parentDelete, unplace: parentUnplace },
      history: { appendedRows: historyEvidence, workbooks: { unplaced: unplacedWorkbook,
        detached: detachedWorkbook, looseNode: looseNodeWorkbook, final: finalWorkbook },
        persistence: 'exact across immediate SIGKILL/restart and workspace undo/redo',
        cfxml: 'stable native fields retained by export/reimport; empty tooltip may be omitted by Lenovo import' },
      imports: { native: nativeImport, mcp: mcpImport }, calls: calls.length };
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await writeFile(path.join(out, 'report.json'), JSON.stringify({ status: 'fail', stage,
      error: error instanceof Error ? error.stack : String(error), calls: calls.length }, null, 2));
    throw error;
  } finally {
    await client?.close();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
