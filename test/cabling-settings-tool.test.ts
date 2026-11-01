import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';

it('exposes website auto-connect settings', async () => {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  try {
    const raw = { id: 'server', code: 'SERVER', quantity: 1, tabs: [] };
    const session = service.sessions.create({ locale: service.locale,
      solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] }, mode: 'cto', raw,
      configurationId: raw.id, reduced: reduceConfiguration(raw, raw.id), primed: true });
    const workspace = service.sessions.getWorkspace(session.id)!;
    workspace.nonRackArea = [{ id: raw.id, code: raw.code, type: 'server' }];
    let handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    registerTools({ registerTool(name: string, _definition: unknown, callback: typeof handler) {
      if (name === 'dcsc_auto_connect') handler = callback;
      return { remove() {}, update() {} };
    } } as unknown as McpServer, service);
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: { connections: [], errors: [] } } as never);
    const settings = { autoAddPDU: false, autoAddSwitch: true, p2pCabling: true };
    const result = await handler!({ session: workspace.id, settings });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ settings, connectionCount: 0 });
    expect(send.mock.calls[0]![0].body).toMatchObject({ kind: 'json', value: { autoConnectSettings: settings } });
    expect(send).toHaveBeenCalledTimes(1);
  } finally { await service.close(); }
});
