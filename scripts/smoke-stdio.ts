/** Offline startup check for a built checkout or an installed production package. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = mkdtempSync(join(tmpdir(), 'dcsc-stdio-check-'));
const serverPath = resolve(process.argv[2] ?? 'dist/mcp/server.js');
const config = join(root, 'config.json');
writeFileSync(config, JSON.stringify({ files: {
  persistSessions: false,
  sessionFile: join(root, 'sessions.json'),
  artifactDir: join(root, 'artifacts'),
} }));
const env = Object.fromEntries(Object.entries(process.env).filter(
  (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('DCSC_'),
));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: { ...env, DCSC_CONFIG: config, DCSC_LOG_LEVEL: 'error' },
  stderr: 'inherit',
});
const client = new Client({ name: 'distribution-smoke', version: '1.0.0' });
try {
  await client.connect(transport);
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    names.push(...page.tools.map(tool => tool.name));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(names).size, names.length, 'Tool names must be unique');
  assert(names.includes('dcsc_session_list') && names.includes('dcsc_search'));
  const response = await client.callTool({ name: 'dcsc_session_list', arguments: { view: 'health' } });
  assert(!response.isError, 'Offline health check failed');
  const content = response.content as Array<{ type: string; text?: string }>;
  const text = content.find(item => item.type === 'text')?.text;
  assert(text, 'Health check must return JSON text');
  const health = JSON.parse(text) as { openSessions: number; config: { files: { persistSessions: boolean } } };
  assert.equal(health.openSessions, 0);
  assert.equal(health.config.files.persistSessions, false);
  console.log(`Stdio startup, ${names.length} unique tools and isolated health check passed (no Lenovo requests).`);
} finally {
  await client.close();
  await transport.close();
  rmSync(root, { recursive: true, force: true });
}
