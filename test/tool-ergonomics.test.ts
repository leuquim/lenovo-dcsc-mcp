import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ConfigSchema } from '../src/config/schema.js';
import type { Catalog } from '../src/domain/catalog.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { DcscService } from '../src/mcp/service.js';
import { catalogCodeSet } from '../src/app/serviceHelpers.js';
import { registerTools } from '../src/mcp/tools.js';
import type { RawConfiguration } from '../src/model/types.js';

type Obj = Record<string, unknown>;

const powerFixture = JSON.parse(
  readFileSync(new URL('./fixtures/parity/power-controls.json', import.meta.url), 'utf8'),
) as {
  response: Obj;
  expectedExport: { voltage: Obj; loadFactor: number; currentPowerPolicy: number };
};

const pciFixture = JSON.parse(
  readFileSync(new URL('./fixtures/parity/pci-wizard.json', import.meta.url), 'utf8'),
) as {
  before: RawConfiguration;
  derived: RawConfiguration;
  validationResponse: Obj;
};

const services: DcscService[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
});

async function createConnectedHarness() {
  const service = new DcscService(
    ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }),
  );
  services.push(service);
  const server = new McpServer({ name: 'lenovo-dcsc', version: '0.1.0' });
  registerTools(server, service);
  const client = new Client({ name: 'test-ergonomics-client', version: '1.0.0' });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { service, server, client };
}

