import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { downloadReferenceSolution } from '../src/domain/referenceSolutions.js';
import { writeCfxmlArtifact } from '../src/files/artifactStore.js';
import { ConfigSchema } from '../src/config/schema.js';
import { DcscService } from '../src/mcp/service.js';

const xml = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><CFXML><CFData><ProprietaryInformation><Name>Configuration Type</Name><Value>General Purpose</Value></ProprietaryInformation><ProductLineItem><ProductIdentification><PartnerProductIdentification><ProprietaryProductIdentifier>7DGDCTO1WW</ProprietaryProductIdentifier></PartnerProductIdentification></ProductIdentification><Quantity>1</Quantity></ProductLineItem></CFData></CFXML>');
it('requires native approval, streams original bytes and enforces the configured size bound', async () => {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  try {
    const send = vi.spyOn(service.http, 'send');
    send.mockResolvedValueOnce({ raw: { type: 'HAS_CONFIG_ERROR' } } as never);
    await expect(downloadReferenceSolution(service.http, service.newCtx(), 'SID123', 1000)).rejects.toThrow('customize');
    expect(send).toHaveBeenCalledTimes(1);
    send.mockResolvedValueOnce({ raw: { type: 'SUCCESS' } } as never)
      .mockResolvedValueOnce({ stream: Readable.from([xml.subarray(0, 25), xml.subarray(25)]), contentType: 'application/json' } as never);
    expect(await downloadReferenceSolution(service.http, service.newCtx(), 'SID123', 1000)).toEqual(xml);
    expect(send.mock.calls[2]![0]).toMatchObject({ method: 'GET', path: '/reference_solution/CRNs/SID123/download' });
    send.mockResolvedValueOnce({ raw: { type: 'SUCCESS' } } as never)
      .mockResolvedValueOnce({ stream: Readable.from([xml]) } as never);
    await expect(downloadReferenceSolution(service.http, service.newCtx(), 'SID123', 10)).rejects.toThrow('limit');
    const calls = send.mock.calls.length;
    await expect(downloadReferenceSolution(service.http, service.newCtx(), '../escape', 1000)).rejects.toThrow('crnId');
    expect(send).toHaveBeenCalledTimes(calls);
  } finally { await service.close(); }
});
it('publishes validated XML atomically with exact bytes, safe paths and an exact checksum', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dcsc-reference-'));
  try {
    const config = ConfigSchema.parse({ files: { artifactDir: dir } });
    const result = await writeCfxmlArtifact(xml, '../../SID123.xml', config);
    expect(result.path.startsWith(dir)).toBe(true);
    expect(result.path.endsWith('.xml')).toBe(true);
    expect(await readFile(result.path)).toEqual(xml);
    expect(result.sha256).toBe(createHash('sha256').update(xml).digest('hex'));
    expect(result.format).toBe('lenovo-cfxml');
    await expect(writeCfxmlArtifact(Buffer.from('{"error":"unavailable"}'), 'bad.xml', config)).rejects.toThrow('Invalid CFXML');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
