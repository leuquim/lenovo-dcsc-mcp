import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { isolatedChildEnv } from '../lib/isolated-runtime.js';

export type Json = Record<string, unknown>;
export interface CallRecord { tool: string; args: Json; isError: boolean; bytes: number; elapsedMs: number; result: Json }
export interface CallOptions { expectError?: boolean; timeoutMs?: number }

export const RESPONSE_BUDGET_BYTES = 8_000;
const DEFAULT_TIMEOUT_MS = 180_000;
const SERVER_ENTRY = path.resolve('dist/mcp/server.js');

export async function startMcp(outDir: string) {
  assert(existsSync(SERVER_ENTRY), 'dist/mcp/server.js is missing; run npm run build first.');
  const env = isolatedChildEnv({ DCSC_LOG_LEVEL: 'error' }, true);
  const { files } = JSON.parse(readFileSync(env['DCSC_CONFIG']!, 'utf8')) as
    { files: { sessionFile: string; artifactDir: string } };
  const calls: CallRecord[] = [];
  let client: Client;
  let transport: StdioClientTransport;

  const start = async () => {
    transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], stderr: 'pipe', env });
    client = new Client({ name: 'dcsc-parity', version: '1.0.0' });
    await client.connect(transport);
  };
  await start();

  return {
    calls,
    sessionFile: files.sessionFile,
    artifactDir: files.artifactDir,
    async call(tool: string, args: Json, options: CallOptions = {}): Promise<Json> {
      const started = Date.now();
      const response = await client.callTool({ name: tool, arguments: args }, undefined,
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
      assert(transport.pid, 'MCP server has no pid to kill.');
      process.kill(transport.pid, 'SIGKILL');
      await client.close().catch(() => undefined);
      await start();
    },
    async close(): Promise<void> {
      await client.close().catch(() => undefined);
    },
  };
}
export type Mcp = Awaited<ReturnType<typeof startMcp>>;
