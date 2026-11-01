import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { loadConfig } from '../../src/config/load.js';
import { ConfigSchema } from '../../src/config/schema.js';
import type { SendInput } from '../../src/http/request.js';
import { DcscService } from '../../src/mcp/service.js';
import { registerTools } from '../../src/mcp/tools.js';
import { loadSessions, serializeWorkspaces } from '../../src/session/persist.js';
import { SessionStore } from '../../src/session/SessionStore.js';
import { isolatedChildEnv } from '../lib/isolated-runtime.js';

export type Json = Record<string, unknown>;
export interface CallRecord { tool: string; args: Json; isError: boolean; bytes: number; elapsedMs: number; result: Json }
export type McpMode = 'stdio' | 'in-process';
/** One DcscHttpClient.send input and the upstream outcome, recorded in in-process mode only. */
export interface WireRequest {
  endpoint: string; method: string; path: string; query?: SendInput['query']; body?: SendInput['body'];
  status?: number; error?: string;
}
interface Connection { client: Client; crash(): Promise<void>; close(): Promise<void> }
export interface CallOptions { expectError?: boolean; timeoutMs?: number }

export const RESPONSE_BUDGET_BYTES = 8_000;
const DEFAULT_TIMEOUT_MS = 180_000;
const SERVER_ENTRY = path.resolve('dist/mcp/server.js');

const connectStdio = (env: Record<string, string>) => async (): Promise<Connection> => {
  assert(existsSync(SERVER_ENTRY), 'dist/mcp/server.js is missing; run npm run build first.');
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], stderr: 'pipe', env });
  const client = new Client({ name: 'dcsc-parity', version: '1.0.0' });
  await client.connect(transport);
  return {
    client,
    async crash() {
      assert(transport.pid, 'MCP server has no pid to kill.');
      process.kill(transport.pid, 'SIGKILL');
      await client.close().catch(() => undefined);
    },
    close: () => client.close().catch(() => undefined),
  };
};

/** Runs the server in this process over the same state dir; a crash drops the service without close(). */
const connectInProcess = (files: { sessionFile: string; artifactDir: string }, requests: WireRequest[]) =>
  async (): Promise<Connection> => {
    const config = loadConfig({ logLevel: 'error', files: { persistSessions: true, ...files } });
    const service = new DcscService(config);
    const send = service.http.send.bind(service.http) as (input: SendInput) => ReturnType<typeof service.http.send>;
    service.http.send = (async (input: SendInput) => {
      const record: WireRequest = { endpoint: input.endpoint, method: input.method, path: input.path };
      if (input.query !== undefined) record.query = structuredClone(input.query);
      if (input.body !== undefined) record.body = structuredClone(input.body);
      requests.push(record);
      try {
        const response = await send(input);
        record.status = response.status;
        return response;
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }) as typeof service.http.send;
    const server = new McpServer({ name: 'lenovo-dcsc', version: '0.1.0' });
    registerTools(server, service);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'dcsc-parity', version: '1.0.0' });
    await client.connect(clientTransport);
    const dropTransports = async () => { await client.close().catch(() => undefined); await server.close().catch(() => undefined); };
    return {
      client,
      crash: dropTransports,
      async close() { await dropTransports(); await service.close(); },
    };
  };

export async function startMcp(outDir: string, mode: McpMode = 'stdio') {
  const env = isolatedChildEnv({ DCSC_LOG_LEVEL: 'error' }, true);
  const { files } = JSON.parse(readFileSync(env['DCSC_CONFIG']!, 'utf8')) as
    { files: { sessionFile: string; artifactDir: string } };
  const calls: CallRecord[] = [];
  const requests: WireRequest[] = [];
  const connect = mode === 'stdio' ? connectStdio(env) : connectInProcess(files, requests);
  let connection = await connect();

  return {
    calls,
    requests,
    mode,
    sessionFile: files.sessionFile,
    /** Reads what the server persisted through the project's own loader, independent of the on-disk layout. */
    persistedWorkspaces(): Json[] {
      const config = ConfigSchema.parse({ logLevel: 'error', files: { persistSessions: true, sessionFile: files.sessionFile } });
      const store = new SessionStore();
      loadSessions(store, config);
      return (JSON.parse(serializeWorkspaces(store.listWorkspaces())) as { workspaces: Json[] }).workspaces;
    },
    artifactDir: files.artifactDir,
    async call(tool: string, args: Json, options: CallOptions = {}): Promise<Json> {
      const started = Date.now();
      const response = await connection.client.callTool({ name: tool, arguments: args }, undefined,
        { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
      const text = (response.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text')?.text ?? '';
      let result: Json;
      try {
        const parsed: unknown = JSON.parse(text);
        result = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : { value: parsed };
      } catch { result = { error: text }; }
      const isError = response.isError === true;
      const bytes = Buffer.byteLength(text);
      calls.push({ tool, args, isError, bytes, elapsedMs: Date.now() - started, result });
      await writeFile(path.join(outDir, 'calls.json'), JSON.stringify(calls, null, 2));
      assert.equal(isError, options.expectError === true, `${tool}: unexpected isError=${isError}: ${text.slice(0, 2_000)}`);
      assert(bytes <= RESPONSE_BUDGET_BYTES, `${tool} returned ${bytes} bytes, over the ${RESPONSE_BUDGET_BYTES} byte budget.`);
      return result;
    },
    async killAndRestart(): Promise<void> {
      await connection.crash();
      connection = await connect();
    },
    async close(): Promise<void> {
      await connection.close();
    },
  };
}
export type Mcp = Awaited<ReturnType<typeof startMcp>>;
