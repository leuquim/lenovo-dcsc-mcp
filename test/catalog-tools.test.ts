import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import type { Catalog, CatalogEntry } from '../src/domain/catalog.js';
import type { FabricOptions } from '../src/domain/fabric.js';
import type { RackCabinet } from '../src/domain/rack.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';

type Reply = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;
type Json = Record<string, unknown>;

const services: DcscService[] = [];
afterEach(async () => Promise.all(services.splice(0).map(service => service.close())));

function setup() {
  const service = new DcscService(ConfigSchema.parse({ logLevel: 'silent', files: { persistSessions: false } }));
  services.push(service);
  const handlers = new Map<string, Handler>();
  registerTools({ registerTool(name: string, _definition: unknown, callback: Handler) {
    handlers.set(name, callback);
    return { remove() {}, update() {} };
  } } as unknown as McpServer, service);
  vi.spyOn(service, 'resolveSolution').mockResolvedValue({ solutionMode: 'General Purpose', masterSlices: ['GP'] });
  return { service, handlers };
}

function parse(reply: Reply): Json {
  return JSON.parse(reply.content[0]?.text ?? '{}') as Json;
}

function textBytes(reply: Reply): number {
  return Buffer.byteLength(reply.content[0]?.text ?? '');
}

function handler(handlers: Map<string, Handler>, name: string): Handler {
  const callback = handlers.get(name);
  if (!callback) throw new Error(`${name} was not registered.`);
  return callback;
}

function catalogEntries(count = 83): CatalogEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const code = `PRODUCT-${String(index).padStart(3, '0')}`;
    const description = index === 0 ? `Oversized catalog product ${'detail '.repeat(2_000)}` : `Catalog product ${index} ${'metadata '.repeat(30)}`;
    return {
      code, description, path: ['Servers', 'Rack Servers'], categoryId: 'rack', type: 'CTO',
      hardwareType: 'server', withdrawn: false,
      haystack: `${code} ${description} catalog servers rack`.toLowerCase(),
    };
  });
}

function catalog(entries: CatalogEntry[]): Catalog {
  return { tree: [], entries, fetchedAt: 1 };
}

function fabricItems(count = 77): FabricOptions {
  const long = `Oversized fabric option ${'fabric-detail '.repeat(2_000)}`;
  return {
    topologies: Array.from({ length: count }, (_, index) => ({
      id: `topology:TOPO-${index}`, shortName: `TOPO-${index}`,
      description: index === 0 ? long : `Topology ${index}`,
    })),
    networkDevices: [], networkTypes: [], cables: [], selectedServices: [], nodeRoles: [],
    storageSwitches: [], storageControllers: [],
  };
}

async function enumerate(
  callback: Handler,
  initial: Record<string, unknown>,
  collection: string,
): Promise<{ values: Json[]; first: Json; replies: Reply[] }> {
  const values: Json[] = [];
  const replies: Reply[] = [];
  let args: Record<string, unknown> | undefined = initial;
  let first: Json | undefined;
  while (args) {
    const reply = await callback(args);
    replies.push(reply);
    expect(reply.isError).not.toBe(true);
    expect(textBytes(reply)).toBeLessThanOrEqual(7_500);
    const value = parse(reply);
    first ??= value;
    values.push(...((value[collection] as Json[] | undefined) ?? []));
    args = (value['next'] as { arguments?: Record<string, unknown> } | undefined)?.arguments;
  }
  return { values, first: first!, replies };
}

async function reconstructLongField(
  callback: Handler,
  detail: { arguments: Record<string, unknown> },
  key: string,
): Promise<string> {
  const parent = parse(await callback(detail.arguments));
  const entry = (parent['items'] as Array<{ key: string; value?: unknown; next?: { arguments: Record<string, unknown> } }>).find(item => item.key === key);
  expect(entry).toBeDefined();
  if (typeof entry?.value === 'string') return entry.value;
  let args = entry?.next?.arguments;
  let value = '';
  while (args) {
    const reply = await callback(args);
    expect(reply.isError).not.toBe(true);
    expect(textBytes(reply)).toBeLessThanOrEqual(7_500);
    const page = parse(reply);
    value += String(page['text'] ?? '');
    args = (page['next'] as { arguments?: Record<string, unknown> } | undefined)?.arguments;
  }
  return value;
}

