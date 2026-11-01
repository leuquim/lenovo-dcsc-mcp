import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import { errorCustomizeWithAutoDerive } from '../src/domain/autoFix.js';
import {
  fetchCtoVersions,
  fetchRuleVersions,
  fetchRuleVersionsInfo,
} from '../src/domain/ruleVersions.js';
import { queryDiscoveryHelper } from '../src/domain/discoveryHelpers.js';
import { registerConfigurationTools } from '../src/mcp/configurationTools.js';
import { registerSessionTools } from '../src/mcp/sessionTools.js';
import { registerCatalogTools } from '../src/mcp/catalogTools.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import type { RawConfiguration } from '../src/model/types.js';

type ToolReply = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean | undefined;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolReply>;

const services: DcscService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});

async function setupTestEnvironment() {
  const service = new DcscService(
    ConfigSchema.parse({
      logLevel: 'silent',
      files: { persistSessions: false },
    }),
  );
  services.push(service);

  vi.spyOn(service, 'resolveSolution').mockResolvedValue({
    solutionMode: 'General Purpose',
    masterSlices: ['GP'],
  });

  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
      return { remove() {}, update() {} };
    },
  };

  registerConfigurationTools(server as unknown as McpServer, service);
  registerSessionTools(server as unknown as McpServer, service);
  registerCatalogTools(server as unknown as McpServer, service);

  return { service, handlers };
}

function parse(reply: ToolReply): Record<string, unknown> {
  return JSON.parse(reply.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('Phase 2 Part B: G7 — Batch & Error Customize', () => {
  it('errorCustomizeWithAutoDerive calls CTO endpoint by default', async () => {
    const { service } = await setupTestEnvironment();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: [{ id: 'config-1', status: 'OK' }],
      status: 200,
    } as never);

    const res = await errorCustomizeWithAutoDerive(service.http, service.newCtx(), {
      configurations: [{ id: 'cfg-1' }],
    });

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'ctos.errorCustomizeWithAutoDerive',
        method: 'POST',
        path: '/ctos/errorCustomizeWithAutoDerive',
        body: { kind: 'json', value: { configurations: [{ id: 'cfg-1' }] } },
      }),
    );
    expect(res).toEqual([{ id: 'config-1', status: 'OK' }]);
  });

  it('errorCustomizeWithAutoDerive calls LFO endpoint when mode is lfo', async () => {
    const { service } = await setupTestEnvironment();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: [],
      status: 200,
    } as never);

    const res = await errorCustomizeWithAutoDerive(service.http, service.newCtx(), {
      mode: 'lfo',
      configurations: [],
    });

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'lfos.errorCustomizeWithAutoDerive',
        method: 'POST',
        path: '/lfos/errorCustomizeWithAutoDerive',
      }),
    );
    expect(res).toEqual([]);
  });
});

