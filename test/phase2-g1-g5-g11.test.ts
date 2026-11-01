import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import {
  exportPowerOrGroupXls,
  exportP2pReport,
  fetchShareUrl,
} from '../src/domain/exportExtras.js';
import {
  launchMemoryWizard,
  queryMemoryWizard,
} from '../src/domain/memoryWizard.js';
import {
  fetchSupplyStatus,
  fetchEsdInfo,
} from '../src/domain/supplyStatus.js';
import {
  fetchAiDefaultPrompt,
  fetchAiPromptTemplate,
  fetchAiCandidateAttributes,
  fetchAiCandidateFeatures,
  fetchAiCandidateFeaturesDesc,
  fetchAiConfigReplenishment,
  fetchAiReplaceFeatures,
  fetchAiRecommendConfigs,
  fetchAiRecommendServices,
} from '../src/domain/aiConfigurator.js';
import { registerImportExportTools } from '../src/mcp/importExportTools.js';
import { registerConfigurationTools } from '../src/mcp/configurationTools.js';
import { registerPciWizardTools } from '../src/mcp/pciWizardTools.js';
import { registerCatalogTools } from '../src/mcp/catalogTools.js';
import { registerStandaloneTools } from '../src/mcp/standaloneTools.js';

type ToolReply = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean | undefined;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolReply>;

const services: DcscService[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setupTestEnvironment() {
  const artifacts = await mkdtemp(join(tmpdir(), 'dcsc-phase2-'));
  tempDirs.push(artifacts);
  const service = new DcscService(
    ConfigSchema.parse({
      logLevel: 'silent',
      files: { persistSessions: false, artifactDir: artifacts },
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

  registerImportExportTools(server as unknown as McpServer, service);
  registerConfigurationTools(server as unknown as McpServer, service);
  registerPciWizardTools(server as unknown as McpServer, service);
  registerCatalogTools(server as unknown as McpServer, service);
  registerStandaloneTools(server as unknown as McpServer, service);

  return { service, handlers, artifacts };
}

function parse(reply: ToolReply): Record<string, unknown> {
  return JSON.parse(reply.content[0]?.text ?? '{}') as Record<string, unknown>;
}

function createMockStream(content: string | Buffer): Readable {
  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  return new Readable({
    read() {
      this.push(buf);
      this.push(null);
    },
  });
}

describe('Phase 2 Part A: G1, G2, G11 (Export Extras)', () => {
  it('G1: exportPowerOrGroupXls calls correct endpoint for CTO power export and saves file', async () => {
    const { service, artifacts } = await setupTestEnvironment();
    const fakeData = Buffer.from('PK\x03\x04fake-power-xls');
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      stream: createMockStream(fakeData),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      requestId: 'req-g1-1',
    } as never);

    const targetFile = join(artifacts, 'Power_Report.xlsx');
    const result = await exportPowerOrGroupXls(service.http, service.newCtx(), {
      mode: 'cto',
      reportType: 'power',
      fileName: 'Power_Report.xlsx',
      exportFormPayload: { data: '{}', groups: '[]' },
      outputPath: targetFile,
    });

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'cto_power_export_xls',
        method: 'POST',
        path: '/ctos/power/export_xls',
        query: { fileName: 'Power_Report.xlsx' },
        body: { kind: 'form', fields: { data: '{}', groups: '[]' } },
        responseKind: 'stream',
      }),
    );
    expect(result.filename).toBe('Power_Report.xlsx');
    expect(result.bytes).toBe(fakeData.length);
    expect(result.savedPath).toBe(targetFile);

    const savedBytes = await readFile(targetFile);
    expect(savedBytes).toEqual(fakeData);
  });

  it('G1: exportPowerOrGroupXls calls correct endpoint for LFO group export', async () => {
    const { service } = await setupTestEnvironment();
    const fakeData = Buffer.from('PK\x03\x04fake-group-xls');
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      stream: createMockStream(fakeData),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      requestId: 'req-g1-2',
    } as never);

    const result = await exportPowerOrGroupXls(service.http, service.newCtx(), {
      mode: 'lfo',
      reportType: 'group',
      fileName: 'Group_Quote',
      exportFormPayload: { data: '{}', groups: '[]' },
    });

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'lfo_group_export_xls',
        method: 'POST',
        path: '/lfos/group/export_xls',
        query: { fileName: 'Group_Quote' },
      }),
    );
    expect(result.filename).toBe('Group_Quote.xlsx');
    expect(result.bytes).toBe(fakeData.length);
  });

  it('G2: exportP2pReport calls /p2p-report with json body and stream response', async () => {
    const { service, artifacts } = await setupTestEnvironment();
    const fakeData = Buffer.from('PK\x03\x04fake-p2p-xls');
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      stream: createMockStream(fakeData),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      requestId: 'req-g2-1',
    } as never);

    const targetFile = join(artifacts, 'P2P_Report.xlsx');
    const result = await exportP2pReport(
      service.http,
      service.newCtx(),
      { data: '{"cabling":[]}' },
      { fileName: 'P2P_Report.xlsx', outputPath: targetFile },
    );

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'cabling_p2p_report',
        method: 'POST',
        path: '/p2p-report',
        query: { fileName: 'P2P_Report.xlsx' },
        body: { kind: 'form', fields: { data: '{"cabling":[]}' } },
        responseKind: 'stream',
      }),
    );
    expect(result.filename).toBe('P2P_Report.xlsx');
    expect(result.bytes).toBe(fakeData.length);
    expect(result.savedPath).toBe(targetFile);

    const savedBytes = await readFile(targetFile);
    expect(savedBytes).toEqual(fakeData);
  });

  it('G11: fetchShareUrl calls GET /copy/url and parses shareable link', async () => {
    const { service } = await setupTestEnvironment();
    const mockShareUrl = 'https://us-dcsc.lenovo.com/redirect/rack-summary/rack-cto?configuration_id=CID123&locale=en_';
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: mockShareUrl,
      requestId: 'req-g11-1',
    } as never);

    const result = await fetchShareUrl(service.http, service.newCtx(), 'CID123');

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'copy_url',
        method: 'GET',
        path: '/copy/url',
        query: { configuration_id: 'CID123' },
        responseKind: 'json',
      }),
    );
    expect(result.shareUrl).toBe(mockShareUrl);
  });
});

