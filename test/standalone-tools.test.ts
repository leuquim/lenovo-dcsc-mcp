import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { parseStandaloneImportResponse } from '../src/domain/importStandalone.js';
import { buildProductServiceExportEnvelope } from '../src/domain/standalone.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { registerStandaloneTools } from '../src/mcp/standaloneTools.js';
import { registerImportExportTools } from '../src/mcp/importExportTools.js';
import { registerCatalogTools } from '../src/mcp/catalogTools.js';
import { registerSessionTools } from '../src/mcp/sessionTools.js';
import { basketView } from '../src/app/standalone.js';
import { DcscService } from '../src/mcp/service.js';

type ToolReply = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean | undefined;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolReply>;

const solutionModes = [
  { mode: 'General Purpose', masterSlices: ['GP', 'HPCGPALL', 'HPCGPRYO'] },
];
const zip = Buffer.from(
  'UEsDBBQAAAAIAJBsT10RXudMCQAAAAcAAAAKAAAAZXhwb3J0LnhtbLMpys8v0bcDAFBLAQIUAxQAAAAIAJBsT10RXudMCQAAAAcAAAAKAAAAAAAAAAAAAACAAQAAAABleHBvcnQueG1sUEsFBgAAAAABAAEAOAAAADEAAAAAAA==',
  'base64',
);

const softwareFeature = {
  softwareCode: '7S1SCTO8WW',
  code: '7S1S002WWW',
  description: 'Windows Server license',
  priceNotAvailable: false,
  unitPrice: 234.5,
  prices: [{ priceTypeId: 1, price: 234.5 }],
  showPrice: true,
  preSelectedQuantity: 0,
  inventory: null,
  capturedFeature: true,
};
const softwarePortal = {
  tabs: [
    {
      title: 'OS & Software',
      subTabs: [
        {
          title: 'Microsoft',
          sections: [
            {
              description: 'Licenses',
              features: [softwareFeature],
            },
          ],
        },
      ],
    },
  ],
};
const softwareLaunch = {
  capturedBase: { mustSurvive: true },
  workspace: { capturedWorkspaceField: 'preserved' },
  exportFileTypes: ['XML'],
};

const serviceFeature = {
  code: '5WS7B99623',
  description: '3Yr Premier NBD Resp SR630 V3',
  type: 'Warranty Service Upgrades',
  characterName: 'Warranty Service Upgrades',
  unitPrice: 1637,
  prices: [{ priceTypeId: 1, price: 1637 }],
  productNumber: '7D73CTO1WW',
  preSelectedQuantity: 1,
  capturedFeature: true,
};
const serviceGraph = {
  tabs: [
    {
      title: 'Services',
      subTabs: [
        {
          title: 'A la Carte|Column2',
          sections: [
            {
              name: 'A la Carte|Column2|3 Year',
              description: '3 Year',
              features: [serviceFeature],
              results: [],
            },
          ],
        },
      ],
    },
  ],
};

function serviceGraphForRequest(
  graph: typeof serviceGraph,
  request: unknown,
): typeof serviceGraph {
  const sections = (request as {
    body?: { value?: { sections?: Array<{ name?: string; results?: unknown[] }> } } | undefined;
  }).body?.value?.sections;
  if (!sections) return graph;
  const derived = structuredClone(graph);
  for (const requested of sections) {
    const section = derived.tabs
      .flatMap((tab) => tab.subTabs)
      .flatMap((subTab) => subTab.sections)
      .find((candidate) => candidate.name === requested.name);
    if (section) section.results = (requested.results ?? []) as typeof section.results;
  }
  return derived;
}

const services: DcscService[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => service.close()));
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const artifacts = await mkdtemp(join(tmpdir(), 'dcsc-standalone-tools-'));
  tempDirs.push(artifacts);
  const service = new DcscService(
    ConfigSchema.parse({
      logLevel: 'silent',
      files: { persistSessions: false, artifactDir: artifacts },
    }),
  );
  services.push(service);
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
      return { remove() {}, update() {} };
    },
  };
  registerStandaloneTools(server as unknown as McpServer, service);
  registerImportExportTools(server as unknown as McpServer, service);
  registerCatalogTools(server as unknown as McpServer, service);
  registerSessionTools(server as unknown as McpServer, service);
  return { service, handlers };
}

function parse(reply: ToolReply): Record<string, unknown> {
  return JSON.parse(reply.content[0]?.text ?? '{}') as Record<string, unknown>;
}

function launchTool(handlers: Map<string, ToolHandler>, mode: 'software' | 'services'): ToolHandler {
  return (args) => handler(handlers, 'dcsc_launch')({ mode, ...args });
}

