import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import { registerRecoveryTools } from '../src/mcp/recoveryTools.js';
import type { RawConfiguration } from '../src/model/types.js';

type ToolReply = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean | undefined;
};
type ToolHandler = (args: { session: string }) => Promise<ToolReply>;

const roots: string[] = [];
const services: DcscService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('dcsc_recovery_export', () => {
  it('exports only the requested workspace with lossless recovery and integrity data', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dcsc-recovery-tool-'));
    roots.push(root);
    const service = new DcscService(
      ConfigSchema.parse({
        logLevel: 'error',
        files: {
          persistSessions: false,
          artifactDir: join(root, 'artifacts'),
          maxDownloadBytes: 1024 * 1024,
        },
      }),
    );
    services.push(service);
    const requested = addConfiguration(service, 'US__recovery_requested', {
      originalServerField: { nested: ['kept', 42] },
    });
    const other = addConfiguration(service, 'US__recovery_other', { secretFromOther: true });
    const workspace = service.sessions.getWorkspace(requested.id)!;
    workspace.integrity = 'damaged';
    workspace.integrityWarnings = ['Original configuration record could not be normalized.'];
    workspace.recoveryData = [
      { originalRecord: { id: '', raw: null, opaqueVendorField: { keep: true } } },
    ];

    const handler = registeredHandler(service);
    const reply = await handler({ session: requested.id });
    expect(reply.isError).not.toBe(true);
    const result = parse(reply);
    expect(result).toMatchObject({
      session: workspace.id,
      integrity: 'damaged',
      integrityWarnings: workspace.integrityWarnings,
      recoveryRecords: 1,
      format: 'lenovo-dcsc-session-snapshot-v2',
      warning: expect.stringMatching(/not CFXML.*not a quote or validation/i),
    });
    const path = String(result.path);
    expect(resolve(path).startsWith(resolve(join(root, 'artifacts')) + sep)).toBe(true);
    const json = readFileSync(path, 'utf8');
    expect(result.bytes).toBe(Buffer.byteLength(json));
    expect(result.sha256).toBe(createHash('sha256').update(json).digest('hex'));

    const snapshot = JSON.parse(json) as {
      version: number;
      workspaces: Array<Record<string, unknown> & { configurations: Array<{ raw: RawConfiguration }> }>;
    };
    expect(snapshot.version).toBe(2);
    expect(snapshot.workspaces).toHaveLength(1);
    expect(snapshot.workspaces[0]?.id).toBe(workspace.id);
    expect(snapshot.workspaces[0]?.id).not.toBe(other.workspaceId);
    expect(snapshot.workspaces[0]?.integrity).toBe('damaged');
    expect(snapshot.workspaces[0]?.integrityWarnings).toEqual(workspace.integrityWarnings);
    expect(snapshot.workspaces[0]?.recoveryData).toEqual(workspace.recoveryData);
    expect(snapshot.workspaces[0]?.configurations[0]?.raw).toMatchObject({
      originalServerField: { nested: ['kept', 42] },
    });
    expect(json).not.toContain('secretFromOther');
  });

  it('returns a tool error for an unknown handle without creating an artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dcsc-recovery-tool-missing-'));
    roots.push(root);
    const service = new DcscService(
      ConfigSchema.parse({
        logLevel: 'error',
        files: { persistSessions: false, artifactDir: join(root, 'artifacts') },
      }),
    );
    services.push(service);

    const reply = await registeredHandler(service)({ session: 'missing' });
    expect(reply.isError).toBe(true);
    expect(reply.content[0]?.text).toMatch(/not found/i);
  });
});

function addConfiguration(
  service: DcscService,
  configurationId: string,
  extra: Record<string, unknown>,
) {
  const raw: RawConfiguration = {
    id: configurationId,
    sliceCtoCode: '7D73CTO1WW',
    description: configurationId,
    type: 'SERVER',
    quantity: 1,
    totalPrice: 100,
    tabs: [],
    ...extra,
  };
  return service.sessions.create({
    locale: service.locale,
    solution: { solutionMode: 'General Purpose', masterSlices: ['ISG'] },
    mode: 'cto',
    raw,
    configurationId,
    reduced: reduceConfiguration(raw, configurationId),
    primed: true,
  });
}

function registeredHandler(service: DcscService): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    registerTool(_name: string, _config: unknown, candidate: ToolHandler) {
      handler = candidate;
      return { remove() {}, update() {} };
    },
  };
  registerRecoveryTools(server as unknown as McpServer, service);
  if (!handler) throw new Error('Recovery tool was not registered');
  return handler;
}

function parse(reply: ToolReply): Record<string, unknown> {
  return JSON.parse(reply.content[0]?.text ?? '{}') as Record<string, unknown>;
}
