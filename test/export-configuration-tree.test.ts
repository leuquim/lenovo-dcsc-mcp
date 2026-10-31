import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';
import { exportConfigurationTree } from '../src/domain/exportConfigurationTree.js';
import { vi, afterEach } from 'vitest';

const services: DcscService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});

function setupService() {
  const service = new DcscService(
    ConfigSchema.parse({ logLevel: 'silent', files: { persistSessions: false } }),
  );
  services.push(service);
  vi.spyOn(service, 'resolveSolution').mockResolvedValue({
    solutionMode: 'General Purpose',
    masterSlices: ['GP'],
  });
  return service;
}

describe('R5: Configuration Tree Spreadsheet Export', () => {
  it('streams and encodes configuration tree Excel export successfully', async () => {
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

    const result = await exportConfigurationTree(service.http, service.newCtx(), {
      name: 'SR650V3',
      dataList: [
        {
          typeName: 'Processors',
          contents: ['2x Intel Xeon Gold 6430'],
        },
      ],
    });

    expect(result.filename).toBe('SR650V3.xlsx');
    expect(result.mimeType).toContain('spreadsheetml.sheet');
    expect(result.bytes).toBe(fakeBuffer.length);
    expect(result.base64).toBe(fakeBuffer.toString('base64'));
  });
});
