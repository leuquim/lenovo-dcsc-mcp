import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ConfigSchema } from '../src/config/schema.js';
import {
  querySids,
  customizeSid,
} from '../src/domain/configId.js';
import { DcscService } from '../src/mcp/service.js';
import { registerImportExportTools } from '../src/mcp/importExportTools.js';
import { registerCatalogTools } from '../src/mcp/catalogTools.js';

type Obj = Record<string, unknown>;

const services: DcscService[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(services.splice(0).map((s) => s.close()));
});

const solution = {
  solutionMode: 'General Purpose',
  masterSlices: ['GP', 'HPCGPALL'],
};

function createService() {
  const service = new DcscService(
    ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }),
  );
  services.push(service);
  vi.spyOn(service, 'resolveSolution').mockResolvedValue(solution);
  return service;
}

async function createMcpClient(service: DcscService) {
  const server = new McpServer({ name: 'test-lenovo-dcsc', version: '0.1.0' });
  registerImportExportTools(server, service);
  registerCatalogTools(server, service);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('Domain: SIDs', () => {

  it('querySids queries GET /sids/query/${categoryId} with mandatory pageIndex and parses content', async () => {
    const service = createService();
    const ctx = service.newCtx({ solution });
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: {
        content: [
          {
            sidShortDesc: 'ThinkSystem SR650 V3 Solution',
            sidNumber: 'SID123456',
            cpu: ['2x Intel Xeon Gold 6430'],
            ram: ['32x 64GB TruDDR5'],
            storage: ['8x 2.5" SAS 1.2TB'],
            gpu: [],
            network: ['4-port 10/25GbE'],
            ctoCount: 1,
            sidPrice: 15420,
          },
        ],
        totalElements: 42,
        number: 2,
      },
    } as never);

    const res = await querySids(service.http, { categoryId: 'servers', pageIndex: 2, pageSize: 15, sidNumber: '123' }, ctx);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'query_sids',
        method: 'GET',
        path: '/sids/query/servers',
        query: {
          pageIndex: 2,
          pageSize: 15,
          sidNumber: '123',
        },
      }),
    );

    expect(res.totalElements).toBe(42);
    expect(res.number).toBe(2);
    expect(res.content).toHaveLength(1);
    expect(res.content[0]!.sidNumber).toBe('SID123456');
    expect(res.content[0]!.sidPrice).toBe(15420);
  });

  it('customizeSid calls GET /reference_solution/CRNs/${sidNumber}/customize', async () => {
    const service = createService();
    const ctx = service.newCtx({ solution });
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: { crnId: 'SID123', configuration: [] },
    } as never);

    const payload = await customizeSid(service.http, 'SID123', ctx);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'customize_sid',
        method: 'GET',
        path: '/reference_solution/CRNs/SID123/customize',
        timeoutClass: 'heavy',
      }),
    );
    expect(payload).toMatchObject({ crnId: 'SID123' });
  });
});

describe('Domain: SIDs input handling', () => {
  it('encodes the category into the path, rejects blank ids before HTTP, and defaults malformed fields', async () => {
    const service = createService();
    const ctx = service.newCtx({ solution });
    const send = vi.spyOn(service.http, 'send');

    await expect(querySids(service.http, { categoryId: '   ' }, ctx)).rejects.toThrow(/A category ID is required/);
    await expect(customizeSid(service.http, '   ', ctx)).rejects.toThrow(/A non-empty SID number is required/);
    expect(send).not.toHaveBeenCalled();

    send.mockResolvedValueOnce({
      raw: {
        content: [{
          sidShortDesc: 'SID Test', sidNumber: 'SID001', cpu: ['CPU 1'], ram: ['RAM 1'],
          storage: null, gpu: 'not-an-array', network: [], ctoCount: 'invalid-num', sidPrice: null,
        }],
        totalElements: 1,
        number: 1,
      },
    } as never);
    const result = await querySids(
      service.http,
      { categoryId: 'SERVER/STORAGE & SPECIAL?ID', pageIndex: 1, pageSize: 10 },
      ctx,
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/sids/query/SERVER%2FSTORAGE%20%26%20SPECIAL%3FID' }),
    );
    expect(result.content[0]).toMatchObject({ storage: [], gpu: [], ctoCount: 1, sidPrice: 0 });

    send.mockResolvedValueOnce({ raw: ['array-is-not-solution-payload'] } as never);
    await expect(customizeSid(service.http, 'SID_FAIL', ctx)).rejects.toThrow(
      /returned no customizable reference solution/,
    );
  });
});

describe('MCP Tools: SIDs', () => {

  it('dcsc_search sids returns paginated SID list', async () => {
    const service = createService();
    const client = await createMcpClient(service);

    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: {
        content: [
          {
            sidShortDesc: 'ThinkSystem SR650 V3 SID',
            sidNumber: 'SID999',
            cpu: ['2x Xeon'],
            ram: ['16x 32GB'],
            storage: [],
            gpu: [],
            network: [],
            ctoCount: 1,
            sidPrice: 12000,
          },
        ],
        totalElements: 1,
        number: 1,
      },
    } as never);

    const res = await client.callTool({
      name: 'dcsc_search',
      arguments: { search: { kind: 'sids', categoryId: 'servers', offset: 0, limit: 10 } },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ type: 'text'; text: string }>)[0]!.text) as Obj;
    expect(parsed['categoryId']).toBe('servers');
    expect(parsed['totalElements']).toBe(1);
    expect((parsed['content'] as Obj[])[0]!['sidNumber']).toBe('SID999');
  });
});
