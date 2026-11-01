import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';
import type { RawConfiguration } from '../src/model/types.js';

type Reply = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;
const services: DcscService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

function setup(totalPrice: unknown, priceNotAvailable = false) {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  services.push(service);
  const raw = { id: 'node', code: 'NODE', sliceCtoCode: 'NODE', type: 'server',
    quantity: 1, tabs: [], totalPrice, priceNotAvailable } as RawConfiguration;
  const session = service.sessions.create({ locale: service.locale,
    solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] }, mode: 'cto', raw,
    configurationId: raw.id!, reduced: reduceConfiguration(raw, raw.id!), primed: true });
  const handlers = new Map<string, Handler>();
  registerTools({ registerTool(name: string, _definition: unknown, callback: Handler) {
    handlers.set(name, callback);
    return { remove() {}, update() {} };
  } } as unknown as McpServer, service);
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await handlers.get(name)!(args);
    expect(reply.isError).not.toBe(true);
    return JSON.parse(reply.content[0]!.text) as Record<string, unknown>;
  };
  return { service, session, call };
}

describe('configuration tool price availability', () => {
  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not turn totalPrice=%s into a quoted zero when inspecting, changing quantity or cloning', async price => {
      const { session, call } = setup(price);
      expect(await call('dcsc_workspace_get', { session: session.id })).toMatchObject({
        totalPrice: null, extendedPrice: null, priceAvailable: false, unitPrice: null,
      });
      expect(await call('dcsc_configure', { session: session.id, salesQuantity: 3 })).toMatchObject({
        totalPrice: null, extendedPrice: null, priceAvailable: false,
        priceChange: { before: null, after: null },
      });
      expect(await call('dcsc_rack_edit', { session: session.id, action: 'clone', count: 2 })).toMatchObject({
        combinedListPrice: null, priceAvailable: false, knownListPriceSubtotal: 0,
        source: { unitPrice: null }, created: [{ unitPrice: null }, { unitPrice: null }],
      });
    },
  );

  it('honors explicit unavailability even when a numeric value is present', async () => {
    const { session, call } = setup(100, true);
    expect(await call('dcsc_configure', { session: session.id, salesQuantity: 2 })).toMatchObject({
      totalPrice: null, extendedPrice: null, priceAvailable: false,
      priceChange: { before: null, after: null },
    });
  });

  it.each([0, 12.34])('retains a genuine quoted total of %s', async price => {
    const { session, call } = setup(price);
    expect(await call('dcsc_configure', { session: session.id, salesQuantity: 2 })).toMatchObject({
      totalPrice: price, extendedPrice: price * 2, priceAvailable: true,
      priceChange: { before: price, after: price * 2 },
    });
    expect(await call('dcsc_rack_edit', { session: session.id, action: 'clone', count: 2 })).toMatchObject({
      combinedListPrice: Math.round(price * 6 * 100) / 100, priceAvailable: true,
    });
  });
});
