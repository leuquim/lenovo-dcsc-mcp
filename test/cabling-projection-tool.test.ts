import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';

type Reply = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;
type Link = { tool: string; arguments: Record<string, unknown> };

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const raw = { id: 'server', code: 'SERVER', quantity: 1, tabs: [] };
  const session = service.sessions.create({ locale: service.locale,
    solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] }, mode: 'cto', raw,
    configurationId: raw.id, reduced: reduceConfiguration(raw, raw.id), primed: true });
  const workspace = service.sessions.getWorkspace(session.id)!;
  workspace.nonRackArea = [{ id: raw.id, code: raw.code, type: 'server' }];
  const handlers = new Map<string, Handler>();
  registerTools({ registerTool(name: string, _definition: unknown, callback: Handler) {
    handlers.set(name, callback);
    return { remove() {}, update() {} };
  } } as unknown as McpServer, service);
  return { service, workspace, handlers };
}

function json(reply: Reply): Record<string, unknown> {
  return JSON.parse(reply.content[0]!.text) as Record<string, unknown>;
}

describe('bounded auto-connect tool result', () => {
  it('keeps a small nonempty connection and message response complete', async () => {
    const { service, workspace, handlers } = setup();
    vi.spyOn(service.http, 'send').mockResolvedValue({ raw: {
      rackArea: [{ id: 'rack-1', code: 'RACK', size: 42, rackItems: [],
        errors: [{ code: '102', message: 'Small server message' }] }],
      nonRackArea: workspace.nonRackArea,
      configurations: [], connections: [{ id: 'connection-1', sourceId: 'server', sourcePortName: 'A', sourcePortNumber: '1',
        destinationId: 'server', destinationPortName: 'B', destinationPortNumber: '2', cablePart: 'DAC' }],
      errors: [],
    } } as never);
    const reply = await handlers.get('dcsc_add_cabling')!({ session: workspace.id, mode: 'auto' });
    const result = json(reply);
    expect(result['compacted']).toBeUndefined();
    expect(result).toMatchObject({
      connectionCount: 1, messageGroupCount: 1, messageCount: 1,
      connections: [{ id: 'connection-1', fromPort: 'A - 1', toPort: 'B - 2', cableCode: 'DAC' }],
      messages: [{ rackId: 'rack-1', messages: ['Small server message'] }],
    });
  });

  it('bounds many long connections and exposes exact raw connections and messages through layout pages', async () => {
    const { service, workspace, handlers } = setup();
    const longPort = 'source-port-'.repeat(1_000);
    const longMessage = 'server-message-'.repeat(1_000);
    const rawConnections = Array.from({ length: 90 }, (_, index) => ({
      id: `connection-${index}`, sourceId: 'server', sourcePortName: `${longPort}${index}`,
      destinationId: 'server', destinationPortName: `destination-${index}`, cablePart: 'DAC',
      transceivers: [{ code: 'OPTIC', opaque: `detail-${index}` }],
    }));
    vi.spyOn(service.http, 'send').mockResolvedValue({ raw: {
      rackArea: [{ id: 'rack-1', code: 'RACK', size: 42, rackItems: [],
        errors: Array.from({ length: 12 }, (_, index) => ({ code: '102', message: `${longMessage}${index}` })) }],
      nonRackArea: workspace.nonRackArea, configurations: [], connections: rawConnections, errors: [],
    } } as never);

    const cablingReply = await handlers.get('dcsc_add_cabling')!({ session: workspace.id, mode: 'auto' });
    const cabling = json(cablingReply);
    expect(Buffer.byteLength(cablingReply.content[0]!.text)).toBeLessThan(7_500);
    expect(cabling).toMatchObject({
      compacted: true, connectionCount: 90, messageGroupCount: 1, messageCount: 12,
      pages: {
        rawConnections: { total: 90 },
        messages: { total: 1, messageCount: 12 },
      },
    });

    const pages = cabling['pages'] as Record<string, { inspect: Link }>;
    const layout = handlers.get('dcsc_workspace_layout')!;
    const rawPageReply = await layout(pages['rawConnections']!.inspect.arguments);
    const rawPage = json(rawPageReply);
    expect(rawPage).toMatchObject({ path: ['rawConnections'], total: 90 });
    expect((rawPage['items'] as Array<Record<string, unknown>>)[0]).toHaveProperty('next');

    const messagePageReply = await layout(pages['messages']!.inspect.arguments);
    const messagePage = json(messagePageReply);
    expect(messagePage).toMatchObject({ path: ['autoConnectMessages'], total: 1 });
    const groupLink = ((messagePage['items'] as Array<{ next: Link }>)[0]!).next;
    const group = json(await layout(groupLink.arguments));
    expect(group['items']).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'messages', type: 'array' }),
    ]));
  });
});