function handler(handlers: Map<string, ToolHandler>, name: string): ToolHandler {
  const value = handlers.get(name);
  if (!value) throw new Error(`${name} not registered`);
  return value;
}

describe('standalone MCP tools', () => {
  it('enumerates a byte-trimmed part-search snapshot without gaps or repeated upstream downloads', async () => {
    const { service, handlers } = await setup();
    let parts = Array.from({ length: 83 }, (_, index) => ({ code: `PART-${index}`,
      description: 'Long catalog description '.repeat(30), type: 'SOFTWARE' }));
    const send = vi.spyOn(service.http, 'send').mockImplementation(async request => {
      if (request.path === '/solution_modes') return { raw: solutionModes } as never;
      if (request.path === '/findpart') return { raw: parts } as never;
      throw new Error(`Unexpected ${request.path}`);
    });
    const lookup = handler(handlers, 'dcsc_search');
    let args: Record<string, unknown> | undefined = { search: { kind: 'parts', query: 'catalog', types: ['SOFTWARE'], mode: 'CTO', offset: 0, limit: 50 } };
    const codes: string[] = [];
    let savedContinuation: Record<string, unknown> | undefined;
    while (args) {
      const reply = await lookup(args);
      expect(reply.isError).not.toBe(true);
      expect(Buffer.byteLength(reply.content[0]!.text)).toBeLessThanOrEqual(8_000);
      const result = parse(reply);
      const rows = result.parts as Array<{ code: string }>;
      codes.push(...rows.map(row => row.code));
      args = (result.next as { arguments: Record<string, unknown> } | undefined)?.arguments;
      if (args) {
        savedContinuation ??= args;
        expect(args['search']).toMatchObject({ query: 'catalog', types: ['SOFTWARE'], offset: codes.length });
      }
    }
    expect(codes).toEqual(parts.map(part => part.code));
    expect(send.mock.calls.filter(([request]) => request.path === '/findpart')).toHaveLength(1);
    parts = parts.slice(1);
    const retained = await lookup(savedContinuation!);
    expect(retained.isError).not.toBe(true);
    expect((parse(retained).parts as Array<{ code: string }>)[0]?.code)
      .toBe(`PART-${String((savedContinuation!['search'] as Record<string, unknown>)['offset'])}`);
    expect(send.mock.calls.filter(([request]) => request.path === '/findpart')).toHaveLength(1);

    const mismatched = await lookup({ search: { ...(savedContinuation!['search'] as Record<string, unknown>), query: 'different catalog' } });
    expect(mismatched.isError).toBe(true);
    expect(mismatched.content[0]!.text).toContain('catalog or query context changed');
    expect(send.mock.calls.filter(([request]) => request.path === '/findpart')).toHaveLength(2);

    const refreshed = parse(await lookup({ search: { kind: 'parts', query: 'catalog', types: ['SOFTWARE'], mode: 'CTO', offset: 0, limit: 50 } }));
    expect((refreshed.parts as Array<{ code: string }>)[0]?.code).toBe('PART-1');
    expect(send.mock.calls.filter(([request]) => request.path === '/findpart')).toHaveLength(3);
  });

  it('provides lossless details for an oversized software item and preserves filter continuations', async () => {
    const { service, handlers } = await setup();
    const description = 'License with extended metadata '.repeat(1200);
    const features = Array.from({ length: 61 }, (_, index) => ({ ...softwareFeature,
      code: `SOFTWARE-${index}`, description: index === 0 ? description : 'License '.repeat(80) }));
    const portal = { tabs: [{ title: 'OS & Software', subTabs: [{ title: 'Microsoft',
      sections: [{ description: 'Licenses', features }] }] }] };
    vi.spyOn(service.http, 'send').mockImplementation(async request => {
      if (request.path === '/solution_modes') return { raw: solutionModes } as never;
      if (request.path === '/ctos/standalone_software/launch') return { raw: softwareLaunch } as never;
      if (request.path === '/software/portal/launch') return { raw: portal } as never;
      throw new Error(`Unexpected ${request.path}`);
    });
    const launched = parse(await launchTool(handlers, 'software')({ replace: false }));
    expect(parse(await handler(handlers, 'dcsc_workspace_get')({ session: launched.session, view: { kind: 'baskets', offset: 0, limit: 20 } })))
      .toMatchObject({ basket: 'software', session: launched.session, selections: [] });
    const browseTool = handler(handlers, 'dcsc_basket_browse');
    const browse = (args: Record<string, unknown>) => browseTool({ basket: 'software', ...args });
    const first = parse(await browse({ session: launched.session, query: 'License', subTab: 'Microsoft', offset: 0, limit: 50 }));
    const compact = (first.software as Array<Record<string, unknown>>)[0]!;
    expect(compact).toMatchObject({ code: 'SOFTWARE-0', compacted: true });
    const detailArgs = (compact.detail as { arguments: Record<string, unknown> }).arguments;
    const detail = parse(await browse(detailArgs));
    const descriptionEntry = (detail.items as Array<{ key: string; next?: { arguments: Record<string, unknown> } }>)
      .find(item => item.key === 'description')!;
    let args = descriptionEntry.next!.arguments as Record<string, unknown> | undefined;
    let reconstructed = '';
    while (args) {
      const reply = await browse(args);
      expect(reply.isError).not.toBe(true);
      expect(Buffer.byteLength(reply.content[0]!.text)).toBeLessThanOrEqual(8_000);
      const page = parse(reply);
      reconstructed += String(page.text);
      args = (page.next as { arguments: Record<string, unknown> } | undefined)?.arguments;
    }
    expect(reconstructed).toBe(description);
    const codes = [String(compact.code)];
    args = (first.next as { arguments: Record<string, unknown> }).arguments;
    while (args) {
      expect(args).toMatchObject({ query: 'License', subTab: 'Microsoft', offset: codes.length });
      const reply = await browse(args);
      expect(reply.isError).not.toBe(true);
      expect(Buffer.byteLength(reply.content[0]!.text)).toBeLessThanOrEqual(8_000);
      const page = parse(reply);
      codes.push(...(page.software as Array<{ code: string }>).map(item => item.code));
      args = (page.next as { arguments: Record<string, unknown> } | undefined)?.arguments;
    }
    expect(codes).toEqual(features.map(feature => feature.code));
    await service.sessions.transact(String(launched.session), { keepEmptyWorkspace: true }, draft => { draft.label = 'changed'; });
    expect((await browse(detailArgs)).isError).toBe(true);
  });

  it('paginates global lookup without claiming an upstream total', async () => {
    const { service, handlers } = await setup();
    const send = vi.spyOn(service.http, 'send').mockImplementation(async (request) => {
      if (request.path === '/solution_modes') return { raw: solutionModes } as never;
      if (request.path === '/findpart') {
        return {
          raw: [
            { code: 'SW1', description: 'Software', type: 'SOFTWARE' },
            { code: 'SV1', description: 'Service', type: 'SERVICE' },
          ],
        } as never;
      }
      throw new Error(`Unexpected ${request.path}`);
    });

    const result = parse(
      await handler(handlers, 'dcsc_search')({ search: { kind: 'parts',
        query: 'lenovo',
        types: ['SOFTWARE', 'SERVICE'],
        mode: 'CTO',
        offset: 0,
        limit: 1,
      } }),
    );

    expect(result).toMatchObject({
      account: 'anonymous',
      currency: 'USD',
      page: {
        offset: 0,
        limit: 1,
        itemsInFetchedResponse: 2,
        source: 'GET /api/findpart',
        upstreamCompleteness: 'unknown',
        upstreamContract: 'single-response-array',
        upstreamPagination: 'none-reported',
        continuationScope: 'local-snapshot',
      },
      parts: [{ code: 'SW1', nextAction: 'browse_software_catalog' }],
      next: { tool: 'dcsc_search', arguments: { search: { offset: 1, limit: 1 } } },
    });
    expect(result.scope).toContain('website paginates it client-side');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/findpart',
        query: expect.objectContaining({ type: 'SOFTWARE,SERVICE', mode: 'CTO' }),
      }),
    );
    expect(result).not.toHaveProperty('total');

    const second = parse(await handler(handlers, 'dcsc_search')(
      (result.next as { arguments: Record<string, unknown> }).arguments,
    ));
    expect(second.parts).toEqual([expect.objectContaining({ code: 'SV1' })]);
    expect(send.mock.calls.filter(([request]) => request.path === '/findpart')).toHaveLength(1);
  });

  it('runs a durable software basket, preserves launch data in export, and rolls back failed persistence', async () => {
    const { service, handlers } = await setup();
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(service.http, 'send').mockImplementation(async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      if (request.path === '/solution_modes') return { raw: solutionModes } as never;
      if (request.path === '/ctos/standalone_software/launch') {
        return { raw: softwareLaunch } as never;
      }
      if (request.path === '/software/portal/launch') return { raw: softwarePortal } as never;
      if (request.path === '/lfos/export_zip' || request.path === '/ctos/export_zip') {
        return {
          stream: Readable.from(zip),
          contentDisposition: 'attachment; filename="software.zip"',
        } as never;
      }
      throw new Error(`Unexpected ${request.path}`);
    });

    const launched = parse(
      await launchTool(handlers, 'software')({ replace: false }),
    );
    const workspace = String(launched['session']);
    expect(launched).toMatchObject({ basket: 'software', catalogItems: 1, priceType: 'LIST' });
    expect(basketView(service.sessions.getWorkspace(workspace)!, 'software')).toMatchObject({ selections: [] });

    const page = parse(
      await handler(handlers, 'dcsc_basket_browse')({ basket: 'software',
        session: workspace,
        offset: 0,
        limit: 1,
      }),
    );
    expect(page).toMatchObject({
      page: { totalInFetchedCatalog: 1, upstreamCompleteness: 'unknown' },
      software: [
        {
          code: '7S1S002WWW',
          unitPrice: 234.5,
          next: {
            tool: 'dcsc_basket_set',
            arguments: { session: workspace, basket: 'software', action: 'select', code: '7S1S002WWW', quantity: 1 },
          },
        },
      ],
    });

    const selected = parse(
      await handler(handlers, 'dcsc_basket_set')({ basket: 'software', action: 'select',
        session: workspace,
        code: '7S1S002WWW',
        quantity: 2,
      }),
    );
    expect(selected).toMatchObject({ totalListPrice: 469, priceIncomplete: false });
    const stale = await handler(handlers, 'dcsc_basket_set')({ basket: 'software', action: 'setQuantity',
      session: workspace,
      code: '7S1S002WWW',
      quantity: 9,
      expectedRevision: launched['revision'],
    });
    expect(stale.isError).toBe(true);
    expect(basketView(service.sessions.getWorkspace(workspace)!, 'software')).toMatchObject({
      selections: [{ code: '7S1S002WWW', quantity: 2 }],
    });

    const exported = parse(
      await handler(handlers, 'dcsc_export')({ kind: 'reports', session: workspace, fileName: 'software' }),
    );
    expect(exported).toMatchObject({
      session: workspace,
      scope: 'workspace',
      bytes: zip.length,
      contentDisposition: 'attachment; filename="software.zip"',
    });
    const exportRequest = requests.find((request) => request['path'] === '/lfos/export_zip');
    expect(exportRequest).toMatchObject({
      method: 'POST',
      query: { fileName: 'software' },
      body: { kind: 'form' },
      responseKind: 'stream',
    });
    const fields = (exportRequest?.['body'] as { fields: Record<string, string> }).fields;
    const data = JSON.parse(fields['data'] ?? '{}') as Record<string, unknown>;
    expect(data).not.toHaveProperty('capturedBase');
    expect(data).toMatchObject({
      workspace: { capturedWorkspaceField: 'preserved' },
      standaloneData: [{ code: '7S1S002WWW', quantity: 2, price: 234.5 }],
    });
    expect(JSON.parse(fields['groups'] ?? '[]')).toMatchObject([
      { products: [{ code: '7S1S002WWW', type: 'standalone', unitPrice: 234.5 }] },
    ]);

    const configurationId = 'hardware-configuration';
    const raw = {
      id: configurationId,
      sliceCtoCode: '7D73CTO1WW',
      description: 'ThinkSystem SR630 V3',
      type: 'server',
      quantity: 1,
      totalPrice: 1000,
      tabs: [],
    };
    service.sessions.create({
      locale: service.locale,
      solution: service.sessions.getWorkspace(workspace)?.solution ?? {
        solutionMode: 'General Purpose',
        masterSlices: ['GP', 'HPCGPALL', 'HPCGPRYO'],
      },
      mode: 'cto',
      raw,
      configurationId,
      reduced: reduceConfiguration(raw, configurationId),
      primed: true,
      workspaceId: workspace,
    });
    const mixedWorkspace = service.sessions.getWorkspace(workspace);
    if (!mixedWorkspace) throw new Error('mixed workspace missing');
    mixedWorkspace.rackArea = [
      {
        id: 'rack-1',
        code: 'RACK',
        size: 42,
        rackItems: [
          {
            id: configurationId,
            code: '7D73CTO1WW',
            position: 1,
            size: 1,
            type: 'server',
          },
        ],
      },
    ];
    await handler(handlers, 'dcsc_export')({ kind: 'reports',
      session: workspace,
      fileName: 'mixed',
      fileTypes: ['XML', 'RACK_REPORT'],
    });
    const mixedRequest = requests.filter((request) => request['path'] === '/ctos/export_zip').at(-1);
    const mixedFields = (mixedRequest?.['body'] as { fields: Record<string, string> }).fields;
    const mixedData = JSON.parse(mixedFields['data'] ?? '{}') as Record<string, unknown>;
    expect(mixedData).toMatchObject({
      exportFileTypes: ['XML', 'RACK_REPORT'],
      workspace: {
        capturedWorkspaceField: 'preserved',
        rackArea: [
          {
            id: 'rack-1',
            type: 'rack',
            children: [{ id: configurationId, type: 'server' }],
          },
        ],
      },
      workspaceInformation: {
        rackData: [
          {
            id: 'rack-1',
            rackItems: [{ id: configurationId, position: 1 }],
          },
        ],
      },
      configurations: [{ id: configurationId, code: '7D73CTO1WW' }],
      standaloneData: [{ code: '7S1S002WWW', quantity: 2 }],
    });
    expect(JSON.parse(mixedFields['groups'] ?? '[]')).toMatchObject([
      {
        name: 'Config 1',
        products: [
          { code: '7D73CTO1WW', type: 'hardware' },
          { code: '7S1S002WWW', type: 'standalone' },
        ],
      },
    ]);

    service.sessions.setPersistenceWriter(() => {
      throw new Error('simulated durable write failure');
    });
    const failed = await handler(handlers, 'dcsc_basket_set')({ basket: 'software', action: 'setQuantity',
      session: workspace,
      code: '7S1S002WWW',
      quantity: 3,
    });
    expect(failed.isError).toBe(true);
    const after = basketView(service.sessions.getWorkspace(workspace)!, 'software');
    expect(after).toMatchObject({
      totalListPrice: 469,
      selections: [{ code: '7S1S002WWW', quantity: 2 }],
    });
  });

  it('refreshes an imported service catalog without changing saved quantities or export prices, then selects another service', async () => {
    const { service, handlers } = await setup();
    const imported = parseStandaloneImportResponse(JSON.parse(readFileSync(new URL('./fixtures/service-qty-import-response.json', import.meta.url),'utf8')));
    if (!imported || imported.kind !== 'service') throw new Error('Expected captured service import');
    const alternate = { ...serviceFeature, code: 'NEW-SERVICE', description: 'Alternative captured section choice' };
    const fresh = structuredClone(serviceGraph);
    fresh.tabs[0]!.subTabs[0]!.sections[0]!.features.push(alternate);
    const send = vi.spyOn(service.http,'send').mockImplementation(async request => {
      if(request.path === '/solution_modes') return {raw:solutionModes} as never;
      if(request.path === '/services/autoDerive') return {raw:serviceGraphForRequest(fresh, request)} as never;
      if(request.path === '/service_pacs/export') return {
        stream: Readable.from(zip),
        contentDisposition: 'attachment; filename="service.zip"',
      } as never;
      if(request.path.startsWith('/service_pacs/')) return {raw:{services:[serviceFeature,alternate]}} as never;
      if(request.path === '/services/summaries') return {raw:{totalPrice:2400,currency:'USD'}} as never;
      throw new Error(`Unexpected ${request.path}`);
    });
    const solution = await service.resolveSolution(service.newCtx(),'General Purpose');
    const {workspace} = await service.sessions.createManyAtomic([],{
      workspaceContext:{locale:service.locale,solution},
      workspaceState:{serverState:{standaloneServiceState:imported.state},
        integrityWarnings: [...imported.diagnostics.warnings, 'Retained unrelated import diagnostic']},
    });
    const beforeExport = buildProductServiceExportEnvelope(imported.state);
    const before = structuredClone(imported.state);
    const refreshed = await launchTool(handlers, 'services')({session:workspace.id,refresh:true,expectedRevision:workspace.revision});
    expect(refreshed.isError).not.toBe(true);
    expect(workspace.integrityWarnings).toEqual(['Retained unrelated import diagnostic']);
    const state = workspace.serverState.standaloneServiceState as typeof imported.state;
    expect(state.selections).toEqual(before.selections);
    expect(state.product).toEqual(before.product);
    expect(state.summaryRaw).toEqual(before.summaryRaw);
    expect(buildProductServiceExportEnvelope(state)).toEqual(beforeExport);
    expect(state.options.some(option=>option.code==='NEW-SERVICE')).toBe(true);
    const resized = parse(await handler(handlers, 'dcsc_basket_set')({ basket: 'services', action: 'setProductQuantity',
      session: workspace.id,
      quantity: 4,
      expectedRevision: workspace.revision,
    }));
    expect(resized).toMatchObject({
      product: { code: '7D73CTO1WW', quantity: 4 },
      selections: [{ code: '5WS7B99623', quantity: 2 }],
    });
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
      path: '/services/summaries',
      body: {
        kind: 'json',
        value: [{
          code: '7D73CTO1WW',
          quantity: 4,
          services: [{ serviceCode: '5WS7B99623', quantity: 2 }],
        }],
      },
    });
    const exported = parse(await handler(handlers, 'dcsc_export')({ kind: 'reports',
      session: workspace.id,
      fileName: 'imported-non-unit-service',
    }));
    expect(exported['warning']).toEqual(expect.stringContaining('native Save after import and a product-quantity change'));
    const requestCount = send.mock.calls.length;
    const stale = await launchTool(handlers, 'services')({session:workspace.id,refresh:true,expectedRevision:workspace.revision-1});
    expect(stale.isError).toBe(true);
    expect(send).toHaveBeenCalledTimes(requestCount);
    const selected = await handler(handlers, 'dcsc_basket_set')({ basket: 'services', action: 'select',session:workspace.id,code:'NEW-SERVICE',quantity:1,expectedRevision:workspace.revision});
    expect(selected.isError).not.toBe(true);
    expect(parse(selected)).toMatchObject({selections:[{code:'NEW-SERVICE',quantity:1}],summary:{totalPrice:2400}});
  });

  it('rejects DCSC service-quantity normalization without changing workspace state', async () => {
    const { service, handlers } = await setup();
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(service.http, 'send').mockImplementation(async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      if (request.path === '/solution_modes') return { raw: solutionModes } as never;
      if (request.path === '/service_pacs/7D73CTO1WW') {
        return { raw: { services: [serviceFeature] } } as never;
      }
      if (request.path === '/services/autoDerive') {
        const normalized = serviceGraphForRequest(serviceGraph, request);
        for (const section of normalized.tabs.flatMap((tab) => tab.subTabs)
          .flatMap((subTab) => subTab.sections)) {
          section.results = section.results.map((result) => ({
            ...result as Record<string, unknown>,
            quantity: 1,
          })) as typeof section.results;
        }
        return { raw: normalized } as never;
      }
      if (request.path === '/services/summaries') {
        return { raw: [{ code: '7D73CTO1WW', quantity: 3, totalPrice: 4911 }] } as never;
      }
      throw new Error(`Unexpected ${request.path}`);
    });

    const launched = parse(await launchTool(handlers, 'services')({
      productCode: '7D73CTO1WW',
      productQuantity: 3,
      subCategory: 'Point of Sale',
      replace: false,
    }));
    const workspace = String(launched['session']);
    const initialRevision = Number(launched['revision']);
    const initialWorkspace = service.sessions.getWorkspace(workspace)!;
    const initialServerState = structuredClone(initialWorkspace.serverState);
    const initialHistory = structuredClone(initialWorkspace.history);
    const rejectedSelection = await handler(handlers, 'dcsc_basket_set')({ basket: 'services', action: 'select',
      session: workspace,
      code: '5WS7B99623',
      quantity: 2,
    });
    expect(rejectedSelection.isError).toBe(true);
    expect(parse(rejectedSelection)).toMatchObject({ kind: 'invalid_request' });
    expect(rejectedSelection.content[0]!.text).toContain('requestedQuantity=2');
    expect(rejectedSelection.content[0]!.text).toContain('acceptedQuantity=1');
    expect(rejectedSelection.content[0]!.text).toContain('No workspace change was saved');
    expect(rejectedSelection.content[0]!.text).toContain('setProductQuantity');
    expect(rejectedSelection.content[0]!.text).toContain('(remove)');
    expect(service.sessions.getWorkspace(workspace)?.revision).toBe(initialRevision);
    expect(service.sessions.getWorkspace(workspace)?.serverState).toEqual(initialServerState);
    expect(service.sessions.getWorkspace(workspace)?.history).toEqual(initialHistory);
    expect((service.sessions.getWorkspace(workspace)?.serverState.standaloneServiceState as {
      selections: unknown[];
    }).selections).toEqual([]);

    const selected = await handler(handlers, 'dcsc_basket_set')({ basket: 'services', action: 'select',
      session: workspace,
      code: '5WS7B99623',
      quantity: 1,
      expectedRevision: initialRevision,
    });
    expect(selected.isError).not.toBe(true);
    const acceptedRevision = Number(parse(selected)['revision']);
    const acceptedWorkspace = service.sessions.getWorkspace(workspace)!;
    const acceptedServerState = structuredClone(acceptedWorkspace.serverState);
    const acceptedHistory = structuredClone(acceptedWorkspace.history);
    const acceptedExport = buildProductServiceExportEnvelope(
      acceptedWorkspace.serverState.standaloneServiceState as Parameters<
        typeof buildProductServiceExportEnvelope
      >[0],
    );

    const rejectedChange = await handler(handlers, 'dcsc_basket_set')({ basket: 'services', action: 'setQuantity',
      session: workspace,
      code: '5WS7B99623',
      quantity: 4,
    });
    expect(rejectedChange.isError).toBe(true);
    expect(rejectedChange.content[0]!.text).toContain('requestedQuantity=4');
    expect(rejectedChange.content[0]!.text).toContain('acceptedQuantity=1');
    expect(service.sessions.getWorkspace(workspace)?.revision).toBe(acceptedRevision);
    expect(service.sessions.getWorkspace(workspace)?.serverState).toEqual(acceptedServerState);
    expect(service.sessions.getWorkspace(workspace)?.history).toEqual(acceptedHistory);
    expect(buildProductServiceExportEnvelope(
      service.sessions.getWorkspace(workspace)?.serverState.standaloneServiceState as Parameters<
        typeof buildProductServiceExportEnvelope
      >[0],
    )).toEqual(acceptedExport);
    expect((service.sessions.getWorkspace(workspace)?.serverState.standaloneServiceState as {
      selections: Array<{ code: string; quantity: number }>;
    }).selections).toEqual([
      expect.objectContaining({ code: '5WS7B99623', quantity: 1 }),
    ]);
    const summaryRequests = requests.filter((request) => request['path'] === '/services/summaries');
    expect(summaryRequests).toHaveLength(1);
  });

  it('selects one verified product service and exports the captured exact form', async () => {
    const { service, handlers } = await setup();
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(service.http, 'send').mockImplementation(async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      if (request.path === '/solution_modes') return { raw: solutionModes } as never;
      if (request.path === '/services/autoDerive') return { raw: serviceGraphForRequest(serviceGraph, request) } as never;
      if (request.path === '/service_pacs/7D73CTO1WW') {
        return { raw: { services: [serviceFeature], capturedCatalog: true } } as never;
      }
      if (request.path === '/services/summaries') {
        return { raw: { totalPrice: 1637, currency: 'USD', capturedSummary: true } } as never;
      }
      if (request.path === '/service_pacs/export') {
        return {
          stream: Readable.from(zip),
          contentDisposition: 'attachment; filename="services.zip"',
        } as never;
      }
      throw new Error(`Unexpected ${request.path}`);
    });

    const launched = parse(
      await launchTool(handlers, 'services')({
        productCode: '7D73CTO1WW',
        productQuantity: 1,
        subCategory: 'Point of Sale',
        replace: false,
      }),
    );
    const workspace = String(launched['session']);
    expect(launched).toMatchObject({ basket: 'services' });
    expect(parse(await handler(handlers, 'dcsc_basket_browse')({ basket: 'services', session: workspace }))).toMatchObject({
      selectionSemantics: 'base-plus-add-ons-verified',
      product: { code: '7D73CTO1WW' },
      options: [{ code: '5WS7B99623', unitPrice: 1637 }],
    });

    const selected = parse(
      await handler(handlers, 'dcsc_basket_set')({ basket: 'services', action: 'select',
        session: workspace,
        code: '5WS7B99623',
        quantity: 1,
      }),
    );
    expect(selected).toMatchObject({
      selections: [{ code: '5WS7B99623', quantity: 1 }],
      summary: { totalPrice: 1637, currency: 'USD', capturedSummary: true },
    });

    const changedService = parse(
      await handler(handlers, 'dcsc_basket_set')({ basket: 'services', action: 'setQuantity', session: workspace, quantity: 2 }),
    );
    expect(changedService).toMatchObject({
      product: { code: '7D73CTO1WW', quantity: 1 },
      selections: [{ code: '5WS7B99623', quantity: 2 }],
    });
    const changedProduct = parse(
      await handler(handlers, 'dcsc_basket_set')({ basket: 'services', action: 'setProductQuantity',
        session: workspace,
        quantity: 3,
      }),
    );
    expect(changedProduct).toMatchObject({
      product: { code: '7D73CTO1WW', quantity: 3 },
      selections: [{ code: '5WS7B99623', quantity: 2 }],
      summary: { totalPrice: 1637 },
    });

    const exported = parse(
      await handler(handlers, 'dcsc_export')({ kind: 'reports', session: workspace, fileName: 'services' }),
    );
    expect(exported).toMatchObject({
      session: workspace,
      scope: 'workspace',
      bytes: zip.length,
    });
    const exportRequest = requests.find((request) => request['path'] === '/service_pacs/export');
    expect(exportRequest).toMatchObject({
      method: 'POST',
      query: { fileName: 'services' },
      body: { kind: 'form' },
      responseKind: 'stream',
    });
    const fields = (exportRequest?.['body'] as { fields: Record<string, string> }).fields;
    expect(JSON.parse(fields['data'] ?? '[]')).toEqual([
      {
        code: '7D73CTO1WW',
        quantity: 3,
        services: [{ serviceCode: '5WS7B99623', quantity: 2 }],
      },
    ]);
    expect(JSON.parse(fields['serviceAndorRequest'] ?? '{}')).toMatchObject({
      ctoCode: '7D73CTO1WW',
      delta: { section: 'A la Carte', featureCode: '5WS7B99623', quantity: 2 },
    });
    expect(fields).toMatchObject({
      multipleProductData: '',
      excelData: 'null',
      groups: '',
      'dcsc-isFromIntegration': 'false',
    });

    const removed = parse(await handler(handlers, 'dcsc_basket_set')({ basket: 'services', action: 'remove', session: workspace }));
    expect(removed).toMatchObject({
      product: { code: '7D73CTO1WW', quantity: 3 },
      selections: [],
    });
    const deriveRequests = requests.filter((request) => request['path'] === '/services/autoDerive');
    expect(deriveRequests).toContainEqual(
      expect.objectContaining({
        body: {
          kind: 'json',
          value: expect.objectContaining({
            delta: { section: 'A la Carte', featureCode: '5WS7B99623', quantity: 2 },
          }),
        },
      }),
    );
    expect(deriveRequests.at(-1)).toMatchObject({
      body: {
        kind: 'json',
        value: {
          ctoCode: '7D73CTO1WW',
          subCategory: 'Point of Sale',
          sections: [],
          delta: { section: 'A la Carte' },
        },
      },
    });
  });

  it('keeps a base service and add-on together, addresses quantity by code, and removes only the add-on', async () => {
    const { service, handlers } = await setup();
    const addOn = {
      ...serviceFeature,
      code: '5PS7B99638',
      description: '3Yr KYD Add-On SR630 V3',
      type: 'Keep Your Drive',
      characterName: 'Keep Your Drive',
      unitPrice: 173,
    };
    const graph = structuredClone(serviceGraph) as typeof serviceGraph & {
      tabs: Array<{ subTabs: Array<Record<string, unknown>> }>;
    };
    graph.tabs[0]!.subTabs.push({
      title: 'Add ons|Keep Your Drive',
      sections: [{
        name: 'Add ons|Keep Your Drive|3 Year',
        description: '3 Year',
        features: [addOn],
        results: [],
      }],
    });
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(service.http, 'send').mockImplementation(async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      if (request.path === '/solution_modes') return { raw: solutionModes } as never;
      if (request.path === '/services/autoDerive') {
        return { raw: serviceGraphForRequest(graph as typeof serviceGraph, request) } as never;
      }
      if (request.path === '/service_pacs/7D73CTO1WW') {
        return { raw: { services: [serviceFeature, addOn] } } as never;
      }
      if (request.path === '/services/summaries') {
        const body = request.body;
        const items = (body?.kind === 'json'
          ? body.value as Array<{ services?: unknown[] }>
          : [])[0]?.services?.length ?? 0;
        return { raw: { totalPrice: items > 1 ? 1810 : 1637, currency: 'USD' } } as never;
      }
      throw new Error(`Unexpected ${request.path}`);
    });

    const launched = parse(await launchTool(handlers, 'services')({
      productCode: '7D73CTO1WW', subCategory: 'Point of Sale', replace: false,
    }));
    const workspace = String(launched['session']);
    await handler(handlers, 'dcsc_basket_set')({ basket: 'services', action: 'select',
      session: workspace, code: serviceFeature.code, quantity: 1,
    });
    const withAddOn = parse(await handler(handlers, 'dcsc_basket_set')({ basket: 'services', action: 'select',
      session: workspace, code: addOn.code, quantity: 1,
    }));
    expect(withAddOn).toMatchObject({
      selectionSemantics: 'base-plus-add-ons-verified',
      selections: [{ code: serviceFeature.code }, { code: addOn.code }],
      summary: { totalPrice: 1810 },
    });

    const ambiguous = await handler(handlers, 'dcsc_basket_set')({ basket: 'services', action: 'setQuantity', session: workspace, quantity: 2 });
    expect(ambiguous.isError).toBe(true);
    const changed = parse(await handler(handlers, 'dcsc_basket_set')({ basket: 'services', action: 'setQuantity',
      session: workspace, code: addOn.code, quantity: 2,
    }));
    expect(changed).toMatchObject({
      selections: [{ code: serviceFeature.code, quantity: 1 }, { code: addOn.code, quantity: 2 }],
    });

    const removed = parse(await handler(handlers, 'dcsc_basket_set')({ basket: 'services', action: 'remove',
      session: workspace, code: addOn.code,
    }));
    expect(removed).toMatchObject({
      selections: [{ code: serviceFeature.code, quantity: 1 }],
      summary: { totalPrice: 1637 },
    });
    const removal = requests.filter(request => request['path'] === '/services/autoDerive').at(-1);
    expect(removal).toMatchObject({
      body: {
        kind: 'json',
        value: {
          sections: [{ source: 'A la Carte' }],
          delta: { section: 'Add ons' },
        },
      },
    });
  });
});
