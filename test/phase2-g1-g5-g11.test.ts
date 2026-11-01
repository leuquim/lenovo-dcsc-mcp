import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import { reduceConfiguration } from '../src/domain/reduce.js';
import { exportPowerXls, fetchShareUrl } from '../src/domain/exportExtras.js';
import {
  fetchSupplyStatus,
  fetchEsdInfo,
} from '../src/domain/supplyStatus.js';
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
  it('G1: exportPowerXls streams the workbook into the artifact store', async () => {
    const { service, artifacts } = await setupTestEnvironment();
    const fakeData = Buffer.from('PK\x03\x04fake-power-xls');
    const sendSpy = vi.spyOn(service.http, 'send').mockResolvedValue({
      stream: createMockStream(fakeData),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      requestId: 'req-g1-1',
    } as never);

    const result = await exportPowerXls(service.http, service.newCtx(), service.config, {
      mode: 'cto',
      fileName: 'Power_Report.xlsx',
      exportFormPayload: { data: '{}', groups: '[]' },
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
    expect(result.bytes).toBe(fakeData.length);
    expect(result.path.startsWith(artifacts)).toBe(true);
    expect(await readFile(result.path)).toEqual(fakeData);
  });

  it('G1: exportPowerXls rejects a body that is not an xlsx container', async () => {
    const { service } = await setupTestEnvironment();
    vi.spyOn(service.http, 'send').mockResolvedValue({
      stream: createMockStream('<html>maintenance</html>'),
      requestId: 'req-g1-2',
    } as never);

    await expect(exportPowerXls(service.http, service.newCtx(), service.config, {
      mode: 'lfo',
      fileName: 'Power_Report',
      exportFormPayload: {},
    })).rejects.toThrow(/not an \.xlsx workbook/);
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
        responseKind: 'text',
      }),
    );
    expect(result.shareUrl).toBe(mockShareUrl);
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
  it('dcsc_export writes the POWER_XLS report to the artifact store and returns its path', async () => {
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

    const reply = await exportHandler!({
      session: session.id,
      kind: 'power',
      includeShareUrl: true,
    });

    const parsed = parse(reply);
    expect(parsed.session).toBe(session.id);
    expect(parsed.shareUrl).toBe('https://us-dcsc.lenovo.com/share/test1234');
    expect(String(parsed.path).startsWith(artifacts)).toBe(true);
    expect(parsed.base64).toBeUndefined();

    const writtenBytes = await readFile(String(parsed.path));
    expect(writtenBytes).toEqual(fakePowerXls);
  });

  it('dcsc_search parts supports includeSupplyStatus enrichment', async () => {
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

    const findPartsHandler = handlers.get('dcsc_search');
    expect(findPartsHandler).toBeDefined();

    const reply = await findPartsHandler!({
      kind: 'parts',
      query: '4X77A08621',
      includeSupplyStatus: true,
    });

    const parsed = parse(reply);
    expect(parsed.supplyStatus).toBeDefined();
    expect((parsed.supplyStatus as { shippingStatus: string[] }).shippingStatus).toEqual(['14', '14']);
    expect((parsed.supplyStatus as { code: string }).code).toBe('4X77A08621');
  });
});
