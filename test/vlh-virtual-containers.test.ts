import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import { registerVlhTools } from '../src/mcp/vlhTools.js';
import { buildVlhExportForm, importVlhItems, fetchVlhAttributes, fetchVlhWizardInfo, type VlhAttributes, type VlhWizardInfo } from '../src/domain/vlh.js';
import {
  checkVirtualContainerRules,
  fetchVirtualContainerCompatibleProducts,
  type VirtualContainerCompatibleCategory,
} from '../src/domain/virtualContainers.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { buildVlhItem } from '../src/app/vlh.js';

const mockWizardInfo: VlhWizardInfo = {
  networkTopologyConnectorsMap: {
    '100GbE_Copper': [{ shortName: 'QSFP28', description: 'QSFP28 Copper', type: 'Connector' }],
    '1GbE_Copper': [{ shortName: 'RJ45', description: 'RJ45 Copper', type: 'Connector' }],
  },
  connectorFunctions: [
    { shortName: 'Console', description: 'Console' },
    { shortName: 'Network', description: 'Network' },
    { shortName: 'Power', description: 'Power' },
  ],
  networkTopologies: ['100GbE_Copper', '1GbE_Copper'],
  rpqPlaceholders: ['None', 'RPQ-WATER-LOOP-1'],
};

const mockAttributes: VlhAttributes = {
  type: 'server',
  attributes: {
    PRODUCT_TYPE: 'SERVER',
    HEIGHT_EIA: '1',
    EIA_U_CAPACITY: 42,
    CONNECTORPORT: 2,
  },
  connectors: [
    { networkTopology: '100GbE_Copper', connector: 'QSFP28', connectorFunction: 'Network', quantity: 2 },
  ],
};

const mockCategories: VirtualContainerCompatibleCategory[] = [
  {
    id: 'vc-cat-1',
    compatibleProducts: [
      { code: '7D73CTO1WW', description: 'ThinkSystem SR650 V3', type: 'server' },
    ],
  },
];

const mockRules: unknown[] = [
  { ruleId: 'vc-rule-01', result: 'PASS', description: 'Enclosure power budget satisfied' },
];

function textContent(res: unknown): string {
  if (res && typeof res === 'object' && 'content' in res && Array.isArray((res as { content: unknown[] }).content)) {
    const first = (res as { content: Array<{ type?: string; text?: string }> }).content[0];
    return first?.text ?? '';
  }
  return '';
}

