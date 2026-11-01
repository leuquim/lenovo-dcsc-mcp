import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import { fetchServiceSavings, fetchFlagSummary } from '../src/domain/summaryInsights.js';
import { exportConfigurationTree } from '../src/domain/exportConfigurationTree.js';

const services: DcscService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});

function setupService() {
  const service = new DcscService(
    ConfigSchema.parse({
      logLevel: 'silent',
      files: { persistSessions: false, artifactDir: mkdtempSync(join(tmpdir(), 'dcsc-tree-')) },
    }),
  );
  services.push(service);
  vi.spyOn(service, 'resolveSolution').mockResolvedValue({
    solutionMode: 'General Purpose',
    masterSlices: ['GP'],
  });
  return service;
}

describe('R4: Summary Insights (Service Savings & Flag Summary)', () => {
  it('fetches and parses service savings successfully', async () => {
    const service = setupService();
    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: {
        serviceSaving: [
          { price: 150.0, priceNotAvailable: false, totalPrice: 2500.0 },
        ],
      },
      requestId: 'req-srv-1',
    } as never);

    const result = await fetchServiceSavings(service.http, service.newCtx(), { snapshotId: 'test-1' });

    expect(result.serviceSaving).toHaveLength(1);
    expect(result.serviceSaving[0]?.price).toBe(150.0);
    expect(result.serviceSaving[0]?.priceNotAvailable).toBe(false);
    expect(result.serviceSaving[0]?.totalPrice).toBe(2500.0);
  });

  it('fetches and parses flag summary successfully', async () => {
    const service = setupService();
    vi.spyOn(service.http, 'send').mockResolvedValue({
      raw: {
        selectableEoFlagItems: [
          {
            id: 'FLAG-1',
            name: 'Special BIOS Flag',
            description: 'Enables high performance mode',
            code: 'F1',
            features: [{ tabTitle: 'BIOS', code: 'SUB1' }],
          },
        ],
      },
      requestId: 'req-flag-1',
    } as never);

    const result = await fetchFlagSummary(service.http, service.newCtx(), { snapshotId: 'test-2' });

    expect(result.selectableEoFlagItems).toHaveLength(1);
    expect(result.selectableEoFlagItems[0]?.id).toBe('FLAG-1');
    expect(result.selectableEoFlagItems[0]?.name).toBe('Special BIOS Flag');
    expect(result.selectableEoFlagItems[0]?.code).toBe('F1');
    expect(result.selectableEoFlagItems[0]?.features).toHaveLength(1);
  });
});

describe('R5: Configuration Tree Spreadsheet Export', () => {
  it('streams the configuration tree workbook into the artifact store', async () => {
    const service = setupService();
    const fakeBuffer = Buffer.from('PK\x03\x04fake-xlsx-content');
    const mockStream = new Readable({
      read() {
        this.push(fakeBuffer);
        this.push(null);
      },
    });

    vi.spyOn(service.http, 'send').mockResolvedValue({
      stream: mockStream,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      requestId: 'req-export-1',
    } as never);

    const result = await exportConfigurationTree(service.http, service.newCtx(), service.config, {
      name: 'SR650V3',
      dataList: [
        {
          typeName: 'Processors',
          contents: ['2x Intel Xeon Gold 6430'],
        },
      ],
    });

    expect(result.path.endsWith('.xlsx')).toBe(true);
    expect(result.bytes).toBe(fakeBuffer.length);
    expect(readFileSync(result.path)).toEqual(fakeBuffer);
  });
});
