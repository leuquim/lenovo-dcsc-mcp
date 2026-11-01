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

const EXPECTED_TOOLS = [
  'dcsc_auto_connect', 'dcsc_auto_fix', 'dcsc_basket_browse', 'dcsc_basket_set', 'dcsc_cabling_get', 'dcsc_cabling_set',
  'dcsc_category', 'dcsc_compare', 'dcsc_configuration_get', 'dcsc_configure', 'dcsc_export', 'dcsc_floor_set',
  'dcsc_import', 'dcsc_launch', 'dcsc_network_get', 'dcsc_network_set', 'dcsc_pdu_set', 'dcsc_power_get', 'dcsc_power_set',
  'dcsc_rack_add', 'dcsc_rack_edit', 'dcsc_rack_get', 'dcsc_rack_position_rule', 'dcsc_reconcile_workspace',
  'dcsc_recovery_export', 'dcsc_reference_solutions', 'dcsc_search', 'dcsc_session_close', 'dcsc_session_list',
  'dcsc_settings_get', 'dcsc_settings_set', 'dcsc_storage_get', 'dcsc_storage_set', 'dcsc_undo', 'dcsc_validate',
  'dcsc_virtual_container_get', 'dcsc_vlh_get', 'dcsc_vlh_set', 'dcsc_wizard_get', 'dcsc_wizard_set', 'dcsc_workspace_get',
];
const MUTATING_TOOLS = [
  'dcsc_auto_connect', 'dcsc_auto_fix', 'dcsc_basket_set', 'dcsc_cabling_set', 'dcsc_configure', 'dcsc_export', 'dcsc_floor_set',
  'dcsc_import', 'dcsc_launch', 'dcsc_network_set', 'dcsc_pdu_set', 'dcsc_power_set', 'dcsc_rack_add', 'dcsc_rack_edit',
  'dcsc_reconcile_workspace', 'dcsc_recovery_export', 'dcsc_session_close', 'dcsc_settings_set', 'dcsc_storage_set', 'dcsc_undo',
  'dcsc_validate', 'dcsc_vlh_set', 'dcsc_wizard_set',
];
const TOOL_DEFINITION_BYTE_BUDGET = 5_000;
const TOTAL_DEFINITION_BYTE_BUDGET = 64_000;

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

describe('MCP tool annotations, definition budget, workflow resource, handles and inline dispatch', () => {
  it('registers the panel tool set with complete annotations within the definition budget', async () => {
    const { client } = await createConnectedHarness();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
    expect(tools).toHaveLength(41);

    let totalBytes = 0;
    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} should have annotations`).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint).toBe('boolean');
      expect(typeof tool.annotations?.destructiveHint).toBe('boolean');
      expect(typeof tool.annotations?.idempotentHint).toBe('boolean');
      expect(typeof tool.annotations?.openWorldHint).toBe('boolean');
      const bytes = Buffer.byteLength(JSON.stringify(tool));
      expect(bytes, `${tool.name} definition bytes`).toBeLessThan(TOOL_DEFINITION_BYTE_BUDGET);
      totalBytes += bytes;
      if (tool.name.endsWith('_get')) expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      if (tool.name.endsWith('_set')) expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
    }
    expect(totalBytes).toBeLessThan(TOTAL_DEFINITION_BYTE_BUDGET);

    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('dcsc_session_list')?.annotations).toMatchObject({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(byName.get('dcsc_search')?.annotations).toMatchObject({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    });
    expect(byName.get('dcsc_session_close')?.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false,
    });
    expect(byName.get('dcsc_auto_fix')?.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    });
    for (const name of MUTATING_TOOLS) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(false);
    }
  });

  it('exposes the dcsc://docs/capabilities workflow guide naming only registered tools', async () => {
    const { client } = await createConnectedHarness();
    const { resources } = await client.listResources();
    expect(resources.find((r) => r.uri === 'dcsc://docs/capabilities')).toBeDefined();

    const readResult = await client.readResource({ uri: 'dcsc://docs/capabilities' });
    expect(readResult.contents).toHaveLength(1);
    const text = (readResult.contents[0] as { text?: string }).text ?? '';
    expect(text).toContain('workflow guide');
    const named = new Set(text.match(/dcsc_[a-z_]+/g) ?? []);
    expect([...named].filter((name) => !EXPECTED_TOOLS.includes(name))).toEqual([]);
    for (const name of ['dcsc_launch', 'dcsc_configure', 'dcsc_validate', 'dcsc_export']) expect(named.has(name)).toBe(true);
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

    // 1. dcsc_power_get takes session and expectedRevision
    const inspectRes = await client.callTool({
      name: 'dcsc_power_get',
      arguments: {
        session: session.id,
        section: 'controls',
        expectedRevision: workspace.revision,
      },
    });
    expect(inspectRes.isError).toBeFalsy();
    const inspectBody = JSON.parse(
      ((inspectRes.content as Array<{ text: string }>)[0]?.text) ?? '{}',
    ) as Obj;
    expect(inspectBody['session']).toBe(session.id);

    // 2. dcsc_basket_browse takes the workspace id as session
    workspace.serverState['standaloneSoftwareState'] = {
      kind: 'standalone-software',
      features: [],
      selections: [],
    };
    const swRes = await client.callTool({
      name: 'dcsc_basket_browse',
      arguments: {
        basket: 'software',
        session: workspace.id,
      },
    });
    expect(swRes.isError).toBeFalsy();
    const swBody = JSON.parse(
      ((swRes.content as Array<{ text: string }>)[0]?.text) ?? '{}',
    ) as Obj;
    expect(swBody['session']).toBe(workspace.id);
    expect(swBody['revision']).toBe(workspace.revision);
  });

  it('supports a single-call mutation on dcsc_wizard_set', async () => {
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
      name: 'dcsc_wizard_set',
      arguments: {
        session: session.id,
        wizard: 'pci',
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
    expect(mutateBody['revision']).toBe(workspace.revision);
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
