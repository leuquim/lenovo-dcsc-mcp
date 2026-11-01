import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import type { LayoutResult } from '../src/domain/rack.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';

type Reply = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;
type Link = { arguments: Record<string, unknown> };

const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

function setup() {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const raw = { id: 'node', code: 'NODE', quantity: 1, tabs: [] };
  const session = service.sessions.create({ locale: service.locale,
    solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] }, mode: 'cto', raw,
    configurationId: raw.id, reduced: reduceConfiguration(raw, raw.id), primed: true });
  const workspace = service.sessions.getWorkspace(session.id)!;
  const handlers = new Map<string, Handler>();
  registerTools({ registerTool(name: string, _definition: unknown, callback: Handler) {
    handlers.set(name, callback);
    return { remove() {}, update() {} };
  } } as unknown as McpServer, service);
  return { service, session, workspace, handlers };
}

function resultJson(reply: Reply): Record<string, unknown> {
  return JSON.parse(reply.content[0]!.text) as Record<string, unknown>;
}

function smallLayout(): LayoutResult {
  return {
    racks: [{ id: 'rack-1', code: 'RACK', description: 'Rack', sizeU: 42, usedU: 1, freeU: 41,
      stableStatus: 'PASSED', items: [{ id: 'node', code: 'NODE', description: 'Node', position: 1, endPosition: 1, sizeU: 1 }],
      errors: [] }],
    unplaced: [{ id: 'loose', code: 'LOOSE', description: 'Loose item' }],
    errors: [{ code: 'INFO', message: 'Small layout message' }],
    rawRackArea: [], rawNonRackArea: [], connections: [], rawState: {},
  };
}

describe('bounded layout mutation results', () => {
  it('passes chassis copy context and returns the independently editable nested node handle', async () => {
    const { service, session, workspace, handlers } = setup();
    const nestedPlacement = { rackId: 'rack-1', chassisId: 'chassis-1', nodeId: 'copy-1', occupiedBay: 1, session: 'copy-session' };
    const place = vi.spyOn(service, 'placeInRack').mockResolvedValue({ ...smallLayout(), nestedPlacement });
    const response = resultJson(await handlers.get('dcsc_place_in_rack')!({
      session: workspace.id, rackId: 'rack-1', chassisId: 'chassis-1', configuration: session.id,
    }));
    expect(place).toHaveBeenCalledWith(workspace.id, expect.objectContaining({ chassisId: 'chassis-1', sessionId: session.id }));
    expect(response.nestedPlacement).toEqual(nestedPlacement);
  });

  it('preserves small placement and edit results', async () => {
    const { service, session, workspace, handlers } = setup();
    const layout = smallLayout();
    vi.spyOn(service, 'placeInRack').mockResolvedValue(layout);
    vi.spyOn(service, 'editLayout').mockResolvedValue(layout);

    const placed = resultJson(await handlers.get('dcsc_place_in_rack')!({
      session: workspace.id, rackId: 'rack-1', configuration: session.id,
    }));
    expect(placed['compacted']).toBeUndefined();
    expect(placed).toMatchObject({
      rackCount: 1, unplacedCount: 1, errorCount: 1,
      racks: [{ items: [{ id: 'node', code: 'NODE' }] }],
      unplaced: [{ id: 'loose', code: 'LOOSE' }],
      errors: [{ code: 'INFO', message: 'Small layout message' }],
    });

    const edited = resultJson(await handlers.get('dcsc_edit_layout')!({
      session: workspace.id, action: 'arrange', contents: 'unplace',
    }));
    expect(edited).toMatchObject({ rackCount: 1, unplacedCount: 1, errorCount: 1 });
  });

  it('compacts a large accepted add-rack result and pages retained raw layout errors', async () => {
    const { service, workspace, handlers } = setup();
    const long = 'layout-detail-'.repeat(1_000);
    const layout: LayoutResult = {
      racks: Array.from({ length: 60 }, (_, index) => ({
        id: `rack-${index}`, code: `RACK-${index}`, description: `${long}${index}`,
        sizeU: 42, usedU: 20, freeU: 22, stableStatus: index % 3 ? 'PASSED' : 'WARNING',
        items: Array.from({ length: 20 }, (_value, item) => ({
          id: `item-${index}-${item}`, code: `NODE-${item}`, description: `${long}${item}`,
          position: item + 1, endPosition: item + 1, sizeU: 1,
        })), errors: [],
      })),
      unplaced: Array.from({ length: 30 }, (_, index) => ({ id: `loose-${index}`, code: `LOOSE-${index}`, description: `${long}${index}` })),
      errors: Array.from({ length: 40 }, (_, index) => ({ code: `E${index}`, message: `${long}${index}` })),
      rawRackArea: [], rawNonRackArea: [], connections: [], rawState: {},
    };
    workspace.rackArea = layout.racks.map((rack, index) => ({
      id: rack.id, code: rack.code, raw: `${long}${index}`,
    }));
    workspace.nonRackArea = layout.unplaced.map(item => ({ ...item, raw: long }));
    workspace.serverState['layoutErrors'] = structuredClone(layout.errors);
    vi.spyOn(service, 'addRack').mockResolvedValue(layout);

    const reply = await handlers.get('dcsc_add_rack')!({ session: workspace.id, rackCode: 'RACK' });
    const projected = resultJson(reply);
    expect(Buffer.byteLength(reply.content[0]!.text)).toBeLessThan(8_000);
    expect(projected).toMatchObject({
      compacted: true, rackCount: 60, unplacedCount: 30, errorCount: 40,
    });
    const pages = projected['pages'] as Record<string, { total: number; inspect: Link }>;
    expect(pages['racks']).toMatchObject({ total: 60 });
    expect(pages['unplaced']).toMatchObject({ total: 30 });
    expect(pages['errors']).toMatchObject({ total: 40 });

    const errorPage = resultJson(await handlers.get('dcsc_workspace_layout')!(pages['errors']!.inspect.arguments));
    expect(errorPage).toMatchObject({ path: ['layoutErrors'], total: 40 });
    expect((errorPage['items'] as Array<Record<string, unknown>>)[0]).toHaveProperty('next');
  });
});