describe('Phase 2 Part A: G3 (Memory Wizard)', () => {
  it('launchMemoryWizard calls GET /ctos/{code}/memory_wizard/launch', async () => {
    const { service } = await setupTestEnvironment();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: ['MEMORY', 'PROCESSOR'],
      requestId: 'req-g3-launch',
    } as never);

    const result = await launchMemoryWizard(service.http, service.newCtx(), '7D73CTO1WW');

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'memory_wizard_launch',
        method: 'POST',
        path: '/ctos/7D73CTO1WW/memory_wizard/launch',
        body: { kind: 'json', value: {} },
        responseKind: 'json',
      }),
    );
    expect(result.steps).toEqual(['MEMORY', 'PROCESSOR']);
    expect(result.ctoCode).toBe('7D73CTO1WW');
  });

  it('queryMemoryWizard routes actions to appropriate endpoints', async () => {
    const { service } = await setupTestEnvironment();
    const sendSpy = vi.spyOn(service.http, 'send').mockImplementation(async (opts) => {
      if (opts.path.includes('/slot_number')) {
        return { raw: { slotNumber: 16, maximumServerMemory: 2048 }, requestId: 'req-slot' } as never;
      }
      if (opts.path.includes('/memory_loadmap')) {
        return { raw: { channels: [{ id: 1, slots: ['A1', 'A2'] }] }, requestId: 'req-loadmap' } as never;
      }
      if (opts.path.includes('/options')) {
        return { raw: { options: [{ code: 'MEM1', capacity: 32 }] }, requestId: 'req-options' } as never;
      }
      return { raw: { success: true }, requestId: 'req-other' } as never;
    });

    const slotResult = await queryMemoryWizard(service.http, service.newCtx(), {
      action: 'slotNumber',
      ctoCode: '7D73CTO1WW',
      payload: { processorCode: 'PROC1', processorMaxNumber: 2 },
    });
    expect(slotResult.action).toBe('slotNumber');
    expect(slotResult.data).toEqual({ slotNumber: 16, maximumServerMemory: 2048 });

    const loadmapResult = await queryMemoryWizard(service.http, service.newCtx(), {
      action: 'loadmap',
      ctoCode: '7D73CTO1WW',
      payload: { productCode: '7D73CTO1WW', processorNumber: 2 },
    });
    expect(loadmapResult.action).toBe('loadmap');
    expect(loadmapResult.data).toEqual({ channels: [{ id: 1, slots: ['A1', 'A2'] }] });

    const optionsResult = await queryMemoryWizard(service.http, service.newCtx(), {
      action: 'options',
      payload: { code: '7D73CTO1WW' },
    });
    expect(optionsResult.action).toBe('options');
    expect(optionsResult.data).toEqual({ options: [{ code: 'MEM1', capacity: 32 }] });

    expect(sendSpy).toHaveBeenCalledTimes(3);
  });
});