describe('Phase 2 Part B: G9 — Rule & Table Versions', () => {
  it('fetchCtoVersions fetches version list for a CTO product', async () => {
    const { service } = await setupTestEnvironment();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: ['6195524', '7D3KCTORWW', '7D75CTO2WW'],
      status: 200,
    } as never);

    const versions = await fetchCtoVersions(service.http, service.newCtx(), '7D73CTO1WW');
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'ctos.versions',
        method: 'GET',
        path: '/ctos/7D73CTO1WW/versions',
      }),
    );
    expect(versions).toEqual(['6195524', '7D3KCTORWW', '7D75CTO2WW']);
  });

  it('fetchRuleVersions fetches rule versions for table (defaulting to 203)', async () => {
    const { service } = await setupTestEnvironment();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: { version: '2026.1', table: '203' },
      status: 200,
    } as never);

    const res = await fetchRuleVersions(service.http, service.newCtx(), {
      ctoCode: '7D73CTO1WW',
    });
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'ctos.ruleVersions',
        method: 'GET',
        path: '/ctos/7D73CTO1WW/203/rule_versions',
      }),
    );
    expect(res).toEqual({ version: '2026.1', table: '203' });
  });

  it('fetchRuleVersionsInfo fetches both CTO versions and rule versions concurrently', async () => {
    const { service } = await setupTestEnvironment();
    vi.spyOn(service.http, 'send').mockImplementation((input: { path: string }) => {
      if (input.path.endsWith('/versions')) {
        return Promise.resolve({ raw: ['v1', 'v2'], status: 200 } as never);
      }
      return Promise.resolve({ raw: { rules: 'ok' }, status: 200 } as never);
    });

    const info = await fetchRuleVersionsInfo(service.http, service.newCtx(), {
      ctoCode: '7D73CTO1WW',
      tableCode: '305',
    });

    expect(info.ctoCode).toBe('7D73CTO1WW');
    expect(info.tableCode).toBe('305');
    expect(info.versions).toEqual(['v1', 'v2']);
    expect(info.ruleVersions).toEqual({ rules: 'ok' });
  });

  it('dcsc_configuration_get inspects rule versions with explicit ctoCode and no session', async () => {
    const { service, handlers } = await setupTestEnvironment();
    vi.spyOn(service.http, 'send').mockImplementation((input: { path: string }) => {
      if (input.path.endsWith('/versions')) {
        return Promise.resolve({ raw: ['v1'], status: 200 } as never);
      }
      return Promise.resolve({ raw: null, status: 200 } as never);
    });

    const handler = handlers.get('dcsc_configuration_get')!;
    const reply = await handler({
      view: 'rules', ctoCode: '7D73CTO1WW',
      ruleTableCode: '203',
    });
    const parsed = parse(reply);
    expect(parsed.ctoCode).toBe('7D73CTO1WW');
    expect(parsed.versions).toEqual(['v1']);
    expect(parsed.tableCode).toBe('203');
  });

  it('dcsc_configuration_get returns rule versions for an active session', async () => {
    const { service, handlers } = await setupTestEnvironment();
    const raw: RawConfiguration = {
      id: 'session-rule-test',
      code: '7D73CTO1WW',
      type: 'SERVER',
      items: [],
      properties: {},
      tabs: [],
    };
    const session = service.sessions.create({
      locale: { country: 'US', language: 'en', currency: 'USD', geo: 'NA' },
      solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
      mode: 'cto',
      raw,
      configurationId: raw.id ?? 'session-rule-test',
      reduced: reduceConfiguration(raw, raw.id ?? 'session-rule-test'),
      primed: true,
    });

    vi.spyOn(service.http, 'send').mockImplementation((input: { path: string }) => {
      if (input.path.endsWith('/versions')) {
        return Promise.resolve({ raw: ['v1', 'v2'], status: 200 } as never);
      }
      return Promise.resolve({ raw: { ruleCount: 42 }, status: 200 } as never);
    });

    const handler = handlers.get('dcsc_configuration_get')!;
    const reply = await handler({
      session: session.id,
      view: 'rules',
    });
    const parsed = parse(reply);
    expect(parsed).toMatchObject({
      ctoCode: '7D73CTO1WW',
      tableCode: '203',
      versions: ['v1', 'v2'],
      ruleVersions: { ruleCount: 42 },
    });
  });
});

