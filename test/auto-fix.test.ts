import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ConfigSchema } from '../src/config/schema.js';
import {
  inspectAutoFixCandidates,
  buildAutoFixCurrentSelections,
  executeAutoFix,
  applyAutoFixSections,
} from '../src/domain/autoFix.js';
import { DcscService } from '../src/mcp/service.js';
import { registerConfigurationTools } from '../src/mcp/configurationTools.js';
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
  masterSlices: ['GP'],
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
  registerConfigurationTools(server, service);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function sampleRawConfiguration(): RawConfiguration {
  return {
    id: 'cfg_autofix_1',
    sliceCtoCode: '7D73CTO1WW',
    quantity: 1,
    tabs: [
      {
        title: 'Processors',
        subTabs: [
          {
            title: 'CPU',
            sections: [
              {
                name: 'PROCESSOR',
                title: 'Processor',
                singleEntry: true,
                required: true,
                features: [
                  {
                    code: 'B0MA',
                    description: 'Intel Xeon Silver 4410Y 12C 150W 2.0GHz Processor',
                    unitPrice: 500,
                  },
                  {
                    code: 'B0MB',
                    description: 'Intel Xeon Gold 5415+ 8C 150W 2.9GHz Processor',
                    unitPrice: 800,
                  },
                ],
                results: [
                  {
                    code: 'B0MA',
                    quantity: 1,
                    description: 'Intel Xeon Silver 4410Y 12C 150W 2.0GHz Processor',
                  },
                ],
                errors: ['Processor selection requires matching thermal solution.'],
              },
            ],
          },
        ],
      },
      {
        title: 'Storage',
        subTabs: [
          {
            title: 'Internal Storage',
            sections: [
              {
                name: 'NONRAID_HDD',
                title: 'HDD not in RAID Array',
                features: [
                  {
                    code: 'A2VN',
                    description: '2.5" 1.2TB 10K SAS 12Gb Hot Swap 512n HDD',
                    unitPrice: 300,
                  },
                ],
                results: [],
                errors: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('Domain: Auto Fix', () => {
  it('inspectAutoFixCandidates calls POST /cto/hardware/autoFix/config and parses candidates', async () => {
    const service = createService();
    const ctx = service.newCtx({ solution });
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: [
        {
          tabTitle: 'Processors',
          characterName: 'PROCESSOR',
          characterDesc: 'Processor',
        },
        {
          tabTitle: 'Internal Storage',
          characterName: 'NONRAID_HDD',
          characterDesc: 'HDD not in RAID Array',
        },
      ],
    } as never);

    const candidates = await inspectAutoFixCandidates(service.http, '7D73CTO1WW', ctx);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'inspect_auto_fix_candidates',
        method: 'POST',
        path: '/cto/hardware/autoFix/config',
        query: { cto: '7D73CTO1WW' },
        requiresSolution: false,
      }),
    );
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.characterName).toBe('PROCESSOR');
    expect(candidates[1]!.characterName).toBe('NONRAID_HDD');
  });

  it('inspectAutoFixCandidates rejects empty ctoCode before HTTP', async () => {
    const service = createService();
    const ctx = service.newCtx({ solution });
    await expect(inspectAutoFixCandidates(service.http, '   ', ctx)).rejects.toThrow('required');
  });

  it('buildAutoFixCurrentSelections extracts current selections into wire shape', () => {
    const raw = sampleRawConfiguration();
    const selections = buildAutoFixCurrentSelections(raw);

    expect(selections).toHaveLength(1);
    expect(selections[0]!.name).toBe('PROCESSOR');
    expect(selections[0]!.results).toEqual([{ featureCode: 'B0MA', quantity: 1 }]);
  });

  it('executeAutoFix sends POST /cto/hardware/autoFix with selections and parses response', async () => {
    const service = createService();
    const ctx = service.newCtx({ solution });
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: {
        ctoCode: '7D73CTO1WW',
        autoFixResult: 'FIX_SUCCESS',
        sections: [
          {
            name: 'PROCESSOR',
            results: [{ featureCode: 'B0MB', quantity: 1 }],
          },
        ],
        notices: [{ message: 'Auto-fixed processor to meet thermal constraints.', severity: 'INFO' }],
        errors: null,
      },
    } as never);

    const res = await executeAutoFix(
      service.http,
      '7D73CTO1WW',
      ['PROCESSOR'],
      [{ name: 'PROCESSOR', results: [{ featureCode: 'B0MA', quantity: 1 }] }],
      ctx,
      { configurationId: 'US__cfg-1', showExpressMode: true, selectedTceAudience: 'MID' },
    );

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'execute_auto_fix',
        method: 'POST',
        path: '/cto/hardware/autoFix',
        query: { configurationId: 'US__cfg-1' },
        body: {
          kind: 'json',
          value: {
            cto: '7D73CTO1WW',
            requiredSections: ['PROCESSOR'],
            currentSelections: [{ name: 'PROCESSOR', results: [{ featureCode: 'B0MA', quantity: 1 }] }],
            showExpressMode: true,
            selectedTceAudience: 'MID',
          },
        },
      }),
    );

    expect(res.autoFixResult).toBe('FIX_SUCCESS');
    expect(res.sections).toHaveLength(1);
    expect(res.notices).toHaveLength(1);
  });

  it('applyAutoFixSections updates matching sections, restores feature metadata and clears errors', () => {
    const raw = sampleRawConfiguration();
    const fixedSections = [
      {
        name: 'PROCESSOR',
        results: [{ featureCode: 'B0MB', quantity: 1 }],
      },
    ];

    const { configuration: updated, sectionsChanged } = applyAutoFixSections(raw, fixedSections);

    expect(sectionsChanged).toEqual(['PROCESSOR']);

    const sec = updated.tabs![0]!.subTabs![0]!.sections![0]!;
    expect(sec.results).toHaveLength(1);
    expect(sec.results![0]!.code).toBe('B0MB');
    expect(sec.results![0]!.description).toBe('Intel Xeon Gold 5415+ 8C 150W 2.9GHz Processor');
    expect(sec.results![0]!.cost).toBe(800);
    expect(sec.errors).toEqual([]);

    // Raw input configuration must not be mutated
    expect(raw.tabs![0]!.subTabs![0]!.sections![0]!.results![0]!.code).toBe('B0MA');
  });
});

