/** Maintained MCP/browser differential for Distributed main/leaf Management cabling. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Page } from 'playwright';

import { buildAutoConnectRequest, readAutoConnectSettings, readConnectionGraph,
  readSwitchMap } from '../src/domain/cabling.js';
import { buildFloorState } from '../src/domain/floorWire.js';
import { buildRackCustomizePayload } from '../src/domain/rack.js';
import type { ConfigSession, WorkspaceSession } from '../src/model/session.js';
import { readJsonProjection } from './lib/read-json-projection.js';

type Obj = Record<string, unknown>;

const ROOT = process.cwd();
const SOURCE_XML = path.resolve('test/fixtures/parity/xml/manual-cabling-shared-network.xml');
const ORACLE_PATH = path.resolve('test/fixtures/parity/network-leaf-auto-connect.json');
const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Obj : {};
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];
const string = (value: unknown): string => value === undefined || value === null ? '' : String(value);

async function closeCookie(page: Page): Promise<void> {
  const close = page.locator('.dcsc-cookie-close').first();
  if (await close.isVisible({ timeout: 2_000 }).catch(() => false)) await close.click();
}

async function importXml(page: Page, xmlPath: string): Promise<Obj> {
  await page.goto('https://dcsc.lenovo.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await closeCookie(page);
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: 'attached', timeout: 30_000 });
  const pending = page.waitForResponse(response => response.url().includes('/multiple/cfxml_import') &&
    response.request().method() === 'POST', { timeout: 180_000 });
  await input.setInputFiles(xmlPath);
  const response = await pending;
  const text = await response.text();
  assert.equal(response.status(), 200, `Fresh-browser leaf CFXML import failed: ${text.slice(0, 500)}`);
  await page.waitForURL(/#\/(?:rack-summary|summary)\//, { timeout: 120_000 });
  const parsed = JSON.parse(text) as unknown;
  return object(Array.isArray(parsed) ? parsed[0] : parsed);
}

function connectionGraph(value: Obj): Obj[] {
  const networking = object(value['networkingInformation']);
  const workspace = object(value['workspace']);
  for (const candidate of [value['connections'], value['autoConnectResults'], networking['autoConnectResults'],
    networking['connections'], workspace['connections']]) {
    if (Array.isArray(candidate)) return rows(candidate);
  }
  return [];
}

function switchMap(value: Obj): Obj[] {
  const networking = object(value['networkingInformation']);
  const workspace = object(value['workspace']);
  for (const candidate of [value['switchMap'], networking['switchMap'], workspace['switchMap']]) {
    if (Array.isArray(candidate)) return rows(candidate);
  }
  return [];
}

function roleFor(id: string, location: string, switches: Obj[]): string {
  const mapped = switches.find(entry => string(entry['id']) === id);
  if (mapped) return string(mapped['type']);
  const unit = /\/U(\d+)/.exec(location)?.[1];
  return unit ? `server@U${unit}` : `server:${id}`;
}

function normalizedConnections(connections: Obj[], switches: Obj[]): Obj[] {
  return connections.map(connection => ({
    sourceRole: roleFor(string(connection['sourceId']), string(connection['sourceLocation']), switches),
    destinationRole: roleFor(string(connection['destinationId']), string(connection['destinationLocation']), switches),
    sourcePortNumber: string(connection['sourcePortNumber']),
    destinationPortNumber: string(connection['destinationPortNumber']),
    cablePart: string(connection['cablePart']),
    cableOption: string(connection['cableOption']),
    totalDistance: connection['totalDistance'],
  })).sort((left, right) => string(left['sourceRole']).localeCompare(string(right['sourceRole'])));
}

function workspaceSnapshot(payload: Obj): Obj {
  const workspace = rows(payload['workspaces'])[0];
  assert(workspace, 'Persisted state contains no workspace.');
  return workspace;
}

function revision(result: Obj): number {
  const value = Number(result['workspaceRevision'] ?? result['revision']);
  assert(Number.isInteger(value) && value > 0, 'Tool response contains no workspace revision.');
  return value;
}

/** Reproduce DcscService.#cablingPayload from the durable pre-auto-connect state. */
function autoConnectPayload(snapshot: Obj): Obj {
  const workspace = structuredClone(snapshot) as unknown as WorkspaceSession;
  workspace.configurations = new Map(rows(snapshot['configurations']).map(configuration =>
    [string(configuration['id']), configuration as unknown as ConfigSession]));
  workspace.racks = new Map();
  const floor = buildFloorState(workspace);
  const state = object(workspace.serverState);
  const previous = object(state['autoConnectState']);
  const networking = object(state['networkingInformation']);
  const retained: Obj = {
    controllerExpansionMap: {}, clusterPreference: [], powerPreference: [], storageConnectionNetworks: [],
    cloneRackMapping: {}, connections: [], autoConnectSettings: {}, switchMap: [],
    virtualContainerIdMapping: {}, virtualContainerRule2ConfigMapping: {},
    virtualContainerInvalidRuleIdMapping: {}, vlhItems: [],
    cloneDependency: Object.fromEntries([...workspace.configurations.values()]
      .map(configuration => [configuration.configurationId, [configuration.configurationId]])),
  };
  for (const key of Object.keys(retained)) {
    const value = state[key] ?? previous[key] ?? networking[key];
    if (value !== undefined) retained[key] = structuredClone(value);
  }
  if (state['storageConnectionNetworks'] === undefined && networking['storageNetworks'] !== undefined) {
    retained['storageConnectionNetworks'] = structuredClone(networking['storageNetworks']);
  }
  retained['connections'] = readConnectionGraph(state);
  retained['switchMap'] = readSwitchMap(state);
  retained['autoConnectSettings'] = readAutoConnectSettings(state);
  return buildAutoConnectRequest(buildRackCustomizePayload({
    ...retained, floorItems: floor.items, floorPreference: floor.information['floorPreference'],
    rackArea: workspace.rackArea, nonRackArea: workspace.nonRackArea,
  }, [...workspace.configurations.values()].map(configuration => configuration.raw)));
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out');
  const outDir = path.resolve(outIndex >= 0 ? process.argv[outIndex + 1]! :
    `artifacts/parity-network-leaf/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(outDir, { recursive: true });
  const configFile = path.join(outDir, 'config.json');
  const sessionFile = path.join(outDir, 'sessions.json');
  await writeFile(configFile, JSON.stringify({ logLevel: 'error', files: {
    persistSessions: true, sessionFile, artifactDir: path.join(outDir, 'exports'),
  } }));
  const oracle = object(JSON.parse(await readFile(ORACLE_PATH, 'utf8')) as unknown);
  const expectedConnections = rows(oracle['connections'])
    .sort((left, right) => string(left['sourceRole']).localeCompare(string(right['sourceRole'])));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !entry[0].startsWith('DCSC_')));
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let stage = 'start';
  let sequence = 0;
  const calls: Obj[] = [];
  const start = async () => {
    transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/server.ts'], stderr: 'pipe',
      env: { ...env, DCSC_CONFIG: configFile } });
    client = new Client({ name: 'network-leaf-parity', version: '1.0.0' });
    await client.connect(transport);
    const listed = await client.listTools();
    for (const name of ['dcsc_import', 'dcsc_fabric_options', 'dcsc_set_network_preferences',
      'dcsc_add_cabling', 'dcsc_workspace_layout', 'dcsc_export']) {
      assert(listed.tools.some(tool => tool.name === name), `${name} is not registered.`);
    }
  };
  const call = async (name: string, args: Obj): Promise<Obj> => {
    const response = await client!.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
    const content = (response.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text')?.text ?? '';
    const result = object(JSON.parse(content));
    const entry = { name, arguments: args, isError: response.isError === true,
      bytes: Buffer.byteLength(content), result };
    calls.push(entry);
    await writeFile(path.join(outDir, `${String(++sequence).padStart(3, '0')}-${name}.json`),
      JSON.stringify(entry, null, 2));
    assert.notEqual(response.isError, true, `${name}: ${content}`);
    assert(Buffer.byteLength(content) <= 8_000, `${name} exceeded the 8 KB response budget.`);
    return result;
  };
  const enumerateFabric = async (args: Obj): Promise<Obj[]> => {
    const items: Obj[] = [];
    let next: Obj | undefined = args;
    while (next) {
      const page = await call('dcsc_fabric_options', next);
      const returned = rows(page['items']);
      assert(returned.length > 0 || Number(page['total']) === 0,
        `Fabric continuation for ${String(args['collection'])} made no progress.`);
      items.push(...returned);
      const continuation = object(page['next']);
      next = Object.keys(continuation).length > 0 ? object(continuation['arguments']) : undefined;
    }
    return items;
  };
  const persisted = async (): Promise<Obj> => object(JSON.parse(await readFile(sessionFile, 'utf8')) as unknown);

  try {
    await start();
    stage = 'import-native-seed';
    const imported = await call('dcsc_import', { filePath: SOURCE_XML, solutionMode: 'HPC and AI - Systems' });
    const workspaceId = string(imported['workspace']);
    assert(workspaceId, 'Import returned no workspace.');
    let state = workspaceSnapshot(await persisted());
    let expectedRevision = Number(state['revision']);

    stage = 'discover-fabric';
    const networks = await enumerateFabric({ session: workspaceId,
      collection: 'networkTypes', offset: 0, limit: 100 });
    const devices = await enumerateFabric({ session: workspaceId,
      collection: 'networkDevices', offset: 0, limit: 100 });
    const cables = await enumerateFabric({ session: workspaceId,
      collection: 'cables', offset: 0, limit: 100 });
    const policies = await enumerateFabric({ session: workspaceId,
      collection: 'leafNodeCabling', offset: 0, limit: 20 });
    const management = networks.find(item => item['name'] === 'Management');
    const bpc7 = devices.find(item => item['feature'] === 'BPC7' && item['option'] === '7D5FCTOFWW');
    const cat5e = cables.find(item => item['featureCode'] === '3791' &&
      Array.isArray(item['compatibility']) && item['compatibility'].includes('7D5FCTOFWW')) ??
      cables.find(item => item['featureCode'] === '3791');
    const balanced = policies.find(item => item['description'] ===
      'Balance Connections across leaf switches (best performance)');
    assert(management && bpc7 && cat5e && balanced,
      'Current fabric lacks the captured Management/BPC7/Cat5E/leaf policy choices.');

    stage = 'preference-close';
    const changed = await call('dcsc_set_network_preferences', { session: workspaceId,
      expectedRevision, autoConnect: false, selections: [{ networkTypeId: management['id'],
        layout: 'Distributed', mainDeviceId: bpc7['id'], leafDeviceId: bpc7['id'],
        cableId: cat5e['id'], cableColor: '', leafCableColor: '',
        mainTrunks: 1, leafTrunks: 1, leafCabling: balanced['description'] }] });
    expectedRevision = revision(changed);
    assert.equal(changed['connectionGraphStale'], true);
    assert.equal(changed['autoConnectRequired'], true);
    state = workspaceSnapshot(await persisted());
    await writeFile(path.join(outDir, 'sessions-after-preference-close.json'),
      JSON.stringify(await persisted(), null, 2));
    await writeFile(path.join(outDir, 'mcp-auto-connect-request.json'),
      JSON.stringify(autoConnectPayload(state), null, 2));
    const configsAfterClose = rows(state['configurations']);
    assert.equal(configsAfterClose.length, 6, 'Preference Close must preserve five imported configurations and add one leaf.');
    const preferences = rows(object(state['serverState'])['clusterPreference']);
    const managementPreference = preferences.find(item => item['name'] === 'Management');
    assert(managementPreference, 'Accepted workspace lost its Management preference.');
    assert.deepEqual({
      name: managementPreference['name'],
      networkType: managementPreference['networkType'],
      networkLayout: managementPreference['networkLayout'],
      mainSwitch: {
        feature: object(managementPreference['mainSwitch'])['feature'],
        option: object(managementPreference['mainSwitch'])['option'],
      },
      leafSwitch: {
        feature: object(managementPreference['leafSwitch'])['feature'],
        option: object(managementPreference['leafSwitch'])['option'],
      },
      trunks: managementPreference['trunks'],
      leafTrunks: managementPreference['leafTrunks'],
      leafCabling: managementPreference['leafCabling'],
    }, oracle['preference']);

    stage = 'p2p-auto-connect';
    const connected = await call('dcsc_add_cabling', { session: workspaceId, mode: 'auto', expectedRevision,
      settings: object(oracle['settings'])['final'] });
    expectedRevision = revision(connected);
    state = workspaceSnapshot(await persisted());
    const serverState = object(state['serverState']);
    const switches = rows(serverState['switchMap']);
    const graph = rows(serverState['connections']);
    assert.deepEqual(switches.map(({ id: _id, ...entry }) => entry)
      .sort((left, right) => string(left['type']).localeCompare(string(right['type']))),
    rows(oracle['switchMap']).sort((left, right) => string(left['type']).localeCompare(string(right['type']))));
    assert.deepEqual(normalizedConnections(graph, switches), expectedConnections);

    stage = 'sigkill-restart';
    const accepted = await persisted();
    assert(transport?.pid, 'MCP transport has no child PID.');
    process.kill(transport.pid, 'SIGKILL');
    await client!.close();
    client = undefined;
    transport = undefined;
    await start();
    assert.deepEqual(await persisted(), accepted, 'Leaf preferences or graph changed across immediate SIGKILL/restart.');
    const restartedLayout = await call('dcsc_workspace_layout', { session: workspaceId });
    assert.equal(object(restartedLayout['totals'])['rawConnections'], expectedConnections.length,
      'Restarted workspace projection did not retain the accepted connection count.');
    assert.notEqual(restartedLayout['connectionGraphStale'], true,
      'Restarted workspace incorrectly marked the accepted graph stale.');
    const rawConnectionInspect = object(object(object(restartedLayout['pages'])['rawConnections'])['inspect']);
    const restartedGraph = rows(await readJsonProjection(call, {
      tool: string(rawConnectionInspect['tool']), arguments: object(rawConnectionInspect['arguments']),
    }, 'array'));
    assert.deepEqual(normalizedConnections(restartedGraph, switches), expectedConnections,
      'Restarted MCP layout projection changed the accepted Distributed leaf graph.');

    stage = 'export';
    const exported = await call('dcsc_export', { session: workspaceId, fileName: 'network-leaf-parity',
      fileTypes: ['XML', 'QUOTE', 'FLOOR'] });
    const xmlPath = string(exported['xml']);
    assert(xmlPath && (await readFile(xmlPath)).length > 0, 'Leaf export returned no XML.');

    stage = 'fresh-browser-import';
    const browser = await chromium.launch({ headless: true });
    let browserImport: Obj;
    try {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      browserImport = await importXml(page, xmlPath);
      await writeFile(path.join(outDir, 'browser-import-response.json'), JSON.stringify(browserImport, null, 2));
      await context.close();
    } finally {
      await browser.close();
    }
    const importedGraph = connectionGraph(browserImport);
    const importedSwitches = switchMap(browserImport);
    assert.deepEqual(normalizedConnections(importedGraph, importedSwitches), expectedConnections,
      'Fresh browser import changed the Distributed leaf graph.');
    const configurations = rows(browserImport['configuration']).length > 0
      ? rows(browserImport['configuration']) : rows(browserImport['configurations']);
    assert.equal(configurations.length, 6, 'Fresh browser import changed the leaf workspace configuration count.');

    const result = {
      capturedAt: new Date().toISOString(),
      status: 'pass',
      scope: 'distributed-main-leaf-preference-close-graph-crash-export-fresh-import',
      browserOracle: path.relative(ROOT, ORACLE_PATH),
      workspace: workspaceId,
      revision: expectedRevision,
      preference: oracle['preference'],
      switchMap: switches,
      connections: normalizedConnections(graph, switches),
      exportXml: xmlPath,
      freshBrowser: { configurationCount: configurations.length,
        connections: normalizedConnections(importedGraph, importedSwitches) },
      restartedProjection: { connectionCount: restartedGraph.length,
        connections: normalizedConnections(restartedGraph, switches) },
      calls: calls.length,
    };
    await writeFile(path.join(outDir, 'report.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await writeFile(path.join(outDir, 'report.json'), JSON.stringify({ capturedAt: new Date().toISOString(),
      status: 'fail', stage, error: error instanceof Error ? error.message : String(error), calls: calls.length }, null, 2));
    throw error;
  } finally {
    await client?.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
