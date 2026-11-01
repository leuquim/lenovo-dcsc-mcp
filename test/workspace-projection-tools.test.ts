import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';
import type { RawConfiguration } from '../src/model/types.js';

type Reply = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;
type Continuation = { tool: string; arguments: Record<string, unknown> };

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

function setup() {
  const service = new DcscService(ConfigSchema.parse({
    files: { persistSessions: false }, logLevel: 'silent',
  }));
  services.push(service);
  const raw: RawConfiguration = {
    id: 'US__node-1', code: 'NODE', sliceCtoCode: 'NODE', quantity: 2, totalPrice: 100, tabs: [],
  };
  const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
  const session = service.sessions.create({
    locale: service.locale, solution, mode: 'cto', raw,
    configurationId: raw.id!, reduced: reduceConfiguration(raw, raw.id!), primed: true,
  });
  const workspace = service.sessions.getWorkspace(session.id)!;
  const handlers = new Map<string, Handler>();
  registerTools({
    registerTool(name: string, _definition: unknown, handler: Handler) {
      handlers.set(name, handler);
      return { remove() {}, update() {} };
    },
  } as unknown as McpServer, service);
  return { service, session, workspace, handlers };
}

function json(reply: Reply): Record<string, unknown> {
  return JSON.parse(reply.content[0]!.text) as Record<string, unknown>;
}

describe('registered bounded workspace readers', () => {
  it('keeps a small layout complete and rejects a continuation after its workspace changes', async () => {
    const { service, session, workspace, handlers } = setup();
    workspace.rackSummaries = [{
      id: 'rack-1', code: 'RACK', description: '42U rack', sizeU: 42, usedU: 1, freeU: 41,
      stableStatus: 'PASSED', items: [{
        id: session.configurationId, code: 'NODE', description: 'Node', position: 1, endPosition: 1, sizeU: 1,
      }], errors: [{ code: 'INFO', message: 'Retained server message' }],
    }];
    workspace.serverState['connections'] = [{
      source: { id: session.configurationId, port: 'A1' },
      destination: { id: 'switch-1', port: 'B1' },
      transceivers: [{ code: 'OPTIC' }],
    }];

    const handler = handlers.get('dcsc_workspace_get')!;
    const summaryReply = await handler({ session: workspace.id, view: 'layout' });
    expect(summaryReply.isError).not.toBe(true);
    const summary = json(summaryReply);
    expect(Buffer.byteLength(summaryReply.content[0]!.text)).toBeLessThan(7_500);
    expect((summary['racks'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      itemCount: 1, itemsReturned: 1, itemsComplete: true,
      errorCount: 1, errorsReturned: 1, errorsComplete: true,
    });

    const rawLink = ((summary['pages'] as Record<string, { inspect: Continuation }>)['rawConnections']!).inspect;
    expect(rawLink).toMatchObject({
      tool: 'dcsc_workspace_get',
      arguments: { session: workspace.id, expectedRevision: workspace.revision, path: ['rawConnections'] },
    });
    const rawPage = json(await handler(rawLink.arguments));
    expect(rawPage).toMatchObject({ path: ['rawConnections'], total: 1, returned: 1 });

    await service.sessions.transact(workspace.id, {}, draft => { draft.label = 'changed'; });
    const stale = await handler(rawLink.arguments);
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toContain('changed from revision');
    expect(stale.content[0]!.text).toContain('Restart dcsc_workspace_get');

    const unbound = await handler({ session: workspace.id, path: ['cables'], offset: 0, limit: 20 });
    expect(unbound.isError).toBe(true);
    expect(unbound.content[0]!.text).toContain('expectedRevision is required');
  });

  it('includes independent software in a mixed workspace total and pages every cable', async () => {
    const { workspace, handlers } = setup();
    workspace.serverState['standaloneSoftwareState'] = {
      kind: 'standalone-software', selections: [{
        id: 'sw-1', kind: 'software', code: 'SOFTWARE', quantity: 1, unitPrice: 40, totalPrice: 40,
        feature: { description: 'Software', raw: { retained: true } },
      }],
    };
    workspace.cables = Array.from({ length: 83 }, (_, index) => ({
      id: `cable-${index}`, fromConfigId: 'US__node-1', fromPort: `A${index}`,
      toConfigId: 'switch-1', toPort: `B${index}`, description: `Cable ${index}`,
    }));

    const handler = handlers.get('dcsc_workspace_get')!;
    const summaryReply = await handler({ session: workspace.id });
    const summary = json(summaryReply);
    expect(Buffer.byteLength(summaryReply.content[0]!.text)).toBeLessThan(7_500);
    expect(summary).toMatchObject({
      totalPrice: 240, priceIncomplete: false,
      subtotals: { configurations: 200, standaloneSoftware: 40 },
      totals: { configurations: 1, cables: 83, standaloneSoftware: 1 },
    });

    const inspect = ((summary['pages'] as Record<string, { inspect: Continuation }>)['cables']!).inspect;
    const keys: string[] = [];
    let arguments_: Record<string, unknown> | undefined = inspect.arguments;
    while (arguments_) {
      const page = json(await handler(arguments_)) as {
        items: Array<{ key: string }>;
        next?: Continuation;
      };
      keys.push(...page.items.map(item => item.key));
      arguments_ = page.next?.arguments;
    }
    expect(keys).toEqual(Array.from({ length: 83 }, (_, index) => String(index)));
  });

  it('preserves the single-configuration revision contract with bounded warnings', async () => {
    const { session, workspace, handlers } = setup();
    workspace.integrityWarnings = Array.from({ length: 100 }, (_, index) =>
      `warning-${index}-` + 'x'.repeat(4_000));

    const handler = handlers.get('dcsc_workspace_get')!;
    const reply = await handler({ session: session.id });
    const result = json(reply);
    expect(Buffer.byteLength(reply.content[0]!.text)).toBeLessThan(7_500);
    expect(result).toMatchObject({
      session: session.id,
      revision: workspace.revision,
      workspace: workspace.id,
      integrityWarningCount: 100,
    });
    const page = result['integrityWarningsPage'] as { inspect: Continuation };
    expect(page.inspect.arguments).toMatchObject({
      session: workspace.id,
      expectedRevision: workspace.revision,
      path: ['integrityWarnings'],
    });
    expect(json(await handler(page.inspect.arguments))).toMatchObject({
      path: ['integrityWarnings'], total: 100,
    });
  });
});