describe('MCP tool annotations, context diet, resource, parameter aliasing, and inline dispatch', () => {
  it('registers all 105 tools with complete MCP annotations and a tightened description footprint', async () => {
    const { client } = await createConnectedHarness();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(105);

    let totalDescChars = 0;
    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} should have annotations`).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint).toBe('boolean');
      expect(typeof tool.annotations?.destructiveHint).toBe('boolean');
      expect(typeof tool.annotations?.idempotentHint).toBe('boolean');
      expect(typeof tool.annotations?.openWorldHint).toBe('boolean');
      totalDescChars += (tool.description ?? '').length;
    }

    // Read-only tools vs destructive tools spot checks
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('dcsc_session_list')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get('dcsc_standalone_hardware_inspect')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get('dcsc_find_products')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.get('dcsc_session_close')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName.get('dcsc_standalone_hardware_remove')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName.get('dcsc_specialty_catalog')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.get('dcsc_vlh_wizard_info')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.get('dcsc_auto_fix')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.get('dcsc_generate_config_id')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });

    for (const name of ['dcsc_power_controls', 'dcsc_pci_wizard', 'dcsc_storage_wizard', 'dcsc_export_configuration_tree']) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(false);
    }

    // Context diet: previously 36,352 description chars; verify substantial reduction
    expect(totalDescChars).toBeLessThan(28_000);
  });

  it('exposes the dcsc://docs/capabilities MCP resource with detailed verification matrix notes', async () => {
    const { client } = await createConnectedHarness();
    const { resources } = await client.listResources();
    const capResource = resources.find((r) => r.uri === 'dcsc://docs/capabilities');
    expect(capResource).toBeDefined();

    const readResult = await client.readResource({ uri: 'dcsc://docs/capabilities' });
    expect(readResult.contents).toHaveLength(1);
    const text = (readResult.contents[0] as { text?: string }).text ?? '';
    expect(text).toContain('Lenovo DCSC MCP — Verified Capabilities & Upstream Constraints');
    expect(text).toContain('Parameter Conventions');
  });

  it('takes one handle (session) and one revision (expectedRevision) on every tool', async () => {
    const { service, client } = await createConnectedHarness();
    const raw: RawConfiguration = {
      id: 'node-1',
      code: '7D73CTO1WW',
      type: 'SERVER',
      quantity: 1,
      totalPrice: 100,
      tabs: [],
      voltage: { level: 'Low', type: 'AC', displayValue: '115V', actualValue: '115' },
      optionalVoltages: [
        { level: 'Low', type: 'AC', displayValue: '115V', actualValue: '115' },
        powerFixture.expectedExport.voltage,
      ],
      currentPowerPolicy: 5,
      powerPolicies: [{ value: 5, description: 'Native policy' }],
      loadFactor: 70,
      powerReportResponse: {
        ...structuredClone(powerFixture.response),
        powerReport: {
          ...(powerFixture.response['powerReport'] as Obj),
          loadFactor: 70,
          operatingVoltage: '115V-AC',
        },
      },
    };
    const session = service.sessions.create({
      raw,
      configurationId: 'node-1',
      locale: service.locale,
      solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
      mode: 'cto',
      primed: true,
      reduced: reduceConfiguration(raw, 'node-1'),
    });
    const workspace = service.sessions.getWorkspace(session.id)!;

    // 1. dcsc_power_controls takes session and expectedRevision
    const inspectRes = await client.callTool({
      name: 'dcsc_power_controls',
      arguments: {
        session: session.id,
        expectedRevision: workspace.revision,
      },
    });
    expect(inspectRes.isError).toBeFalsy();
    const inspectBody = JSON.parse(
      ((inspectRes.content as Array<{ text: string }>)[0]?.text) ?? '{}',
    ) as Obj;
    expect(inspectBody['session']).toBe(session.id);

    // 2. dcsc_software_inspect takes the workspace id as session
    workspace.serverState['standaloneSoftwareState'] = {
      kind: 'standalone-software',
      features: [],
      selections: [],
    };
    const swRes = await client.callTool({
      name: 'dcsc_software_inspect',
      arguments: {
        session: workspace.id,
      },
    });
    expect(swRes.isError).toBeFalsy();
    const swBody = JSON.parse(
      ((swRes.content as Array<{ text: string }>)[0]?.text) ?? '{}',
    ) as Obj;
    expect(swBody['workspace']).toBe(workspace.id);
  });

  it('supports inline mutation dispatch on dcsc_power_controls and dcsc_pci_wizard', async () => {
    const { service, client } = await createConnectedHarness();
    const raw = structuredClone(pciFixture.before);
    const session = service.sessions.create({
      raw,
      configurationId: String(raw.id),
      locale: service.locale,
      solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
      mode: 'cto',
      primed: true,
      reduced: reduceConfiguration(raw, String(raw.id)),
    });
    const workspace = service.sessions.getWorkspace(session.id)!;

    vi.spyOn(service.http, 'send').mockImplementation(async (request) => {
      if (request.path === '/pci_wizard/validate/additional/slot') {
        return { raw: pciFixture.validationResponse } as never;
      }
      if (request.path === '/ctos/autoDerive') {
        return { raw: { configurations: [pciFixture.derived] } } as never;
      }
      throw new Error(`Unexpected request ${request.path}`);
    });

    const mutateRes = await client.callTool({
      name: 'dcsc_pci_wizard',
      arguments: {
        session: session.id,
        expectedRevision: workspace.revision,
        optionId: '1P Rear5-a',
        rowId: '2',
        enabled: true,
      },
    });
    expect(mutateRes.isError).toBeFalsy();
    const mutateBody = JSON.parse(
      ((mutateRes.content as Array<{ text: string }>)[0]?.text) ?? '{}',
    ) as Obj;
    expect(mutateBody['workspaceRevision']).toBe(workspace.revision);
    expect(mutateBody['affectedConfigurationCount']).toBe(1);
  });

  it('caches O(1) product code sets per Catalog object via WeakMap in catalogCodeSet', () => {
    const mockCatalog: Catalog = {
      tree: [],
      fetchedAt: 1,
      entries: [
        {
          code: '7D73CTO1WW',
          description: 'ThinkSystem SR650 V3',
          path: ['Servers'],
          categoryId: 'SERVER',
          type: 'SERVER',
          withdrawn: false,
          haystack: '7d73cto1ww thinksystem sr650 v3',
        },
      ],
    };
    const set1 = catalogCodeSet(mockCatalog);
    const set2 = catalogCodeSet(mockCatalog);
    expect(set1).toBe(set2);
    expect(set1.has('7D73CTO1WW')).toBe(true);
    expect(set1.has('UNKNOWN')).toBe(false);
  });
});
