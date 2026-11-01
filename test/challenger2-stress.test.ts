import { describe, expect, it, vi } from 'vitest';
import { fetchSpecialtyCatalog, fetchConvergedCategoryDetail } from '../src/domain/specialtyCatalog.js';
import { flatten } from '../src/domain/catalog.js';
import { buildExportData, reduceConfiguration } from '../src/domain/reduce.js';
import { SessionStore } from '../src/session/SessionStore.js';
import type { WorkspaceSession } from '../src/model/session.js';
import { fetchVlhAttributes } from '../src/domain/vlh.js';
import { fetchVirtualContainerCompatibleProducts, checkVirtualContainerRules } from '../src/domain/virtualContainers.js';
import type { DcscHttpClient, RequestCtx } from '../src/http/request.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';
import { ConfigSchema } from '../src/config/schema.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expandImportedClones } from '../src/domain/importClones.js';
import type { CategoryNode } from '../src/schemas/catalog.js';
import type { RawConfiguration } from '../src/model/types.js';

type Obj = Record<string, unknown>;

const mockCtx: RequestCtx = {
  corrId: 'corr-challenge-test',
  locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
};

describe('Adversarial Challenge: Specialty Catalogs', () => {
  it('handles empty, nullish, or deeply nested CategoryNode structures safely', () => {
    // 1. Empty tree
    expect(flatten([])).toEqual([]);

    // 2. Nodes with nullish or missing products and children
    const weirdTree: CategoryNode[] = [
      {
        id: 'node-empty',
        name: null,
        products: null,
        children: null,
      },
      {
        id: 'node-no-prod',
        name: 'Empty Category',
        products: [],
        children: [
          {
            id: 'subnode-1',
            name: undefined,
            products: [
              {
                code: 'PROD-1',
                description: undefined,
                type: undefined,
                withdrawnDate: undefined,
              },
            ],
          },
        ],
      },
    ];
    const entries = flatten(weirdTree);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.code).toBe('PROD-1');
    expect(entries[0]?.description).toBe('');
    expect(entries[0]?.path).toEqual(['Empty Category', 'subnode-1']);
    expect(entries[0]?.type).toBe('LFO'); // fallback when cto is false/undefined
    expect(entries[0]?.withdrawn).toBe(false);
  });

  it('rejects invalid or blank categoryId for converged category detail', async () => {
    const mockHttp = {
      send: vi.fn(),
    } as unknown as DcscHttpClient;

    await expect(fetchConvergedCategoryDetail(mockHttp, mockCtx, '')).rejects.toThrow(
      /non-empty categoryId is required/i,
    );
    await expect(fetchConvergedCategoryDetail(mockHttp, mockCtx, '   ')).rejects.toThrow(
      /non-empty categoryId is required/i,
    );
  });

  it('handles malformed converged category detail responses from upstream', async () => {
    const mockHttp = {
      send: vi.fn().mockResolvedValue({ raw: null }),
    } as unknown as DcscHttpClient;

    await expect(fetchConvergedCategoryDetail(mockHttp, mockCtx, 'CAT-123')).rejects.toThrow(
      /invalid converged category detail/i,
    );

    const mockHttpArray = {
      send: vi.fn().mockResolvedValue({ raw: ['unexpected', 'array'] }),
    } as unknown as DcscHttpClient;

    await expect(fetchConvergedCategoryDetail(mockHttpArray, mockCtx, 'CAT-123')).rejects.toThrow(
      /invalid converged category detail/i,
    );
  });

  it('handles unexpected empty promotion hierarchy payloads gracefully', async () => {
    const mockHttp = {
      send: vi.fn().mockResolvedValue({ raw: null }),
    } as unknown as DcscHttpClient;

    const res = await fetchSpecialtyCatalog(mockHttp, mockCtx, {
      type: 'promotion',
      subType: 'hierarchies',
    });
    expect(res.type).toBe('promotion');
    if (res.type === 'promotion') {
      expect(res.data).toEqual({});
    }
  });

  it('handles unexpected categoryId in promotion option subType cleanly', async () => {
    const mockHttp = {
      send: vi.fn().mockResolvedValue({ raw: { options: [] } }),
    } as unknown as DcscHttpClient;

    const res = await fetchSpecialtyCatalog(mockHttp, mockCtx, {
      type: 'promotion',
      subType: 'option',
      categoryId: 'SPECIAL-OPT-CAT',
    });
    expect(res.type).toBe('promotion');
    expect(mockHttp.send).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { categoryId: 'SPECIAL-OPT-CAT' },
      }),
    );
  });
});

