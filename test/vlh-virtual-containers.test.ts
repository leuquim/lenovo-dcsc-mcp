import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import { registerVlhTools } from '../src/mcp/vlhTools.js';
import { fetchVlhAttributes, fetchVlhWizardInfo, type VlhAttributes, type VlhWizardInfo } from '../src/domain/vlh.js';
import {
  checkVirtualContainerRules,
  fetchVirtualContainerCompatibleProducts,
  type VirtualContainerCompatibleCategory,
} from '../src/domain/virtualContainers.js';
import { reduceConfiguration } from '../src/domain/reduce.js';

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
    it('registers all 4 tools on the MCP server', async () => {
      const service = createTestService();
      const { client } = await createConnectedVlhHarness(service);

      const { tools } = await client.listTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain('dcsc_vlh_wizard_info');
      expect(toolNames).toContain('dcsc_vlh_attributes');
      expect(toolNames).toContain('dcsc_virtual_container_compatible_products');
      expect(toolNames).toContain('dcsc_virtual_container_check_rules');
    });

    it('dcsc_vlh_wizard_info executes and returns wizard data', async () => {
      const service = createTestService();
      vi.spyOn(service.http, 'send').mockResolvedValueOnce({
        status: 200,
        headers: {},
        raw: mockWizardInfo,
      } as never);
      const { client } = await createConnectedVlhHarness(service);

      const res = await client.callTool({
        name: 'dcsc_vlh_wizard_info',
        arguments: {},
      });

      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(textContent(res));
      expect(parsed).toEqual(mockWizardInfo);
    });

    it('dcsc_vlh_attributes executes and returns physical specifications', async () => {
      const service = createTestService();
      vi.spyOn(service.http, 'send').mockResolvedValueOnce({
        status: 200,
        headers: {},
        raw: mockAttributes,
      } as never);
      const { client } = await createConnectedVlhHarness(service);

      const res = await client.callTool({
        name: 'dcsc_vlh_attributes',
        arguments: { code: '7D73CTO1WW' },
      });

      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(textContent(res));
      expect(parsed.type).toBe('server');
      expect(parsed.attributes.PRODUCT_TYPE).toBe('SERVER');
    });

    it('dcsc_virtual_container_compatible_products executes and supports parameter aliasing', async () => {
      const service = createTestService();
      const { workspace } = setupWorkspace(service);
      vi.spyOn(service.http, 'send').mockResolvedValue({
        status: 200,
        headers: {},
        raw: mockCategories,
      } as never);
      const { client } = await createConnectedVlhHarness(service);

      // Call using 'session' parameter
      const resSession = await client.callTool({
        name: 'dcsc_virtual_container_compatible_products',
        arguments: { session: workspace.id },
      });
      expect(resSession.isError).toBeFalsy();
      const parsedSession = JSON.parse(textContent(resSession));
      expect(parsedSession.workspace).toBe(workspace.id);
      expect(parsedSession.categories).toEqual(mockCategories);

      // Call using 'workspace' alias parameter
      const resWorkspace = await client.callTool({
        name: 'dcsc_virtual_container_compatible_products',
        arguments: { workspace: workspace.id },
      });
      expect(resWorkspace.isError).toBeFalsy();
      const parsedWorkspace = JSON.parse(textContent(resWorkspace));
      expect(parsedWorkspace.workspace).toBe(workspace.id);
    });

    it('dcsc_virtual_container_compatible_products enforces expectedWorkspaceRevision CAS check', async () => {
      const service = createTestService();
      const { workspace } = setupWorkspace(service);
      const { client } = await createConnectedVlhHarness(service);

      const res = await client.callTool({
        name: 'dcsc_virtual_container_compatible_products',
        arguments: { session: workspace.id, expectedWorkspaceRevision: 9999 },
      });

      expect(res.isError).toBe(true);
      const text = textContent(res);
      expect(text).toContain('Workspace revision conflict');
    });

    it('dcsc_virtual_container_check_rules executes and handles missing workspace cleanly', async () => {
      const service = createTestService();
      const { workspace } = setupWorkspace(service);
      vi.spyOn(service.http, 'send').mockResolvedValueOnce({
        status: 200,
        headers: {},
        raw: mockRules,
      } as never);
      const { client } = await createConnectedVlhHarness(service);

      const res = await client.callTool({
        name: 'dcsc_virtual_container_check_rules',
        arguments: { session: workspace.id },
      });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(textContent(res));
      expect(parsed.rules).toEqual(mockRules);

      // Missing workspace session
      const resMissing = await client.callTool({
        name: 'dcsc_virtual_container_check_rules',
        arguments: { session: 'nonexistent-session-id' },
      });
      expect(resMissing.isError).toBe(true);
      const missingText = textContent(resMissing);
      expect(missingText).toContain('Workspace session nonexistent-session-id not found');
    });
  });
});
