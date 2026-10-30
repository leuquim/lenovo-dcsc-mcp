import { describe, expect, it } from 'vitest';
import { serialiseMultipart } from '../src/http/request.js';

describe('DCSC multipart uploads', () => {
  it('preserves arbitrary workbook bytes alongside the JSON restore mapping', () => {
    const bytes = Uint8Array.from([0x50, 0x4b, 0, 0xff, 0x80, 0xc0, 0x0d, 0x0a]);
    const actual = serialiseMultipart('boundary', [
      { name: 'excelFile', filename: 'design.xlsx', contentType: 'application/octet-stream', content: bytes },
      { name: 'excelRestoreRequest', value: '{"rackInfo":{"rack":"Räck"}}' },
    ]);
    const prefix = Buffer.from('--boundary\r\nContent-Disposition: form-data; name="excelFile"; filename="design.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n');
    const suffix = Buffer.from('\r\n--boundary\r\nContent-Disposition: form-data; name="excelRestoreRequest"\r\n\r\n{"rackInfo":{"rack":"Räck"}}\r\n--boundary--\r\n');
    expect(actual).toEqual(Buffer.concat([prefix, bytes, suffix]));
  });

  it('retains the existing UTF-8 CFXML upload wire format', () => {
    expect(serialiseMultipart('boundary', [
      { name: 'cfxmlFile', filename: 'configuration.xml', contentType: 'text/xml', content: '<name>Räck</name>' },
    ])).toEqual(Buffer.from('--boundary\r\nContent-Disposition: form-data; name="cfxmlFile"; filename="configuration.xml"\r\nContent-Type: text/xml\r\n\r\n<name>Räck</name>\r\n--boundary--\r\n'));
  });
});
