import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ConfigSchema } from '../src/config/schema.js';
import {
  generateConfigId,
  retrieveConfigId,
  querySids,
  customizeSid,
} from '../src/domain/configId.js';
import { DcscService } from '../src/mcp/service.js';
import { registerImportExportTools } from '../src/mcp/importExportTools.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import type { RawConfiguration } from '../src/model/types.js';

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
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('Domain: Config ID & SIDs', () => {
  it('generateConfigId requests POST /generateConfigId with controlExpressModal=false and returns 10-char id', async () => {
    const service = createService();
    const ctx = service.newCtx({ solution });
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: 'CIDU00CKWN',
    } as never);

    const result = await generateConfigId(service.http, ctx);
    expect(result).toEqual({ configId: 'CIDU00CKWN' });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'generate_config_id',
        method: 'POST',
        path: '/generateConfigId',
        query: { controlExpressModal: 'false' },
        requiresSolution: false,
      }),
    );
  });

  it('generateConfigId parses json object response if returned by backend', async () => {
    const service = createService();
    const ctx = service.newCtx({ solution });
    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: { configId: 'CIDU99TEST' },
    } as never);

    const result = await generateConfigId(service.http, ctx);
    expect(result).toEqual({ configId: 'CIDU99TEST' });
  });

  it('generateConfigId throws on empty response', async () => {
    const service = createService();
    const ctx = service.newCtx({ solution });
    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: '',
    } as never);

    await expect(generateConfigId(service.http, ctx)).rejects.toThrow('empty or invalid');
  });

  it('retrieveConfigId submits multipart form with existing configurationIds and CTO file type', async () => {
    const service = createService();
    const ctx = service.newCtx({ solution });
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: [{ configuration: [{ id: 'CIDU00CKWN' }], workspace: {} }],
    } as never);

    const payload = await retrieveConfigId(service.http, 'CIDU00CKWN', ['existing-1', 'existing-2'], ctx);
    expect(Array.isArray(payload)).toBe(true);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'retrieve_config_id',
        method: 'POST',
        path: '/retrieve/configId',
        query: {
          configuration_id: 'CIDU00CKWN',
          currentFileType: 'CTO',
        },
        body: {
          kind: 'multipart',
          parts: [
            { name: 'configurationIds', value: 'existing-1' },
            { name: 'configurationIds', value: 'existing-2' },
          ],
        },
        timeoutClass: 'heavy',
      }),
    );
  });

  it('retrieveConfigId throws when upstream returns errorMessage object', async () => {
    const service = createService();
    const ctx = service.newCtx({ solution });
    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: {
        configuration_id: 'CIDU00CKWN',
        errorMessage: 'Unable to import the configID. Please verify the configID',
      },
    } as never);

    await expect(retrieveConfigId(service.http, 'CIDU00CKWN', [], ctx)).rejects.toThrow(
      'Unable to import the configID',
    );
  });

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

describe('Service Integration: Config ID & SIDs', () => {
  it('generateConfigId binds the returned ID to session and workspace serverState', async () => {
    const service = createService();
    const raw: RawConfiguration = {
      id: 'cfg_1',
      sliceCtoCode: '7D73CTO1WW',
      quantity: 1,
      tabs: [],
    };
    const session = service.sessions.create({
      raw,
      configurationId: 'cfg_1',
      locale: service.locale,
      solution,
      mode: 'cto',
      primed: true,
      reduced: reduceConfiguration(raw, 'cfg_1'),
    });

    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: 'CIDU00CKWN',
    } as never);

    const res = await service.generateConfigId(session.id);
    expect(res.configId).toBe('CIDU00CKWN');
    expect(session.raw.userGeneratedConfigId).toBe('CIDU00CKWN');

    const ws = service.sessions.getWorkspace(session.workspaceId);
    expect(ws?.serverState.userGeneratedConfigId).toBe('CIDU00CKWN');
  });

  it('retrieveConfigId ingests upstream payload through the import pipeline and creates workspace session', async () => {
    const service = createService();
    const importPayload = [
      {
        configuration: [
          {
            id: 'US__import_1',
            code: '7D73CTO1WW',
            quantity: 1,
            type: 'server',
            description: 'ThinkSystem SR630 V3',
            tabs: [],
          },
        ],
        workspace: {
          rackArea: [],
          nonRackArea: [{ id: 'US__import_1', quantity: 1, originalIds: ['US__import_1'] }],
        },
        differentPartMap: {},
        missingParts: [],
        removedParts: [],
      },
    ];

    vi.spyOn(service.http, 'send').mockImplementation(async (input) => {
      if (input.path.includes('/racks/customize/non_rack')) {
        return { raw: [{ code: '7D73CTO1WW', uheight: 1, type: 'server' }] } as never;
      }
      if (input.path.includes('/autoDerive') || input.path.includes('/racks/customize')) {
        return { raw: { configurations: importPayload[0]!.configuration, workspace: importPayload[0]!.workspace } } as never;
      }
      return { raw: importPayload } as never;
    });

    const result = await service.retrieveConfigId('CIDU00CKWN');
    expect(result.workspaceId).toBeDefined();
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.product.code).toBe('7D73CTO1WW');

    const ws = service.sessions.getWorkspace(result.workspaceId);
    expect(ws).toBeDefined();
    expect(ws!.configurations.size).toBe(1);
  });
});

describe('MCP Tools: Config ID & SIDs', () => {
  it('dcsc_export configId returns configId and binds to handle', async () => {
    const service = createService();
    const client = await createMcpClient(service);

    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: 'CIDU888888',
    } as never);

    const res = await client.callTool({
      name: 'dcsc_export',
      arguments: { kind: 'configId' },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ type: 'text'; text: string }>)[0]!.text) as Obj;
    expect(parsed['configId']).toBe('CIDU888888');
  });

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
      arguments: { kind: 'sids', categoryId: 'servers', offset: 0, limit: 10 },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ type: 'text'; text: string }>)[0]!.text) as Obj;
    expect(parsed['categoryId']).toBe('servers');
    expect(parsed['totalElements']).toBe(1);
    expect((parsed['content'] as Obj[])[0]!['sidNumber']).toBe('SID999');
  });

  it('dcsc_import with configId retrieves and imports saved configuration', async () => {
    const service = createService();
    const client = await createMcpClient(service);

    const importPayload = [
      {
        configuration: [
          {
            id: 'US__import_2',
            code: '7D73CTO1WW',
            quantity: 1,
            type: 'server',
            description: 'ThinkSystem SR630 V3',
            tabs: [],
          },
        ],
        workspace: {
          rackArea: [],
          nonRackArea: [{ id: 'US__import_2', quantity: 1, originalIds: ['US__import_2'] }],
        },
        differentPartMap: {},
        missingParts: [],
        removedParts: [],
      },
    ];

    vi.spyOn(service.http, 'send').mockImplementation(async (input) => {
      if (input.path.includes('/racks/customize/non_rack')) {
        return { raw: [{ code: '7D73CTO1WW', uheight: 1, type: 'server' }] } as never;
      }
      if (input.path.includes('/autoDerive') || input.path.includes('/racks/customize')) {
        return { raw: { configurations: importPayload[0]!.configuration, workspace: importPayload[0]!.workspace } } as never;
      }
      return { raw: importPayload } as never;
    });

    const res = await client.callTool({
      name: 'dcsc_import',
      arguments: { configId: 'CIDU00CKWN' },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ type: 'text'; text: string }>)[0]!.text) as Obj;
    expect(parsed['importedConfigurations']).toBe(1);
    expect(parsed['session']).toBeDefined();
  });
});