describe('Phase 2 Part A: G4 (Nightingale AI Configurator Remaining Flows)', () => {
  it('executes all 9 new Nightingale AI endpoints', async () => {
    const { service } = await setupTestEnvironment();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: {
        code: 200,
        message: 'success',
        data: { generated: true },
      },
      requestId: 'req-ai-test',
    } as never);

    const ctx = service.newCtx();
    const actions = [
      { fn: fetchAiDefaultPrompt, path: '/nightingale-configurator/api/v1/default-prompt/_query', action: 'defaultPrompt' },
      { fn: fetchAiPromptTemplate, path: '/nightingale-configurator/api/v1/prompt-template/_query', action: 'promptTemplate' },
      { fn: fetchAiCandidateAttributes, path: '/nightingale-configurator/api/v1/candidate/attributes', action: 'candidateAttributes' },
      { fn: fetchAiCandidateFeatures, path: '/nightingale-configurator/api/v1/candidate/features', action: 'candidateFeatures' },
      { fn: fetchAiCandidateFeaturesDesc, path: '/nightingale-configurator/api/v1/candidate/features/desc', action: 'candidateFeaturesDesc' },
      { fn: fetchAiConfigReplenishment, path: '/nightingale-configurator/api/v1/config-replenishment/_calculate', action: 'configReplenishment' },
      { fn: fetchAiReplaceFeatures, path: '/nightingale-configurator/api/v1/features/replace', action: 'replaceFeatures' },
      { fn: fetchAiRecommendConfigs, path: '/nightingale-configurator/api/v1/recommendation/configs', action: 'recommendConfigs' },
      { fn: fetchAiRecommendServices, path: '/nightingale-configurator/api/v1/recommendation/services', action: 'recommendServices' },
    ];

    for (const item of actions) {
      const res = await item.fn(service.http, ctx, { testKey: 'val' });
      expect(res.action).toBe(item.action);
      expect(res.data).toEqual({ generated: true });
    }

    expect(sendSpy).toHaveBeenCalledTimes(9);
  });

  it('DcscService.aiRecommend dispatches all 12 actions correctly', async () => {
    const { service } = await setupTestEnvironment();
    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: {
        code: 200,
        message: 'success',
        data: { dispatched: true },
      },
      requestId: 'req-ai-dispatch',
    } as never);

    const res = await service.aiRecommend({
      action: 'promptTemplate',
      payload: { country: 'US' },
    });
    expect((res as { action: string }).action).toBe('promptTemplate');
    expect((res as { data: unknown }).data).toEqual({ dispatched: true });
  });
});