describe('VLH and Virtual Containers domain & MCP tools', () => {
  const clients: Client[] = [];
  const services: DcscService[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await Promise.all(services.splice(0).map((s) => s.close()));
    vi.restoreAllMocks();
  });

  function createTestService(): DcscService {
    const service = new DcscService(
      ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }),
    );
    services.push(service);
    return service;
  }

  async function createConnectedVlhHarness(service: DcscService) {
    const server = new McpServer({ name: 'lenovo-dcsc-vlh-test', version: '0.1.0' });
    registerVlhTools(server, service);
    const client = new Client({ name: 'test-vlh-client', version: '1.0.0' });
    clients.push(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { server, client };
  }

  function setupWorkspace(service: DcscService) {
    const locale = { country: 'US', geo: 'NA', language: 'en', currency: 'USD' };
    const solution = { solutionMode: 'General Purpose', masterSlices: ['GP'] };
    const sourceRaw = {
      id: 'ws-root-config',
      workspaceId: 'ws-root-config',
      sliceCtoCode: '7D73CTO1WW',
      code: '7D73CTO1WW',
      type: 'server',
      name: 'Test Server',
      quantity: 1,
      tabs: [],
    };
    const session = service.sessions.create({
      locale,
      solution,
      mode: 'cto',
      raw: sourceRaw,
      configurationId: 'ws-root-config',
      reduced: reduceConfiguration(sourceRaw, 'ws-root-config'),
      primed: true,
    });
    const workspace = service.sessions.getWorkspace(session.workspaceId)!;
    workspace.nonRackArea = [
      { id: 'ws-root-config', code: '7D73CTO1WW', type: 'server', size: 1, quantity: 1 },
    ];
    return { session, workspace };
  }

  describe('domain: vlh', () => {
    it('fetchVlhWizardInfo retrieves network topologies, connector functions, and RPQ placeholders', async () => {
      const service = createTestService();
      const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValueOnce({
        status: 200,
        headers: {},
        raw: mockWizardInfo,
      } as never);

      const ctx = service.newCtx();
      const result = await fetchVlhWizardInfo(service.http, ctx);

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'vlh.wizardInfo',
          method: 'GET',
          path: '/vlh/wizardInfo',
          responseKind: 'json',
        }),
      );
      expect(result).toEqual(mockWizardInfo);
      expect(result.networkTopologies).toContain('100GbE_Copper');
      expect(result.rpqPlaceholders).toContain('RPQ-WATER-LOOP-1');
    });

    it('fetchVlhAttributes queries physical dimensions and connectors for a valid product code', async () => {
      const service = createTestService();
      const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValueOnce({
        status: 200,
        headers: {},
        raw: mockAttributes,
      } as never);

      const ctx = service.newCtx();
      const result = await fetchVlhAttributes(service.http, '7D73CTO1WW', ctx);

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'vlh.attributes',
          method: 'GET',
          path: '/vlh/attributes/7D73CTO1WW',
          responseKind: 'json',
        }),
      );
      expect(result.type).toBe('server');
      expect(result.attributes.PRODUCT_TYPE).toBe('SERVER');
      expect(result.connectors).toHaveLength(1);
    });

    it('fetchVlhAttributes rejects empty product code', async () => {
      const service = createTestService();
      const ctx = service.newCtx();
      await expect(fetchVlhAttributes(service.http, '', ctx)).rejects.toThrow(
        /non-empty product or VLH item code is required/i,
      );
    });
  });

  describe('domain: virtualContainers', () => {
    it('fetchVirtualContainerCompatibleProducts posts autoDerive wire envelope', async () => {
      const service = createTestService();
      const { workspace } = setupWorkspace(service);
      const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValueOnce({
        status: 200,
        headers: {},
        raw: mockCategories,
      } as never);

      const ctx = service.newCtx();
      const result = await fetchVirtualContainerCompatibleProducts(service.http, workspace, ctx);

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'virtualContainers.compatibleProducts',
          method: 'POST',
          path: '/virtual-containers/getCompatibleProductsForVirtualContainer',
          responseKind: 'json',
        }),
      );
      expect(result).toEqual(mockCategories);
      expect(result[0]!.compatibleProducts[0]!.code).toBe('7D73CTO1WW');
    });

    it('checkVirtualContainerRules posts autoDerive wire envelope to checkIfAnythingNeedUpdate', async () => {
      const service = createTestService();
      const { workspace } = setupWorkspace(service);
      const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValueOnce({
        status: 200,
        headers: {},
        raw: mockRules,
      } as never);

      const ctx = service.newCtx();
      const result = await checkVirtualContainerRules(service.http, workspace, ctx);

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'virtualContainers.checkIfAnythingNeedUpdate',
          method: 'POST',
          path: '/virtual-containers/checkIfAnythingNeedUpdate',
          responseKind: 'json',
        }),
      );
      expect(result).toEqual(mockRules);
    });
  });

  describe('mcp: vlhTools', () => {
    it('registers both tools on the MCP server', async () => {
      const service = createTestService();
      const { client } = await createConnectedVlhHarness(service);

      const { tools } = await client.listTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain('dcsc_vlh_get');
      expect(toolNames).toContain('dcsc_virtual_container_get');
    });

    it('dcsc_vlh_get executes and returns wizard data', async () => {
      const service = createTestService();
      vi.spyOn(service.http, 'send').mockResolvedValueOnce({
        status: 200,
        headers: {},
        raw: mockWizardInfo,
      } as never);
      const { client } = await createConnectedVlhHarness(service);

      const res = await client.callTool({
        name: 'dcsc_vlh_get',
        arguments: {},
      });

      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(textContent(res));
      expect(parsed).toEqual(mockWizardInfo);
    });

    it('dcsc_vlh_get with a code executes and returns physical specifications', async () => {
      const service = createTestService();
      vi.spyOn(service.http, 'send').mockResolvedValueOnce({
        status: 200,
        headers: {},
        raw: mockAttributes,
      } as never);
      const { client } = await createConnectedVlhHarness(service);

      const res = await client.callTool({
        name: 'dcsc_vlh_get',
        arguments: { code: '7D73CTO1WW' },
      });

      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(textContent(res));
      expect(parsed.type).toBe('server');
      expect(parsed.attributes.PRODUCT_TYPE).toBe('SERVER');
    });

    it('builds the captured Export Items form for a default basic item', () => {
      const item = buildVlhItem({ vlhType: 'basic', description: 'New Item', vlhId: 'e90a62ab-670c-4e0d-b297-eaa2157679f9' });
      expect(new URLSearchParams(buildVlhExportForm([item])).toString()).toBe(
        'data=%5B%7B%22commonInfo%22%3A%7B%22description%22%3A%22New+Item%22%2C%22listPrice%22%3A0%2C%22productType%22%3A%22VLH%22%7D%2C' +
        '%22vlhId%22%3A%22e90a62ab-670c-4e0d-b297-eaa2157679f9%22%2C%22vlhType%22%3A%22basic%22%2C%22connectors%22%3A%5B%5D%2C' +
        '%22attributes%22%3A%5B%5D%2C%22bundledParts%22%3A%5B%7B%7D%5D%7D%5D&crnId=&userGeneratedConfigId=&lfoCode=&cancelDownload=false' +
        '&multipleProductData=&excelData=&groups=&integrationParams=&image=&user=&dcsc-isFromIntegration=false&serviceAndorRequest=&uuid=');
    });

    it('dcsc_vlh_set posts the form to /vlh/export/xml and returns the stored .vlh path', async () => {
      const artifactDir = mkdtempSync(path.join(tmpdir(), 'dcsc-vlh-'));
      const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false, artifactDir }, logLevel: 'silent' }));
      services.push(service);
      const xml = '<?xml version="1.0" encoding="UTF-8"?><VLHData><VLH><VLHID>x</VLHID></VLH></VLHData>';
      const send = vi.spyOn(service.http, 'send').mockResolvedValueOnce({ status: 200, headers: {}, stream: Readable.from([Buffer.from(xml)]) } as never);
      const { client } = await createConnectedVlhHarness(service);

      const res = await client.callTool({ name: 'dcsc_vlh_set', arguments: { items: [{ description: 'New Item' }], fileName: 'items' } });

      expect(res.isError).toBeFalsy();
      const stored = JSON.parse(textContent(res)) as { path: string };
      expect(stored.path.endsWith('items.vlh')).toBe(true);
      expect(readFileSync(stored.path, 'utf8')).toBe(xml);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/vlh/export/xml', responseKind: 'stream' }));
    });

    it('dcsc_virtual_container_get executes compatibleProducts', async () => {
      const service = createTestService();
      const { workspace } = setupWorkspace(service);
      vi.spyOn(service.http, 'send').mockResolvedValue({
        status: 200,
        headers: {},
        raw: mockCategories,
      } as never);
      const { client } = await createConnectedVlhHarness(service);

      const resSession = await client.callTool({
        name: 'dcsc_virtual_container_get',
        arguments: { session: workspace.id, check: 'compatibleProducts' },
      });
      expect(resSession.isError).toBeFalsy();
      const parsedSession = JSON.parse(textContent(resSession));
      expect(parsedSession.session).toBe(workspace.id);
      expect(parsedSession.categories).toEqual(mockCategories);
    });

    it('dcsc_virtual_container_get enforces expectedRevision CAS check', async () => {
      const service = createTestService();
      const { workspace } = setupWorkspace(service);
      const { client } = await createConnectedVlhHarness(service);

      const res = await client.callTool({
        name: 'dcsc_virtual_container_get',
        arguments: { session: workspace.id, expectedRevision: 9999, check: 'compatibleProducts' },
      });

      expect(res.isError).toBe(true);
      const text = textContent(res);
      expect(text).toMatch(/revision conflict/i);
    });

    it('dcsc_virtual_container_get rules executes and handles missing workspace cleanly', async () => {
      const service = createTestService();
      const { workspace } = setupWorkspace(service);
      vi.spyOn(service.http, 'send').mockResolvedValueOnce({
        status: 200,
        headers: {},
        raw: mockRules,
      } as never);
      const { client } = await createConnectedVlhHarness(service);

      const res = await client.callTool({
        name: 'dcsc_virtual_container_get',
        arguments: { session: workspace.id, check: 'rules' },
      });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(textContent(res));
      expect(parsed.rules).toEqual(mockRules);

      // Missing workspace session
      const resMissing = await client.callTool({
        name: 'dcsc_virtual_container_get',
        arguments: { session: 'nonexistent-session-id', check: 'rules' },
      });
      expect(resMissing.isError).toBe(true);
      const missingText = textContent(resMissing);
      expect(missingText).toContain('Workspace session nonexistent-session-id not found');
    });
  });
});

it('importVlhItems posts the captured multipart request with the vlhXmlFile part', async () => {
  const send = vi.fn().mockResolvedValue({ raw: { ok: true } });
  const content = new TextEncoder().encode('<VLHData/>');
  await importVlhItems({ send } as never, { fileName: 'vlh.vlh', content }, {} as never);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/vlh/import', requiresSolution: false,
    body: { kind: 'multipart', parts: [{ name: 'vlhXmlFile', filename: 'vlh.vlh', contentType: 'application/octet-stream', content }] } }));
});