describe('Adversarial Challenge: Unracked Multi-Unit Export Auto-Expansion', () => {
  const locale = { country: 'US', geo: 'NA', language: 'en', currency: 'USD' };
  const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };

  function buildWorkspace(items: Array<{ id: string; quantity: number }>): WorkspaceSession {
    const sessions = new SessionStore();
    let workspaceId: string | undefined;

    for (const item of items) {
      const raw: RawConfiguration = {
        id: item.id,
        workspaceId: item.id,
        sliceCtoCode: '7D73CTO1WW',
        code: '7D73CTO1WW',
        type: 'server',
        name: `Server ${item.id}`,
        quantity: item.quantity,
        tabs: [],
      };
      const session = sessions.create({
        locale,
        solution,
        mode: 'cto',
        raw,
        configurationId: item.id,
        reduced: reduceConfiguration(raw, item.id),
        primed: true,
        ...(workspaceId ? { workspaceId } : {}),
      });
      workspaceId = session.workspaceId;
    }

    const ws = sessions.getWorkspace(workspaceId!)!;
    ws.nonRackArea = items.map(item => ({
      id: item.id,
      code: '7D73CTO1WW',
      type: 'server',
      size: 1,
      quantity: item.quantity,
      originalIds: [item.id],
    }));
    return ws;
  }

  it('quantity = 1: produces exactly 1 physical record with no clones', () => {
    const ws = buildWorkspace([{ id: 'single', quantity: 1 }]);
    const exported = buildExportData({
      workspace: ws,
      solution,
      fileTypes: ['XML'],
      validationMode: 'guided',
    });

    const info = exported.workspaceInformation as Obj;
    const nonRackData = info['nonRackData'] as Obj[];
    expect(nonRackData).toHaveLength(1);
    expect(nonRackData[0]?.['id']).toBe('single');
    expect(nonRackData[0]?.['quantity']).toBe(1);

    const space = exported.workspace as Obj;
    const nonRackArea = space['nonRackArea'] as Obj[];
    expect(nonRackArea).toHaveLength(1);
    expect(nonRackArea[0]?.['id']).toBe('single');
    expect(nonRackArea[0]?.['quantity']).toBe(1);
    expect(nonRackArea[0]?.['originalIds']).toEqual(['single']);
  });

  it('quantity = 2: expands to root + 1 synthetic clone (__clone_1)', () => {
    const ws = buildWorkspace([{ id: 'pair', quantity: 2 }]);
    const exported = buildExportData({
      workspace: ws,
      solution,
      fileTypes: ['XML'],
      validationMode: 'guided',
    });

    const info = exported.workspaceInformation as Obj;
    const nonRackData = info['nonRackData'] as Obj[];
    expect(nonRackData).toHaveLength(2);
    expect(nonRackData.map(r => r['id'])).toEqual(['pair', 'pair__clone_1']);
    expect(nonRackData.every(r => r['quantity'] === 1)).toBe(true);

    const space = exported.workspace as Obj;
    const nonRackArea = space['nonRackArea'] as Obj[];
    expect(nonRackArea).toHaveLength(1);
    expect(nonRackArea[0]?.['quantity']).toBe(2);
    expect(nonRackArea[0]?.['originalIds']).toEqual(['pair', 'pair__clone_1']);

    const cloneDep = info['cloneDependency'];
    expect(cloneDep).toEqual({ pair: ['pair', 'pair__clone_1'] });
  });

  it('quantity = 10: expands to root + 9 synthetic clones (__clone_1 through __clone_9)', () => {
    const ws = buildWorkspace([{ id: 'ten', quantity: 10 }]);
    const exported = buildExportData({
      workspace: ws,
      solution,
      fileTypes: ['XML'],
      validationMode: 'guided',
    });

    const info = exported.workspaceInformation as Obj;
    const nonRackData = info['nonRackData'] as Obj[];
    expect(nonRackData).toHaveLength(10);
    const expectedIds = ['ten', ...Array.from({ length: 9 }, (_, i) => `ten__clone_${i + 1}`)];
    expect(nonRackData.map(r => r['id'])).toEqual(expectedIds);
    expect(nonRackData.every(r => r['quantity'] === 1)).toBe(true);

    const space = exported.workspace as Obj;
    const nonRackArea = space['nonRackArea'] as Obj[];
    expect(nonRackArea).toHaveLength(1);
    expect(nonRackArea[0]?.['quantity']).toBe(10);
    expect(nonRackArea[0]?.['originalIds']).toEqual(expectedIds);

    const cloneDep = info['cloneDependency'];
    expect(cloneDep).toEqual({ ten: expectedIds });
  });

  it('multiple unracked items with mixed quantities (e.g. qty 1, qty 3, qty 2)', () => {
    const ws = buildWorkspace([
      { id: 'itemA', quantity: 1 },
      { id: 'itemB', quantity: 3 },
      { id: 'itemC', quantity: 2 },
    ]);
    const exported = buildExportData({
      workspace: ws,
      solution,
      fileTypes: ['XML'],
      validationMode: 'guided',
    });

    const info = exported.workspaceInformation as Obj;
    const nonRackData = info['nonRackData'] as Obj[];
    // 1 (itemA) + 3 (itemB, itemB__clone_1, itemB__clone_2) + 2 (itemC, itemC__clone_1) = 6 records
    expect(nonRackData).toHaveLength(6);
    expect(new Set(nonRackData.map(r => r['id']))).toEqual(
      new Set(['itemA', 'itemB', 'itemB__clone_1', 'itemB__clone_2', 'itemC', 'itemC__clone_1']),
    );

    const space = exported.workspace as Obj;
    const nonRackArea = space['nonRackArea'] as Obj[];
    expect(nonRackArea).toHaveLength(3);
    expect(nonRackArea.find(a => a['id'] === 'itemA')?.['originalIds']).toEqual(['itemA']);
    expect(nonRackArea.find(a => a['id'] === 'itemB')?.['originalIds']).toEqual([
      'itemB',
      'itemB__clone_1',
      'itemB__clone_2',
    ]);
    expect(nonRackArea.find(a => a['id'] === 'itemC')?.['originalIds']).toEqual([
      'itemC',
      'itemC__clone_1',
    ]);
  });

  it('HPC and AI - Systems mode: clones configuration objects in configurations array with quantity 1', () => {
    const ws = buildWorkspace([{ id: 'hpc-node', quantity: 3 }]);
    const aiSolution = { solutionMode: 'HPC and AI - Systems', masterSlices: ['HPCGP'] };
    const exported = buildExportData({
      workspace: ws,
      solution: aiSolution,
      fileTypes: ['XML'],
      validationMode: 'guided',
    });

    const configs = exported.configurations as Obj[];
    expect(configs).toHaveLength(3);
    expect(configs.map(c => c['id'])).toEqual(['hpc-node', 'hpc-node__clone_1', 'hpc-node__clone_2']);
    expect(configs.every(c => c['quantity'] === 1)).toBe(true);

    // Verify round-trip compatibility with expandImportedClones for compressed import
    const info = exported.workspaceInformation as Obj;
    const compressedPayload: Obj = {
      configuration: [configs[0]],
      workspace: exported.workspace,
      cloneDependency: info['cloneDependency'],
      cloneDependencyColor: exported.cloneDependencyColor,
    };
    const imported = expandImportedClones(compressedPayload);
    const importedConfigs = imported['configuration'] as Obj[];
    expect(importedConfigs).toHaveLength(3);
    expect(importedConfigs.map(c => c['id'])).toEqual([
      'hpc-node',
      'hpc-node__clone_1',
      'hpc-node__clone_2',
    ]);
  });

  it('extreme scale: quantity = 100 produces 100 unique physical records without memory or data corruption', () => {
    const ws = buildWorkspace([{ id: 'cluster-node', quantity: 100 }]);
    const exported = buildExportData({
      workspace: ws,
      solution,
      fileTypes: ['XML'],
      validationMode: 'guided',
    });

    const info = exported.workspaceInformation as Obj;
    const nonRackData = info['nonRackData'] as Obj[];
    expect(nonRackData).toHaveLength(100);
    const uniqueIds = new Set(nonRackData.map(r => r['id']));
    expect(uniqueIds.size).toBe(100);
    expect(uniqueIds.has('cluster-node')).toBe(true);
    expect(uniqueIds.has('cluster-node__clone_1')).toBe(true);
    expect(uniqueIds.has('cluster-node__clone_99')).toBe(true);

    const space = exported.workspace as Obj;
    const nonRackArea = space['nonRackArea'] as Obj[];
    expect(nonRackArea[0]?.['quantity']).toBe(100);
    expect((nonRackArea[0]?.['originalIds'] as unknown[])).toHaveLength(100);
  });

  it('racked configurations are isolated from unracked loose auto-expansion', () => {
    const ws = buildWorkspace([{ id: 'racked-server', quantity: 1 }]);
    // Move from nonRackArea to rackArea
    ws.nonRackArea = [];
    ws.rackArea = [
      {
        id: 'rack-1',
        code: '7D6WCTO1WW',
        type: 'rack',
        rackItems: [
          {
            id: 'racked-server',
            code: '7D73CTO1WW',
            type: 'server',
            position: 10,
            size: 1,
            quantity: 1,
            originalIds: ['racked-server'],
          },
        ],
      },
    ];

    const exported = buildExportData({
      workspace: ws,
      solution,
      fileTypes: ['XML'],
      validationMode: 'guided',
    });

    // nonRackData should NOT contain racked-server
    const info = exported.workspaceInformation as Obj;
    const nonRackData = info['nonRackData'] as Obj[];
    expect(nonRackData).toHaveLength(0);

    // rackData must contain the racked server
    const rackData = info['rackData'] as Obj[];
    expect(rackData).toHaveLength(1);
    const rackItems = rackData[0]?.['rackItems'] as Obj[];
    expect(rackItems).toHaveLength(1);
    expect(rackItems[0]?.['id']).toBe('racked-server');
  });

  it('idempotency: successive buildExportData calls produce deterministic and identical clone graphs', () => {
    const ws = buildWorkspace([{ id: 'idem-node', quantity: 4 }]);
    const export1 = buildExportData({
      workspace: ws,
      solution,
      fileTypes: ['XML'],
      validationMode: 'guided',
    });
    const export2 = buildExportData({
      workspace: ws,
      solution,
      fileTypes: ['XML'],
      validationMode: 'guided',
    });

    expect(export1.workspaceInformation).toEqual(export2.workspaceInformation);
    expect(export1.workspace).toEqual(export2.workspace);
    expect(export1.cloneDependencyColor).toEqual(export2.cloneDependencyColor);
  });
});

