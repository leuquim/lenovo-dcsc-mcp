/**
 * Offline real-transport gate for bounded workspace inspection.
 *
 * Seeds an isolated durable workspace, starts the compiled MCP server over
 * stdio, follows lossless collection/string continuations, and verifies that
 * a workspace mutation invalidates continuations issued at an older revision.
 *
 * Run after `npm run build`:
 *   npx tsx scripts/parity-projections.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { reduceConfiguration } from '../src/domain/reduce.js';
import type { RawConfiguration } from '../src/model/types.js';
import { serializeWorkspaces } from '../src/session/persist.js';
import { SessionStore } from '../src/session/SessionStore.js';

type Json = Record<string, unknown>;
type Continuation = { tool: string; arguments: Json };

interface CallResult {
  json: Json;
  bytes: number;
  isError: boolean;
}

const MAX_RESPONSE_BYTES = 8_000;

function object(value: unknown): Json {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Json;
}

function array(value: unknown): unknown[] {
  assert(Array.isArray(value));
  return value;
}

function continuation(value: unknown): Continuation {
  const record = object(value);
  assert.equal(typeof record['tool'], 'string');
  return { tool: record['tool'] as string, arguments: object(record['arguments']) };
}

function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  const entries = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('DCSC_'),
  );
  return { ...Object.fromEntries(entries), ...extra };
}

function seed(sessionFile: string): { workspace: string; firstSession: string; longConnection: string; longWarning: string } {
  const store = new SessionStore(200);
  let workspaceId: string | undefined;
  let firstSession: string | undefined;
  for (let index = 0; index < 80; index += 1) {
    const configurationId = `US__projection-${index}`;
    const raw: RawConfiguration = {
      id: configurationId,
      code: `NODE-${index}`,
      sliceCtoCode: `NODE-${index}`,
      description: `Projection node ${index}`,
      type: 'SERVER',
      quantity: 1,
      totalPrice: 100 + index,
      tabs: [],
      selectedTopologies: { Management: {} },
      selectedStorageNetwork: 'SAN',
    };
    const session = store.create({
      locale: { geo: 'NA', country: 'US', language: 'en', currency: 'USD' },
      solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
      mode: 'cto', raw, configurationId, reduced: reduceConfiguration(raw, configurationId),
      primed: true, configurable: false,
      ...(workspaceId ? { workspaceId } : {}),
    });
    workspaceId ??= session.workspaceId;
    firstSession ??= session.id;
  }
  assert(workspaceId && firstSession);
  const workspace = store.getWorkspace(workspaceId);
  assert(workspace);
  workspace.rackSummaries = [{
    id: 'rack-1', code: 'RACK-42U', description: 'Projection rack', sizeU: 42,
    usedU: 1, freeU: 41, stableStatus: 'PASSED',
    items: [{ id: 'US__projection-0', code: 'NODE-0', description: 'Projection node 0', position: 1, endPosition: 1, sizeU: 1 }],
    errors: [{ code: 'INFO', message: 'Retained layout message' }],
  }];
  workspace.cables = Array.from({ length: 240 }, (_, index) => ({
    id: `cable-${index}`, fromConfigId: `US__projection-${index % 80}`, fromPort: `A${index}`,
    toConfigId: `US__projection-${(index + 1) % 80}`, toPort: `B${index}`, cableCode: 'DAC', description: `Cable ${index}`,
  }));
  const longConnection = 'transceiver-metadata-'.repeat(2_000);
  workspace.serverState['connections'] = [{
    network: 'Management',
    source: { configurationId: 'US__projection-0', port: 'A1' },
    destination: { configurationId: 'switch-0', port: 'B1' },
    cable: { code: 'DAC' }, transceiverDetails: longConnection,
  }];
  const longWarning = 'integrity-warning-'.repeat(2_000);
  workspace.integrityWarnings = [longWarning, ...Array.from({ length: 99 }, (_, index) => `warning-${index}`)];
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, serializeWorkspaces(store.listWorkspaces()));
  return { workspace: workspaceId, firstSession, longConnection, longWarning };
}

async function main(): Promise<void> {
  const runtime = mkdtempSync(path.join(tmpdir(), 'dcsc-projection-stdio-'));
  const sessionFile = path.join(runtime, 'state', 'sessions.json');
  const configFile = path.join(runtime, 'config.json');
  const seeded = seed(sessionFile);
  writeFileSync(configFile, JSON.stringify({
    logLevel: 'error',
    files: { persistSessions: true, sessionFile, artifactDir: path.join(runtime, 'artifacts') },
  }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/mcp/server.js'],
    cwd: process.cwd(),
    stderr: 'pipe',
    maxBufferSize: 12 * 1024 * 1024,
    env: cleanEnvironment({ DCSC_CONFIG: configFile, DCSC_LOG_LEVEL: 'error' }),
  });
  const client = new Client({ name: 'parity-projections', version: '1.0.0' });
  const calls: Array<{ tool: string; bytes: number; isError: boolean }> = [];
  const call = async (tool: string, args: Json, expectedError = false): Promise<CallResult> => {
    const response = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 30_000 });
    const content = (response as { content?: Array<{ type?: string; text?: string }>; isError?: boolean }).content ?? [];
    const text = content.find(item => item.type === 'text')?.text ?? '';
    const result = { json: object(JSON.parse(text) as unknown), bytes: Buffer.byteLength(text), isError: response.isError === true };
    calls.push({ tool, bytes: result.bytes, isError: result.isError });
    assert(result.bytes < MAX_RESPONSE_BYTES, `${tool} returned ${result.bytes} bytes`);
    assert.equal(result.isError, expectedError, `${tool} error state: ${text.slice(0, 300)}`);
    return result;
  };

  try {
    await client.connect(transport);
    const summary = (await call('dcsc_workspace_get', { session: seeded.workspace })).json;
    assert.equal(object(summary['totals'])['configurations'], 80);
    assert.equal(object(summary['totals'])['cables'], 240);
    assert.equal(object(summary['totals'])['rawConnections'], 1);
    const diagnosticsLink = continuation(object(object(summary['pages'])['cablingDiagnostics'])['inspect']);
    const diagnostics = (await call(diagnosticsLink.tool, diagnosticsLink.arguments)).json;
    const diagnosticItems = array(diagnostics['items']).map(object);
    assert.equal(object(diagnosticItems.find(item => item['key'] === 'requestedNetworksWithoutConnections'))['value'], 1);
    const networkItem = object(diagnosticItems.find(item => item['key'] === 'networks'));
    const networks = networkItem['next']
      ? (await call(continuation(networkItem['next']).tool, continuation(networkItem['next']).arguments)).json
      : networkItem['value'];
    assert.match(JSON.stringify(networks), /SAN/);
    assert.match(JSON.stringify(networks), /no_connections/);

    const configurationLink = continuation(object(object(summary['pages'])['configurations'])['inspect']);
    const configurationKeys: string[] = [];
    let configurationPage: Continuation | undefined = configurationLink;
    while (configurationPage) {
      const page: Json = (await call(configurationPage.tool, configurationPage.arguments)).json;
      configurationKeys.push(...array(page['items']).map(item => String(object(item)['key'])));
      configurationPage = page['next'] ? continuation(page['next']) : undefined;
    }
    assert.deepEqual(configurationKeys, Array.from({ length: 80 }, (_, index) => String(index)));

    const rawCollectionLink = continuation(object(object(summary['pages'])['rawConnections'])['inspect']);
    const rawCollection = (await call(rawCollectionLink.tool, rawCollectionLink.arguments)).json;
    const rawItemLink = continuation(object(array(rawCollection['items'])[0])['next']);
    const rawItem = (await call(rawItemLink.tool, rawItemLink.arguments)).json;
    const longField = object(array(rawItem['items']).find(item => object(item)['key'] === 'transceiverDetails'));
    let stringPage = continuation(longField['next']);
    let reconstructedConnection = '';
    for (;;) {
      const page = (await call(stringPage.tool, stringPage.arguments)).json;
      reconstructedConnection += String(page['text']);
      if (!page['next']) break;
      stringPage = continuation(page['next']);
    }
    assert.equal(reconstructedConnection, seeded.longConnection);

    const warningLink = continuation(object(object(summary['pages'])['integrityWarnings'])['inspect']);
    const warningCollection = (await call(warningLink.tool, warningLink.arguments)).json;
    const warningItemLink = continuation(object(array(warningCollection['items'])[0])['next']);
    let warningPage = warningItemLink;
    let reconstructedWarning = '';
    for (;;) {
      const page = (await call(warningPage.tool, warningPage.arguments)).json;
      reconstructedWarning += String(page['text']);
      if (!page['next']) break;
      warningPage = continuation(page['next']);
    }
    assert.equal(reconstructedWarning, seeded.longWarning);

    const layout = (await call('dcsc_workspace_get', { session: seeded.workspace, view: 'layout' })).json;
    const rack = object(array(layout['racks'])[0]);
    assert.equal(array(rack['items']).length, 1);
    assert.equal(array(rack['errors']).length, 1);

    const configInfo = (await call('dcsc_workspace_get', { session: seeded.firstSession })).json;
    await call('dcsc_configure', {
      session: seeded.firstSession, salesQuantity: 2, expectedRevision: configInfo['revision'],
    });
    const stale = await call(rawCollectionLink.tool, rawCollectionLink.arguments, true);
    assert.match(JSON.stringify(stale.json), /changed from revision/);

    process.stdout.write(`${JSON.stringify({
      status: 'pass', workspace: seeded.workspace, calls: calls.length,
      maxResponseBytes: Math.max(...calls.map(entry => entry.bytes)),
      configurationsEnumerated: configurationKeys.length,
      rawConnectionCharacters: reconstructedConnection.length,
      warningCharacters: reconstructedWarning.length,
      staleContinuationRejected: true,
      missingStorageNetworkReported: true,
    }, null, 2)}\n`);
  } finally {
    await client.close().catch(() => undefined);
    rmSync(runtime, { recursive: true, force: true });
  }
}

await main();