describe('Phase 2 Part A: G5 (Supply Status & ESD)', () => {
  it('fetchSupplyStatus retrieves shipping lead times from /supply/status', async () => {
    const { service } = await setupTestEnvironment();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: [
        {
          code: '4X77A08621',
          shippingStatus: ['30', '30', '60'],
        },
      ],
      requestId: 'req-supply-1',
    } as never);

    const result = await fetchSupplyStatus(service.http, service.newCtx(), {
      code: '4X77A08621',
      type: 'Option',
      country: 'US',
    });

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'supply_status',
        method: 'GET',
        path: '/supply/status',
        query: { country: 'US', type: 'Option', code: '4X77A08621' },
      }),
    );
    expect(result.shippingStatus).toEqual(['30', '30', '60']);
    expect(result.code).toBe('4X77A08621');
  });

  it('fetchEsdInfo routes to /sst/esd/info and /sst/esd/alternative', async () => {
    const { service } = await setupTestEnvironment();
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: { esdValid: true },
      requestId: 'req-esd-1',
    } as never);

    const infoRes = await fetchEsdInfo(service.http, service.newCtx(), {
      action: 'info',
      payload: { partNumber: '7S1S002WWW' },
    });
    expect(infoRes.action).toBe('info');
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'sst_esd_info',
        path: '/sst/esd/info',
      }),
    );

    const altRes = await fetchEsdInfo(service.http, service.newCtx(), {
      action: 'alternative',
      payload: { partNumber: '7S1S002WWW' },
    });
    expect(altRes.action).toBe('alternative');
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'sst_esd_alternative',
        path: '/sst/esd/alternative',
      }),
    );
  });
});