describe('Phase 2 Part B: G10 — Discovery Helpers', () => {
  it('caseStudies queries /categories/caseStudy/{id}', async () => {
    const { service } = await setupTestEnvironment();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: [{ title: 'HPC AI cluster' }],
      status: 200,
    } as never);

    const res = await queryDiscoveryHelper(service.http, service.newCtx(), {
      action: 'caseStudies',
      params: { id: 'all' },
    });
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'categories.caseStudy',
        method: 'GET',
        path: '/categories/caseStudy/all',
      }),
    );
    expect(res).toEqual([{ title: 'HPC AI cluster' }]);
  });

  it('subCategoryConditions queries /categories/getSubCategorySearchConditions', async () => {
    const { service } = await setupTestEnvironment();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: [{ conditionName: 'Rack' }],
      status: 200,
    } as never);

    const res = await queryDiscoveryHelper(service.http, service.newCtx(), {
      action: 'subCategoryConditions',
    });
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'categories.getSubCategorySearchConditions',
        method: 'GET',
        path: '/categories/getSubCategorySearchConditions',
      }),
    );
    expect(res).toEqual([{ conditionName: 'Rack' }]);
  });

  it('productListBySubCategory queries /categories/getProductListBySubCategory with conditions json', async () => {
    const { service } = await setupTestEnvironment();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: { children: [{ id: 'p1' }], totalCount: 1 },
      status: 200,
    } as never);

    const res = await queryDiscoveryHelper(service.http, service.newCtx(), {
      action: 'productListBySubCategory',
      params: {
        categoryId: 'STG@Servers@Rack Server',
        conditions: { cpu: 'AMD' },
        pageNumber: 1,
        pageSize: 5,
      },
    });
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'categories.getProductListBySubCategory',
        method: 'GET',
        path: '/categories/getProductListBySubCategory',
        query: expect.objectContaining({
          categoryId: 'STG@Servers@Rack Server',
          conditions: JSON.stringify({ cpu: 'AMD' }),
          pageNumber: '1',
          pageSize: '5',
          signCustomize: 'true',
        }),
      }),
    );
    expect(res).toEqual({ children: [{ id: 'p1' }], totalCount: 1 });
  });

  it('topChoiceCountry queries /categories/checkTopChoiceCountry', async () => {
    const { service } = await setupTestEnvironment();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: true,
      status: 200,
    } as never);

    const res = await queryDiscoveryHelper(service.http, service.newCtx(), {
      action: 'topChoiceCountry',
    });
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'categories.checkTopChoiceCountry',
        method: 'GET',
        path: '/categories/checkTopChoiceCountry',
      }),
    );
    expect(res).toBe(true);
  });

  it('productFunctions posts /function_definition/product_functions with code', async () => {
    const { service } = await setupTestEnvironment();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: { NODEROLES: true, UNCONFIGUREDTAB: true },
      status: 200,
    } as never);

    const res = await queryDiscoveryHelper(service.http, service.newCtx(), {
      action: 'productFunctions',
      params: { code: '7D73CTO1WW' },
    });
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'function_definition.product_functions',
        method: 'POST',
        path: '/function_definition/product_functions',
        query: { code: '7D73CTO1WW' },
        body: { kind: 'json', value: {} },
      }),
    );
    expect(res).toEqual({ NODEROLES: true, UNCONFIGUREDTAB: true });
  });

  it('displayOrders queries /ctos/{code}/display_orders/features_and_groups', async () => {
    const { service } = await setupTestEnvironment();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: ['[MECH, BU1E]=>-1'],
      status: 200,
    } as never);

    const res = await queryDiscoveryHelper(service.http, service.newCtx(), {
      action: 'displayOrders',
      params: { ctoCode: '7D73CTO1WW' },
    });
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'ctos.display_orders',
        method: 'GET',
        path: '/ctos/7D73CTO1WW/display_orders/features_and_groups',
      }),
    );
    expect(res).toEqual(['[MECH, BU1E]=>-1']);
  });

  it('staticFeatures posts /ctos/{code}/{tab}/staticFeatures with json body', async () => {
    const { service } = await setupTestEnvironment();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: { title: 'Memory', subTabs: [] },
      status: 200,
    } as never);

    const res = await queryDiscoveryHelper(service.http, service.newCtx(), {
      action: 'staticFeatures',
      params: { ctoCode: '7D73CTO1WW', tab: 'Memory' },
    });
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'ctos.staticFeatures',
        method: 'POST',
        path: '/ctos/7D73CTO1WW/Memory/staticFeatures',
        body: { kind: 'json', value: {} },
      }),
    );
    expect(res).toEqual({ title: 'Memory', subTabs: [] });
  });

  it('dcsc_category dispatches discovery kinds', async () => {
    const { service, handlers } = await setupTestEnvironment();
    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: true,
      status: 200,
    } as never);

    const handler = handlers.get('dcsc_category')!;
    const reply = await handler({
      category: { kind: 'topChoiceCountry' },
    });
    expect(parse(reply)).toBe(true);
  });

  it('dcsc_category detail rejects a missing categoryId', async () => {
    const { handlers } = await setupTestEnvironment();
    const handler = handlers.get('dcsc_category')!;
    const reply = await handler({ category: { kind: 'detail' } });
    expect(reply.isError).toBe(true);
    expect(reply.content[0]?.text).toContain('categoryId is required');
  });
});