describe('Service Integration: Auto Fix', () => {
  it('inspectAutoFix delegates to domain when session is CTO mode', async () => {
    const service = createService();
    const raw = sampleRawConfiguration();
    const session = service.sessions.create({
      raw,
      configurationId: 'cfg_autofix_1',
      locale: service.locale,
      solution,
      mode: 'cto',
      primed: true,
      reduced: reduceConfiguration(raw, 'cfg_autofix_1'),
    });

    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: [{ tabTitle: 'Processors', characterName: 'PROCESSOR', characterDesc: 'Processor' }],
    } as never);

    const { candidates } = await service.inspectAutoFix(session.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.characterName).toBe('PROCESSOR');
  });

  it('inspectAutoFix returns empty candidates for non-CTO sessions', async () => {
    const service = createService();
    const raw = sampleRawConfiguration();
    const session = service.sessions.create({
      raw,
      configurationId: 'cfg_autofix_1',
      locale: service.locale,
      solution,
      mode: 'lfo',
      primed: true,
      reduced: reduceConfiguration(raw, 'cfg_autofix_1'),
    });

    const { candidates } = await service.inspectAutoFix(session.id);
    expect(candidates).toEqual([]);
  });

  it('autoFix enforces CAS optimistic concurrency check and rejects conflict', async () => {
    const service = createService();
    const raw = sampleRawConfiguration();
    const session = service.sessions.create({
      raw,
      configurationId: 'cfg_autofix_1',
      locale: service.locale,
      solution,
      mode: 'cto',
      primed: true,
      reduced: reduceConfiguration(raw, 'cfg_autofix_1'),
    });

    await expect(
      service.autoFix(session.id, { expectedRevision: 999 }),
    ).rejects.toThrow();
  });

  it('autoFix applies successful section resolution, derives rules, and bumps revision', async () => {
    const service = createService();
    const raw = sampleRawConfiguration();
    const session = service.sessions.create({
      raw,
      configurationId: 'cfg_autofix_1',
      locale: service.locale,
      solution,
      mode: 'cto',
      primed: true,
      reduced: reduceConfiguration(raw, 'cfg_autofix_1'),
    });

    const initialRevision = session.revision;

    vi.spyOn(service.http, 'send').mockImplementation(async (input) => {
      if (input.path.includes('/autoFix/config')) {
        return {
          raw: [{ tabTitle: 'Processors', characterName: 'PROCESSOR', characterDesc: 'Processor' }],
        } as never;
      }
      if (input.path.includes('/autoFix')) {
        return {
          raw: {
            ctoCode: '7D73CTO1WW',
            autoFixResult: 'FIX_SUCCESS',
            sections: [
              {
                name: 'PROCESSOR',
                results: [{ featureCode: 'B0MB', quantity: 1 }],
              },
            ],
            notices: [{ message: 'Auto-fixed processor' }],
          },
        } as never;
      }
      if (input.path.includes('/autoDerive')) {
        return {
          raw: {
            configurations: [
              {
                ...raw,
                tabs: [
                  {
                    title: 'Processors',
                    subTabs: [
                      {
                        title: 'CPU',
                        sections: [
                          {
                            name: 'PROCESSOR',
                            results: [{ code: 'B0MB', quantity: 1 }],
                            features: [{ code: 'B0MB', unitPrice: 800 }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        } as never;
      }
      return { raw: {} } as never;
    });

    const report = await service.autoFix(session.id);
    expect(report.result.applied).toBe(true);
    expect(report.result.sectionsChanged).toContain('PROCESSOR');
    expect(report.session.revision).toBeGreaterThan(initialRevision);

    const sec = report.session.raw.tabs![0]!.subTabs![0]!.sections![0]!;
    expect(sec.results![0]!.code).toBe('B0MB');
  });

  it('autoFix does not bump revision when upstream returns FIX_FAIL', async () => {
    const service = createService();
    const raw = sampleRawConfiguration();
    const session = service.sessions.create({
      raw,
      configurationId: 'cfg_autofix_1',
      locale: service.locale,
      solution,
      mode: 'cto',
      primed: true,
      reduced: reduceConfiguration(raw, 'cfg_autofix_1'),
    });

    const initialRevision = session.revision;

    vi.spyOn(service.http, 'send').mockImplementation(async (input) => {
      if (input.path.includes('/autoFix/config')) {
        return {
          raw: [{ tabTitle: 'Processors', characterName: 'PROCESSOR', characterDesc: 'Processor' }],
        } as never;
      }
      if (input.path.includes('/autoFix')) {
        return {
          raw: {
            ctoCode: '7D73CTO1WW',
            autoFixResult: 'FIX_FAIL',
            sections: [],
            message: 'autoFix Failed',
          },
        } as never;
      }
      return { raw: {} } as never;
    });

    const report = await service.autoFix(session.id);
    expect(report.result.applied).toBe(false);
    expect(report.result.message).toContain('Failed');
    expect(report.session.revision).toBe(initialRevision);
  });
});

describe('MCP Tools: Auto Fix', () => {
  it('dcsc_auto_fix executes autoFix on session and returns tool payload', async () => {
    const service = createService();
    const client = await createMcpClient(service);

    const raw = sampleRawConfiguration();
    const session = service.sessions.create({
      raw,
      configurationId: 'cfg_autofix_1',
      locale: service.locale,
      solution,
      mode: 'cto',
      primed: true,
      reduced: reduceConfiguration(raw, 'cfg_autofix_1'),
    });

    vi.spyOn(service.http, 'send').mockImplementation(async (input) => {
      if (input.path.includes('/autoFix/config')) {
        return {
          raw: [{ tabTitle: 'Processors', characterName: 'PROCESSOR', characterDesc: 'Processor' }],
        } as never;
      }
      if (input.path.includes('/autoFix')) {
        return {
          raw: {
            ctoCode: '7D73CTO1WW',
            autoFixResult: 'FIX_SUCCESS',
            sections: [
              {
                name: 'PROCESSOR',
                results: [{ featureCode: 'B0MB', quantity: 1 }],
              },
            ],
            notices: [{ message: 'Auto-fixed processor' }],
          },
        } as never;
      }
      if (input.path.includes('/autoDerive')) {
        return {
          raw: {
            configurations: [
              {
                ...raw,
                tabs: [
                  {
                    title: 'Processors',
                    subTabs: [
                      {
                        title: 'CPU',
                        sections: [
                          {
                            name: 'PROCESSOR',
                            results: [{ code: 'B0MB', quantity: 1 }],
                            features: [{ code: 'B0MB', unitPrice: 800 }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        } as never;
      }
      return { raw: {} } as never;
    });

    const res = await client.callTool({
      name: 'dcsc_auto_fix',
      arguments: { session: session.id },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ type: 'text'; text: string }>)[0]!.text) as Obj;
    expect(parsed['applied']).toBe(true);
    expect(parsed['sectionsChanged']).toEqual(['PROCESSOR']);
    expect(parsed['session']).toBe(session.id);
  });
});