async function enumerateBrowse(
  callback: Handler,
  initial: Record<string, unknown>,
): Promise<{ categories: Json[]; products: Json[]; first: Json; replies: Reply[] }> {
  const categories: Json[] = [];
  const products: Json[] = [];
  const replies: Reply[] = [];
  let args: Record<string, unknown> | undefined = initial;
  let first: Json | undefined;
  while (args) {
    const reply = await callback(args);
    replies.push(reply);
    expect(reply.isError).not.toBe(true);
    expect(textBytes(reply)).toBeLessThanOrEqual(7_500);
    const value = parse(reply);
    first ??= value;
    categories.push(...((value['categories'] as Json[] | undefined) ?? []));
    products.push(...((value['products'] as Json[] | undefined) ?? []));
    args = (value['next'] as { arguments?: Record<string, unknown> } | undefined)?.arguments;
  }
  return { categories, products, first: first!, replies };
}

function browseFixture(): Catalog {
  const entries = catalogEntries();
  const productRows = entries.map(entry => ({
    code: entry.code,
    description: entry.description,
    type: 'CTO' as const,
    withdrawnDate: '2999-12-31',
  }));
  const nested = [
    { id: 'rack', name: 'Rack Servers', products: productRows },
    ...Array.from({ length: 70 }, (_, index) => ({
      id: `nested-${index}`,
      name: `Nested category ${index}`,
      products: [],
    })),
  ];
  return {
    entries,
    fetchedAt: 1,
    tree: [
      { id: 'oversized', name: `Oversized category ${'category-detail '.repeat(2_000)}`, products: [] },
      { id: 'servers', name: 'Servers', products: [], children: nested },
      ...Array.from({ length: 68 }, (_, index) => ({
        id: `root-${index}`,
        name: `Root category ${index}`,
        products: [],
      })),
    ],
  };
}

