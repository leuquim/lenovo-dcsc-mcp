import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';
import {
  listSessionRecoveryArchives,
  saveSessions,
  workspaceFile,
} from '../src/session/persist.js';

type Reply = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;
const roots: string[] = [];
const services: DcscService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function setup(bytes: Buffer, maxDownloadBytes = 1024 * 1024) {
  const root = mkdtempSync(join(tmpdir(), 'dcsc-archive-tools-'));
  roots.push(root);
  const sessionFile = join(root, 'sessions.json');
  const config = ConfigSchema.parse({ logLevel: 'error', files: {
    persistSessions: true, sessionFile, artifactDir: join(root, 'artifacts'), maxDownloadBytes,
  } });
  mkdirSync(dirname(workspaceFile(config, 'ws_corrupt')), { recursive: true });
  writeFileSync(workspaceFile(config, 'ws_corrupt'), bytes);
  const service = new DcscService(config);
  services.push(service);
  service.sessions.listWorkspaces();
  const handlers = new Map<string, Handler>();
  registerTools({ registerTool(name: string, _config: unknown, handler: Handler) {
    handlers.set(name, handler);
    return { remove() {}, update() {} };
  } } as unknown as McpServer, service);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await handlers.get(name)!(args);
    return { ...reply, json: JSON.parse(reply.content[0]!.text) as Record<string, unknown> };
  };
  return { service, config, call };
}

describe('recovery tools for unreadable session sources', () => {
  it('discovers and exports corrupt source bytes before and after a later valid save', async () => {
    const original = Buffer.concat([Buffer.from('{"version":2,"workspaces":['), Buffer.from([0xff, 0x00])]);
    const { service, config, call } = setup(original);
    expect(service.sessions.listWorkspaces()).toEqual([]);
    const health = await call('dcsc_session_list', { view: 'health' });
    expect(health.json.recovery).toMatchObject({ warningCount: expect.any(Number), archiveCount: 1,
      inspect: { tool: 'dcsc_session_list' } });
    const inspection = await call('dcsc_session_list', { view: 'recovery', path: [], offset: 0, limit: 20 });
    expect(inspection.isError).not.toBe(true);
    expect(inspection.json.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'warnings' }), expect.objectContaining({ key: 'recoveryArchives' }),
    ]));
    const archive = listSessionRecoveryArchives(config)[0]!;
    const exported = await call('dcsc_recovery_export', { archiveId: archive.id });
    expect(exported.isError).not.toBe(true);
    expect(exported.json).toMatchObject({ format: 'lenovo-dcsc-session-source-bytes', bytes: original.length,
      sha256: createHash('sha256').update(original).digest('hex') });
    expect(readFileSync(String(exported.json.path))).toEqual(original);

    saveSessions(service.sessions, config);
    const restarted = new DcscService(config);
    services.push(restarted);
    expect(restarted.sessions.lastRestoreReport.recoveryArchives.map(item => item.id)).toContain(archive.id);
    const again = await call('dcsc_recovery_export', { archiveId: archive.id });
    expect(readFileSync(String(again.json.path))).toEqual(original);
  });

  it('pages large quarantined records with executable continuations', async () => {
    const { service, call } = setup(Buffer.from('invalid JSON'));
    service.sessions.recordRestoreDiagnostics({ quarantined: [{ payload: 'x'.repeat(20_000) }] });
    const position = String(service.sessions.lastRestoreReport.quarantined.length - 1);
    const reply = await call('dcsc_session_list', { view: 'recovery', path: ['quarantined', position], offset: 0, limit: 20 });
    expect(reply.isError).not.toBe(true);
    expect(Buffer.byteLength(reply.content[0]!.text)).toBeLessThan(8000);
    const item = (reply.json.items as Array<{ next: { tool: string; arguments: Record<string, unknown> } }>)[0]!;
    expect(item.next.arguments.limit).toBe(1000);
    let continuation: typeof item.next | undefined = item.next;
    let reconstructed = '';
    while (continuation) {
      const expanded = await call(continuation.tool, continuation.arguments);
      expect(expanded.isError).not.toBe(true);
      expect(Buffer.byteLength(expanded.content[0]!.text)).toBeLessThan(8000);
      expect(expanded.json.total).toBe(20_000);
      reconstructed += String(expanded.json.text);
      continuation = expanded.json.next as typeof continuation;
    }
    expect(reconstructed).toBe('x'.repeat(20_000));
  });

  it('rejects ambiguous sources, path traversal and oversized archive exports', async () => {
    const { config, call } = setup(Buffer.from('not valid JSON and longer than eight bytes'), 8);
    for (const args of [{}, { archiveId: '../sessions.json' }, { session: 'x', archiveId: listSessionRecoveryArchives(config)[0]!.id }]) {
      expect((await call('dcsc_recovery_export', args)).isError).toBe(true);
    }
    const reply = await call('dcsc_recovery_export', { archiveId: listSessionRecoveryArchives(config)[0]!.id });
    expect(reply.isError).toBe(true);
    expect(reply.content[0]!.text).toMatch(/limit|exceed/i);
  });
});
