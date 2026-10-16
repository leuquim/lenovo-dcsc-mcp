import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';

it('exposes the workspace revision separately when a single configuration has a different revision', async () => {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false } }));
  try {
    const raw = { id: 'revision-test', sliceCtoCode: 'SERVER', quantity: 1, totalPrice: 100, tabs: [] };
    const session = service.sessions.create({ locale: service.locale,
      solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] }, mode: 'cto', raw,
      configurationId: raw.id, reduced: reduceConfiguration(raw, raw.id), primed: true });
    const workspace = service.sessions.getWorkspace(session.id)!;
    await service.sessions.transact(workspace.id, {}, draft => { draft.label = 'Workspace-only edit'; });
    expect(workspace.revision).not.toBe(session.revision);
    let handler: ((args: { session: string }) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    registerTools({ registerTool(name: string, _definition: unknown, callback: typeof handler) {
      if (name === 'dcsc_session_info') handler = callback;
      return { remove() {}, update() {} };
    } } as unknown as McpServer, service);
    for (const target of [workspace.id, session.id]) {
      const reply = await handler!({ session: target });
      expect(JSON.parse(reply.content[0]!.text)).toMatchObject({
        session: session.id, revision: session.revision, revisionScope: 'configuration',
        workspace: workspace.id, workspaceRevision: workspace.revision,
      });
    }
  } finally { await service.close(); }
});