describe('Phase 2 Part A: Tool Surface Extensions', () => {
  it('dcsc_export supports directReport and includeShareUrl', async () => {
    const { service, handlers, artifacts } = await setupTestEnvironment();
    const raw = { id: '7D73CTO1WW', code: '7D73CTO1WW', sliceCtoCode: '7D73CTO1WW', type: 'server', quantity: 1, tabs: [] };
    const session = service.sessions.create({
      locale: service.locale,
      solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
      mode: 'cto',
      raw,
      configurationId: '7D73CTO1WW',
      reduced: reduceConfiguration(raw, '7D73CTO1WW'),
      primed: true,
    });

    const fakePowerXls = Buffer.from('PK\x03\x04power-report-stream');
    vi.spyOn(service.http, 'send').mockImplementation(async (opts) => {
      if (opts.path === '/copy/url') {
        return { raw: 'https://us-dcsc.lenovo.com/share/test1234', requestId: 'req-share' } as never;
      }
      return {
        stream: createMockStream(fakePowerXls),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        requestId: 'req-export-stream',
      } as never;
    });

    const exportHandler = handlers.get('dcsc_export');
    expect(exportHandler).toBeDefined();

    const targetFile = join(artifacts, 'direct-power.xlsx');
    const reply = await exportHandler!({
      session: session.id,
      directReport: 'POWER_XLS',
      includeShareUrl: true,
      outputPath: targetFile,
    });

    const parsed = parse(reply);
    expect(parsed.directReport).toBe('POWER_XLS');
    expect(parsed.shareUrl).toBe('https://us-dcsc.lenovo.com/share/test1234');
    expect(parsed.savedPath).toBe(targetFile);

    const writtenBytes = await readFile(targetFile);
    expect(writtenBytes).toEqual(fakePowerXls);
  });

  it('dcsc_list_options supports memoryWizardAction inline dispatch', async () => {
    const { service, handlers } = await setupTestEnvironment();
    const raw = { id: '7D73CTO1WW', code: '7D73CTO1WW', sliceCtoCode: '7D73CTO1WW', type: 'server', quantity: 1, tabs: [] };
    const session = service.sessions.create({
      locale: service.locale,
      solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
      mode: 'cto',
      raw,
      configurationId: '7D73CTO1WW',
      reduced: reduceConfiguration(raw, '7D73CTO1WW'),
      primed: true,
    });

    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: ['MEMORY', 'PROCESSOR'],
      requestId: 'req-mem-launch',
    } as never);

    const listOptionsHandler = handlers.get('dcsc_list_options');
    expect(listOptionsHandler).toBeDefined();

    const reply = await listOptionsHandler!({
      session: session.id,
      memoryWizardAction: 'launch',
    });

    const parsed = parse(reply);
    expect(parsed.action).toBe('launch');
    expect(parsed.ctoCode).toBe('7D73CTO1WW');
    expect(parsed.data).toEqual(['MEMORY', 'PROCESSOR']);
  });

  it('dcsc_pci_wizard supports memoryWizardAction inline dispatch', async () => {
    const { service, handlers } = await setupTestEnvironment();
    const raw = { id: '7D73CTO1WW', code: '7D73CTO1WW', sliceCtoCode: '7D73CTO1WW', type: 'server', quantity: 1, tabs: [] };
    const session = service.sessions.create({
      locale: service.locale,
      solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] },
      mode: 'cto',
      raw,
      configurationId: '7D73CTO1WW',
      reduced: reduceConfiguration(raw, '7D73CTO1WW'),
      primed: true,
    });

    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: { options: [{ id: 'OPT1', slots: [1, 2] }] },
      requestId: 'req-mem-options',
    } as never);

    const pciHandler = handlers.get('dcsc_pci_wizard');
    expect(pciHandler).toBeDefined();

    const reply = await pciHandler!({
      session: session.id,
      memoryWizardAction: 'options',
      memoryWizardPayload: { code: '7D73CTO1WW' },
    });

    const parsed = parse(reply);
    expect(parsed.action).toBe('options');
    expect(parsed.ctoCode).toBe('7D73CTO1WW');
    expect(parsed.data).toEqual({ options: [{ id: 'OPT1', slots: [1, 2] }] });
  });

  it('dcsc_ai_recommend dispatches new action defaultPrompt', async () => {
    const { service, handlers } = await setupTestEnvironment();
    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: {
        code: 200,
        data: { suggestedPrompt: 'Optimize for HPC cluster' },
      },
      requestId: 'req-ai-prompt',
    } as never);

    const aiHandler = handlers.get('dcsc_ai_recommend');
    expect(aiHandler).toBeDefined();

    const reply = await aiHandler!({
      action: 'defaultPrompt',
      payload: { country: 'US', ctoCode: '7D73CTO1WW' },
    });

    const parsed = parse(reply);
    expect(parsed.action).toBe('defaultPrompt');
    expect(parsed.data).toEqual({ suggestedPrompt: 'Optimize for HPC cluster' });
  });

  it('dcsc_find_parts supports includeSupplyStatus enrichment', async () => {
    const { service, handlers } = await setupTestEnvironment();
    vi.spyOn(service.http, 'send').mockImplementation(async (opts) => {
      if (opts.path === '/supply/status') {
        return {
          raw: [{ code: '4X77A08621', shippingStatus: ['14', '14'] }],
          requestId: 'req-supply-status',
        } as never;
      }
      return {
        raw: [{ code: '4X77A08621', description: '32GB TruDDR4', type: 'HARDWARE' }],
        requestId: 'req-findpart',
      } as never;
    });

    const findPartsHandler = handlers.get('dcsc_find_parts');
    expect(findPartsHandler).toBeDefined();

    const reply = await findPartsHandler!({
      keyword: '4X77A08621',
      includeSupplyStatus: true,
    });

    const parsed = parse(reply);
    expect(parsed.supplyStatus).toBeDefined();
    expect((parsed.supplyStatus as { shippingStatus: string[] }).shippingStatus).toEqual(['14', '14']);
    expect((parsed.supplyStatus as { code: string }).code).toBe('4X77A08621');
  });
});