describe('bounded discovery tool projections', () => {
  it('walks bounded root, nested and leaf catalog pages without losing categories or products', async () => {
    const { service, handlers } = setup();
    let current = browseFixture();
    vi.spyOn(service, 'catalog').mockImplementation(async () => current);
    const browse = handler(handlers, 'dcsc_browse_catalog');
    const defaults = { categoryOffset: 0, offset: 0, limit: 50,
      includeWithdrawn: false, solutionMode: 'General Purpose' };

    const root = await enumerateBrowse(browse, { ...defaults, path: [] });
    expect(root.categories.map(item => item['id'])).toEqual(current.tree.map(node => node.id));
    expect(root.products).toEqual([]);
    expect(new Set(root.categories.map(item => item['id'])).size).toBe(current.tree.length);
    expect(root.first['categoryPage']).toMatchObject({ total: current.tree.length });
    expect(root.first['catalogFingerprint']).toEqual(expect.any(String));
    const compactCategory = root.categories[0]!;
    expect(compactCategory).toMatchObject({ id: 'oversized', compacted: true });
    const longName = await reconstructLongField(browse,
      compactCategory['detail'] as { arguments: Record<string, unknown> }, 'name');
    expect(longName).toBe(current.tree[0]!.name);

    const nested = await enumerateBrowse(browse, { ...defaults, path: ['Servers'] });
    const serverChildren = current.tree[1]!.children!;
    expect(nested.first['path']).toEqual(['Servers']);
    expect(nested.categories.map(item => item['id'])).toEqual(serverChildren.map(node => node.id));
    expect(nested.products).toEqual([]);

    const leaf = await enumerateBrowse(browse, { ...defaults, path: ['Servers', 'Rack Servers'] });
    expect(leaf.first['path']).toEqual(['Servers', 'Rack Servers']);
    expect(leaf.categories).toEqual([]);
    expect(leaf.products.map(item => item['code'])).toEqual(current.entries.map(entry => entry.code));
    expect(new Set(leaf.products.map(item => item['code'])).size).toBe(current.entries.length);
    const compactProduct = leaf.products[0]!;
    expect(compactProduct).toMatchObject({ code: current.entries[0]!.code, compacted: true });
    const description = await reconstructLongField(browse,
      compactProduct['detail'] as { arguments: Record<string, unknown> }, 'description');
    expect(description).toBe(current.entries[0]!.description);

    const continuation = nested.first['next'] as { arguments: Record<string, unknown> };
    expect(continuation.arguments).toMatchObject({ path: ['Servers'],
      categoryOffset: (nested.first['categoryPage'] as { returned: number }).returned,
      offset: 0, limit: 50, expectedCatalogFingerprint: expect.any(String) });
    current = { ...current, tree: current.tree.map(node => node.id === 'servers'
      ? { ...node, children: node.children?.slice(1) } : node) };
    const stale = await browse(continuation.arguments);
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toContain('catalog or query context changed');

    current = browseFixture();
    const live = parse(await browse({ ...defaults, path: ['Servers'] }));
    service.setLocale({ country: 'DE', geo: 'EMEA', language: 'en', currency: 'EUR' });
    const staleContext = await browse((live['next'] as { arguments: Record<string, unknown> }).arguments);
    expect(staleContext.isError).toBe(true);
    expect(staleContext.content[0]!.text).toContain('catalog or query context changed');
  });

  it('enumerates product pages without gaps, exposes lossless oversized details, and rejects stale catalog data and locale context', async () => {
    const { service, handlers } = setup();
    let entries = catalogEntries();
    vi.spyOn(service, 'catalog').mockImplementation(async () => catalog(entries));
    vi.spyOn(service, 'modesContaining').mockImplementation(async (_ctx, codes) =>
      new Map(codes.map(code => [code.toUpperCase(), ['General Purpose']])));
    const find = handler(handlers, 'dcsc_find_products');
    const initial = { query: 'catalog', type: 'CTO', includeWithdrawn: false,
      solutionMode: 'General Purpose', offset: 0, limit: 50 };
    const result = await enumerate(find, initial, 'products');
    expect(result.values.map(item => item['code'])).toEqual(entries.map(entry => entry.code));
    expect(new Set(result.values.map(item => item['code'])).size).toBe(entries.length);
    const compact = result.values[0]!;
    expect(compact).toMatchObject({ code: entries[0]!.code, compacted: true });
    const description = await reconstructLongField(find,
      compact['detail'] as { arguments: Record<string, unknown> }, 'description');
    expect(description).toBe(entries[0]!.description);
    const continuation = result.first['next'] as { arguments: Record<string, unknown> };
    expect(continuation.arguments).toMatchObject({ query: 'catalog', type: 'CTO', offset: 1, limit: 50 });
    expect(continuation.arguments['expectedCatalogFingerprint']).toEqual(expect.any(String));

    entries = entries.map((entry, index) => index === 2 ? { ...entry, description: `${entry.description} changed` } : entry);
    const staleData = await find(continuation.arguments);
    expect(staleData.isError).toBe(true);
    expect(staleData.content[0]!.text).toContain('catalog or query context changed');

    entries = catalogEntries();
    const current = parse(await find(initial));
    service.setLocale({ country: 'DE', geo: 'EMEA', language: 'en', currency: 'EUR' });
    const staleContext = await find((current['next'] as { arguments: Record<string, unknown> }).arguments);
    expect(staleContext.isError).toBe(true);
    expect(staleContext.content[0]!.text).toContain('catalog or query context changed');
  });

  it('enumerates every rack exactly once and rejects a changed compatibility catalog', async () => {
    const { service, handlers } = setup();
    let racks: RackCabinet[] = Array.from({ length: 81 }, (_, index) => ({
      code: `RACK-${String(index).padStart(3, '0')}`,
      description: index === 0 ? `Oversized rack ${'rack-detail '.repeat(2_000)}` : `Rack ${index}`,
      machineType: '42U', price: 1000 + index,
    }));
    vi.spyOn(service, 'rackCabinets').mockImplementation(async () => racks);
    const list = handler(handlers, 'dcsc_list_racks');
    const initial = { solutionMode: 'General Purpose', offset: 0, limit: 50 };
    const result = await enumerate(list, initial, 'racks');
    expect(result.values.map(item => item['code'])).toEqual(racks.map(rack => rack.code));
    expect(result.first['compatibleWith']).toBeNull();
    const description = await reconstructLongField(list,
      result.values[0]!['detail'] as { arguments: Record<string, unknown> }, 'description');
    expect(description).toBe(racks[0]!.description);
    const next = result.first['next'] as { arguments: Record<string, unknown> };
    racks = racks.slice(1);
    const stale = await list(next.arguments);
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toContain('catalog or query context changed');
  });

  it('discovers compatible chassis and nodes with type-bound executable continuations', async () => {
    const { service, handlers } = setup();
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: [{ products: [
      { code: 'RACK', hardwareType: 'rack', description: 'Cabinet' },
      { code: 'CHASSIS-1', hardwareType: 'chassis', description: 'Chassis 1' },
      { code: 'CHASSIS-2', hardwareType: 'chassis', description: 'Chassis 2' },
    ], children: [{ products: [{ code: 'NODE', hardwareType: 'node', description: 'Node' }] }] }] } as never);
    const list = handler(handlers, 'dcsc_list_racks');
    const first = parse(await list({ productCode: 'RACK', hardwareType: 'chassis', offset: 0, limit: 1 }));
    expect(first).toMatchObject({ hardwareType: 'chassis', compatibleWith: 'RACK', total: 2,
      racks: [{ code: 'CHASSIS-1' }] });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ path: '/ctos/racks/compatible_categories',
      query: { masterCode: 'RACK' } }));
    const next = (first.next as { arguments: Record<string, unknown> }).arguments;
    expect(next.hardwareType).toBe('chassis');
    expect(parse(await list(next))).toMatchObject({ racks: [{ code: 'CHASSIS-2' }] });
    expect((await list({ ...next, hardwareType: 'node' })).isError).toBe(true);
    expect(parse(await list({ productCode: 'CHASSIS-1', hardwareType: 'node', offset: 0, limit: 20 })))
      .toMatchObject({ total: 1, racks: [{ code: 'NODE' }] });
  });

  it('pages fabric options losslessly and keeps returned option IDs executable', async () => {
    const { service, handlers } = setup();
    let fabric = fabricItems();
    vi.spyOn(service, 'fabricOptions').mockImplementation(async () => fabric);
    const browse = handler(handlers, 'dcsc_fabric_options');
    const initial = { solutionMode: 'General Purpose', collection: 'topologies',
      offset: 0, limit: 50 };
    const result = await enumerate(browse, initial, 'items');
    const expectedIds = fabric.topologies.map(item => item.id);
    const resolvedIds: string[] = [];
    for (const item of result.values) {
      if (typeof item['id'] === 'string') resolvedIds.push(item['id']);
      else {
        const detail = parse(await browse((item['detail'] as { arguments: Record<string, unknown> }).arguments));
        const id = (detail['items'] as Array<{ key: string; value?: unknown }>).find(field => field.key === 'id')?.value;
        resolvedIds.push(String(id));
      }
    }
    expect(resolvedIds).toEqual(expectedIds);
    expect(new Set(resolvedIds).size).toBe(expectedIds.length);

    const byId = await browse({ ...initial, optionId: resolvedIds[1], offset: 0, limit: 20 });
    expect(byId.isError).not.toBe(true);
    expect(parse(byId)['items']).toMatchObject([{ id: resolvedIds[1] }]);
    const next = result.first['next'] as { arguments: Record<string, unknown> };
    fabric = { ...fabric, topologies: fabric.topologies.map((item, index) =>
      index === 2 ? { ...item, description: `${item.description} changed` } : item) };
    const stale = await browse(next.arguments);
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toContain('catalog or query context changed');
  });
});