describe('Adversarial Challenge: VLH and Virtual Containers', () => {
  it('fetchVlhAttributes rejects missing or empty code', async () => {
    const mockHttp = { send: vi.fn() } as unknown as DcscHttpClient;
    await expect(fetchVlhAttributes(mockHttp, '', mockCtx)).rejects.toThrow(
      /non-empty product or VLH item code is required/i,
    );
  });

  it('fetchVlhAttributes correctly encodes special characters in code', async () => {
    const mockHttp = {
      send: vi.fn().mockResolvedValue({ raw: { type: 'server', attributes: {}, connectors: [] } }),
    } as unknown as DcscHttpClient;

    const res = await fetchVlhAttributes(mockHttp, 'PROD/SPECIAL#1', mockCtx);
    expect(mockHttp.send).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/vlh/attributes/PROD%2FSPECIAL%231',
      }),
    );
    expect(res.type).toBe('server');
  });

  it('fetchVirtualContainerCompatibleProducts handles empty responses safely', async () => {
    const mockHttp = {
      send: vi.fn().mockResolvedValue({ raw: null }),
    } as unknown as DcscHttpClient;
    const sessions = new SessionStore();
    const dummyRaw: RawConfiguration = {
      id: 'root',
      code: '7D73CTO1WW',
      type: 'server',
      quantity: 1,
      tabs: [],
    };
    const ws = sessions.getWorkspace(sessions.create({
      locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
      solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
      mode: 'cto',
      raw: dummyRaw,
      configurationId: 'root',
      reduced: reduceConfiguration(dummyRaw, 'root'),
      primed: true,
    }).id)!;

    const products = await fetchVirtualContainerCompatibleProducts(mockHttp, ws, mockCtx);
    expect(products).toEqual([]);
  });

  it('checkVirtualContainerRules handles empty responses safely', async () => {
    const mockHttp = {
      send: vi.fn().mockResolvedValue({ raw: null }),
    } as unknown as DcscHttpClient;
    const sessions = new SessionStore();
    const dummyRaw: RawConfiguration = {
      id: 'root',
      code: '7D73CTO1WW',
      type: 'server',
      quantity: 1,
      tabs: [],
    };
    const ws = sessions.getWorkspace(sessions.create({
      locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' },
      solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
      mode: 'cto',
      raw: dummyRaw,
      configurationId: 'root',
      reduced: reduceConfiguration(dummyRaw, 'root'),
      primed: true,
    }).id)!;

    const rules = await checkVirtualContainerRules(mockHttp, ws, mockCtx);
    expect(rules).toEqual([]);
  });
});

describe('Adversarial Challenge: Tool Ergonomics & Character Budget', () => {
  it('verifies total tool description character count is strictly below 28,000 characters', async () => {
    const service = new DcscService(
      ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }),
    );
    const server = new McpServer({ name: 'lenovo-dcsc', version: '0.1.0' });
    registerTools(server, service);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    let totalDescChars = 0;
    for (const t of tools) {
      totalDescChars += (t.description ?? '').length;
    }

    console.log(`[CHALLENGE EMPIRICAL METRIC] Tool count: ${tools.length}, Total description characters: ${totalDescChars}`);

    expect(tools.length).toBeGreaterThanOrEqual(100);
    expect(totalDescChars).toBeLessThan(28_000);

    await client.close();
    await service.close();
  });
});
